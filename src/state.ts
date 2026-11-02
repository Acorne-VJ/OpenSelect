import type { Account, AccountState, AccountUsage, Config } from "./types";
import type { Catalog } from "./catalog";
import { checkUsageAlerts } from "./alerts";
import {
  allStates,
  insertUsage,
  latestUsage,
  logSwitch as dbLogSwitch,
  rebindAllSessions,
  recentSessions,
  setState,
  upsertSession,
} from "./db";

/** usage snapshots older than this are not restored at startup (window boundaries make them misleading) */
export const USAGE_SEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionBinding {
  accountId: string;
  updatedAt: number;
}

export class Runtime {
  config: Config;
  catalog: Catalog;
  states = new Map<string, AccountState>();
  usages = new Map<string, AccountUsage>();
  sessions = new Map<string, SessionBinding>();
  /** last account chosen by policy (for dashboard / auto-activate) */
  preferredAccountId: string | null = null;
  /** 手动指定的账号（面板「设为首选」）：新流量优先走它 */
  forcedAccountId: string | null = null;
  /** per (accountId:model) model-scoped denials (e.g. workspace privacy 403) — skip combo until expiry */
  modelDeny = new Map<string, { until: number; status: number; body: string }>();
  /** accounts whose recent usage snapshot was restored from SQLite at startup */
  usageSeeded = 0;

  constructor(config: Config, catalog: Catalog) {
    this.config = config;
    this.catalog = catalog;
    for (const s of allStates()) this.states.set(s.accountId, s);
    for (const s of recentSessions(500)) this.sessions.set(s.sessionId, { accountId: s.accountId, updatedAt: s.updatedAt });
    this.forcedAccountId = config.policy.forcedAccountId ?? null;
    // restore last-known usage so the restart window cannot pick an account that was already at threshold
    const now = Date.now();
    for (const acct of config.accounts) {
      const u = latestUsage(acct.id);
      if (u && now - u.ts <= USAGE_SEED_MAX_AGE_MS) {
        this.usages.set(u.accountId, u);
        this.usageSeeded++;
      }
    }
  }

  account(id: string): Account | undefined {
    return this.config.accounts.find((a) => a.id === id);
  }

  state(id: string): AccountState {
    let s = this.states.get(id);
    if (!s) {
      s = { accountId: id, cooldownUntil: 0, lastError: null, lastUsed: 0, invalid: false };
      this.states.set(id, s);
    }
    return s;
  }

  setUsage(u: AccountUsage): void {
    this.usages.set(u.accountId, u);
    insertUsage(u);
    // 阈值告警：每轮用量轮询后判定（不产生额外出站请求）
    const thresholds = this.config.policy.alertAt;
    if (Array.isArray(thresholds) && thresholds.length > 0) {
      try {
        checkUsageAlerts(u.accountId, u, thresholds, {
          cooldownSec: this.config.policy.alertCooldownSec,
          byWindow: this.config.policy.alertAtByWindow,
          quiet: this.config.policy.alertQuiet,
          email: this.config.policy.alertEmail,
        });
      } catch (e) {
        console.error(`[openselect] checkUsageAlerts failed: ${String(e)}`);
      }
    }
  }

  setCooldown(id: string, until: number, error: string | null): void {
    const s = this.state(id);
    s.cooldownUntil = until;
    s.lastError = error;
    setState({ accountId: id, cooldownUntil: until, lastError: error });
  }

  setInvalid(id: string, error: string | null): void {
    const s = this.state(id);
    s.invalid = true;
    s.lastError = error;
    setState({ accountId: id, invalid: true, lastError: error });
  }

  /**
   * Remember that this account got a model-scoped denial — skip the combo for a while.
   * scope = 上游端点作用域（chat / responses / anthropic / google）：
   * 同一模型在不同协议端点上的可用性是**独立**的（例如免费模型只在 chat 端点上服务，
   * 在 responses 端点上会 404），不区分作用域会把 chat 的可用性误伤掉。
   */
  denyModel(accountId: string, model: string, status: number, body: string, ttlMs: number, scope = ""): void {
    this.modelDeny.set(`${accountId}:${model}:${scope}`, { until: Date.now() + ttlMs, status, body: body.slice(0, 2000) });
  }

  modelDenied(accountId: string, model: string, scope = ""): { status: number; body: string } | null {
    const k = `${accountId}:${model}:${scope}`;
    const d = this.modelDeny.get(k);
    if (!d) return null;
    if (d.until <= Date.now()) {
      this.modelDeny.delete(k);
      return null;
    }
    return { status: d.status, body: d.body };
  }

  touch(id: string): void {
    const s = this.state(id);
    s.lastUsed = Date.now();
    setState({ accountId: id, lastUsed: s.lastUsed });
  }

  getSessionAccount(sessionId: string | null): string | null {
    if (!sessionId) return null;
    const b = this.sessions.get(sessionId);
    if (!b) return null;
    if (Date.now() - b.updatedAt > this.config.policy.sessionTtlSec * 1000) return null;
    return b.accountId;
  }

  /**
   * 手动切换：把该账号设为首选，并把已绑定的会话重绑过去（在途会话立即换号）。
   * 返回被重绑的会话数。
   * 目标账号不存在或已停用 → 不重绑（避免把会话绑到幽灵账号上），返回 0。
   */
  forceAccount(accountId: string | null): number {
    if (!accountId) {
      this.forcedAccountId = null;
      return 0;
    }
    const target = this.config.accounts.find((a) => a.id === accountId);
    if (!target || !target.enabled) {
      this.forcedAccountId = null;
      return 0;
    }
    this.forcedAccountId = accountId;
    // 只改绑定，不刷新 updatedAt：过期会话不因重绑而"复活"
    for (const [sid, b] of this.sessions) {
      this.sessions.set(sid, { accountId, updatedAt: b.updatedAt });
      upsertSession(sid, accountId, b.updatedAt);
    }
    return rebindAllSessions(accountId);
  }

  /** 当前会话 → 账号 绑定（面板展示）；按 TTL 过滤，与 getSessionAccount 同口径 */
  sessionBindings(limit = 50): Array<{ sessionId: string; accountId: string; updatedAt: number }> {
    const ttlMs = this.config.policy.sessionTtlSec * 1000;
    const now = Date.now();
    return [...this.sessions.entries()]
      .filter(([, b]) => now - b.updatedAt <= ttlMs)
      .map(([sessionId, b]) => ({ sessionId, accountId: b.accountId, updatedAt: b.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  bindSession(sessionId: string | null, accountId: string): void {
    if (!sessionId) return;
    const now = Date.now();
    this.sessions.set(sessionId, { accountId, updatedAt: now });
    upsertSession(sessionId, accountId, now);
  }

  logSwitch(from: string | null, to: string | null, reason: string, detail: string | null, sessionId: string | null = null): void {
    dbLogSwitch({ ts: Date.now(), sessionId, fromAccount: from, toAccount: to, reason, detail });
  }
}
