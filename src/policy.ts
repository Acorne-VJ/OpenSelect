import type { Account, AccountState, AccountUsage, PolicyConfig } from "./types";

export interface PolicyInput {
  accounts: Account[];
  states: Map<string, AccountState>;
  usages: Map<string, AccountUsage>;
  /** sticky session binding account id (may be stale/ineligible) */
  sessionAccount?: string | null;
  /** free models do not consume quota → relax quota checks */
  free: boolean;
  /** accounts already tried within this request */
  exclude?: Set<string>;
  /** 手动指定的账号：优先使用（仅当 enabled 且 Key 有效） */
  forcedAccountId?: string | null;
  /** 按接入（客户端）指定的账号：优先于 forcedAccountId（仅当 enabled 且 Key 有效） */
  clientAccountId?: string | null;
  now: number;
  switchAt: number;
}

export interface PolicyDecision {
  accountId: string;
  reason: "client-pinned" | "forced" | "sticky" | "least-pressure" | "fallback";
  pressure: number;
}

/**
 * 压力排序饱和上限：所有 >=100% 的账号统一按 120% 参与排序（避免超大值压过排序）。
 *
 * 用途：① 账号之间的排序饱和；②「接近阈值」展示（eligibility 的 over-threshold 判定走
 * accountPressure，因此本上限**确实参与阈值判定**——当前 switchAt 被夹在 [0.95, 0.99] < 1.2，
 * 结论不受影响；若将来上调 SWITCH_AT_MAX 超过 1.2，必须同步复核这条链路）。
 * 限流判定（isRateLimited）不使用本上限，而是独立看窗口 percent >= 1。
 *
 * 与 usage.ts 的 USAGE_PERCENT_MAX（用量展示上限 1.5）语义不同：压力上限更低，
 * 因此真实 150% 的用量在账号卡片上显示为 120% 压力。两者不要相互对齐。
 */
export const PRESSURE_MAX = 1.2;

/** max across rolling/weekly/monthly, 0..1 */
export function accountPressure(usage: AccountUsage | undefined): number {
  if (!usage) return 0;
  const ps = [usage.rolling.percent, usage.weekly.percent, usage.monthly.percent];
  const vals = ps.filter((p) => Number.isFinite(p)).map((p) => Math.max(0, Math.min(PRESSURE_MAX, p)));
  return vals.length ? Math.max(...vals) : 0;
}

export function isRateLimited(usage: AccountUsage | undefined): boolean {
  if (!usage) return false;
  return [usage.rolling, usage.weekly, usage.monthly].some((w) => w.status === "rate-limited" || w.percent >= 1);
}

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

export function eligibility(
  acc: Account,
  state: AccountState | undefined,
  usage: AccountUsage | undefined,
  opts: { free: boolean; now: number; switchAt: number },
): Eligibility {
  if (!acc.enabled) return { eligible: false, reason: "disabled" };
  if (state?.invalid) return { eligible: false, reason: "invalid-key" };
  if (!opts.free) {
    if (state && state.cooldownUntil > opts.now) return { eligible: false, reason: "cooldown" };
    if (isRateLimited(usage)) return { eligible: false, reason: "rate-limited" };
    if (accountPressure(usage) >= opts.switchAt) return { eligible: false, reason: "over-threshold" };
  }
  return { eligible: true, reason: "ok" };
}

function lastUsed(states: Map<string, AccountState>, id: string): number {
  return states.get(id)?.lastUsed ?? 0;
}

function cooldown(states: Map<string, AccountState>, id: string): number {
  return states.get(id)?.cooldownUntil ?? 0;
}

/**
 * Deterministic account selection:
 * 1) sticky session account if eligible
 * 2) among eligible: lowest pressure, then least recently used
 * 3) fallback (all ineligible): lowest cooldown, lowest pressure, least recently used
 */
export function pickAccount(input: PolicyInput): PolicyDecision | null {
  const exclude = input.exclude ?? new Set<string>();
  const pool = input.accounts.filter((a) => !exclude.has(a.id));
  if (pool.length === 0) return null;

  const eligible: Account[] = [];
  for (const a of pool) {
    const e = eligibility(a, input.states.get(a.id), input.usages.get(a.id), {
      free: input.free,
      now: input.now,
      switchAt: input.switchAt,
    });
    if (e.eligible) eligible.push(a);
  }

  // 按接入指定的账号优先（面板「接入 → 指定账号」）：比全局指定更具体
  if (input.clientAccountId) {
    const pinned = eligible.find((a) => a.id === input.clientAccountId);
    if (pinned) {
      return { accountId: pinned.id, reason: "client-pinned", pressure: accountPressure(input.usages.get(pinned.id)) };
    }
  }

  // 手动指定账号优先（面板「设为首选」/ 手动切换）
  if (input.forcedAccountId) {
    const forced = eligible.find((a) => a.id === input.forcedAccountId);
    if (forced) {
      return { accountId: forced.id, reason: "forced", pressure: accountPressure(input.usages.get(forced.id)) };
    }
  }

  if (input.sessionAccount) {
    const sticky = eligible.find((a) => a.id === input.sessionAccount);
    if (sticky) {
      return { accountId: sticky.id, reason: "sticky", pressure: accountPressure(input.usages.get(sticky.id)) };
    }
  }

  if (eligible.length > 0) {
    const best = [...eligible].sort((a, b) => {
      const pa = accountPressure(input.usages.get(a.id));
      const pb = accountPressure(input.usages.get(b.id));
      if (pa !== pb) return pa - pb;
      return lastUsed(input.states, a.id) - lastUsed(input.states, b.id);
    })[0]!;
    return { accountId: best.id, reason: "least-pressure", pressure: accountPressure(input.usages.get(best.id)) };
  }

  // fallback: everything is drained/cooling; still try the least-bad one.
  // 优先级必须是：未限流 > 未超阈值 > 冷却更短 > 压力更低。
  // 不能只按 cooldownUntil 排序：周额度 100% 的账号 cooldown=0，会排在
  // 仅因瞬时 429 冷却 3s 的健康账号前面，导致连续撞 4 个已耗尽账号。
  const cands = pool.filter((a) => a.enabled && !input.states.get(a.id)?.invalid);
  if (cands.length === 0) return null;
  const best = [...cands].sort((a, b) => {
    const ua = input.usages.get(a.id);
    const ub = input.usages.get(b.id);
    const ra = isRateLimited(ua) ? 1 : 0;
    const rb = isRateLimited(ub) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const oa = accountPressure(ua) >= input.switchAt ? 1 : 0;
    const ob = accountPressure(ub) >= input.switchAt ? 1 : 0;
    if (oa !== ob) return oa - ob;
    const ca = cooldown(input.states, a.id);
    const cb = cooldown(input.states, b.id);
    if (ca !== cb) return ca - cb;
    const pa = accountPressure(ua);
    const pb = accountPressure(ub);
    if (pa !== pb) return pa - pb;
    return lastUsed(input.states, a.id) - lastUsed(input.states, b.id);
  })[0]!;
  return { accountId: best.id, reason: "fallback", pressure: accountPressure(input.usages.get(best.id)) };
}

export function describePolicy(cfg: PolicyConfig): string {
  return `switchAt=${(cfg.switchAt * 100).toFixed(1)}% maxAttempts=${cfg.maxAttempts} sessionTtl=${cfg.sessionTtlSec}s`;
}
