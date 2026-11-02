/**
 * opencode zen 免费层中转（通过本地 opencode serve 的 /generate）。
 * 原理：本地 opencode server 能合法访问 zen 免费端点（不需要伪造身份），
 * 我们通过 server 的 HTTP API 驱动它生成文本。
 */

export interface ZenModel {
  id: string;
  name: string;
  free: true;
}

let zenServer: { process: any; port: number; password: string } | null = null;
let zenSpawnLock: Promise<{ port: number; password: string }> | null = null;
let zenModelCache: ZenModel[] | null = null;
let zenCacheTime = 0;

const ZEN_CATALOG_URL = "https://opencode.ai/zen/v1/models";
const ZEN_CACHE_TTL = 10 * 60 * 1000;
const ZEN_SPAWN_TIMEOUT_MS = 12_000;
const ZEN_REQUEST_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 只清理本服务专用端口上的 opencode serve 残留，避免影响其它进程 */
function killZenPortProcess(port: number): void {
  try {
    Bun.spawnSync(["pkill", "-f", `opencode serve.*--port ${port}`]);
  } catch {
    /* pkill 不可用则交给下次启动失败处理 */
  }
}

async function portResponds(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function spawnZenServer(port: number): Promise<{ port: number; password: string }> {
  // 端口上是上一次遗留的 serve（密码已丢失）→ 清掉再起，避免“密码未出现”导致整链失效
  if (await portResponds(port)) {
    console.warn(`[zen] 端口 ${port} 已被占用，清理残留 opencode serve 后重启`);
    killZenPortProcess(port);
    await sleep(400);
    if (await portResponds(port)) throw new Error(`zen server: 端口 ${port} 被其它进程占用`);
  }

  const proc = Bun.spawn({
    cmd: ["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"],
    stdout: "pipe",
    stderr: "pipe",
  });

  // 持续抽干 stdout/stderr：既避免管道背压，也保证密码只被解析一次
  let password = "";
  let errTail = "";
  let resolvePw: (v: string) => void = () => {};
  const pwPromise = new Promise<string>((r) => { resolvePw = r; });
  void (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stdout) {
        const line = dec.decode(chunk);
        const m = line.match(/server password\s+(\S+)/);
        if (m && !password) {
          password = m[1];
          resolvePw(password);
        }
      }
    } catch {
      /* stream closed */
    }
    resolvePw(password);
  })();
  void (async () => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stderr) {
        errTail = (errTail + dec.decode(chunk)).slice(-1200);
      }
    } catch {
      /* ignore */
    }
  })();

  const got = await Promise.race([pwPromise, sleep(ZEN_SPAWN_TIMEOUT_MS).then(() => "")]);
  if (!got) {
    proc.kill();
    throw new Error(`zen server: 启动超时/密码未出现${errTail ? `：${errTail.slice(-300)}` : ""}`);
  }

  let ok = false;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/info`, {
        headers: { authorization: "Basic " + btoa("opencode:" + got) },
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) {
        ok = true;
        break;
      }
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  if (!ok) {
    proc.kill();
    throw new Error(`zen server: 健康检查失败${errTail ? `：${errTail.slice(-300)}` : ""}`);
  }

  zenServer = { process: proc, port, password: got };
  console.log(`[zen] server up on 127.0.0.1:${port}`);
  return { port, password: got };
}

export async function ensureZenServer(port: number): Promise<{ port: number; password: string }> {
  if (zenServer) return { port: zenServer.port, password: zenServer.password };
  if (zenSpawnLock) return zenSpawnLock;
  zenSpawnLock = (async () => {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await spawnZenServer(port);
      } catch (e) {
        lastErr = e;
        console.warn(`[zen] server 启动失败（第 ${attempt + 1}/2 次）：${String(e)}`);
        killZenPortProcess(port);
        await sleep(400);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  })().finally(() => {
    zenSpawnLock = null;
  });
  return zenSpawnLock;
}

/** server 失联时清空托管状态；下次调用会自动重新拉起（端口残留由 spawn 阶段清理） */
export function zenResetServer(reason: string): void {
  if (!zenServer) return;
  console.warn(`[zen] server 失联，自动重启：${reason}`);
  try {
    zenServer.process.kill();
  } catch {
    /* ignore */
  }
  zenServer = null;
}

async function zenFetch(port: number, path: string, method = "GET", body?: unknown) {
  const { password } = await ensureZenServer(port);
  const h = { "content-type": "application/json", authorization: "Basic " + btoa("opencode:" + password) };
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ZEN_REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = String(e);
    // 只有连接层面的失败才重启 server；请求超时只是这一次慢，不能把 server 杀掉
    if (!/TimeoutError|timed? ?out|abort/i.test(msg) && /ECONNREFUSED|ECONNRESET|fetch failed|Unable to connect|Connection refused/i.test(msg)) {
      zenResetServer(`fetch ${method} ${path} 失败：${msg}`);
    }
    throw new Error(`zen ${method} ${path} 连接失败: ${msg}`);
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`zen ${method} ${path} → ${r.status}: ${txt.slice(0, 300)}`);
  }
  if (r.status === 204) return null;
  if (!(r.headers.get("content-type") ?? "").includes("json")) return null;
  return r.json();
}

interface SessionCreateResp { data?: { id?: string } }
interface SessionGenerateResp { data?: { text?: string } }
interface ModelsResp { data?: Array<{ id: string }> }

/** 删除临时会话：不触发 ensure（server 已失联时无需为清理再拉一个） */
async function deleteZenSession(port: number, sid: string): Promise<void> {
  if (!zenServer || zenServer.port !== port) return;
  try {
    await fetch(`http://127.0.0.1:${port}/api/session/${sid}`, {
      method: "DELETE",
      headers: { authorization: "Basic " + btoa("opencode:" + zenServer.password) },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* 孤儿会话不影响服务 */
  }
}

