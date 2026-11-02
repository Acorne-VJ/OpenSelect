import type { Account, AccountUsage, UsageWindow } from "./types";
import type { Runtime } from "./state";
import { fetchOllamaAccountModels } from "./ollama";
import { isProviderIntegration, providerModelIds, providerUsageUrl } from "./providers";

export type UsageResult = { ok: true; usage: AccountUsage } | { ok: false; status: number; error: string };

/**
 * 用量展示上限：允许显示到 150%（超配额），用于「用量条/百分比」展示。
 * 与 policy.ts 的 PRESSURE_MAX（压力排序饱和上限，1.2）语义不同：
 * 压力上限用于排序饱和与阈值展示（且当前 switchAt < 1.2，结论不受其影响），
 * 限流判定独立看窗口 percent >= 1。真实 150% 的用量在账号卡片上显示为 120% 压力。
 * 两者不要相互对齐。
 */
export const USAGE_PERCENT_MAX = 1.5;

/**
 * 用量刻度解析修复时刻（2026-10-20 13:20 CST = 2026-10-20T05:20:00Z）。
 * 此刻之前写入的 usage_snapshots 可能被旧解析器放大（0..2 的原始百分比被当成 0..1 比例），
 * 之后写入的都是正确刻度。历史快照的定向清理**只允许触及该时刻之前的行**。
 */
export const USAGE_SCALE_FIXED_AT = Date.parse("2026-10-20T05:20:00.000Z");

export function parseWindow(w: unknown): UsageWindow {
  const o = (w ?? {}) as Record<string, unknown>;
  const raw = Number(o.percent ?? 0);
  // Upstream /v1/usage reports 0..100 (verified 2026-10-20: weekly=2 means 2%).
  // Always normalize; magnitude-guessing breaks valid low percentages (2 → 200%).
  const percent = Number.isFinite(raw) ? raw / 100 : 0;
  return {
    status: typeof o.status === "string" ? o.status : "unknown",
    percent: Math.max(0, Math.min(USAGE_PERCENT_MAX, percent)),
    resetsAt: typeof o.resetsAt === "string" ? o.resetsAt : null,
  };
}

function zeroWindow(): UsageWindow {
  return { status: "active", percent: 0, resetsAt: null };
}

function usedPercent(used: unknown, fallbackTotal?: unknown, fallbackCount?: unknown): number {
  const p = Number(used);
  if (Number.isFinite(p)) return Math.max(0, Math.min(USAGE_PERCENT_MAX, p / 100));
  const total = Number(fallbackTotal);
  const count = Number(fallbackCount);
  if (Number.isFinite(total) && total > 0 && Number.isFinite(count)) {
    return Math.max(0, Math.min(USAGE_PERCENT_MAX, count / total));
  }
  return 0;
}

function resetIso(ms: unknown): string | null {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const value = n > 1e12 ? n : n * 1000;
  return new Date(value).toISOString();
}

interface ZaiLimit {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  nextResetTime?: number;
}

/** Z.ai GLM Coding Plan：unit=3/number=5 是 5h，unit=6/number=1 是周；percentage 为已用百分比。 */
export function parseZaiUsage(accountId: string, j: unknown): AccountUsage {
  const limits = ((j as { data?: { limits?: ZaiLimit[] } })?.data?.limits ?? []) as ZaiLimit[];
  const find = (unit: number, number: number): ZaiLimit | undefined =>
    limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === unit && l.number === number);
  const win = (l: ZaiLimit | undefined): UsageWindow => {
    if (!l) return zeroWindow();
    const pct = Number(l.percentage);
    return {
      status: Number.isFinite(pct) && pct >= 100 ? "rate-limited" : "active",
      percent: Math.max(0, Math.min(USAGE_PERCENT_MAX, (Number.isFinite(pct) ? pct : 0) / 100)),
      resetsAt: resetIso(l.nextResetTime),
    };
  };
  return {
    accountId,
    ts: Date.now(),
    rolling: win(find(3, 5)),
    weekly: win(find(6, 1)),
    monthly: zeroWindow(),
  };
}

