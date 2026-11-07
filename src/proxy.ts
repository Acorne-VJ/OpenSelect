import { detectClient } from "./client";
import { tracedFetch, withRequestTrace } from "./request_trace";
import { buildRoutingPlan } from "./route_plan";
import {
  familyFromPath,
  isFreeFirstEligible,
  isFreeModel,
  loadCatalog,
  stripVersionPrefix,
  type Catalog,
} from "./catalog";
import { logRequest, updateRequestContentTiming, updateRequestDuration, updateRequestTokens } from "./db";
import { eligibility, pickAccount, type PolicyDecision } from "./policy";
import { parseTokenUsage, tapUsageStream } from "./tokens";
import { deepSeekFallbackRoute, resolveProviderRoute } from "./providers";
import { handleProviderRequest } from "./provider_proxy";
import { codingAutoOrder } from "./coding_auto";
import { capabilityRejections, requestRequirements, ROUTE_CAPABILITIES } from "./route_capabilities";
import { handleDeepSeekTool } from "./tools";
import type { Runtime } from "./state";
import {
  zenComplete,
  listZenModels,
  isZenModelId,
  zenChain,
  zenDeniedUntil,
  zenDenyMap,
  zenNoteFailure,
  zenOutageRemaining,
  zenMarkOutage,
} from "./zen.js";
import {
  anthropicError,
  chatSseToAnthropicStream,
  countTokensResponse,
  translateAnthropicRequest,
  translateChatCompletion,
  translateOpenAiError,
} from "./translate";
import type { Family } from "./types";
import { parseRetryAfter, truncate } from "./util";

const FAMILY_PREFIX: Record<Family, string> = {
  openai: "/openai/v1",
  anthropic: "/anthropic/v1",
  google: "/google/v1beta",
};

/** request headers not forwarded upstream */
const REQ_STRIP = new Set([
  "host",
  // OpenSelect 内部控制头：不转发到上游
  "x-openselect-client",
  "authorization",
  "x-api-key", // anthropic family auth — replaced per-account
  "x-goog-api-key", // google family auth — replaced per-account
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding", // let fetch negotiate; body arrives decompressed
]);

/** Auth header used by each API family (mirrors what the real opencode client sends). */
const FAMILY_AUTH_HEADER: Record<Family, string> = {
  openai: "authorization",
  anthropic: "x-api-key",
  google: "x-goog-api-key",
};

/** response headers not forwarded downstream (Bun fetch already decompressed the body) */
const RESP_STRIP = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "trailer",
  "upgrade",
]);

/** (账号×免费模型) 负缓存时长：免费模型不可用后 15 分钟内不再重试该组合 */
const FREE_MODEL_DENY_TTL_MS = 15 * 60 * 1000;
/** 裸 429（无 limitName / retry-after）多为瞬时并发/RPM 限流：只做 3s 短冷却，不写 60s 模型负缓存 */
const BARE_429_COOLDOWN_MS = 3_000;
/** Claude Code 的 [1m]/[200k] 是上下文窗口提示，不是模型 ID；转发上游前剥掉。 */
const CONTEXT_SUFFIX_RE = /\[(?:1m|200k|400k|500k)\]/gi;
/** 预检阈值：低于 DeepSeek 1,048,576 上限，留 tokenizer/工具 schema 误差。 */
const SAFE_CONTEXT_TOKENS = 1_040_000;
/**
 * 404「Endpoint is unavailable」的负缓存时长：比 403（模型被计划/工作区禁用，状态稳定）短得多。
 * 实测上游该错误是**间歇性**的（同一账号同一模型，先 404 后 200），所以只短暂拉黑，避免误伤。
 */
const MODEL_404_DENY_TTL_MS = 2 * 60 * 1000;
/**
 * 同一模型连续多少个账号返回「Endpoint/Model is unavailable」后停止扫描：
 * 实测该错误多为**模型级**不可用（所有账号都一样），继续扫池只是放大上游调用。
 */
const MODEL_404_MAX_SCAN = 3;

/**
 * 上游 404 是否属于「端点/模型在该账号不可用」（账号级，可换号）。
 * 覆盖措辞变体：Endpoint is unavailable / endpoint_unavailable / Model is unavailable /
 * The model X does not exist / model not found。
 * 注意：本分支只对**本代理目录里存在**的模型生效（见调用处），所以"模型不存在"= 该账号计划里没有。
 */