/**
 * 每个请求独立会话：避免并发请求共用会话时“刚切完模型又被别的请求切走”的竞态。
 * 实测创建/删除会话各 ~20ms，相对生成耗时可忽略。
 */
export async function zenComplete(modelId: string, prompt: string, maxTokens = 4096, port: number): Promise<string> {
  await ensureZenServer(port);
  const created = (await zenFetch(port, "/api/session", "POST", {
    title: `openselect-zen ${modelId}`.slice(0, 80),
  })) as SessionCreateResp | null;
  const sid = created?.data?.id;
  if (!sid) throw new Error("zen: 创建会话失败");
  try {
    await zenFetch(port, `/api/session/${sid}/model`, "POST", { model: { providerID: "opencode", id: modelId } });
    const data = (await zenFetch(port, `/api/session/${sid}/generate`, "POST", {
      prompt,
      max_tokens: maxTokens,
    })) as SessionGenerateResp | null;
    const text = data?.data?.text ?? "";
    if (!text.trim()) throw new Error(`zen ${modelId} 返回空内容`);
    return text;
  } finally {
    void deleteZenSession(port, sid);
  }
}

export async function listZenModels(): Promise<ZenModel[]> {
  const now = Date.now();
  if (zenModelCache && now - zenCacheTime < ZEN_CACHE_TTL) return zenModelCache;

  try {
    const r = await fetch(ZEN_CATALOG_URL);
    if (!r.ok) throw new Error(`zen catalog ${r.status}`);
    const data = await r.json() as ModelsResp;
    // 过滤免费模型（与 proxy 的 ZEN_MODELS 保持一致）
    const freeIds = new Set([
      "deepseek-v4.1-flash-free",
      "nemotron-3.5-lightning-free",
      "nemotron-3.5-super-vl-free",
      "nemotron-3-ultra-free",
      "mimo-v2.6-flash-free",
      "glm-5.3-flash-free",
      "flint-40b-free",
      "big-pickle",
    ]);
    const models: ZenModel[] = [];
    for (const m of (data.data ?? [])) {
      if (freeIds.has(m.id)) {
        models.push({ id: m.id, name: m.id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), free: true });
      }
    }
    zenModelCache = models;
    zenCacheTime = now;
    console.log(`[zen] catalog: ${models.length} free models`);
    return models;
  } catch (e) {
    console.warn("[zen] catalog fetch failed:", e);
    return zenModelCache ?? [];
  }
}

export async function stopZenServer() {
  if (zenServer) {
    zenServer.process.kill();
    zenServer = null;
    console.log("[zen] server stopped");
  }
}
// ---- 免费链：负缓存 / 候选顺序 / 恢复时间 ----

/** zen 免费模型全集（顺序 = 默认尝试顺序） */
export const ZEN_MODEL_IDS: string[] = [
  "deepseek-v4.1-flash-free",
  "nemotron-3-ultra-free",
  "mimo-v2.6-flash-free",
  "glm-5.3-flash-free",
  "flint-40b-free",
  "big-pickle",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
];
const ZEN_ID_SET = new Set(ZEN_MODEL_IDS);