interface MiniMaxQuotaRow {
  model_name?: string;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  current_interval_remaining_percent?: number;
  current_interval_status?: number;
  end_time?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  current_weekly_remaining_percent?: number;
  current_weekly_status?: number;
  weekly_end_time?: number;
}

/** MiniMax M Plan：current_*_remaining_percent 是剩余百分比；status 2=耗尽，3=不限。 */
export function parseMiniMaxUsage(accountId: string, j: unknown): AccountUsage {
  const rows = ((j as { model_remains?: MiniMaxQuotaRow[] })?.model_remains ?? []) as MiniMaxQuotaRow[];
  const m = rows.find((r) => r.model_name === "general") ?? rows[0];
  if (!m) {
    return { accountId, ts: Date.now(), rolling: zeroWindow(), weekly: zeroWindow(), monthly: zeroWindow() };
  }
  const win = (
    remainingPct: number | undefined,
    status: number | undefined,
    total: number | undefined,
    count: number | undefined,
    reset: number | undefined,
  ): UsageWindow => {
    const percent =
      remainingPct === undefined || remainingPct === null
        ? usedPercent(undefined, total, count)
        : usedPercent(100 - Number(remainingPct));
    return {
      status: status === 2 ? "rate-limited" : "active",
      percent: status === 3 ? 0 : percent,
      resetsAt: resetIso(reset),
    };
  };
  return {
    accountId,
    ts: Date.now(),
    rolling: win(
      m.current_interval_remaining_percent,
      m.current_interval_status,
      m.current_interval_total_count,
      m.current_interval_usage_count,
      m.end_time,
    ),
    weekly: win(
      m.current_weekly_remaining_percent,
      m.current_weekly_status,
      m.current_weekly_total_count,
      m.current_weekly_usage_count,
      m.weekly_end_time,
    ),
    monthly: zeroWindow(),
  };
}

/** DeepSeek 官方按量计费：没有 5h/周窗口，余额就是唯一额度。 */
export function parseDeepSeekUsage(accountId: string, j: unknown): AccountUsage {
  const o = (j ?? {}) as {
    is_available?: boolean;
    balance_infos?: Array<{ currency?: string; total_balance?: string; topped_up_balance?: string }>;
  };
  const info = (o.balance_infos ?? [])[0];
  const total = Number(info?.total_balance ?? 0);
  const available = o.is_available !== false && Number.isFinite(total) && total > 0;
  const zero = zeroWindow();
  return {
    accountId,
    ts: Date.now(),
    rolling: available ? zero : { ...zero, status: "rate-limited", percent: 1 },
    weekly: zero,
    monthly: zero,
    balance: {
      currency: info?.currency ?? "CNY",
      total: Number.isFinite(total) ? total : 0,
      available,
    },
  };
}

function noQuotaUsage(accountId: string): AccountUsage {
  return {
    accountId,
    ts: Date.now(),
    rolling: zeroWindow(),
    weekly: zeroWindow(),
    monthly: zeroWindow(),
  };
}