function isEndpointUnavailable(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  // 网关路由类错误（route / routing / url / path）不是"模型不可用"：
  // 误判会白白换号 + 给多个账号写 2 分钟负缓存，把本来可用的模型也冷却掉
  if (/(route|routing|url|path)\b/.test(t)) return false;
  if (/(endpoint|model)[^"]{0,30}unavailable/.test(t)) return true;
  if (/(endpoint|model)[^"]{0,60}(does not exist|not exist|not found|not available)/.test(t)) return true;
  return false;
}

export interface ProxyOptions {
  hostname?: string;
  port?: number;
}

export interface ProxyHandle {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
}

export function startProxy(rt: Runtime, opts: ProxyOptions = {}): ProxyHandle {
  const server = Bun.serve({
    hostname: opts.hostname ?? rt.config.proxy.host,
    port: opts.port ?? rt.config.proxy.port,
    idleTimeout: 255,
    fetch: (req) => handleProxyRequest(rt, req),
  });
  return { server, stop: () => void server.stop(true) };
}

function sanitizeResponseHeaders(h: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of h.entries()) {
    if (RESP_STRIP.has(k.toLowerCase())) continue;
    out.set(k, v);
  }
  return out;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 简单的 SSE 流式响应构造器（支持拉取式流，避免一次性吞吐导致客户端读不到）。 */
function sseStream(
  gen: (yield_: (chunk: string) => void) => void | Promise<void> | AsyncGenerator<void, void, unknown>,
): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const queue: string[] = [];
        let closed = false;
        const yield_ = (chunk: string) => {
          queue.push(chunk);
          // 尝试立即冲刷
          while (queue.length && controller.desiredSize !== null && controller.desiredSize > 0) {
            controller.enqueue(encoder.encode(queue.shift()!));
          }
        };
        let genDone = false;
        try {
          const result = gen(yield_);
          if (result && typeof result === "object" && Symbol.asyncIterator in result) {
            // AsyncGenerator: 边跑边冲刷
            for await (const _ of result as AsyncGenerator<unknown, void, unknown>) {
              while (queue.length && controller.desiredSize !== null && controller.desiredSize > 0) {
                controller.enqueue(encoder.encode(queue.shift()!));
              }
              // 让出控制权，给客户端读取时间
              await new Promise((r) => setTimeout(r, 0));
            }
          } else {
            await result;
          }
          genDone = true;
        } catch (e) {
          controller.error(e);
          return;
        }
        // 冲刷剩余
        while (queue.length && controller.desiredSize !== null && controller.desiredSize > 0) {
          controller.enqueue(encoder.encode(queue.shift()!));
        }
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    },
  );
}

function withJsonContentType(h: Headers): Headers {
  h.set("content-type", "application/json; charset=utf-8");
  return h;
}

/** hard cap for request bodies buffered for retries / model detection */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

class BodyTooLargeError extends Error {}

function payloadTooLarge(path = ""): Response {
  const message = `request body exceeds ${MAX_BODY_BYTES} bytes`;
  // Anthropic 客户端要求 {type:"error",error:{...}} 外形
  if (path.includes("/messages")) return jsonResponse(413, anthropicError("request_too_large", message));
  return jsonResponse(413, { error: { type: "openselect_payload_too_large", message } });
}

/** Read a request body with a size cap; throws BodyTooLargeError when the cap is exceeded. */
async function readBodyCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      void reader.cancel().catch(() => {});
      throw new BodyTooLargeError(`request body exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return merged.buffer;
}

/** Stable session id for clients that don't send one (upstream gateway requires x-opencode-session).
 *  Derived from client credential + user-agent so the same client keeps a sticky account. */
function synthesizeSession(req: Request): string {
  const cred = req.headers.get("authorization") ?? req.headers.get("x-api-key") ?? "";
  if (!cred) return `openselect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ua = req.headers.get("user-agent") ?? "";
  const hash = new Bun.CryptoHasher("sha256").update(`${cred}|${ua}`).digest("hex").slice(0, 16);
  return `openselect-${hash}`;
}

/** Unified model list for standard clients (OpenAI/Anthropic both use GET /v1/models).
 *  Served locally from the catalog — no upstream request, includes free-model markers.
 *  Also includes zen free models (served via local opencode server /generate). */
async function modelsResponse(catalog: Catalog, id: string | null): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const entry = (mid: string, info: Catalog["models"][string] | { name: string; family: "openai"; free: true }): Record<string, unknown> => ({
    id: mid,
    object: "model",
    type: "model",
    created: now,
    created_at: new Date(now * 1000).toISOString(),
    owned_by: "openselect",
    display_name: info.name,
    family: info.family,
    free: info.free ?? false,
    ...("inputModalities" in info && info.inputModalities ? { input_modalities: info.inputModalities } : {}),
  });
  if (id) {
    const info = catalog.models[id];
    if (info) return jsonResponse(200, entry(id, info));
    // zen 模型不在 catalog.models 里，但可能在 zen 列表里
    const zen = await listZenModels();
    const z = zen.find((m) => m.id === id);
    if (z) return jsonResponse(200, entry(z.id, { name: z.name, family: "openai", free: true }));
    return jsonResponse(404, { error: { type: "not_found_error", message: `model ${id} not found` } });
  }
  const data = Object.keys(catalog.models).map((mid) => entry(mid, catalog.models[mid]!));
  // 添加 zen 免费模型
  const zen = await listZenModels();
  for (const z of zen) {
    data.push(entry(z.id, { name: z.name, family: "openai", free: true }));
  }
  return jsonResponse(200, {
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
}

/** zen 免费层直通：把请求转给本地 opencode server 的 /generate（带候选链与负缓存） */

interface ZenParsed {
  prompt: string;
  stream: boolean;
  maxTokens: number;
  isMessages: boolean;
}

function zenParseRequest(normPath: string, bodyBuf: ArrayBuffer | null, fallThrough = false): ZenParsed | Response | null {
  const isMessages = normPath === "/messages" || normPath === "/v1/messages";
  const isChat = normPath === "/chat/completions" || normPath === "/v1/chat/completions";
  const isResponses = normPath === "/responses" || normPath === "/v1/responses";
  if (!isMessages && !isChat && !isResponses) {
    return jsonResponse(400, { error: { type: "invalid_request_error", message: "zen 模型仅支持 /v1/chat/completions /v1/messages /v1/responses" } });
  }
  let prompt = "";
  let stream = false;
  let maxTokens = 4096;
  if (bodyBuf && bodyBuf.byteLength > 0) {
    try {
      const j = JSON.parse(new TextDecoder().decode(bodyBuf)) as {
        messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
        stream?: boolean;
        max_tokens?: number;
        max_completion_tokens?: number;
      };
      const msgs = j.messages ?? [];
      const parts: string[] = [];
      for (const m of msgs) {
        const role = isMessages ? (m.role === "assistant" ? "Assistant" : "User") : m.role;
        const text = typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("");
        if (text.trim()) parts.push(`${role}: ${text}`);
      }
      prompt = parts.join(isMessages ? "\n\n" : "\n");
      stream = j.stream ?? false;
      maxTokens = j.max_completion_tokens ?? j.max_tokens ?? 4096;
    } catch {
      return jsonResponse(400, { error: { type: "invalid_request_error", message: "request body must be JSON" } });
    }
  }
  if (!prompt.trim()) {
    // tool_result-only / 纯图片等没有可抽取文本的请求：免费链无法承接，
    // 让调用方继续走账号池/付费，而不是把整个请求判成 400。
    if (fallThrough) return null;
    return jsonResponse(400, { error: { type: "invalid_request_error", message: "no content to generate" } });
  }
  return { prompt, stream, maxTokens, isMessages };
}

function zenBuildResponse(parsed: ZenParsed, modelId: string, text: string): Response {
  if (parsed.isMessages) {
    const resp = {
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      type: "message",
      role: "assistant",
      model: modelId,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    if (parsed.stream) {
      return sseStream(async function* (yield_: (chunk: string) => void) {
        yield_(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: resp })}\n\n`);
        yield; yield_(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
        yield;
        for (const w of text.split(/(\s+)/)) {
          yield_(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } })}\n\n`);
          yield;
        }
        yield_(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        yield; yield_(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`);
        yield; yield_(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      });
    }
    return jsonResponse(200, resp);
  }
  const completion = {
    id: "chatcmpl-" + Math.random().toString(36).slice(2, 10),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  if (parsed.stream) {
    return sseStream(async function* (yield_: (chunk: string) => void) {
      yield_(`data: ${JSON.stringify({ ...completion, choices: [{ ...completion.choices[0], delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      yield;
      for (const w of text.split(/(\s+)/)) {
        yield_(`data: ${JSON.stringify({ ...completion, choices: [{ ...completion.choices[0], delta: { content: w }, finish_reason: null }] })}\n\n`);
        yield;
      }
      yield_(`data: ${JSON.stringify({ ...completion, choices: [{ ...completion.choices[0], delta: {}, finish_reason: "stop" }] })}\n\n`);
      yield; yield_("data: [DONE]\n\n");
    });
  }
  return jsonResponse(200, completion);
}

/**
 * 尝试 zen 免费候选链：
 * - 顺序 = 指定模型 → 用户配置（policy.freeFirst 里的 zen id）→ 默认全集；
 * - 负缓存命中的候选直接跳过；只有**模型级**失败才写冷却（额度 30min / 下线 24h / 未知 1min）；
 * - 通用上游故障（503/连接失败/server 起不来）不写模型冷却，换下一个候选；连续 2 个候选都失败则整链短时熔断 8s；
 * - fallThrough=true（免费中转链）全部失败返回 null（调用方继续走账号池/付费兜底）；
 *   false（客户端点名 zen 且禁用免费替换）返回带恢复时间的 503。
 */
async function tryZenChain(
  req: Request,
  preferred: string | null,
  bodyBuf: ArrayBuffer | null,
  rt: Runtime,
  opts: { origModel?: string | null; fallThrough: boolean },
): Promise<Response | null> {
  const url = new URL(req.url);
  const normPath = stripVersionPrefix(url.pathname);
  const parsed = zenParseRequest(normPath, bodyBuf, opts.fallThrough);
  if (parsed === null) return null;
  if (parsed instanceof Response) return parsed;

  const chain = zenChain(preferred, rt.config.policy.freeFirst ?? []);
  const zenPort = rt.config.zen?.port ?? 8790;
  const started = Date.now();
  const zenClient = detectClient(req, url.pathname);
  const zenSession =
    req.headers.get("x-opencode-session") ??
    req.headers.get("x-session-id") ??
    req.headers.get("x-session-affinity") ??
    synthesizeSession(req);
  const origModel = opts.origModel ?? preferred ?? "";
  let lastErr = "";
  let attempted = 0;
  let transportFails = 0;

  let outage = zenOutageRemaining();
  if (outage > 0) lastErr = `zen 上游暂不可用，${Math.ceil(outage / 1000)}s 后自动重试`;

  for (const id of chain) {
    if (zenDeniedUntil(id) > 0) continue;
    if (zenOutageRemaining() > 0) break;
    attempted++;
    try {
      const text = await zenComplete(id, parsed.prompt, parsed.maxTokens, zenPort);
      const latency = Date.now() - started;
      logRequest({
        client: zenClient,
        ts: started,
        sessionId: zenSession,
        model: origModel || id,
        servedModel: origModel && origModel !== id ? id : null,
        family: "openai",
        accountId: "zen-local",
        provider: "zen",
        status: 200,
        attempts: attempted,
        latencyMs: latency,
        error: null,
        path: url.pathname,
      });
      if (origModel && origModel !== id) console.log(`[zen] ${origModel} → ${id}（免费链顶替，${latency}ms）`);
      return zenBuildResponse(parsed, id, text);
    } catch (e) {
      lastErr = String(e);
      const f = zenNoteFailure(id, lastErr);
      if (f.scope === "transport") {
        transportFails++;
        if (transportFails >= 2) {
          zenMarkOutage(8000, f.reason);
          outage = zenOutageRemaining();
          break;
        }
      } else {
        transportFails = 0;
      }
    }
  }

  if (opts.fallThrough) {
    console.warn(
      `[zen] 候选全部失败（尝试 ${attempted}/${chain.length} 个）→ 走后备：${truncate(lastErr, 200) || "全部在冷却中"}`,
    );
    return null;
  }

  // 点名 zen 且不允许免费替换：给出每个模型的恢复时间
  const deny = zenDenyMap();
  const detail = Object.entries(deny)
    .map(([id, d]) => `${id}（${d.reason}）${new Date(d.until).toLocaleTimeString("zh-CN", { hour12: false })} 恢复`)
    .join("；");
  const recovery = outage > 0 ? `上游暂不可用，约 ${Math.ceil(outage / 1000)}s 后重试` : detail || "无候选";
  logRequest({
    client: zenClient,
    ts: started,
    sessionId: zenSession,
    model: origModel || preferred || "zen",
    servedModel: null,
    family: "openai",
    accountId: "zen-local",
    provider: "zen",
    status: 503,
    attempts: attempted,
    latencyMs: Date.now() - started,
    error: truncate(lastErr, 300),
    path: url.pathname,
  });
  return jsonResponse(503, {
    error: {
      type: "openselect_zen_exhausted",
      message: `zen 免费模型全部不可用；恢复时间：${recovery}`,
    },
  });
}

/** Retryable upstream statuses that trigger account failover before first byte reaches the client. */
function isRetryable(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** 把 JSON 请求体里的 model 改成指定模型（zen 全挂 → 无缝落付费模型时用） */
function rewriteBodyModel(body: ArrayBuffer | null, model: string): ArrayBuffer | null {
  if (!body || body.byteLength === 0) return body;
  try {
    const j = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    if (j.model === model) return body;
    j.model = model;
    return new TextEncoder().encode(JSON.stringify(j)).buffer as ArrayBuffer;
  } catch {
    return body;
  }
}

function stripContextSuffix(id: string): string {
  return id.replace(CONTEXT_SUFFIX_RE, "");
}

/** 把上游 context-length 400 转成 Claude Code 能识别的 Anthropic 「prompt is too long」。 */
function contextOverflowMessage(text: string): string | null {
  const m =
    text.match(/maximum context length is\s+(\d+)\s+tokens;?\s*the prompt has\s+(\d+)\s+tokens/i) ??
    text.match(/prompt has\s+(\d+)\s+tokens.*?maximum context length is\s+(\d+)/i);
  if (!m) return null;
  const first = Number(m[1]);
  const second = Number(m[2]);
  const max = m[0].toLowerCase().startsWith("prompt has") ? second : first;
  const prompt = m[0].toLowerCase().startsWith("prompt has") ? first : second;
  if (!Number.isFinite(max) || !Number.isFinite(prompt)) return null;
  return `prompt is too long: ${prompt} tokens > ${max} maximum; run /compact or reduce context`;
}

export async function handleProxyRequest(rt: Runtime, req: Request, opts?: { disableFreeRouting?: boolean; originalRequestedModel?: string; allowedAccountIds?: Set<string> }): Promise<Response> {
  return withRequestTrace(req, () => handleProxyRequestInner(rt, req, opts));
}

async function handleProxyRequestInner(rt: Runtime, req: Request, opts?: { disableFreeRouting?: boolean; originalRequestedModel?: string; allowedAccountIds?: Set<string> }): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);

  if (url.pathname === "/" || url.pathname === "/healthz") {
    return jsonResponse(200, { service: "openselect", ok: true, accounts: rt.config.accounts.length });
  }

  // 标准客户端（Claude Code / OpenAI SDK）统一模型清单：本地返回，不触发上游请求
  const normPath = stripVersionPrefix(url.pathname);
  if (req.method === "GET" && normPath === "/models") {
    return modelsResponse(await loadCatalog(), null);
  }
  // 单模型查询仅拦截标准 /v1 前缀路径（Claude Code / OpenAI SDK）；无前缀 /models/<id> 保持既有家族路由
  // （google /v1beta 等），不被本地清单劫持；同时排除 google 方法后缀（:generateContent / :streamGenerateContent）。
  if (req.method === "GET" && url.pathname.startsWith("/v1/models/") && !normPath.includes(":")) {
    const catalog = await loadCatalog();
    const id = decodeURIComponent(normPath.slice("/models/".length));
    return modelsResponse(catalog, id); // 目录内返回条目；未知模型本地 404（不触发上游请求）
  }

  if (req.method === "POST" && (normPath === "/tools/search" || normPath === "/tools/fetch")) {
    return handleDeepSeekTool(rt, req, normPath === "/tools/search" ? "/tools/search" : "/tools/fetch");
  }

  const family = familyFromPath(url.pathname);
  const isMessages = family === "anthropic" && normPath === "/messages";
  const isCountTokens = family === "anthropic" && normPath === "/messages/count_tokens";
  const isOpenAiBodyModel = normPath === "/chat/completions" || normPath === "/responses";
  /** 用户配置的免费优先候选（有序） */
  const freeFirstList = !opts?.disableFreeRouting && Array.isArray(rt.config.policy.freeFirst) ? rt.config.policy.freeFirst : [];
  /** 免费模型三态：off 不替换 / first 先免费后付费 / fallback 先付费、付费全挂才用免费 */
  const freeMode = opts?.disableFreeRouting ? "off" : rt.config.policy.freeFirstMode ?? "first";

  // Buffer the body once — required for retries and model detection. Bounded to guard memory.
  let bodyBuf: ArrayBuffer | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return payloadTooLarge(url.pathname);
    try {
      bodyBuf = req.body ? await readBodyCapped(req.body, MAX_BODY_BYTES) : new ArrayBuffer(0);
    } catch (e) {
      if (e instanceof BodyTooLargeError) return payloadTooLarge(url.pathname);
      bodyBuf = null;
    }
  }

  let model: string | null = null;
  /** 原始请求 JSON（用于免费优先时改写 model 字段）；非 JSON 请求体为 null */
  let parsedReqBody: Record<string, unknown> | null = null;
  // /v1/messages 没有路径模型；超过 2MB 也要解析（Claude Code 截图/长上下文常见）。
  // OpenAI 兼容路径的 model 也在 body 内，2MB+ 同样解析。
  if (
    bodyBuf &&
    bodyBuf.byteLength > 0 &&
    (bodyBuf.byteLength < 2_000_000 || isMessages || isCountTokens || isOpenAiBodyModel)
  ) {
    try {
      const j = JSON.parse(new TextDecoder().decode(bodyBuf)) as { model?: unknown };
      if (typeof j?.model === "string") model = stripContextSuffix(j.model);
      // 仅在需要改写模型（免费优先）时保留解析结果，避免大请求体常驻堆内存
      if (freeFirstList.length > 0) parsedReqBody = j as Record<string, unknown>;
    } catch {
      /* non-JSON body (e.g. multipart) — ignore */
    }
  }
  if (!model) {
    const m = url.pathname.match(/\/models\/([^/?:]+)/);
    if (m) model = stripContextSuffix(decodeURIComponent(m[1]));
  }

  const catalog = await loadCatalog();
  let free = isFreeModel(catalog, model);
  let modelInfo = model ? catalog.models[model] : undefined;
  /** 客户端原始请求模型：zen 全挂落付费后，台账仍记录客户端点名模型，served_model 记实际服务模型 */
  const requestedModel = model;

  // Only coding-auto uses the user-configured provider sequence. A missing setting
  // preserves the historic chain; an invalid explicit setting fails closed.
  if (model === "coding-auto" && (isMessages || isCountTokens)) {
    const configuredOrder = codingAutoOrder(rt.config.policy.codingAutoOrder);
    if (!configuredOrder.length) return jsonResponse(503, anthropicError("openselect_route_config", "coding-auto 线路配置无效或为空"));
    let requestBody: Record<string, unknown>;
    try { requestBody = JSON.parse(new TextDecoder().decode(bodyBuf!)) as Record<string, unknown>; }
    catch { return jsonResponse(400, anthropicError("invalid_request_error", "request body must be JSON")); }
    let requirements: ReturnType<typeof requestRequirements>;
    try { requirements = requestRequirements(requestBody, req.headers.get("x-openselect-context-window")); }
    catch (error) { return jsonResponse(400, anthropicError("invalid_request_error", String(error))); }
    const plan = buildRoutingPlan(rt, requirements, detectClient(req, url.pathname), req.headers.get("x-opencode-session") ?? req.headers.get("x-session-id"), true);
    const order = plan.executionOrder;
    if (!order.length) {
      const details = configuredOrder.map((step) => step + ": " + capabilityRejections(ROUTE_CAPABILITIES[step], requirements).join("、")).join("；");
      const error = "已选 coding-auto 线路均不满足请求能力：" + details + "。实际上下文占用及供应商容量仍须上游验证。";
      logRequest({ ts: started, sessionId: req.headers.get("x-opencode-session") ?? req.headers.get("x-session-id"),
        model: "coding-auto", family, accountId: "", status: 400, attempts: 0, latencyMs: Date.now() - started,
        error, path: url.pathname, client: detectClient(req, url.pathname) });
      return jsonResponse(400, anthropicError("openselect_unsupported_capability", error));
    }
    const run = async (index: number): Promise<Response> => {
      const step = order[index]!;
      const next = index + 1 < order.length ? () => run(index + 1) : undefined;
      if (step === "opencode") {
        const strict = rt.config.policy.codingAutoOrder !== undefined || !!(rt.config.policy.routingMode && rt.config.policy.routingMode !== "manual");
        const available = new Set(plan.rows.find((r) => r.route === "opencode")?.accounts.filter((a) => a.eligible).map((a) => a.id));
        // Explicitly configured routes must not retry a drained account merely
        // because the generic pool has a last-resort selection policy.
        if (strict) {
          if (!available.size) return next ? next() : jsonResponse(503, anthropicError("openselect_provider_unavailable", "OpenCode Go 暂无符合阈值及模型要求的账号"));
        }
        const headers = new Headers(req.headers);
        headers.delete("content-length");
        headers.set("x-openselect-no-deepseek-fallback", "1");
        const child = new Request(req.url, { method: req.method, headers, body: rewriteBodyModel(bodyBuf, "deepseek-v4.1-flash") });
        const response = await handleProxyRequest(rt, child, { disableFreeRouting: strict || requirements.imageSources.length > 0 || requirements.thinking !== "unspecified", originalRequestedModel: "coding-auto",allowedAccountIds:strict?available:undefined });
        if (!next || response.status < 400 || response.status === 400 || response.status === 413) return response;
        try { await response.body?.cancel(); } catch { /* best effort */ }
        return next();
      }
      const aliases = { zai: "zai/glm-5.3-flash", minimax: "minimax/MiniMax-M3.1-Flash", deepseek: "deepseek/deepseek-flash" } as const;
      const route = resolveProviderRoute(aliases[step]);
      if (!route) return jsonResponse(503, anthropicError("openselect_route_config", "coding-auto 线路配置无效"));
      // Keep adjacent Z.ai and MiniMax in one provider chain so failover logging is retained.
      if (step !== "deepseek" && next && order[index + 1] !== "opencode" && order[index + 1] !== "deepseek") {
        const following = resolveProviderRoute(aliases[order[index + 1] as "zai" | "minimax"]);
        if (following) route.candidates.push(...following.candidates);
        const after = index + 2 < order.length ? () => run(index + 2) : undefined;
        return handleProviderRequest({ req, url, bodyBuf, requestedModel: model!, route: { ...route, strict: false }, rt, fallback: after });
      }
      return handleProviderRequest({ req, url, bodyBuf, requestedModel: model!, route: { ...route, strict: false }, rt, fallback: next, allowFallbackOnly: step === "deepseek" });
    };
    const response = await run(0);
    const skipped = configuredOrder.filter((step) => !order.includes(step));
    if (!skipped.length) return response;
    const headers = new Headers(response.headers);
    // Report capability filtering even when another candidate ultimately succeeds.
    headers.set("x-openselect-skipped-routes", encodeURIComponent(JSON.stringify(skipped.map((step) => ({
      route: step, reasons: capabilityRejections(ROUTE_CAPABILITIES[step], requirements),
    })))));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  // 直连供应商与 coding-auto：Anthropic Messages 原生透传。
  // Command Code 同时支持 OpenAI chat/responses；Ollama 由 provider_proxy 做 Anthropic→chat 翻译。
  const providerRoute = resolveProviderRoute(model);
  if (providerRoute) {
    const providerOpenAi = providerRoute.candidates.some(
      (c) => c.provider === "commandcode" || c.provider === "ollama",
    );
    if (!isMessages && !isCountTokens && !providerOpenAi) {
      return jsonResponse(
        400,
        anthropicError(
          "invalid_request_error",
          `模型 ${model} 目前仅支持 Anthropic /v1/messages；请改用 Z.ai / MiniMax / DeepSeek 或 Command Code 的 OpenAI 兼容端点。`,
        ),
      );
    }
    return handleProviderRequest({
      req,
      url,
      bodyBuf,
      requestedModel: model!,
      route: providerRoute,
      rt,
      fallback:
        providerRoute.strict
          ? undefined
          : async () => {
              const fallbackModel = "deepseek-v4.1-flash";
              const headers = new Headers(req.headers);
              headers.delete("content-length");
              // 由 coding-auto 自己负责 DeepSeek 官方最后一层，避免 generic 路径抢先落 DeepSeek 丢日志
              headers.set("x-openselect-no-deepseek-fallback", "1");
              const newReq = new Request(req.url, {
                method: req.method,
                headers,
                body: rewriteBodyModel(bodyBuf, fallbackModel),
              });
              const r = await handleProxyRequest(rt, newReq);
              // DeepSeek 官方只做最后一层：opencode 也不可用时才使用。
              // 403/404/401/429/5xx（包括 opencode.ai 的 Cloudflare 1010）都继续兜底；
              // 只有明确的客户端请求错误 400/413 不重试。
              if (r.status < 400 || r.status === 400 || r.status === 413) return r;
              try {
                await r.body?.cancel();
              } catch {
                /* ignore */
              }
              const dsRoute = resolveProviderRoute("deepseek/deepseek-flash");
              if (!dsRoute) return r;
              return handleProviderRequest({
                req,
                url,
                bodyBuf,
                requestedModel: "coding-auto",
                route: dsRoute,
                rt,
                allowFallbackOnly: true,
              });
            },
    });
  }

  // zen 免费层直通：opencode zen 免费模型走本地 opencode server /generate
  // （与账号池、免费优先、切换阈值完全独立；不占账号额度）
  // 客户端点名 zen 模型：先走候选链；全部失败时——免费替换开启则无缝落付费模型（不把 Claude Code 卡死），
  // 免费替换关闭（off）则返回 503（带各模型恢复时间）。
  let zenFellBack = false;
  if (model && isZenModelId(model) && rt.config.zen?.enabled !== false) {
    const zenModel = model;
    // 只有 chat/messages 端点能无缝落 chat 付费模型；/responses 没有对应翻译，
    // 硬塞 chat 模型会被上游拒绝，故保持 503（带恢复时间）更诚实。
    const canPaidFallback = freeMode !== "off" && (normPath === "/chat/completions" || isMessages);
    const r = await tryZenChain(req, model, bodyBuf, rt, {
      origModel: model,
      fallThrough: canPaidFallback,
    });
    if (r) return r;

    const fallbackModel = (rt.config.zen?.fallbackModel ?? "").trim() || "deepseek-v4.1-flash";
    const fallbackInfo = catalog.models[fallbackModel];
    if (!fallbackInfo) {
      return jsonResponse(503, {
        error: {
          type: "openselect_zen_fallback_missing",
          message: `zen 免费模型全部不可用，且兜底付费模型 ${fallbackModel} 不在目录中`,
        },
      });
    }
    if (fallbackInfo.family !== "openai" || (fallbackInfo.api ?? "chat") !== "chat") {
      return jsonResponse(503, {
        error: {
          type: "openselect_zen_fallback_incompatible",
          message: `zen 免费模型全部不可用，且兜底模型 ${fallbackModel} 不是 openai/chat 协议（无法承接 /chat/completions 或 /messages）`,
        },
      });
    }
    console.warn(`[zen] ${zenModel} 全部不可用 → 无缝落到付费模型 ${fallbackModel}`);
    model = fallbackModel;
    free = isFreeModel(catalog, model);
    modelInfo = fallbackInfo;
    bodyBuf = rewriteBodyModel(bodyBuf, fallbackModel);
    zenFellBack = true;
  }

  // 协议翻译：Anthropic 客户端 → openai/chat 系模型（请求侧一次性完成，重试间复用同一份）
  let upstreamFamily: Family = family;
  let upstreamPath = normPath;
  let upstreamBody: ArrayBuffer | Uint8Array | null = bodyBuf;
  let xlate: { model: string; stream: boolean; inputTokens: number } | null = null;
  /** 翻译后的 chat 请求体（用于免费优先时改写 model 字段） */
  let xlateBodyObj: Record<string, unknown> | null = null;

  if (isCountTokens && modelInfo && modelInfo.family !== "anthropic") {
    // Anthropic 客户端 token 计数：非 anthropic 模型本地近似（不触发推理与上游请求）
    let parsed: unknown = {};
    if (bodyBuf && bodyBuf.byteLength > 0) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(bodyBuf));
      } catch {
        return jsonResponse(400, anthropicError("invalid_request_error", "request body must be JSON"));
      }
    }
    return jsonResponse(200, countTokensResponse(parsed));
  }

  if (isMessages && modelInfo) {
    if (modelInfo.family === "openai") {
      if (modelInfo.api === "responses") {
        return jsonResponse(
          400,
          anthropicError(
            "invalid_request_error",
            `模型 ${model} 使用 OpenAI Responses API；/v1/messages 翻译层仅支持 openai/chat 系模型。请改用 OpenAI 客户端，或选择 chat 系模型。`,
          ),
        );
      }
      if (!bodyBuf || bodyBuf.byteLength === 0) {
        return jsonResponse(400, anthropicError("invalid_request_error", "request body is required"));
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bodyBuf)) as Record<string, unknown>;
      } catch {
        return jsonResponse(400, anthropicError("invalid_request_error", "request body must be JSON"));
      }
      const tr = translateAnthropicRequest(parsed, model!);
      // OpenCode Go supports OpenAI usage in the final streaming chunk.
      if (tr.stream && model === "deepseek-v4.1-flash") tr.body.stream_options = { include_usage: true };
      const bytes = new TextEncoder().encode(JSON.stringify(tr.body));
      upstreamFamily = "openai";
      upstreamPath = "/chat/completions";
      upstreamBody = bytes;
      xlateBodyObj = freeFirstList.length > 0 ? (tr.body as Record<string, unknown>) : null;
      xlate = { model: model!, stream: tr.stream, inputTokens: tr.approxInputTokens };
    } else if (modelInfo.family === "google") {
      return jsonResponse(
        400,
        anthropicError(
          "invalid_request_error",
          `模型 ${model} 属于 Google 协议；/v1/messages 翻译层暂不支持。请改用 Google 客户端。`,
        ),
      );
    }
  }

  // 上下文预检：Claude Code 的 token 估算和上游 DeepSeek tokenizer 有偏差，
  // 接近 1M 时提前返回标准 Anthropic 「prompt is too long」，让客户端 compact，
  // 而不是把 1.05M 的请求发到上游换一个 400。
  if (xlate && xlate.inputTokens > SAFE_CONTEXT_TOKENS) {
    return jsonResponse(
      400,
      anthropicError(
        "invalid_request_error",
        `prompt is too long: ~${xlate.inputTokens} tokens > 1048576 maximum; run /compact or reduce context`,
      ),
    );
  }

  // 接入（客户端）识别：决定流量归属统计，以及「按接入指定账号」的查表键
  const clientKind = detectClient(req, url.pathname);

  const sessionId =
    req.headers.get("x-opencode-session") ??
    req.headers.get("x-session-id") ??
    req.headers.get("x-session-affinity") ??
    synthesizeSession(req); // 外部客户端（Claude Code / OpenAI SDK）无会话头：按凭据合成稳定会话

  // 免费模型中转：模式决定"什么时候"用免费模型
  //   off      —— 完全不替换（质量完全由客户端请求的模型决定）
  //   first    —— 先用免费模型承接，再回落付费模型（省额度）
  //   fallback —— 平时用付费模型；只有付费模型所有账号都不可用时才用免费模型接着
  // 约束：仅 openai/chat 家族可替换（anthropic/google/responses 协议不匹配）；请求模型本身已免费则不替换。
  const canRewriteModel = xlate ? xlateBodyObj !== null : parsedReqBody !== null;
  const freeCandidates: string[] =
    model &&
    freeMode !== "off" &&
    freeFirstList.length > 0 &&
    !free &&
    canRewriteModel &&
    upstreamFamily === "openai" &&
    (upstreamPath === "/chat/completions" || isMessages)
      ? freeFirstList.filter((id) => id !== model && (isFreeFirstEligible(catalog, id) || isZenModelId(id)))
      : [];
  /** zen 免费候选（走本地 opencode server，不进账号池） */
  const zenCands = freeCandidates.filter((id) => isZenModelId(id));
  /** go 账号池免费候选 */
  const goFreeCands = freeCandidates.filter((id) => !isZenModelId(id));

  /**
   * 负缓存作用域 = 上游端点类型。同一模型在不同端点上的可用性独立
   * （免费模型只在 chat 端点服务，在 responses 端点会 404），不区分会互相误伤。
   */
  const denyScope = (): string => {
    if (upstreamPath === "/chat/completions") return "chat";
    if (upstreamPath === "/responses") return "responses";
    return upstreamFamily;
  };

  const maxAttempts = Math.max(1, rt.config.policy.maxAttempts);
  const tried = new Set<string>();
  const attempted: string[] = [];
  const priorSessionAccount = rt.getSessionAccount(sessionId);
  let lastErrorResponse: Response | null = null;
  let lastErrorText = "";
  /** last retryable failure not yet linked to a replacement account (failover row written with destination) */
  let pendingFailover: { from: string; reason: string; detail: string | null } | null = null;
  /** 本次请求内每个模型连续 404（端点不可用）的次数，用于封顶扫描 */
  const model404Scan = new Map<string, number>();
  /** 当前免费候选已试过的账号（换号重试，避免同一账号上反复失败） */
  let freeTriedAccounts = new Set<string>();


  // 模型尝试队列：
  //   first    → [免费候选..., 客户端请求的模型]（先免费后付费）
  //   fallback → [客户端请求的模型, 免费候选...]（先付费，付费全不可用才用免费）
  const modelQueue: string[] =
    goFreeCands.length === 0
      ? [model!]
      : freeMode === "fallback"
        ? [model!, ...goFreeCands]
        : [...goFreeCands, model!];
  let queueIdx = 0;
  let attemptModel = modelQueue[0]!;
  /** 免费候选模型级失败后：复用同一账号换下一个候选（不重新选号） */
  let reuseAccountId: string | null = null;

  /**
   * 构造指定模型的上游请求体。
   * 返回 undefined = 无法改写模型（请求体不是 JSON）；返回 null = 该请求本来就没有请求体（GET 等）。
   */
  const bodyForModel = (m: string): ArrayBuffer | Uint8Array | null | undefined => {
    if (m === model) return upstreamBody;
    const base = xlate ? xlateBodyObj : parsedReqBody;
    if (!base) return undefined;
    return new TextEncoder().encode(JSON.stringify({ ...base, model: m }));
  };

  /**
   * 推进到下一个模型候选。
   * - 下一个仍是免费候选 → 复用同一账号（换模型不换号）
   * - 推进到原付费模型 → 释放该账号（免费尝试不占用付费选号名额）并清空复用，
   *   让 pickAccount 按付费资格（冷却/阈值）重新选号
   */
  const advanceModel = (accountId: string): void => {
    queueIdx = Math.min(queueIdx + 1, modelQueue.length - 1);
    attemptModel = modelQueue[queueIdx]!;
    if (attemptModel === model) {
      tried.delete(accountId);
      reuseAccountId = null;
    } else {
      reuseAccountId = accountId;
    }
  };

  /**
   * 跳到队列里下一个免费候选（兜底模式用：付费模型所有账号都不可用时，用免费模型接着）。
   * 返回 false 表示没有下一个免费候选。
   */
  const advanceToFreeCandidate = (): boolean => {
    for (let i = queueIdx + 1; i < modelQueue.length; i++) {
      if (modelQueue[i] !== model) {
        queueIdx = i;
        attemptModel = modelQueue[i]!;
        // 兜底模式：免费候选**重新选号**（不锁死在同一账号），该候选的账号排除集重置
        reuseAccountId = null;
        freeTriedAccounts = new Set();
        // 免费模型不占配额 → 选号时忽略冷却/阈值，因此可以复用刚刚被排除的账号
        tried.clear();
        return true;
      }
    }
    return false;
  };

  /**
   * 免费候选在某个账号上失败后的处理。
   * - 兜底模式（fallback）：**只换账号、不换候选** —— 该账号记入排除集后，用同一候选在别的账号上重试；
   *   候选的账号都用尽时，由 pickAccount 返回 null 触发 advanceToFreeCandidate 换下一个候选。
   * - 优先模式（first）：沿用既有语义「换下一个候选（同账号继续）」。
   */
  const onFreeCandidateFailed = (accountId: string): void => {
    if (freeMode === "fallback") {
      freeTriedAccounts.add(accountId);
      return;
    }
    advanceModel(accountId);
  };

  // 优先模式：先用 zen 免费链（不占账号额度），全部失败再进账号池（go 免费 → 付费）
  // zen 刚全挂并已落付费时跳过，避免第二个请求又从头撞一遍 zen
  if (freeMode === "first" && !zenFellBack && zenCands.length > 0 && (normPath === "/chat/completions" || isMessages)) {
    const r = await tryZenChain(req, null, bodyBuf, rt, { origModel: model, fallThrough: true });
    if (r) return r;
  }

  let upstreamAttempts = 0;
  // 迭代上限：兜底模式下每个失败的免费账号最多消耗 2 次迭代（失败 → 负缓存 → 换号重试），
  // 因此池子项要按 2 倍预留，否则账号多时免费候选只能触达池子前半段（AC-CDX P1-A）
  const poolSize = Math.max(4, rt.config.accounts.length);
  // 每个免费候选最多消耗 2*poolSize 次迭代（一次真实尝试 + 一次负缓存跳过），
  // 候选数越多预算越大（否则第 3 个候选会被饿死，AC-CDX P2-2）
  const iterCap = maxAttempts + goFreeCands.length * (2 * poolSize + 2) + 2;
  for (let iter = 0; iter < iterCap; iter++) {
    /** 本次尝试是否由免费模型承接（与客户端请求的模型不同） */
    const isFreeAttempt = attemptModel !== model;
    // 付费尝试预算用尽：兜底模式继续用免费候选接着；其它模式结束
    if (upstreamAttempts >= maxAttempts && !isFreeAttempt) {
      if (!(freeMode === "fallback" && advanceToFreeCandidate())) break;
      continue;
    }
    let decision: PolicyDecision | null = null;
    if (reuseAccountId) {
      const acc = rt.account(reuseAccountId);
      reuseAccountId = null;
      if (acc) decision = { accountId: acc.id, reason: "fallback", pressure: 0 };
    }
    if (!decision) {
      decision = pickAccount({
        // 通用 opencode-go 路径只允许 opencode-go 账号；Z.ai/MiniMax 走 provider 分支。
        accounts: rt.config.accounts.filter((a) => a.integration === "opencode-go" && (!opts?.allowedAccountIds || opts.allowedAccountIds.has(a.id))),
        states: rt.states,
        usages: rt.usages,
        sessionAccount: upstreamAttempts === 0 ? priorSessionAccount : null,
        forcedAccountId: rt.forcedAccountId,
        // 按接入指定的账号（面板「接入 → 指定账号」）：比全局指定更具体
        clientAccountId: rt.config.policy.clientAccounts?.[clientKind] ?? null,
        // 免费模型不占配额 → 选号时忽略额度/阈值/冷却限制
        free: isFreeModel(catalog, attemptModel),
        // 免费候选：排除本候选已试过的账号（额度用尽的账号不直接排除：
        // 上游 429 常是**模型级**的，免费模型在同一账号上往往仍可用；真被拒时会记入
        // freeTriedAccounts 自动换下一个账号）
        exclude: isFreeAttempt ? new Set([...tried, ...freeTriedAccounts]) : tried,
        now: Date.now(),
        switchAt: rt.config.policy.switchAt,
      });
    }
    if (!decision) {
      // 当前模型没有可用账号：兜底模式改用免费模型接着（质量兜底，不中断会话）
      if (freeMode === "fallback" && advanceToFreeCandidate()) continue;
      break;
    }
    tried.add(decision.accountId);

    // 模型级 404 扫描封顶：同一模型已连续 N 个账号「端点不可用」→ 判定模型级不可用，
    // 停止再试（否则会把整个池扫一遍，只放大上游调用）
    if (attemptModel && (model404Scan.get(attemptModel) ?? 0) >= MODEL_404_MAX_SCAN) break;

    // Known model-scoped denial (e.g. workspace privacy 403): skip the combo without burning an attempt.
    // 查的是「本次尝试的模型」：免费候选的负缓存 (账号×免费模型) 必须能被读到。
    const knownDeny = model ? rt.modelDenied(decision.accountId, attemptModel, denyScope()) : null;
    if (knownDeny) {
      if (isFreeAttempt) {
        if (freeMode === "fallback") {
          // 兜底模式：该账号对该免费模型不可用 → 换账号重试（同一候选，不换候选）
          freeTriedAccounts.add(decision.accountId);
          continue;
        }
        // 该账号上此免费候选已知不可用 → 兜底模式换账号重试；优先模式换下一个候选
        onFreeCandidateFailed(decision.accountId);
        continue;
      }
      lastErrorText = `HTTP ${knownDeny.status} (${model} denied)`;
      if (!lastErrorResponse) {
        lastErrorResponse = new Response(
          xlate ? JSON.stringify(translateOpenAiError(knownDeny.status, knownDeny.body)) : knownDeny.body,
          {
            status: knownDeny.status,
            headers: withJsonContentType(new Headers()),
          },
        );
      }
      continue;
    }

    const account = rt.account(decision.accountId);
    if (!account) continue;

    const attemptBody = bodyForModel(attemptModel);
    if (attemptBody === undefined) {
      // 请求体不是 JSON → 无法改写模型：放弃免费候选，直接用客户端请求的模型
      if (attemptModel === model) break;
      advanceModel(account.id);
      continue;
    }

    if (pendingFailover) {
      // log the failover only once we actually attempt the replacement, so rows carry from → to
      rt.logSwitch(pendingFailover.from, account.id, pendingFailover.reason, pendingFailover.detail, sessionId);
      pendingFailover = null;
    }

    if (!isFreeAttempt) upstreamAttempts++; // 免费尝试不消耗付费重试预算
    attempted.push(decision.accountId);
    const attemptStarted = Date.now();

    if (attempted.length === 1 && priorSessionAccount && priorSessionAccount !== decision.accountId) {
      rt.logSwitch(
        priorSessionAccount,
        decision.accountId,
        `policy:${decision.reason}`,
        `pressure=${(decision.pressure * 100).toFixed(1)}%`,
        sessionId,
      );
    }

    // 版本前缀规范化：/v1/messages、/v1/chat/completions 等标准路径与 SDK 相对路径行为一致
    const upstreamUrl =
      rt.config.upstream.base + FAMILY_PREFIX[upstreamFamily] + upstreamPath + (xlate ? "" : url.search);
    const headers = new Headers();
    for (const [k, v] of req.headers.entries()) {
      const lk = k.toLowerCase();
      if (REQ_STRIP.has(lk)) continue;
      if (lk === "x-openselect-context-window") continue;
      if (xlate && lk.startsWith("anthropic-")) continue; // 翻译模式：Anthropic 专属头不上行
      headers.set(k, v);
    }
    // 上游网关必需 x-opencode-session（缺失会 400 MissingSessionID）：客户端未显式提供时补齐合成会话
    if (!headers.has("x-opencode-session")) headers.set("x-opencode-session", sessionId);
    // opencode.ai 的 Cloudflare 会对空 UA / Python-urllib 等签名返回 1010 browser_signature_banned。
    // 客户端 UA 对上游没有语义价值，统一覆盖为稳定的非浏览器 UA，避免把 WAF 403 误判成 Key 失效。
    headers.set("user-agent", "opencode/1.0.0");
    if (xlate) headers.set("accept", xlate.stream ? "text/event-stream" : "application/json");
    const authHeader = FAMILY_AUTH_HEADER[upstreamFamily];
    if (authHeader === "authorization") headers.set(authHeader, `Bearer ${account.key}`);
    else headers.set(authHeader, account.key);

    let res: Response;
    try {
      res = await tracedFetch(upstreamUrl, {
        method: req.method,
        headers,
        body: attemptBody ?? undefined,
        redirect: "manual",
        // Bun fetch 默认 socket 空闲超时 5 分钟（BUN_CONFIG_HTTP_IDLE_TIMEOUT）；
        // 长思考流可能长时间无字节，放宽到 10 分钟。非整请求期限。
        // 免费候选用更短超时：避免「免费模型连上不吐字节」吃掉客户端全部时间预算，
        // 导致付费回落永远送不到（代理自身无字节静默上限约 255s）。
        timeout: isFreeAttempt ? 30_000 : 600_000,
      }, { provider: account.integration, model: attemptModel, accountId: account.id });
    } catch (e) {
      if (isFreeAttempt) {
        // 免费模型网络错误：视为模型级失败（不冷却账号，避免污染付费流量）
        rt.denyModel(account.id, attemptModel, 0, String(e), FREE_MODEL_DENY_TTL_MS, denyScope());
        lastErrorText = `free-model ${attemptModel}: network ${truncate(String(e), 160)}`;
        lastErrorResponse = null;
        onFreeCandidateFailed(account.id);
        continue;
      }
      rt.setCooldown(
        account.id,
        Date.now() + rt.config.policy.cooldownFallbackSec * 1000,
        `network: ${truncate(String(e), 200)}`,
      );
      pendingFailover = { from: account.id, reason: "network-error", detail: truncate(String(e), 200) };
      lastErrorText = `network: ${truncate(String(e), 200)}`;
      lastErrorResponse = null;
      continue;
    }

    if (isFreeAttempt && res.status >= 400 && res.status !== 401) {
      // 免费模型不可用（任意错误状态，401 除外——401 是 key 失效，属账号级）：
      // 记 (账号×免费模型) 负缓存 15 分钟；**不冷却账号**（免费模型的故障不应影响付费流量），
      // 换下一个免费候选；全部候选失败则回落到原付费模型。
      const text = await res.text().catch(() => "");
      rt.denyModel(account.id, attemptModel, res.status, text, FREE_MODEL_DENY_TTL_MS, denyScope());
      lastErrorText = `free-model ${attemptModel}: HTTP ${res.status}`;
      lastErrorResponse = null;
      onFreeCandidateFailed(account.id);
      continue;
    }

    if (res.status === 404 && attemptModel && catalog.models[attemptModel]) {
      // 上游 404「Endpoint/Model is unavailable」：模型在本代理目录里存在，但该账号的端点不可用
      // → 账号×模型 级负缓存 + 换号重试（不冷却账号、不作废 Key）。
      // 判据收紧：只有响应体表明是"端点/模型不可用"才走账号级故障转移；
      // 其余 404（如上游根本没有这个模型）原样透传给客户端。
      const text404 = await res.text().catch(() => "");
      if (isEndpointUnavailable(text404)) {
        const seen = (model404Scan.get(attemptModel) ?? 0) + 1;
        model404Scan.set(attemptModel, seen);
        rt.denyModel(account.id, attemptModel, 404, text404, MODEL_404_DENY_TTL_MS, denyScope());
        if (isFreeAttempt) {
          onFreeCandidateFailed(account.id);
          continue;
        }
        pendingFailover = { from: account.id, reason: "404", detail: `model-unavailable: ${attemptModel}` };
        lastErrorText = `HTTP 404 (${attemptModel})`;
        lastErrorResponse = new Response(
          xlate ? JSON.stringify(translateOpenAiError(404, text404)) : text404,
          {
            status: 404,
            statusText: res.statusText,
            headers: xlate
              ? withJsonContentType(sanitizeResponseHeaders(res.headers))
              : sanitizeResponseHeaders(res.headers),
          },
        );
        continue; // 换下一个账号（正常消耗一次尝试预算，保持"最多 N 次上游调用"契约）
      }
      // 其余 404：原样透传。body 已被本分支读过，不能再读一次（否则客户端收到空 body）
      logRequest({
        ts: started,
        sessionId,
        model: opts?.originalRequestedModel ?? requestedModel,
        servedModel: isFreeAttempt || zenFellBack || opts?.originalRequestedModel ? attemptModel : null,
        family,
        accountId: account.id,
        provider: account.integration,
        status: 404,
        attempts: attempted.length,
        latencyMs: Date.now() - started,
        error: truncate(text404, 300) || "upstream 404",
        path: url.pathname,
        client: clientKind,
      });
      if (xlate) return jsonResponse(404, translateOpenAiError(404, text404));
      return new Response(text404, {
        status: 404,
        statusText: res.statusText,
        headers: sanitizeResponseHeaders(res.headers),
      });
    }

    if (isRetryable(res.status)) {
      const text = await res.text().catch(() => "");
      if (isFreeAttempt) {
        if (res.status === 401) {
          // 401 = 凭据失效（账号级）→ 移出账号池（与付费路径语义一致；不按模型级处理）
          rt.setInvalid(account.id, `HTTP 401`);
          pendingFailover = { from: account.id, reason: "invalid:401", detail: "key rejected by upstream" };
          lastErrorText = `free-model ${attemptModel}: HTTP 401 (key invalid)`;
          lastErrorResponse = null;
          onFreeCandidateFailed(account.id);
          continue;
        }
        // 免费候选在这个账号上失败 → 换账号重试同一候选（兜底模式）；负缓存同时记录
        rt.denyModel(account.id, attemptModel, res.status, text, FREE_MODEL_DENY_TTL_MS, denyScope());
        onFreeCandidateFailed(account.id);
        lastErrorText = `free-model ${attemptModel}: HTTP ${res.status}`;
        lastErrorResponse = null;
        continue;
      }
      let limitName = "";
      try {
        const parsed = JSON.parse(text) as {
          metadata?: { limitName?: string };
          error?: { metadata?: { limitName?: string } };
        };
        limitName = parsed?.metadata?.limitName ?? parsed?.error?.metadata?.limitName ?? "";
      } catch {
        /* not json */
      }
      const retrySec = parseRetryAfter(res.headers.get("retry-after"));

      if (res.status === 401) {
        // auth-level failure: key is dead → take the account out until a poll re-validates it
        rt.setInvalid(account.id, `HTTP ${res.status}`);
        pendingFailover = { from: account.id, reason: `invalid:${res.status}`, detail: "key rejected by upstream" };
      } else if (res.status === 403) {
        // model/workspace-scoped denial (e.g. privacy settings / train-on-data): do NOT poison the
        // account. Remember the (account, model) combo so we stop retrying it, keep failover intact.
        if (model) rt.denyModel(account.id, model, res.status, text, 15 * 60 * 1000, denyScope());
        pendingFailover = { from: account.id, reason: "403", detail: model ? `model-denied: ${model}` : "forbidden" };
      } else if (res.status === 429) {
        // 有 limitName / retry-after 的 429 是额度或明确的恢复时间 → 账号级冷却。
        // 两者都没有的裸 429 多为瞬时并发/RPM 限流：只做 3s 短冷却，不写 60s 模型负缓存。
        const quotaLimited = Boolean(limitName) || retrySec != null;
        if (quotaLimited) {
          const cdMs = (retrySec ?? rt.config.policy.cooldownFallbackSec) * 1000;
          rt.setCooldown(account.id, Date.now() + cdMs, `HTTP 429${limitName ? ` (${limitName})` : ""}`);
        } else {
          // 裸 429 通常只是瞬时并发/RPM：短冷却让在途请求先结束，绝不写 60s 模型负缓存。
          // 之前写 60s (账号×模型) 负缓存会在并发 burst 时把整池封死，客户端收到大量本地 429。
          rt.setCooldown(account.id, Date.now() + BARE_429_COOLDOWN_MS, "HTTP 429 (transient)");
        }
        // 额度用尽：免费候选在该账号上很可能也被拒 → 记下来，免费候选换号重试
        if (isFreeAttempt) freeTriedAccounts.add(account.id);
        pendingFailover = {
          from: account.id,
          reason: `429${limitName ? `:${limitName}` : ""}`,
          detail: quotaLimited ? `retry-after=${retrySec ?? "-"}s` : `account-cooldown=${BARE_429_COOLDOWN_MS / 1000}s`,
        };
      } else {
        rt.setCooldown(
          account.id,
          Date.now() + Math.min(60, rt.config.policy.cooldownFallbackSec) * 1000,
          `HTTP ${res.status}`,
        );
        // 5xx / 408 / 425: previously missing from the switch log — now logged via pendingFailover
        pendingFailover = { from: account.id, reason: `HTTP ${res.status}`, detail: truncate(text, 200) || null };
      }

      lastErrorText = `HTTP ${res.status}${limitName ? ` ${limitName}` : ""}`;
      lastErrorResponse = new Response(
        xlate ? JSON.stringify(translateOpenAiError(res.status, text)) : text,
        {
          status: res.status,
          statusText: res.statusText,
          headers: xlate
            ? withJsonContentType(sanitizeResponseHeaders(res.headers))
            : sanitizeResponseHeaders(res.headers),
        },
      );
      continue;
    }

    if (res.status >= 400) {
      // non-retryable client error: pass through unchanged
      const text = await res.text().catch(() => "");
      const overflow = contextOverflowMessage(text);
      logRequest({
        ts: started,
        sessionId,
        model: opts?.originalRequestedModel ?? requestedModel,
        family,
        accountId: account.id,
        provider: account.integration,
        status: res.status,
        attempts: attempted.length,
        latencyMs: Date.now() - started,
        error: truncate(overflow ?? text, 300),
        path: url.pathname,
        client: clientKind,
      });
      if (overflow) {
        return jsonResponse(
          400,
          xlate
            ? anthropicError("invalid_request_error", overflow)
            : { error: { type: "invalid_request_error", message: overflow, param: null, code: "invalid_request_error" } },
        );
      }
      if (xlate) return jsonResponse(res.status, translateOpenAiError(res.status, text));
      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: sanitizeResponseHeaders(res.headers),
      });
    }

    // 由免费模型承接时，响应中的 model 字段按实际服务模型呈现（透明，不隐瞒）
    if (xlate) xlate.model = attemptModel;

    // 翻译模式非流：整体读取上游 JSON 并翻译为 Anthropic message
    if (xlate && !xlate.stream) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        logRequest({
          ts: started,
          sessionId,
          model: opts?.originalRequestedModel ?? requestedModel,
          family,
          accountId: account.id,
          provider: account.integration,
          status: 502,
          attempts: attempted.length,
          latencyMs: Date.now() - started,
          error: truncate(text, 300) || "upstream returned invalid JSON",
          path: url.pathname,
          client: clientKind,
        });
        return jsonResponse(502, anthropicError("api_error", "upstream returned invalid JSON"));
      }
      const body = translateChatCompletion(parsed, xlate.model);
      const usage = parseTokenUsage(parsed);
      rt.touch(account.id);
      rt.bindSession(sessionId, account.id);
      rt.preferredAccountId = account.id;
      const completedLogId = logRequest({
        ts: started,
        sessionId,
        model: opts?.originalRequestedModel ?? requestedModel,
        servedModel: isFreeAttempt || zenFellBack || opts?.originalRequestedModel ? attemptModel : null,
        family,
        accountId: account.id,
        provider: account.integration,
        status: res.status,
        attempts: attempted.length,
        latencyMs: Date.now() - started,
        error: null,
        path: url.pathname,
        client: clientKind,
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
      return jsonResponse(res.status, body);
    }

    // success: peek the first chunk so a stream that dies before its first byte still fails over
    let payload: Response;
    let logId: number | null = null;
    if (res.body) {
      const reader = res.body.getReader();
      let first: { done: boolean; value?: Uint8Array } | null = null;
      try {
        first = await reader.read();
      } catch (e) {
        if (isFreeAttempt) {
          // 免费候选 2xx 后首字节前断流：同样按模型级失败处理（不冷却账号、不换号轮换）
          rt.denyModel(account.id, attemptModel, 0, String(e), FREE_MODEL_DENY_TTL_MS, denyScope());
          lastErrorText = `free-model ${attemptModel}: stream ${truncate(String(e), 160)}`;
          lastErrorResponse = null;
          onFreeCandidateFailed(account.id);
          continue;
        }
        rt.setCooldown(
          account.id,
          Date.now() + rt.config.policy.cooldownFallbackSec * 1000,
          `stream: ${truncate(String(e), 200)}`,
        );
        pendingFailover = {
          from: account.id,
          reason: "network-error",
          detail: `stream before first byte: ${truncate(String(e), 160)}`,
        };
        lastErrorText = `network: ${truncate(String(e), 200)}`;
        lastErrorResponse = null;
        continue;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!first || first.done || !first.value) controller.close();
          else controller.enqueue(first.value);
        },
        async pull(controller) {
          try {
            const r = await reader.read();
            if (r.done) controller.close();
            else if (r.value) controller.enqueue(r.value);
          } catch (e) {
            controller.error(e);
          }
        },
        cancel(reason) {
          void reader.cancel(reason).catch(() => {});
        },
      });
      let upstreamUsageObserved = false;
      const upstreamStream = xlate ? tapUsageStream(stream, (u) => {
        if (u.inputKnown && u.outputKnown) {
          upstreamUsageObserved = true;
          if (logId != null) updateRequestTokens(logId, u);
        }
      }) : stream;
      const finalStream = xlate
        ? chatSseToAnthropicStream(upstreamStream, { model: xlate.model, inputTokens: xlate.inputTokens })
        : stream;
      // 翻译路径优先保存上游 usage；仅上游未完整上报时记录翻译器的本地估算。
      const tappedStream = tapUsageStream(
        finalStream,
        (u) => {
          if (logId != null && (!xlate || !upstreamUsageObserved)) updateRequestTokens(logId, u);
        },
        Boolean(xlate),
        () => { if (logId != null) updateRequestDuration(logId, Date.now() - started); },
        (first, last) => { if (logId != null) updateRequestContentTiming(logId, started, first, last, attempted.length > 1 ? attemptStarted - started : 0); },
      );
      const respHeaders = sanitizeResponseHeaders(res.headers);
      if (xlate) respHeaders.set("content-type", "text/event-stream; charset=utf-8");
      payload = new Response(tappedStream, {
        status: res.status,
        statusText: res.statusText,
        headers: respHeaders,
      });
    } else {
      payload = new Response(null, {
        status: res.status,
        statusText: res.statusText,
        headers: sanitizeResponseHeaders(res.headers),
      });
    }

    rt.touch(account.id);
    rt.bindSession(sessionId, account.id);
    rt.preferredAccountId = account.id;
    logId = logRequest({
      ts: started,
      sessionId,
      model: opts?.originalRequestedModel ?? requestedModel,
      servedModel: isFreeAttempt || zenFellBack || opts?.originalRequestedModel ? attemptModel : null,
      family,
      accountId: account.id,
      provider: account.integration,
      status: res.status,
      attempts: attempted.length,
      latencyMs: Date.now() - started,
      error: null,
      path: url.pathname,
      client: clientKind,
    });
    return payload;
  }

  if (pendingFailover) {
    // no replacement was attempted (or attempts exhausted): keep the row with an open destination
    rt.logSwitch(pendingFailover.from, null, pendingFailover.reason, pendingFailover.detail, sessionId);
    pendingFailover = null;
  }

  const accountLabel = attempted.length > 0 ? attempted.join(" → ") : "-";
  logRequest({
    ts: started,
    sessionId,
    model: opts?.originalRequestedModel ?? requestedModel,
    family,
    accountId: accountLabel,
    status: lastErrorResponse?.status ?? 503,
    attempts: attempted.length,
    latencyMs: Date.now() - started,
    error: lastErrorText || "no-eligible-account",
    path: url.pathname,
    client: clientKind,
  });

  // 兜底模式：付费 + go 免费全部不可用 → 最后用 zen 免费链接着（不让会话中断）
  // zen 刚全挂并已落付费时不再重试
  if (freeMode === "fallback" && !zenFellBack && zenCands.length > 0 && (normPath === "/chat/completions" || isMessages)) {
    const r = await tryZenChain(req, null, bodyBuf, rt, { origModel: model, fallThrough: true });
    if (r) return r;
  }

  // 最后一层：opencode-go + 免费链都不可用时，才用 DeepSeek 官方（fallbackOnly 账号）。
  if (
    isMessages &&
    requestedModel &&
    req.headers.get("x-openselect-no-deepseek-fallback") !== "1" &&
    (!lastErrorResponse || (lastErrorResponse.status !== 400 && lastErrorResponse.status !== 413))
  ) {
    const dsRoute = deepSeekFallbackRoute(requestedModel);
    if (dsRoute) {
      return handleProviderRequest({
        req,
        url,
        bodyBuf,
        requestedModel,
        route: dsRoute,
        rt,
        allowFallbackOnly: true,
      });
    }
  }
  if (lastErrorResponse) return lastErrorResponse;
  // 文案要反映真实原因：免费候选全部失败 ≠ 池里没有账号（AC-CDX P2-4）
  const noAccountMsg = lastErrorText.startsWith("free-model ")
    ? `免费候选全部失败（${lastErrorText}）`
    : "no eligible account in pool";
  if (xlate) return jsonResponse(503, anthropicError("api_error", noAccountMsg));
  return jsonResponse(503, {
    error: {
      type: "openselect_no_account",
      message: noAccountMsg,
    },
  });
}
