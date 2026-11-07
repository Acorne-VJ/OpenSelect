import { detectClient } from "./client";
import { tracedFetch } from "./request_trace";
import { logRequest, updateRequestContentTiming, updateRequestDuration, updateRequestTokens } from "./db";
import { accountPressure, eligibility, isRateLimited } from "./policy";
import { parseTokenUsage, tapUsageStream } from "./tokens";
import { providerBase, providerIntegration, type ProviderCandidate, type ProviderRoute } from "./providers";
import {
  chatSseToAnthropicStream,
  countTokensResponse,
  translateAnthropicRequest,
  translateChatCompletion,
  translateOpenAiError,
} from "./translate";
import { parseRetryAfter, truncate } from "./util";
import type { Account, Effort, Family, RequestLogEntry } from "./types";
import type { Runtime } from "./state";

const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);
/** 供应商裸 429 多为瞬时并发/速率限制：只停 3s，不要按 5h 窗口冷却。 */
const PROVIDER_TRANSIENT_429_MS = 3_000;

type WireKind = "anthropic" | "openai-chat" | "openai-responses";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, type: string, message: string, detail?: string): Response {
  return json(status, { error: { type, message, ...(detail ? { detail } : {}) } });
}

function translatedError(status: number, text: string): Response {
  return json(status, translateOpenAiError(status, text));
}

function wireKindFor(url: URL): WireKind | null {
  const p = url.pathname.replace(/^\/v1/, "");
  if (p === "/messages" || p === "/messages/count_tokens") return "anthropic";
  if (p === "/chat/completions") return "openai-chat";
  if (p === "/responses") return "openai-responses";
  return null;
}