export function isZenModelId(id: string | null | undefined): boolean {
  return !!id && ZEN_ID_SET.has(id);
}

export interface ZenDeny {
  until: number;
  reason: string;
}

/** 负缓存：某 zen 模型失败后，在恢复前跳过它（换下一个候选） */
const zenDeny = new Map<string, ZenDeny>();

export function zenDeniedUntil(id: string): number {
  const d = zenDeny.get(id);
  return d && d.until > Date.now() ? d.until : 0;
}

export function zenDenyMap(): Record<string, ZenDeny> {
  const now = Date.now();
  const out: Record<string, ZenDeny> = {};
  for (const [k, v] of zenDeny) if (v.until > now) out[k] = v;
  return out;
}

/**
 * 失败分级：
 * - model    —— 确定是模型自身的问题（额度耗尽 30min / 下线 24h / 未知 1min），写模型负缓存并换下一个；
 * - transport —— 通用上游/传输故障（503、连接失败、server 启不来），**不写模型冷却**，
 *   只让本次请求换下一个候选；连续 2 个候选都遇到则短时熔断整条链（默认 8s）。
 *
 * 关键：以前把 503 当成模型级 10min 冷却，一次上游抖动会把 8 个 zen 模型全部写死 10 分钟，
 * 后续请求 1ms 直接 503 —— 表现为“根本不换模型”。
 */
export type ZenFailureScope = "model" | "transport";

export interface ZenFailureClass {
  scope: ZenFailureScope;
  ms: number;
  reason: string;
}

export function zenClassifyFailure(errText: string): ZenFailureClass {
  const t = String(errText);
  if (/ModelDeprecated|HTTP 410|model.{0,24}(not found|deprecated|unknown)/i.test(t)) {
    return { scope: "model", ms: 24 * 3600_000, reason: "模型已下线" };
  }
  if (/FreeTierError|HTTP 429|rate.?limit|too many requests|quota|额度/i.test(t)) {
    return { scope: "model", ms: 30 * 60_000, reason: "免费额度限流" };
  }
  if (
    /Endpoint is unavailable|ServiceUnavailable|HTTP 5\d\d|ECONNREFUSED|ECONNRESET|fetch failed|Unable to connect|timed? ?out|启动超时|密码未出现|健康检查失败|连接失败/i.test(
      t,
    )
  ) {
    return { scope: "transport", ms: 0, reason: "上游暂不可用" };
  }
  return { scope: "model", ms: 60_000, reason: "调用失败" };
}

/** 记录一次候选失败；transport 类不写模型冷却，返回分类供调用方决定是否继续换模型 */
export function zenNoteFailure(id: string, errText: string): ZenFailureClass {
  const f = zenClassifyFailure(errText);
  if (f.scope === "model" && f.ms > 0) {
    zenDeny.set(id, { until: Date.now() + f.ms, reason: f.reason });
    console.warn(`[zen] ${id} 冷却 ${Math.round(f.ms / 60000)}min（${f.reason}）`);
  } else {
    console.warn(`[zen] ${id} 本次失败：${f.reason}（不写模型冷却）`);
  }
  return f;
}

/** 整条 zen 链短时熔断：全局上游故障时快速落后备，避免每个请求都挨个撞 8 个模型 */
let zenOutageUntil = 0;

export function zenOutageRemaining(): number {
  return zenOutageUntil > Date.now() ? zenOutageUntil - Date.now() : 0;
}

export function zenMarkOutage(ms = 8000, reason = "上游暂不可用"): void {
  zenOutageUntil = Math.max(zenOutageUntil, Date.now() + ms);
  console.warn(`[zen] 上游短时熔断 ${Math.round(ms / 1000)}s（${reason}），期间直接走后备`);
}

/** 候选链顺序：指定模型优先 → 用户配置顺序 → 默认全集 */
export function zenChain(preferred: string | null, configured: string[]): string[] {
  const out: string[] = [];
  if (preferred && ZEN_ID_SET.has(preferred)) out.push(preferred);
  for (const id of configured || []) if (ZEN_ID_SET.has(id) && !out.includes(id)) out.push(id);
  for (const id of ZEN_MODEL_IDS) if (!out.includes(id)) out.push(id);
  return out;
}
