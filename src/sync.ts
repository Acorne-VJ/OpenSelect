/** 模型目录同步：以账号实际 /v1/models 为准，增删 data/models.json 条目。
 *
 * 关键设计：
 * - reconcileCatalog 为纯函数：既有条目（含人工 curation 的名称/价格）原样保留，只增删结构；
 * - 协议探测为零推理：向各协议端点发送"缺必需字段"的请求，命中协议边界先于字段校验——
 *   不匹配协议返回 400 ModelProtocolUnsupported；匹配则返回字段/供应商校验错误（或 2xx）。
 */
import type { Family, ModelInfo } from "./types";

export type ProbeProtocol = "anthropic" | "openai-chat" | "openai-responses" | "google" | "unknown";

export interface ProbeStep {
  probe: string;
  status: number;
  verdict: "accepted" | "unsupported" | "inconclusive" | "error";
}

export interface ProbeResult {
  protocol: ProbeProtocol;
  steps: ProbeStep[];
}

const UNSUPPORTED_MARK = "ModelProtocolUnsupported";
const REGION_MARK = "RegionError";

/** 400/422 响应必须携带明确的错误信封才算协议命中证据——
 *  仅"可解析 JSON"不够：`400 {}` 不含任何字段校验/错误标识，不得判定 accepted。 */
function hasValidationErrorEnvelope(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const j = parsed as Record<string, unknown>;
    const err = j.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const e = err as Record<string, unknown>;
      if (typeof e.message === "string" && e.message.length > 0) return true;
      if (typeof e.type === "string" && e.type.length > 0) return true;
      if (typeof e.status === "string" && e.status.length > 0) return true;
      if ((typeof e.code === "number" && Number.isFinite(e.code)) || (typeof e.code === "string" && e.code.length > 0))
        return true;
    }
    return typeof j.message === "string" && j.message.length > 0;
  } catch {
    return false;
  }
}

const VENDORS: Array<[string, string]> = [
  ["deepseek", "DeepSeek"],
  ["minimax", "MiniMax"],
  ["longcat", "LongCat"],
  ["claude", "Claude"],
  ["qwen", "Qwen"],
  ["kimi", "Kimi"],
  ["grok", "Grok"],
  ["mimo", "MiMo"],
  ["muse", "Muse"],
  ["spark", "Spark"],
  ["step", "Step"],
  ["space", "Space"],
  ["omen", "Omen"],
  ["beam", "Beam"],
  ["glm", "GLM"],
  ["gpt", "GPT"],
];

/** 展示名派生（仅用于新增条目的默认值；人工 curation 优先，不会覆盖既有条目）。 */
export function prettifyModelId(id: string): string {
  const parts = id.split("-");
  const head = parts.shift() ?? "";
  let first = head.charAt(0).toUpperCase() + head.slice(1);
  for (const [pre, label] of VENDORS) {
    if (head.startsWith(pre)) {
      first = label + head.slice(pre.length);
      break;
    }
  }
  const tail = parts.map((p) => (/^[0-9]/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)));
  return [first, ...tail].filter((s) => s.length > 0).join(" ");
}

export function isFreeId(id: string): boolean {
  return id.endsWith("-free");
}

/** 新增条目的默认元数据（cost 无上游来源 → 0 占位，需人工补全）。 */
export function buildModelInfo(id: string, protocol: ProbeProtocol): ModelInfo {
  const family: Family =
    protocol === "anthropic" ? "anthropic" : protocol === "google" ? "google" : "openai";
  const info: ModelInfo = {
    id,
    name: prettifyModelId(id),
    family,
    free: isFreeId(id),
    cost: { input: 0, output: 0, cacheRead: 0 },
  };
  if (protocol === "openai-responses") info.api = "responses";
  return info;
}

export interface ReconcileResult {
  next: Record<string, ModelInfo>;
  added: string[];
  removed: string[];
  kept: number;
}

/** 纯函数：把 liveIds（账号实际并集）折叠进现有目录。既有条目保留（含人工 curation），
 *  顺序不变；新增条目按 liveIds 顺序追加；不在 liveIds 的条目移除。 */
export function reconcileCatalog(
  current: Record<string, ModelInfo>,
  liveIds: string[],
  metaFor: (id: string) => ModelInfo,
): ReconcileResult {
  const live = new Set(liveIds);
  const next: Record<string, ModelInfo> = {};
  const removed: string[] = [];
  const added: string[] = [];
  for (const [id, info] of Object.entries(current)) {
    if (live.has(id)) next[id] = info;
    else removed.push(id);
  }
  const kept = Object.keys(next).length;
  for (const id of liveIds) {
    if (!Object.prototype.hasOwnProperty.call(current, id)) {
      next[id] = metaFor(id);
      added.push(id);
    }
  }
  return { next, added, removed, kept };
}