async function fetchProviderUsage(account: Account): Promise<UsageResult> {
  // Command Code Provider 与 Ollama Cloud 没有 5h/周窗口；按量/订阅 credits 由厂商账单结算。
  if (account.integration === "commandcode" || account.integration === "ollama") {
    return { ok: true, usage: noQuotaUsage(account.id) };
  }
  const url = providerUsageUrl(account);
  if (!url) return { ok: false, status: 0, error: "供应商用量端点未配置" };
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${account.key}`, accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const j = (await res.json()) as Record<string, unknown>;
    if (account.integration === "deepseek-api") {
      return { ok: true, usage: parseDeepSeekUsage(account.id, j) };
    }
    if (account.integration === "zai") {
      const code = Number(j.code);
      if (Number.isFinite(code) && code !== 200) {
        return { ok: false, status: code === 401 || code === 1004 ? 401 : 0, error: `code=${code} ${String(j.msg ?? "")}` };
      }
    } else {
      const baseResp = (j.base_resp ?? {}) as { status_code?: number; status_msg?: string };
      const code = Number(baseResp.status_code);
      if (Number.isFinite(code) && code !== 0) {
        return {
          ok: false,
          status: code === 2049 || code === 1004 ? 401 : 0,
          error: `code=${code} ${baseResp.status_msg ?? ""}`,
        };
      }
    }
    const usage = account.integration === "zai" ? parseZaiUsage(account.id, j) : parseMiniMaxUsage(account.id, j);
    return { ok: true, usage };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

export async function fetchAccountUsage(base: string, account: Account): Promise<UsageResult> {
  if (isProviderIntegration(account.integration)) return fetchProviderUsage(account);
  try {
    const res = await fetch(`${base}/v1/usage`, {
      headers: { authorization: `Bearer ${account.key}`, accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const j = (await res.json()) as Record<string, unknown>;
    const u = ((j.usage ?? j) ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      usage: {
        accountId: account.id,
        ts: Date.now(),
        rolling: parseWindow(u.rolling),
        weekly: parseWindow(u.weekly),
        monthly: parseWindow(u.monthly),
      },
    };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

export type ModelsResult = { ok: true; ids: string[] } | { ok: false; status: number; error: string };

/** Per-account available model list (upstream reports per-account availability — accounts can differ). */
export async function fetchAccountModels(base: string, account: Account): Promise<ModelsResult> {
  if (account.integration === "ollama") return fetchOllamaAccountModels(account);
  if (isProviderIntegration(account.integration)) {
    return { ok: true, ids: providerModelIds(account.integration) };
  }
  try {
    const res = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${account.key}`, accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      // HTTP 200 但正文不是 JSON：保留真实状态，按响应格式异常处理（不与网络失败混淆）
      return { ok: false, status: res.status, error: "响应格式异常：非 JSON 响应" };
    }
    const data = (parsed as { data?: unknown } | null)?.data;
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, status: res.status, error: "响应格式异常：data 缺失或为空" };
    }
    const ids: string[] = [];
    for (const m of data) {
      const id = (m as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id.length === 0) {
        return { ok: false, status: res.status, error: "响应格式异常：模型条目缺少 id" };
      }
      ids.push(id);
    }
    return { ok: true, ids };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

/** Poll every enabled account once (parallel); update runtime state. */
export async function pollAll(rt: Runtime): Promise<Map<string, UsageResult>> {
  const results = new Map<string, UsageResult>();
  const accounts = rt.config.accounts.filter((a) => a.enabled);
  await Promise.all(
    accounts.map(async (a) => {
      const r = await fetchAccountUsage(rt.config.upstream.base, a);
      results.set(a.id, r);
      if (r.ok) {
        rt.setUsage(r.usage);
        // a successful poll means the key works
        const s = rt.state(a.id);
        if (s.invalid) {
          s.invalid = false;
          const { setState } = await import("./db");
          setState({ accountId: a.id, invalid: false });
        }
      } else if (r.status === 401) {
        // 仅 401 代表 key 级失效；403 可能是模型/工作区策略（如隐私设置），不毒化账号
        rt.setInvalid(a.id, r.error);
      }
    }),
  );
  return results;
}

export function startPoller(rt: Runtime, onError?: (e: unknown) => void): () => void {
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      await pollAll(rt);
    } catch (e) {
      onError?.(e);
    }
    if (!stopped) handle = setTimeout(tick, Math.max(10, rt.config.monitor.pollSec) * 1000);
  };
  void tick();
  return () => {
    stopped = true;
    if (handle) clearTimeout(handle);
  };
}