function sessionFor(req: Request): string {
  const direct =
    req.headers.get("x-opencode-session") ??
    req.headers.get("x-session-id") ??
    req.headers.get("x-session-affinity");
  if (direct) return direct;
  const cred = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
  if (!cred) return `openselect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ua = req.headers.get("user-agent") ?? "";
  const hash = new Bun.CryptoHasher("sha256").update(`${cred}|${ua}`).digest("hex").slice(0, 16);
  return `openselect-${hash}`;
}

function pickProviderAccount(
  rt: Runtime,
  provider: ProviderCandidate["provider"],
  upstreamModel: string,
  tried: Set<string>,
  sessionId: string,
  denyScope: string,
  allowFallbackOnly = false,
  clientAccountId?: string,
): Account | null {
  const now = Date.now();
  const integration = providerIntegration(provider);
  const candidates = rt.config.accounts.filter(
    (a) =>
      a.integration === integration &&
      !tried.has(a.id) &&
      !rt.modelDenied(a.id, upstreamModel, denyScope) &&
      (allowFallbackOnly || !a.fallbackOnly) &&
      (!a.models?.length ||
        a.models.includes(upstreamModel) ||
        a.models.includes(`${provider}/${upstreamModel}`)),
  );
  const eligible = candidates.filter(
    (a) =>
      eligibility(a, rt.state(a.id), rt.usages.get(a.id), {
        free: false,
        now,
        switchAt: rt.config.policy.switchAt,
      }).eligible,
  );
  if (eligible.length === 0) return null;
  const pinned = clientAccountId ? eligible.find((a) => a.id === clientAccountId) : undefined;
  if (pinned) return pinned;
  if (rt.forcedAccountId) {
    const forced = eligible.find((a) => a.id === rt.forcedAccountId);
    if (forced) return forced;
  }
  const sticky = rt.getSessionAccount(sessionId);
  const hit = sticky ? eligible.find((a) => a.id === sticky) : undefined;
  if (hit) return hit;
  eligible.sort((a, b) => {
    const pa = accountPressure(rt.usages.get(a.id));
    const pb = accountPressure(rt.usages.get(b.id));
    if (pa !== pb) return pa - pb;
    return (rt.state(a.id).lastUsed ?? 0) - (rt.state(b.id).lastUsed ?? 0);
  });
  return eligible[0]!;
}

function effortFor(req: Request, account: Account, candidate: ProviderCandidate): Effort {
  const raw = (req.headers.get("x-openselect-effort") ?? "").trim().toLowerCase();
  if (EFFORTS.has(raw as Effort)) return raw as Effort;
  return account.defaultEffort ?? candidate.effort ?? "max";
}

/** 供应商端点：base 可能已经带 /v1，避免拼出 /v1/v1。 */
function providerUrl(account: Account, kind: WireKind, countTokens: boolean): string {
  let base = providerBase(account);
  if ((account.integration === "commandcode" || account.integration === "ollama") && !base.endsWith("/v1")) {
    base += "/v1";
  }
  let path: string;
  if (kind === "anthropic") {
    path = countTokens ? "/v1/messages/count_tokens" : "/v1/messages";
  } else if (kind === "openai-chat") {
    path = "/chat/completions";
  } else {
    path = "/responses";
  }
  if (base.endsWith("/v1") && path.startsWith("/v1/")) path = path.slice(3);
  return base + path;
}

function rewriteBody(
  bodyBuf: ArrayBuffer | null,
  candidate: ProviderCandidate,
  effort: Effort,
  kind: WireKind,
  countTokens: boolean,
): string {
  if (!bodyBuf || bodyBuf.byteLength === 0) throw new Error("request body is required");
  const body = JSON.parse(new TextDecoder().decode(bodyBuf)) as Record<string, unknown>;
  body.model = candidate.model;
  if (countTokens || kind !== "anthropic") return JSON.stringify(body);

  if (candidate.provider === "zai" || candidate.provider === "deepseek") {
    const selected = (body.output_config as { effort?: string } | undefined)?.effort;
    delete body.output_config;
    const thinking = body.thinking as { type?: string } | undefined;
    if (!thinking || thinking.type === "adaptive") body.thinking = { type: "enabled" };
    if (!body.reasoning_effort && thinking?.type !== "disabled") {
      body.reasoning_effort = selected === "minimal" ? "low" : selected === "medium" || selected === "xhigh" ? "high" : selected || effort;
    }
  } else if (candidate.provider === "commandcode" || candidate.provider === "ollama") {
    // Command Code / Ollama Cloud 的 Anthropic 透传不接受 OpenCode 专用字段。
    delete body.output_config;
  } else {
    // MiniMax M Plan 使用 output_config.effort + thinking.adaptive。
    delete body.reasoning_effort;
    const outputConfig =
      body.output_config && typeof body.output_config === "object"
        ? (body.output_config as Record<string, unknown>)
        : {};
    if (!outputConfig.effort) outputConfig.effort = effort;
    body.output_config = outputConfig;
    if (candidate.model === "MiniMax-M3.1-Flash") {
      if ((body.thinking as { type?: string } | undefined)?.type === "disabled") {
        body.thinking = { type: "adaptive" };
      }
    } else if (!body.thinking) {
      body.thinking = { type: "adaptive" };
    }
  }
  return JSON.stringify(body);
}

function headersFor(req: Request, account: Account, kind: WireKind): Headers {
  const h = new Headers();
  h.set("authorization", `Bearer ${account.key}`);
  h.set("content-type", "application/json");
  h.set("accept", req.headers.get("accept") ?? (kind === "anthropic" ? "application/json" : "application/json"));
  if (kind === "anthropic") {
    h.set("anthropic-version", req.headers.get("anthropic-version") ?? "2023-06-01");
    const beta = req.headers.get("anthropic-beta");
    if (beta) h.set("anthropic-beta", beta);
  }
  h.set("user-agent", "openselect");
  return h;
}

function passthrough(res: Response): Response {
  const headers = new Headers();
  for (const [k, v] of res.headers) {
    const lk = k.toLowerCase();
    if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding" || lk === "connection") {
      continue;
    }
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function provider429IsQuota(rt: Runtime, account: Account, res: Response, text: string): boolean {
  const usage = rt.usages.get(account.id);
  if (isRateLimited(usage)) return true;
  if (res.headers.get("retry-after")) return true;
  const s = text.toLowerCase();
  return /limitname|quota|insufficient|usage limit|billing|token plan|plan limit|weekly|monthly|5[ -]hour/.test(s);
}

function cooldownMsFor(rt: Runtime, account: Account, res: Response, text: string): number {
  const retry = parseRetryAfter(res.headers.get("retry-after"));
  if (retry != null) return Math.max(1000, retry * 1000);
  const usage = rt.usages.get(account.id);
  const lower = text.toLowerCase();
  const window: "rolling" | "weekly" | "monthly" = /weekly|week/.test(lower)
    ? "weekly"
    : /monthly|month/.test(lower)
      ? "monthly"
      : "rolling";
  const reset = usage?.[window]?.resetsAt ? Date.parse(usage[window].resetsAt!) : NaN;
  if (Number.isFinite(reset)) return Math.max(60_000, reset - Date.now());
  return Math.max(60_000, rt.config.policy.cooldownFallbackSec * 1000);
}

/**
 * 直连供应商代理。
 * - Z.ai / MiniMax / DeepSeek：Anthropic Messages 原生透传。
 * - Command Code / Ollama Cloud：Anthropic /messages、OpenAI /chat/completions、/responses 原生透传。
 */
export async function handleProviderRequest(opts: {
  req: Request;
  url: URL;
  bodyBuf: ArrayBuffer | null;
  requestedModel: string;
  route: ProviderRoute;
  rt: Runtime;
  /** coding-auto 的最后一层：交给 opencode-go 通用路径（会做 Anthropic→chat 翻译）。 */
  fallback?: () => Promise<Response>;
  /** 显式点名 deepseek/... 或最后一层兜底时，允许 fallbackOnly 账号。 */
  allowFallbackOnly?: boolean;
}): Promise<Response> {
  const { req, url, bodyBuf, requestedModel, route, rt, fallback } = opts;
  const allowFallbackOnly = opts.allowFallbackOnly ?? route.strict;
  const started = Date.now();
  const kind = wireKindFor(url);
  if (!kind) return errorResponse(400, "invalid_request_error", `不支持的供应商端点：${url.pathname}`);
  const countTokens = kind === "anthropic" && url.pathname.replace(/^\/v1/, "") === "/messages/count_tokens";
  const family: Family = kind === "anthropic" ? "anthropic" : "openai";
  const denyScope = kind === "anthropic" ? "anthropic" : kind === "openai-responses" ? "responses" : "chat";
  const client = detectClient(req, url.pathname);
  const sessionId = sessionFor(req);
  const maxAttempts = Math.max(1, rt.config.policy.maxAttempts);
  const tried = new Set<string>();
  const attempted: string[] = [];
  let pendingFrom: string | null = null;
  let pendingReason = "";
  let pendingDetail: string | null = null;
  let lastStatus = 0;
  let lastText = "";

  // 本地估算 count_tokens：Command Code / Ollama 没有兼容端点，不必为估算发一次上游请求。
  const first = route.candidates[0];
  if (countTokens && first && (first.provider === "commandcode" || first.provider === "ollama")) {
    try {
      const body = bodyBuf ? (JSON.parse(new TextDecoder().decode(bodyBuf)) as unknown) : {};
      return json(200, countTokensResponse(body));
    } catch {
      return json(200, countTokensResponse({}));
    }
  }
  const log = (
    status: number,
    accountId: string,
    servedModel: string | null,
    error: string | null,
    extra: Partial<RequestLogEntry> = {},
  ): number | null => {
    const entry: RequestLogEntry = {
      ts: started,
      sessionId,
      model: requestedModel,
      servedModel,
      family,
      accountId,
      status,
      attempts: attempted.length,
      latencyMs: Date.now() - started,
      error,
      path: url.pathname,
      client,
      ...extra,
    };
    return logRequest(entry);
  };

  for (const candidate of route.candidates) {
    if (kind !== "anthropic" && candidate.provider !== "commandcode" && candidate.provider !== "ollama") continue;

    for (let i = 0; i < maxAttempts; i++) {
      const account = pickProviderAccount(
        rt,
        candidate.provider,
        candidate.model,
        tried,
        sessionId,
        candidate.provider === "commandcode" && kind === "anthropic" ? "chat" : denyScope,
        allowFallbackOnly,
        rt.config.policy.clientAccounts?.[client],
      );
      if (!account) break;
      tried.add(account.id);
      attempted.push(account.id);
      const attemptStarted = Date.now();

      let body: string;
      let commandStream = false;
      let commandInputTokens = 0;
      try {
        if (candidate.provider === "commandcode" && kind === "anthropic") {
          if (!bodyBuf || bodyBuf.byteLength === 0) throw new Error("request body is required");
          const input = JSON.parse(new TextDecoder().decode(bodyBuf)) as Record<string, unknown>;
          const tr = translateAnthropicRequest(input, candidate.model);
          body = JSON.stringify(tr.body);
          commandStream = tr.stream;
          commandInputTokens = tr.approxInputTokens;
        } else {
          body = rewriteBody(bodyBuf, candidate, effortFor(req, account, candidate), kind, countTokens);
        }
      } catch (e) {
        return errorResponse(400, "invalid_request_error", String(e));
      }

      const upstreamKind: WireKind = candidate.provider === "commandcode" && kind === "anthropic" ? "openai-chat" : kind;
      let res: Response;
      try {
        res = await tracedFetch(providerUrl(account, upstreamKind, countTokens), {
          method: "POST",
          headers: headersFor(req, account, upstreamKind),
          body,
        }, { provider: account.integration, model: candidate.model, accountId: account.id });
      } catch (e) {
        lastStatus = 0;
        lastText = String(e);
        rt.setCooldown(account.id, Date.now() + 60_000, `provider network error`);
        pendingFrom = account.id;
        pendingReason = "network-error";
        pendingDetail = truncate(lastText, 160);
        continue;
      }

      if (res.ok) {
        rt.touch(account.id);
        rt.bindSession(sessionId, account.id);
        if (pendingFrom) {
          rt.logSwitch(pendingFrom, account.id, pendingReason || "provider-failover", pendingDetail, sessionId);
        }
        if (candidate.provider === "commandcode" && kind === "anthropic") {
          const ct = res.headers.get("content-type") ?? "";
          if (commandStream && ct.includes("text/event-stream") && res.body) {
            let logId: number | null = null;
            const translated = chatSseToAnthropicStream(res.body, {
              model: requestedModel,
              inputTokens: commandInputTokens,
            });
            const tapped = tapUsageStream(
              translated,
              (u) => {
                if (logId != null) updateRequestTokens(logId, u);
              },
              true,
              () => { if (logId != null) updateRequestDuration(logId, Date.now() - started); },
        (first, last) => { if (logId != null) updateRequestContentTiming(logId, started, first, last, attempted.length > 1 ? attemptStarted - started : 0); },
            );
            logId = log(200, account.id, requestedModel, null, { provider: "commandcode" });
            return new Response(tapped, {
              status: 200,
              headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
            });
          }
          const text = await res.text();
          try {
            const j = JSON.parse(text) as unknown;
            const usage = parseTokenUsage(j);
            const completedLogId = log(200, account.id, requestedModel, null, {
              provider: "commandcode",
              ...(usage
                ? {
                    inputTokens: usage.input,
                    outputTokens: usage.output,
                    cacheReadTokens: usage.cacheRead,
                    cacheReadKnown: usage.cacheReadKnown,
                    cacheWriteTokens: usage.cacheWrite,
                    totalTokens: usage.total,
                    tokenEstimated: usage.estimated ?? false,
                  }
                : {}),
            });
            if (completedLogId != null) updateRequestDuration(completedLogId, Date.now() - started);
            return json(200, translateChatCompletion(j, requestedModel));
          } catch {
            log(502, account.id, null, "invalid JSON from Command Code");
            return translatedError(502, text);
          }
        }
        let logId: number | null = null;
        const tapped = res.body
          ? tapUsageStream(
              res.body,
              (u) => {
                if (logId != null) updateRequestTokens(logId, u);
              },
              false,
              () => { if (logId != null) updateRequestDuration(logId, Date.now() - started); },
        (first, last) => { if (logId != null) updateRequestContentTiming(logId, started, first, last, attempted.length > 1 ? attemptStarted - started : 0); },
            )
          : null;
        const out = new Response(tapped, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
        logId = log(res.status, account.id, candidate.model, null, { provider: candidate.provider });
        return passthrough(out);
      }

      const text = await res.text().catch(() => "");
      lastStatus = res.status;
      lastText = text;
      const from = account.id;

      if (res.status === 401) {
        rt.setInvalid(account.id, "HTTP 401");
        pendingReason = "invalid:401";
        pendingDetail = "provider key rejected";
      } else if (res.status === 403) {
        rt.denyModel(
          account.id,
          candidate.model,
          res.status,
          text,
          15 * 60_000,
          candidate.provider === "commandcode" && kind === "anthropic" ? "chat" : denyScope,
        );
        pendingReason = "403";
        pendingDetail = `model-denied: ${candidate.model}`;
      } else if (res.status === 402) {
        rt.setCooldown(account.id, Date.now() + 5 * 60_000, "HTTP 402 (balance)");
        pendingReason = "402";
        pendingDetail = truncate(text, 120) || "insufficient balance";
      } else if (res.status === 429) {
        const quota = provider429IsQuota(rt, account, res, text);
        const cd = quota ? cooldownMsFor(rt, account, res, text) : PROVIDER_TRANSIENT_429_MS;
        rt.setCooldown(
          account.id,
          Date.now() + cd,
          quota ? "HTTP 429 (provider quota)" : "HTTP 429 (provider transient)",
        );
        pendingReason = "429";
        pendingDetail = quota
          ? `quota-cooldown=${Math.round(cd / 1000)}s`
          : `provider-cooldown=${Math.round(cd / 1000)}s; ${truncate(text, 80)}`;
      } else if (res.status >= 500) {
        rt.setCooldown(account.id, Date.now() + Math.min(60_000, rt.config.policy.cooldownFallbackSec * 1000), `HTTP ${res.status}`);
        pendingReason = `HTTP ${res.status}`;
        pendingDetail = truncate(text, 160);
      } else {
        // 400/404 等请求级错误：换 provider 通常也无意义，直接透传。
        log(res.status, from, null, truncate(text, 300) || `HTTP ${res.status}`, {
          provider: candidate.provider,
        });
        if (candidate.provider === "commandcode" && kind === "anthropic") return translatedError(res.status, text);
        return new Response(text, {
          status: res.status,
          statusText: res.statusText,
          headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
        });
      }

      pendingFrom = from;
      if (route.strict) {
        // 严格模型：同一个 provider 内换 key；没有其它 key 时结束。
        continue;
      }
    }
  }

  if (!route.strict && fallback) return fallback();

  const providers = [...new Set(route.candidates.map((c) => c.provider))].join(" / ");
  log(lastStatus || 503, attempted.join(" → ") || "-", null, truncate(lastText, 300) || "no eligible account");
  if (kind === "anthropic" && route.strict && route.candidates[0]?.provider === "commandcode") {
    return translatedError(lastStatus || 503, lastText || "Command Code 不可用");
  }
  return errorResponse(
    lastStatus === 429 ? 429 : 503,
    "openselect_provider_unavailable",
    `模型 ${requestedModel} 暂无可用账号（${providers}）；可能是额度、冷却、阈值或未配置 key。`,
    truncate(lastText, 300) || undefined,
  );
}