export interface ProbeOptions {
  base: string;
  key: string;
  modelId: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  session?: string;
}

/** 零推理协议探测：返回模型所属协议（仅明确证据才下结论）。
 *  判定规则（优先级从高到低）：
 *  - 404/405 = 路径异常（优先于一切，记 error）；
 *  - 正文含 ModelProtocolUnsupported = 不匹配本协议（优先于 2xx：2xx 携带错误标记不算命中）；
 *    含 RegionError = 无法判定（继续级联）；
 *  - 2xx = 命中；
 *  - 400/422 且响应为结构化错误信封（error 对象含 message/type/status/code，或顶层 message）= 命中；
 *    空 JSON / 无可识别错误标识 = 无协议证据（inconclusive）；
 *  - 401/403/429/5xx 与网络异常 = 无协议证据（inconclusive，绝不视为命中）。
 *  级联顺序 anthropic → openai-chat → openai-responses → google；全无证据 = unknown。 */
export async function probeModelProtocol(opts: ProbeOptions): Promise<ProbeResult> {
  const f = opts.fetchFn ?? fetch;
  const base = opts.base.replace(/\/+$/, "");
  const session = opts.session ?? "openselect-probe";
  const steps: ProbeStep[] = [];

  const post = async (
    probe: string,
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<ProbeStep["verdict"]> => {
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-session": session, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      });
      const text = await res.text();
      const verdict: ProbeStep["verdict"] =
        res.status === 404 || res.status === 405
          ? "error"
          : text.includes(UNSUPPORTED_MARK)
            ? "unsupported"
            : text.includes(REGION_MARK)
              ? "inconclusive"
              : res.status >= 200 && res.status < 300
                ? "accepted"
                : (res.status === 400 || res.status === 422) && hasValidationErrorEnvelope(text)
                  ? "accepted"
                  : "inconclusive";
      steps.push({ probe, status: res.status, verdict });
      return verdict;
    } catch {
      steps.push({ probe, status: 0, verdict: "inconclusive" });
      return "inconclusive";
    }
  };

  const model = { model: opts.modelId };
  const authAnthropic = { "x-api-key": opts.key };
  const authBearer = { authorization: `Bearer ${opts.key}` };
  const authGoogle = { "x-goog-api-key": opts.key };

  if ((await post("anthropic", `${base}/anthropic/v1/messages`, authAnthropic, model)) === "accepted") {
    return { protocol: "anthropic", steps };
  }
  if ((await post("openai-chat", `${base}/openai/v1/chat/completions`, authBearer, model)) === "accepted") {
    return { protocol: "openai-chat", steps };
  }
  if ((await post("openai-responses", `${base}/openai/v1/responses`, authBearer, model)) === "accepted") {
    return { protocol: "openai-responses", steps };
  }
  if (
    (await post(
      "google",
      `${base}/google/v1beta/models/${encodeURIComponent(opts.modelId)}:generateContent`,
      authGoogle,
      {},
    )) === "accepted"
  ) {
    return { protocol: "google", steps };
  }
  return { protocol: "unknown", steps };
}

export interface WireRefreshResult {
  refreshed: boolean;
  warning?: string;
}

/** 目录变更后的 wire 注入刷新（unwire → wire）。
 *  跨文件原子写无法真正事务化：任一步失败时**完整重试一次**（重跑 unwire 可清除
 *  首次半途失败留下的旧注入条目），仍失败则尽力保持注入并给出可执行的清理指引。
 *  unwire 会按 baseURL 清除全部注入条目（含已从目录移除的旧模型），故指引
 *  `opensel unwire && opensel wire` 能真正清掉残留；失败不影响 opencode 直连上游。 */
export async function refreshWire(ops: {
  unwire: () => Promise<void>;
  wire: () => Promise<void>;
}): Promise<WireRefreshResult> {
  const runPair = async (): Promise<void> => {
    await ops.unwire();
    await ops.wire();
  };
  try {
    await runPair();
    return { refreshed: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      await runPair();
      return { refreshed: true };
    } catch {
      let injected = false;
      try {
        await ops.wire(); // 尽力保持注入，避免 opencode 处于已撤销状态
        injected = true;
      } catch {
        /* ignore */
      }
      const guidance = "请运行 `opensel unwire && opensel wire` 修复（按 baseURL 清除旧条目后重新注入）";
      return {
        refreshed: false,
        warning: injected
          ? `wire 刷新失败（${detail}）：已尽力保持注入，但可能残留旧条目；${guidance}`
          : `wire 刷新失败（${detail}）：自动恢复未成功；${guidance}`,
      };
    }
  }
}
