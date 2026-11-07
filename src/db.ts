import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import { DB_PATH, OPENSELECT_DIR } from "./config";
import { ensureDir } from "./util";
import { USAGE_SCALE_FIXED_AT } from "./usage";
import type { AccountState, AccountUsage, RequestLogEntry, SwitchLogEntry } from "./types";
import type { TokenUsage } from "./tokens";
import { traceContext } from "./trace_context";

let db: Database | null = null;

export function getDb(): Database {
  if (!db) {
    ensureDir(OPENSELECT_DIR);
    db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    migrateSchema(db);
    // ledger contains session ids + usage data: keep it owner-only (0600), including WAL sidecars
    for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      try {
        chmodSync(p, 0o600);
      } catch {
        /* best effort */
      }
    }
  }
  return db;
}

export function migrateSchema(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      rolling_pct REAL, rolling_status TEXT, rolling_reset TEXT,
      weekly_pct REAL, weekly_status TEXT, weekly_reset TEXT,
      monthly_pct REAL, monthly_status TEXT, monthly_reset TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_snapshots(account_id, ts);

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      model TEXT,
      family TEXT,
      account_id TEXT,
      provider TEXT,
      status INTEGER,
      attempts INTEGER,
      latency_ms INTEGER,
      error TEXT,
      path TEXT,
      client TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_tokens INTEGER,
      token_estimated INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);

    CREATE TABLE IF NOT EXISTS switches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session_id TEXT,
      from_account TEXT,
      to_account TEXT,
      reason TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_switches_ts ON switches(ts);

    CREATE TABLE IF NOT EXISTS account_state (
      account_id TEXT PRIMARY KEY,
      cooldown_until INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_used INTEGER NOT NULL DEFAULT 0,
      invalid INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      window TEXT NOT NULL,
      threshold REAL NOT NULL,
      percent REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      status TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
    CREATE INDEX IF NOT EXISTS idx_alerts_key ON alerts(account_id, window, threshold);
  `);
  // 增量迁移：alerts 增加 active（告警是否仍处于越线中）与 status（越线时的窗口状态）
  const alertCols = d.query("PRAGMA table_info(alerts)").all() as Array<{ name: string }>;
  if (!alertCols.some((c) => c.name === "active")) d.exec("ALTER TABLE alerts ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  if (!alertCols.some((c) => c.name === "status")) d.exec("ALTER TABLE alerts ADD COLUMN status TEXT");
  // 增量迁移：requests 增加 served_model（免费优先替换时记录实际服务的模型）
  const cols = d.query("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "served_model")) d.exec("ALTER TABLE requests ADD COLUMN served_model TEXT");
  // 增量迁移：requests 增加 client（接入/客户端归属，用于「按接入指定账号」与流量统计）
  // 注意：索引必须在 ALTER 之后建（新库建表时该列已存在，老库需要先补列）
  if (!cols.some((c) => c.name === "client")) d.exec("ALTER TABLE requests ADD COLUMN client TEXT");
  // 增量迁移：token 统计列。旧请求保持 NULL，统计页显示“未上报”，不回填、不伪造。
  for (const [name, type] of [
    ["provider", "TEXT"],
    ["input_tokens", "INTEGER"],
    ["output_tokens", "INTEGER"],
    ["cache_read_tokens", "INTEGER"],
    ["cache_write_tokens", "INTEGER"],
    ["total_tokens", "INTEGER"],
    ["token_estimated", "INTEGER"],
    ["cache_read_known", "INTEGER"],
    ["duration_ms", "INTEGER"],
    ["first_content_ms", "INTEGER"],
    ["generation_ms", "INTEGER"],
    ["retry_ms", "INTEGER"],
    ["trace_id", "TEXT"],
  ] as const) {
    if (!cols.some((c) => c.name === name)) d.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
  }
  d.exec("CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client, ts)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider, ts)");
  d.exec(`CREATE INDEX IF NOT EXISTS idx_requests_trace ON requests(trace_id);
    CREATE TABLE IF NOT EXISTS request_traces (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, path TEXT, state TEXT,
      status INTEGER, duration_ms INTEGER, attempts INTEGER, final_provider TEXT, final_model TEXT, first_content_ms INTEGER, generation_ms INTEGER, retry_ms INTEGER);
    CREATE INDEX IF NOT EXISTS idx_traces_time ON request_traces(started_at);
    CREATE TABLE IF NOT EXISTS request_attempts (trace_id TEXT NOT NULL, ordinal INTEGER NOT NULL, started_at INTEGER, provider TEXT,
      model TEXT, account_id TEXT, header_status INTEGER, header_ms INTEGER, PRIMARY KEY(trace_id,ordinal));`);
}

export function insertUsage(u: AccountUsage): void {
  getDb()
    .query(
      `INSERT INTO usage_snapshots
        (account_id, ts, rolling_pct, rolling_status, rolling_reset, weekly_pct, weekly_status, weekly_reset, monthly_pct, monthly_status, monthly_reset)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    )
    .run(
      u.accountId,
      u.ts,
      u.rolling.percent,
      u.rolling.status,
      u.rolling.resetsAt,
      u.weekly.percent,
      u.weekly.status,
      u.weekly.resetsAt,
      u.monthly.percent,
      u.monthly.status,
      u.monthly.resetsAt,
    );
  getDb().query(`DELETE FROM usage_snapshots WHERE id <= (SELECT MAX(id) FROM usage_snapshots) - 20000`).run();
}

interface UsageRow {
  account_id: string;
  ts: number;
  rolling_pct: number;
  rolling_status: string;
  rolling_reset: string | null;
  weekly_pct: number;
  weekly_status: string;
  weekly_reset: string | null;
  monthly_pct: number;
  monthly_status: string;
  monthly_reset: string | null;
}

export function latestUsage(accountId: string): AccountUsage | null {
  const r = getDb()
    .query(`SELECT * FROM usage_snapshots WHERE account_id = ?1 ORDER BY ts DESC LIMIT 1`)
    .get(accountId) as UsageRow | null;
  if (!r) return null;
  return {
    accountId: r.account_id,
    ts: r.ts,
    rolling: { percent: r.rolling_pct, status: r.rolling_status, resetsAt: r.rolling_reset },
    weekly: { percent: r.weekly_pct, status: r.weekly_status, resetsAt: r.weekly_reset },
    monthly: { percent: r.monthly_pct, status: r.monthly_status, resetsAt: r.monthly_reset },
  };
}

/** Recent usage snapshots for one account (oldest → newest), for dashboard history charts. */
export function usageHistory(
  accountId: string,
  limit = 120,
): Array<{ ts: number; rolling: number; weekly: number; monthly: number }> {
  const rows = getDb()
    .query(
      `SELECT ts, rolling_pct, weekly_pct, monthly_pct FROM usage_snapshots WHERE account_id = ?1 ORDER BY ts DESC LIMIT ?2`,
    )
    .all(accountId, limit) as Array<{ ts: number; rolling_pct: number; weekly_pct: number; monthly_pct: number }>;
  return rows.reverse().map((r) => ({ ts: r.ts, rolling: r.rolling_pct, weekly: r.weekly_pct, monthly: r.monthly_pct }));
}

export function upsertSession(sessionId: string, accountId: string, ts: number): void {
  getDb()
    .query(
      `INSERT INTO sessions (session_id, account_id, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(session_id) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at`,
    )
    .run(sessionId, accountId, ts);
}

export function getSession(sessionId: string): { accountId: string; updatedAt: number } | null {
  const r = getDb().query(`SELECT account_id, updated_at FROM sessions WHERE session_id = ?1`).get(sessionId) as
    | { account_id: string; updated_at: number }
    | null;
  return r ? { accountId: r.account_id, updatedAt: r.updated_at } : null;
}

/** 删除一条会话绑定（账号被删除时清理） */
export function deleteSession(sessionId: string): void {
  try {
    getDb().query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  } catch (err) {
    console.error(`[openselect] deleteSession failed: ${String(err)}`);
  }
}

/** 把所有已知会话重绑到指定账号（手动切换时用：让在途会话也立刻换号） */
export function rebindAllSessions(accountId: string): number {
  const db = getDb();
  const n = db.query(`SELECT count(*) AS c FROM sessions`).get() as { c: number };
  db.query(`UPDATE sessions SET account_id = ?`).run(accountId);
  return n.c;
}

/** 当前会话绑定（按最近更新） */
export function activeSessions(limit = 20): Array<{ sessionId: string; accountId: string; updatedAt: number }> {
  return recentSessions(limit);
}

export function recentSessions(limit = 20): Array<{ sessionId: string; accountId: string; updatedAt: number }> {
  const rows = getDb()
    .query(`SELECT session_id, account_id, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?1`)
    .all(limit) as Array<{ session_id: string; account_id: string; updated_at: number }>;
  return rows.map((r) => ({ sessionId: r.session_id, accountId: r.account_id, updatedAt: r.updated_at }));
}

export function logRequest(e: RequestLogEntry): number | null {
  try {
    const info = getDb()
      .query(
        `INSERT INTO requests
          (ts, session_id, model, served_model, family, account_id, provider, status, attempts, latency_ms, error, path, client,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, token_estimated, cache_read_known, trace_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`,
      )
      .run(
        e.ts,
        e.sessionId,
        e.model,
        e.servedModel ?? null,
        e.family,
        e.accountId,
        e.provider ?? null,
        e.status,
        e.attempts,
        e.latencyMs,
        e.error,
        e.path,
        e.client ?? null,
        e.inputTokens ?? null,
        e.outputTokens ?? null,
        e.cacheReadTokens ?? null,
        e.cacheWriteTokens ?? null,
        e.totalTokens ?? null,
        e.tokenEstimated == null ? null : e.tokenEstimated ? 1 : 0,
        e.cacheReadKnown == null ? null : e.cacheReadKnown ? 1 : 0,
        traceContext.getStore()?.id ?? null,
      );
    const id = Number(info.lastInsertRowid);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    // telemetry must never break a proxied request
    console.error(`[openselect] logRequest failed: ${String(err)}`);
    return null;
  }
}

/** 流式响应结束后补写 token；日志行在响应开始时已经落库。 */
export function updateRequestTokens(id: number, u: TokenUsage): void {
  try {
    getDb()
      .query(
        `UPDATE requests
         SET input_tokens=?2, output_tokens=?3, cache_read_tokens=?4, cache_write_tokens=?5,
             total_tokens=?6, token_estimated=?7, cache_read_known=?8
         WHERE id=?1`,
      )
      .run(
        id,
        u.input,
        u.output,
        u.cacheRead,
        u.cacheWrite,
        u.total,
        u.estimated ? 1 : 0,
        u.cacheReadKnown ? 1 : 0,
      );
  } catch (err) {
    console.error(`[openselect] updateRequestTokens failed: ${String(err)}`);
  }
}

/** 只在响应完整结束时记录耗时，历史记录保持未知。 */
export function updateRequestDuration(id: number, durationMs: number): void {
  try {
    if (Number.isFinite(durationMs) && durationMs > 0) {
      getDb().query("UPDATE requests SET duration_ms = ?2 WHERE id = ?1").run(id, Math.ceil(durationMs));
    }
  } catch (err) {
    console.error(`[openselect] updateRequestDuration failed: ${String(err)}`);
  }
}

export function updateRequestContentTiming(id: number, started: number, first: number, last: number, retryMs: number | null = null): void {
  try {
    if (first >= started && last >= first) getDb().query("UPDATE requests SET first_content_ms=?2, generation_ms=?3, retry_ms=?4 WHERE id=?1")
      .run(id, first - started, last > first ? last - first : null, retryMs);
  } catch (err) { console.error(`[openselect] updateRequestContentTiming failed: ${String(err)}`); }
}

export function recentRequests(limit = 50): Array<RequestLogEntry & { id: number }> {
  const rows = getDb().query(`SELECT * FROM requests ORDER BY ts DESC LIMIT ?1`).all(limit) as Array<{
    id: number;
    ts: number;
    session_id: string | null;
    model: string | null;
    served_model: string | null;
    family: string;
    account_id: string;
    provider: string | null;
    status: number;
    attempts: number;
    latency_ms: number;
    error: string | null;
    path: string;
    client: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    total_tokens: number | null;
    token_estimated: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    sessionId: r.session_id,
    model: r.model,
    servedModel: r.served_model ?? null,
    family: r.family as RequestLogEntry["family"],
    accountId: r.account_id,
    provider: r.provider ?? null,
    status: r.status,
    attempts: r.attempts,
    latencyMs: r.latency_ms,
    error: r.error,
    path: r.path,
    client: r.client ?? null,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    totalTokens: r.total_tokens,
    tokenEstimated: r.token_estimated == null ? null : Boolean(r.token_estimated),
  }));
}

export interface ModelUsageStat {
  model: string;
  requestedModels: string[];
  requests: number;
  ok: number;
  errors: number;
  avgLatencyMs: number;
  lastTs: number;
}

export interface AccountUsageStat {
  accountId: string;
  requests: number;
  ok: number;
  errors: number;
  avgLatencyMs: number;
  lastTs: number;
  models: string[];
}

export interface TimeUsageStat {
  bucket: string;
  key: string;
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export interface RequestTotals {
  requests: number;
  ok: number;
  errors: number;
  avgLatencyMs: number;
  models: number;
  accounts: number;
}

/** 实际服务模型：免费替换时 served_model 优先，否则用请求模型。 */
const EFFECTIVE_MODEL_SQL = `COALESCE(NULLIF(served_model, ''), model, 'unknown')`;

export function requestTotals(since: number, until: number): RequestTotals {
  const r = getDb()
    .query(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              AVG(latency_ms) AS avg_latency,
              COUNT(DISTINCT ${EFFECTIVE_MODEL_SQL}) AS models,
              COUNT(DISTINCT account_id) AS accounts
       FROM requests WHERE ts >= ?1 AND ts < ?2`,
    )
    .get(since, until) as {
    requests: number;
    ok: number | null;
    errors: number | null;
    avg_latency: number | null;
    models: number;
    accounts: number;
  };
  return {
    requests: Number(r.requests),
    ok: Number(r.ok ?? 0),
    errors: Number(r.errors ?? 0),
    avgLatencyMs: Number(r.avg_latency ?? 0),
    models: Number(r.models),
    accounts: Number(r.accounts),
  };
}

export function statsByModel(since: number, until: number): ModelUsageStat[] {
  const rows = getDb()
    .query(
      `SELECT ${EFFECTIVE_MODEL_SQL} AS model,
              GROUP_CONCAT(DISTINCT COALESCE(model, 'unknown')) AS requested_models,
              COUNT(*) AS requests,
              SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              AVG(latency_ms) AS avg_latency,
              MAX(ts) AS last_ts
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY ${EFFECTIVE_MODEL_SQL}
       ORDER BY requests DESC, model`,
    )
    .all(since, until) as Array<{
    model: string;
    requested_models: string | null;
    requests: number;
    ok: number | null;
    errors: number | null;
    avg_latency: number | null;
    last_ts: number;
  }>;
  return rows.map((r) => ({
    model: r.model,
    requestedModels: (r.requested_models ?? "").split(",").filter(Boolean),
    requests: Number(r.requests),
    ok: Number(r.ok ?? 0),
    errors: Number(r.errors ?? 0),
    avgLatencyMs: Number(r.avg_latency ?? 0),
    lastTs: Number(r.last_ts),
  }));
}

export function statsByAccount(since: number, until: number, knownIds?: Set<string>): AccountUsageStat[] {
  const rows = getDb()
    .query(
      `SELECT account_id,
              GROUP_CONCAT(DISTINCT ${EFFECTIVE_MODEL_SQL}) AS models,
              COUNT(*) AS requests,
              SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              SUM(latency_ms) AS latency_sum,
              MAX(ts) AS last_ts
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY account_id
       ORDER BY requests DESC, account_id`,
    )
    .all(since, until) as Array<{
    account_id: string | null;
    models: string | null;
    requests: number;
    ok: number | null;
    errors: number | null;
    latency_sum: number | null;
    last_ts: number;
  }>;
  // 失败请求的 account_id 可能是 "a → b → c" 尝试链；只保留真实配置账号 +
  // zen-local + "-"，其余合并成 __other__，避免统计页出现几十个“假账号”。
  const out = new Map<
    string,
    { accountId: string; requests: number; ok: number; errors: number; latencySum: number; lastTs: number; models: Set<string> }
  >();
  for (const r of rows) {
    const raw = r.account_id ?? "-";
    const id = knownIds && !knownIds.has(raw) && raw !== "zen-local" && raw !== "-" ? "__other__" : raw;
    const cur = out.get(id) ?? { accountId: id, requests: 0, ok: 0, errors: 0, latencySum: 0, lastTs: 0, models: new Set<string>() };
    cur.requests += Number(r.requests);
    cur.ok += Number(r.ok ?? 0);
    cur.errors += Number(r.errors ?? 0);
    cur.latencySum += Number(r.latency_sum ?? 0);
    cur.lastTs = Math.max(cur.lastTs, Number(r.last_ts));
    for (const m of (r.models ?? "").split(",").filter(Boolean)) cur.models.add(m);
    out.set(id, cur);
  }
  return [...out.values()]
    .map((r) => ({
      accountId: r.accountId,
      requests: r.requests,
      ok: r.ok,
      errors: r.errors,
      avgLatencyMs: r.requests ? r.latencySum / r.requests : 0,
      lastTs: r.lastTs,
      models: [...r.models],
    }))
    .sort((a, b) => b.requests - a.requests || (a.accountId < b.accountId ? -1 : 1));
}

export interface ModelAccountUsageStat {
  model: string;
  accountId: string;
  requests: number;
  errors: number;
  avgLatencyMs: number;
}

export function statsByModelAccount(since: number, until: number): ModelAccountUsageStat[] {
  const rows = getDb()
    .query(
      `SELECT ${EFFECTIVE_MODEL_SQL} AS model,
              account_id AS account_id,
              COUNT(*) AS requests,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              AVG(latency_ms) AS avg_latency
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY model, account_id
       ORDER BY requests DESC, model, account_id`,
    )
    .all(since, until) as Array<{
    model: string;
    account_id: string;
    requests: number;
    errors: number | null;
    avg_latency: number | null;
  }>;
  return rows.map((r) => ({
    model: r.model,
    accountId: r.account_id,
    requests: Number(r.requests),
    errors: Number(r.errors ?? 0),
    avgLatencyMs: Number(r.avg_latency ?? 0),
  }));
}

export function statsByTime(
  since: number,
  until: number,
  bucket: "hour" | "day",
  groupBy: "model" | "account",
): TimeUsageStat[] {
  const fmt = bucket === "hour" ? "%Y-%m-%d %H:00" : "%Y-%m-%d";
  const key = groupBy === "model" ? EFFECTIVE_MODEL_SQL : "account_id";
  const rows = getDb()
    .query(
      `SELECT strftime(?3, ts / 1000, 'unixepoch', 'localtime') AS bucket,
              ${key} AS key,
              COUNT(*) AS requests,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              AVG(latency_ms) AS avg_latency
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY bucket, key
       ORDER BY bucket DESC, requests DESC`,
    )
    .all(since, until, fmt) as Array<{
    bucket: string;
    key: string;
    requests: number;
    errors: number | null;
    avg_latency: number | null;
  }>;
  return rows.map((r) => ({
    bucket: r.bucket,
    key: r.key,
    requests: Number(r.requests),
    errors: Number(r.errors ?? 0),
    avgLatencyMs: Number(r.avg_latency ?? 0),
  }));
}

export interface TokenAggregate {
  requests: number;
  /** 有 usage 上报的请求数（total_tokens 非 NULL） */
  tokenRequests: number;
  /** 其中 usage 来自本地估算的请求数 */
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  /** 仅完整响应且上游上报输出用量的样本。 */
  outputTokensPerSecond: number | null;
  speedRequests: number;
  cacheReadTokens: number;
  cacheKnownRequests: number;
  cacheKnownInputTokens: number;
  cacheKnownReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  errors: number;
  avgLatencyMs: number;
  lastTs: number;
}

export type TokenTotals = TokenAggregate;

export interface ProviderTokenStat extends TokenAggregate {
  provider: string;
}

export interface ModelTokenStat extends TokenAggregate {
  model: string;
  provider: string;
}

export interface AccountTokenStat extends TokenAggregate {
  accountId: string;
  provider: string;
}

export interface TimeTokenStat extends TokenAggregate {
  bucket: string;
}

export interface ClientTokenStat extends TokenAggregate {
  client: string;
}

const TOKEN_AGG_SQL = `COUNT(*) AS requests,
  COUNT(total_tokens) AS token_requests,
  SUM(CASE WHEN token_estimated = 1 THEN 1 ELSE 0 END) AS estimated_requests,
  SUM(COALESCE(input_tokens, 0)) AS input_tokens,
  SUM(COALESCE(output_tokens, 0)) AS output_tokens,
  SUM(CASE WHEN duration_ms > 0 AND output_tokens > 0 AND token_estimated = 0 AND status >= 200 AND status < 300 THEN output_tokens ELSE 0 END) AS speed_output_tokens,
  SUM(CASE WHEN duration_ms > 0 AND output_tokens > 0 AND token_estimated = 0 AND status >= 200 AND status < 300 THEN duration_ms ELSE 0 END) AS speed_duration_ms,
  SUM(CASE WHEN duration_ms > 0 AND output_tokens > 0 AND token_estimated = 0 AND status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS speed_requests,
  SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
  SUM(CASE WHEN cache_read_known = 1 AND COALESCE(token_estimated, 0) = 0 THEN 1 ELSE 0 END) AS cache_known_requests,
  SUM(CASE WHEN cache_read_known = 1 AND COALESCE(token_estimated, 0) = 0 THEN COALESCE(input_tokens, 0) ELSE 0 END) AS cache_known_input_tokens,
  SUM(CASE WHEN cache_read_known = 1 AND COALESCE(token_estimated, 0) = 0 THEN COALESCE(cache_read_tokens, 0) ELSE 0 END) AS cache_known_read_tokens,
  SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
  SUM(COALESCE(total_tokens, 0)) AS total_tokens,
  SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
  AVG(latency_ms) AS avg_latency,
  MAX(ts) AS last_ts`;

interface TokenAggRow {
  requests: number;
  token_requests: number;
  estimated_requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  speed_output_tokens: number | null;
  speed_duration_ms: number | null;
  speed_requests: number | null;
  cache_read_tokens: number | null;
  cache_known_requests: number | null;
  cache_known_input_tokens: number | null;
  cache_known_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  errors: number | null;
  avg_latency: number | null;
  last_ts: number | null;
}

function mapTokenAgg(r: TokenAggRow): TokenAggregate {
  return {
    requests: Number(r.requests),
    tokenRequests: Number(r.token_requests),
    estimatedRequests: Number(r.estimated_requests ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    outputTokensPerSecond: r.speed_duration_ms ? Number(r.speed_output_tokens ?? 0) * 1000 / r.speed_duration_ms : null,
    speedRequests: Number(r.speed_requests ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheKnownRequests: Number(r.cache_known_requests ?? 0),
    cacheKnownInputTokens: Number(r.cache_known_input_tokens ?? 0),
    cacheKnownReadTokens: Number(r.cache_known_read_tokens ?? 0),
    cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
    totalTokens: Number(r.total_tokens ?? 0),
    errors: Number(r.errors ?? 0),
    avgLatencyMs: Number(r.avg_latency ?? 0),
    lastTs: Number(r.last_ts ?? 0),
  };
}

/** 仅完整且真实上报用量的成功请求；不读取请求正文或账号信息。 */
export function requestSpeedSamples(since: number, until: number): import("./speed_analysis").SpeedSample[] {
  return getDb().query(`SELECT ts, ${EFFECTIVE_MODEL_SQL} AS model,
    COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
    output_tokens AS outputTokens, duration_ms AS durationMs,
    first_content_ms AS firstContentMs, generation_ms AS generationMs, retry_ms AS retryMs,
    CASE WHEN latency_ms >= 0 AND latency_ms <= duration_ms THEN latency_ms ELSE NULL END AS waitMs,
    COALESCE(attempts, 1) AS attempts
    FROM requests WHERE ts >= ?1 AND ts < ?2 AND duration_ms > 0
    AND output_tokens > 0 AND token_estimated = 0 AND status >= 200 AND status < 300`)
    .all(since, until) as import("./speed_analysis").SpeedSample[];
}

export function tokenTotals(since: number, until: number): TokenTotals {
  const r = getDb()
    .query(`SELECT ${TOKEN_AGG_SQL} FROM requests WHERE ts >= ?1 AND ts < ?2`)
    .get(since, until) as TokenAggRow;
  return mapTokenAgg(r);
}

export function tokenStatsByProvider(since: number, until: number): ProviderTokenStat[] {
  const rows = getDb()
    .query(
      `SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS provider, ${TOKEN_AGG_SQL}
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY provider
       ORDER BY total_tokens DESC, requests DESC`,
    )
    .all(since, until) as Array<TokenAggRow & { provider: string }>;
  return rows.map((r) => ({ provider: r.provider, ...mapTokenAgg(r) }));
}

export function tokenStatsByModel(since: number, until: number): ModelTokenStat[] {
  const rows = getDb()
    .query(
      `SELECT ${EFFECTIVE_MODEL_SQL} AS model,
              COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
              ${TOKEN_AGG_SQL}
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY model, provider
       ORDER BY total_tokens DESC, requests DESC, model`,
    )
    .all(since, until) as Array<TokenAggRow & { model: string; provider: string }>;
  return rows.map((r) => ({ model: r.model, provider: r.provider, ...mapTokenAgg(r) }));
}

export function tokenStatsByAccount(since: number, until: number): AccountTokenStat[] {
  const rows = getDb()
    .query(
      `SELECT account_id AS accountId,
              COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
              ${TOKEN_AGG_SQL}
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY account_id, provider
       ORDER BY total_tokens DESC, requests DESC, accountId`,
    )
    .all(since, until) as Array<TokenAggRow & { accountId: string; provider: string }>;
  return rows.map((r) => ({ accountId: r.accountId, provider: r.provider, ...mapTokenAgg(r) }));
}

export function tokenStatsByTime(since: number, until: number, bucket: "hour" | "day"): TimeTokenStat[] {
  const fmt = bucket === "hour" ? "%Y-%m-%d %H:00" : "%Y-%m-%d";
  const rows = getDb()
    .query(
      `SELECT strftime(?3, ts / 1000, 'unixepoch', 'localtime') AS bucket, ${TOKEN_AGG_SQL}
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY bucket
       ORDER BY bucket ASC`,
    )
    .all(since, until, fmt) as Array<TokenAggRow & { bucket: string }>;
  return rows.map((r) => ({ bucket: r.bucket, ...mapTokenAgg(r) }));
}

export function tokenStatsByClient(since: number, until: number): ClientTokenStat[] {
  const rows = getDb()
    .query(
      `SELECT COALESCE(NULLIF(client, ''), 'unknown') AS client, ${TOKEN_AGG_SQL}
       FROM requests WHERE ts >= ?1 AND ts < ?2
       GROUP BY client
       ORDER BY total_tokens DESC, requests DESC`,
    )
    .all(since, until) as Array<TokenAggRow & { client: string }>;
  return rows.map((r) => ({ client: r.client, ...mapTokenAgg(r) }));
}

export interface RequestQueryOptions {
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
  client?: string;
  model?: string;
  accountId?: string;
  status?: "ok" | "error";
  q?: string;
}

export interface RequestQueryResult {
  rows: Array<RequestLogEntry & { id: number }>;
  total: number;
  summary: RequestTotals;
}

function mapRequestRow(r: {
  id: number;
  ts: number;
  session_id: string | null;
  model: string | null;
  served_model: string | null;
  family: string;
  account_id: string;
  provider: string | null;
  status: number;
  attempts: number;
  latency_ms: number;
  error: string | null;
  path: string;
  client: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  token_estimated: number | null;
}): RequestLogEntry & { id: number } {
  return {
    id: r.id,
    ts: r.ts,
    sessionId: r.session_id,
    model: r.model,
    servedModel: r.served_model ?? null,
    family: r.family as RequestLogEntry["family"],
    accountId: r.account_id,
    provider: r.provider ?? null,
    status: r.status,
    attempts: r.attempts,
    latencyMs: r.latency_ms,
    error: r.error,
    path: r.path,
    client: r.client ?? null,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    totalTokens: r.total_tokens,
    tokenEstimated: r.token_estimated == null ? null : Boolean(r.token_estimated),
  };
}

/** 请求流水查询：过滤 + 分页 + 同条件汇总。 */
export function queryRequests(opts: RequestQueryOptions = {}): RequestQueryResult {
  const where: string[] = ["ts >= ?", "ts < ?"];
  const params: Array<string | number> = [opts.since ?? 0, opts.until ?? Date.now() + 1];
  if (opts.client) {
    where.push("client = ?");
    params.push(opts.client);
  }
  if (opts.accountId) {
    // 成功请求是单账号；失败请求的 account_id 可能是 "a → b → c" 尝试链
    where.push("(account_id = ? OR account_id LIKE ?)");
    params.push(opts.accountId, `%${opts.accountId}%`);
  }
  if (opts.status === "ok") where.push("status < 400");
  else if (opts.status === "error") where.push("status >= 400");
  if (opts.model) {
    where.push("(model LIKE ? OR served_model LIKE ?)");
    const like = `%${opts.model}%`;
    params.push(like, like);
  }
  if (opts.q) {
    where.push("(session_id LIKE ? OR path LIKE ? OR error LIKE ? OR model LIKE ? OR served_model LIKE ? OR account_id LIKE ?)");
    const like = `%${opts.q}%`;
    params.push(like, like, like, like, like, like);
  }
  const w = where.join(" AND ");
  const totalRow = getDb().query(`SELECT COUNT(*) AS c FROM requests WHERE ${w}`).get(...params) as { c: number };
  const sumRow = getDb()
    .query(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              AVG(latency_ms) AS avg_latency,
              COUNT(DISTINCT ${EFFECTIVE_MODEL_SQL}) AS models,
              COUNT(DISTINCT account_id) AS accounts
       FROM requests WHERE ${w}`,
    )
    .get(...params) as {
    requests: number;
    ok: number | null;
    errors: number | null;
    avg_latency: number | null;
    models: number;
    accounts: number;
  };
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = getDb()
    .query(`SELECT * FROM requests WHERE ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<Parameters<typeof mapRequestRow>[0]>;
  return {
    rows: rows.map(mapRequestRow),
    total: Number(totalRow.c),
    summary: {
      requests: Number(sumRow.requests),
      ok: Number(sumRow.ok ?? 0),
      errors: Number(sumRow.errors ?? 0),
      avgLatencyMs: Number(sumRow.avg_latency ?? 0),
      models: Number(sumRow.models),
      accounts: Number(sumRow.accounts),
    },
  };
}

export interface SwitchQueryOptions {
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
  fromAccount?: string;
  toAccount?: string;
  reason?: string;
  q?: string;
  /** failover = 真实故障换号（排除 policy:* 会话重绑）；rebind = 仅会话重绑；all = 全部 */
  kind?: "failover" | "rebind" | "all";
}

export interface SwitchQueryResult {
  rows: Array<SwitchLogEntry & { id: number }>;
  total: number;
  summary: { total: number; failovers: number; rebinds: number; reasons: Array<{ reason: string; count: number }> };
}

function mapSwitchRow(r: {
  id: number;
  ts: number;
  session_id: string | null;
  from_account: string | null;
  to_account: string | null;
  reason: string;
  detail: string | null;
}): SwitchLogEntry & { id: number } {
  return {
    id: r.id,
    ts: r.ts,
    sessionId: r.session_id,
    fromAccount: r.from_account,
    toAccount: r.to_account,
    reason: r.reason,
    detail: r.detail,
  };
}

/** 切换记录查询：过滤 + 分页 + 同条件汇总。 */
export function querySwitches(opts: SwitchQueryOptions = {}): SwitchQueryResult {
  const where: string[] = ["ts >= ?", "ts < ?"];
  const params: Array<string | number> = [opts.since ?? 0, opts.until ?? Date.now() + 1];
  if (opts.kind === "failover") where.push("reason NOT LIKE 'policy:%'");
  else if (opts.kind === "rebind") where.push("reason LIKE 'policy:%'");
  if (opts.fromAccount) {
    where.push("from_account = ?");
    params.push(opts.fromAccount);
  }
  if (opts.toAccount) {
    where.push("to_account = ?");
    params.push(opts.toAccount);
  }
  if (opts.reason) {
    where.push("reason LIKE ?");
    params.push(`%${opts.reason}%`);
  }
  if (opts.q) {
    where.push("(session_id LIKE ? OR detail LIKE ? OR from_account LIKE ? OR to_account LIKE ? OR reason LIKE ?)");
    const like = `%${opts.q}%`;
    params.push(like, like, like, like, like);
  }
  const w = where.join(" AND ");
  const sumRow = getDb()
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN reason LIKE 'policy:%' THEN 1 ELSE 0 END) AS rebinds,
              SUM(CASE WHEN reason NOT LIKE 'policy:%' THEN 1 ELSE 0 END) AS failovers
       FROM switches WHERE ${w}`,
    )
    .get(...params) as { total: number; rebinds: number | null; failovers: number | null };
  const reasonRows = getDb()
    .query(`SELECT reason, COUNT(*) AS c FROM switches WHERE ${w} GROUP BY reason ORDER BY c DESC LIMIT 6`)
    .all(...params) as Array<{ reason: string; c: number }>;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = getDb()
    .query(`SELECT * FROM switches WHERE ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<Parameters<typeof mapSwitchRow>[0]>;
  return {
    rows: rows.map(mapSwitchRow),
    total: Number(sumRow.total),
    summary: {
      total: Number(sumRow.total),
      failovers: Number(sumRow.failovers ?? 0),
      rebinds: Number(sumRow.rebinds ?? 0),
      reasons: reasonRows.map((r) => ({ reason: r.reason, count: Number(r.c) })),
    },
  };
}

export function switchSummary(
  since: number,
  until: number,
): { total: number; failovers: number; rebinds: number; reasons: Array<{ reason: string; count: number }> } {
  const sumRow = getDb()
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN reason LIKE 'policy:%' THEN 1 ELSE 0 END) AS rebinds,
              SUM(CASE WHEN reason NOT LIKE 'policy:%' THEN 1 ELSE 0 END) AS failovers
       FROM switches WHERE ts >= ? AND ts < ?`,
    )
    .get(since, until) as { total: number; rebinds: number | null; failovers: number | null };
  const reasonRows = getDb()
    .query(`SELECT reason, COUNT(*) AS c FROM switches WHERE ts >= ? AND ts < ? GROUP BY reason ORDER BY c DESC LIMIT 6`)
    .all(since, until) as Array<{ reason: string; c: number }>;
  return {
    total: Number(sumRow.total),
    failovers: Number(sumRow.failovers ?? 0),
    rebinds: Number(sumRow.rebinds ?? 0),
    reasons: reasonRows.map((r) => ({ reason: r.reason, count: Number(r.c) })),
  };
}

/**
 * 按接入（客户端）汇总最近窗口内的请求数与最近一次实际服务的账号。
 * 窗口取最近 limit 条请求（与面板「最近请求」口径一致）。
 */
export function clientStats(limit = 500): Array<{ client: string; requests: number; lastAccountId: string | null; lastAt: number }> {
  // 请求数按窗口内全部请求统计；「最近服务的账号」只取**成功**请求
  // （失败请求的 account_id 记的是尝试链 "a → b → c" 或 "-"，不是账号 id）
  const rows = getDb()
    .query(
      `SELECT client, requests, lastAccountId, lastAt FROM (
         SELECT client,
                account_id AS lastAccountId,
                ts AS lastAt,
                count(*) OVER (PARTITION BY client) AS requests,
                row_number() OVER (PARTITION BY client ORDER BY ts DESC) AS rn
         FROM (
           SELECT client, account_id, ts, status FROM requests ORDER BY ts DESC LIMIT ?1
         )
         WHERE status < 400
       ) WHERE rn = 1`,
    )
    .all(limit) as Array<{ client: string | null; requests: number; lastAccountId: string | null; lastAt: number }>;
  // 窗口内没有成功请求的接入也要出现（请求数 > 0，服务账号为空）
  const counts = getDb()
    .query(
      `SELECT client, count(*) AS requests FROM (
         SELECT client FROM requests ORDER BY ts DESC LIMIT ?1
       ) GROUP BY client`,
    )
    .all(limit) as Array<{ client: string | null; requests: number }>;
  const out = new Map<string, { client: string; requests: number; lastAccountId: string | null; lastAt: number }>();
  for (const c of counts) {
    out.set(c.client ?? "other", { client: c.client ?? "other", requests: Number(c.requests), lastAccountId: null, lastAt: 0 });
  }
  for (const r of rows) {
    const key = r.client ?? "other";
    const prev = out.get(key) ?? { client: key, requests: 0, lastAccountId: null, lastAt: 0 };
    out.set(key, {
      client: key,
      requests: Math.max(prev.requests, Number(r.requests)),
      lastAccountId: r.lastAccountId ?? null,
      lastAt: Number(r.lastAt),
    });
  }
  return [...out.values()];
}

export function logSwitch(e: SwitchLogEntry): void {
  try {
    getDb()
      .query(`INSERT INTO switches (ts, session_id, from_account, to_account, reason, detail) VALUES (?1,?2,?3,?4,?5,?6)`)
      .run(e.ts, e.sessionId, e.fromAccount, e.toAccount, e.reason, e.detail);
  } catch (err) {
    // telemetry must never break a proxied request
    console.error(`[openselect] logSwitch failed: ${String(err)}`);
  }
}

export function recentSwitches(limit = 50): Array<SwitchLogEntry & { id: number }> {
  const rows = getDb().query(`SELECT * FROM switches ORDER BY ts DESC LIMIT ?1`).all(limit) as Array<{
    id: number;
    ts: number;
    session_id: string | null;
    from_account: string | null;
    to_account: string | null;
    reason: string;
    detail: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    sessionId: r.session_id,
    fromAccount: r.from_account,
    toAccount: r.to_account,
    reason: r.reason,
    detail: r.detail,
  }));
}

/** 旧解析器（把 0..100 的低百分比当成 0..1 比例）污染的用量快照：窗口值 >= 1 且该窗口状态为 ok。 */
export interface PollutedUsageRow {
  id: number;
  accountId: string;
  ts: number;
  window: "rolling" | "weekly" | "monthly";
  value: number;
}

const USAGE_WINDOWS = ["rolling", "weekly", "monthly"] as const;

/** 找出被旧解析器放大的用量快照行（真实达到 100% 的窗口上游会标 rate-limited，不会命中）。 */
export function pollutedUsageRows(db: Database, beforeTs?: number): PollutedUsageRow[] {
  const out: PollutedUsageRow[] = [];
  const bound = beforeTs ?? Number.POSITIVE_INFINITY;
  for (const w of USAGE_WINDOWS) {
    const rows = db
      .query(
        `SELECT id, account_id, ts, ${w}_pct AS pct FROM usage_snapshots WHERE ${w}_pct >= 1 AND ${w}_status = 'ok'`,
      )
      .all() as Array<{ id: number; account_id: string; ts: number; pct: number }>;
    for (const r of rows) {
      if (r.ts >= bound) continue; // 只处理旧解析器生效期内写入的行
      out.push({ id: r.id, accountId: r.account_id, ts: r.ts, window: w, value: r.pct });
    }
  }
  return out;
}

/**
 * 定向清理污染的用量快照：把被放大的窗口值按「存值/100」近似还原。
 * 说明：旧解析器对 raw <= 2 直接存 raw（未除 100）→ 真实值 ≈ 存值/100（存 1.0 → 0.01 精确；存 1.5 → 0.015，真值区间 [0.015,0.02]）。
 * 这是**近似**修正，不是精确还原；落在 (0,1) 的存值无法与真实值区分，一律不动。
 *
 * db 必须显式传入（CLI 传 getDb()，测试传独立台账）——避免"漏传参数就写默认台账"的形状。
 * beforeTs 默认只处理 USAGE_SCALE_FIXED_AT 之前的行（旧解析器生效期），防止误伤将来合法的 100%+ok 行。
 */
export function repairPollutedUsage(opts: {
  apply: boolean;
  db: Database;
  beforeTs?: number;
}): { scanned: number; fixed: number; byWindow: Record<string, number>; accounts: string[] } {
  const { apply, db, beforeTs } = opts;
  const rows = pollutedUsageRows(db, beforeTs ?? USAGE_SCALE_FIXED_AT);
  const byWindow: Record<string, number> = {};
  const accounts = new Set<string>();
  let fixed = 0;
  for (const r of rows) {
    byWindow[r.window] = (byWindow[r.window] ?? 0) + 1;
    accounts.add(r.accountId);
    if (!apply) continue;
    db.query(`UPDATE usage_snapshots SET ${r.window}_pct = ? WHERE id = ?`).run(r.value / 100, r.id);
    fixed++;
  }
  return { scanned: rows.length, fixed, byWindow, accounts: [...accounts] };
}

/* ── 用量阈值告警 ────────────────────────────────────────────── */

export interface AlertRow {
  ts: number;
  accountId: string;
  window: string;
  threshold: number;
  percent: number;
  /** 1 = 仍处于越线中（已武装）；0 = 已回落（历史保留，可再次触发） */
  active: boolean;
  /** 越线时该窗口的状态（如 rate-limited / ok） */
  status: string | null;
}

/** 记录一次越线告警（历史行，active=1 表示仍处于越线中） */
export function insertAlert(
  a: {
    ts: number;
    accountId: string;
    window: string;
    threshold: number;
    percent: number;
    status?: string | null;
  },
  db?: Database,
): void {
  try {
    (db ?? getDb())
      .query(
        `INSERT INTO alerts (ts, account_id, window, threshold, percent, active, status) VALUES (?1,?2,?3,?4,?5,1,?6)`,
      )
      .run(a.ts, a.accountId, a.window, a.threshold, a.percent, a.status ?? null);
  } catch (err) {
    console.error(`[openselect] insertAlert failed: ${String(err)}`);
  }
}

/** 某账号某窗口某档阈值的最近一次告警（不论是否仍越线：用于去重与冷却判定） */
export function lastAlert(
  accountId: string,
  window: string,
  threshold: number,
  db?: Database,
): { ts: number; percent: number; active: boolean; status: string | null } | null {
  const r = (db ?? getDb())
    .query(
      `SELECT ts, percent, active, status FROM alerts WHERE account_id = ?1 AND window = ?2 AND threshold = ?3 ORDER BY ts DESC LIMIT 1`,
    )
    .get(accountId, window, threshold) as
    | { ts: number; percent: number; active: number; status: string | null }
    | null;
  if (!r) return null;
  return { ts: r.ts, percent: r.percent, active: !!r.active, status: r.status };
}

/** 解除告警（用量回落到阈值以下）→ 保留历史行，仅标记为不再越线 */
export function disarmAlert(accountId: string, window: string, threshold: number, db?: Database): void {
  try {
    (db ?? getDb())
      .query(`UPDATE alerts SET active = 0 WHERE account_id = ?1 AND window = ?2 AND threshold = ?3 AND active = 1`)
      .run(accountId, window, threshold);
  } catch (err) {
    console.error(`[openselect] disarmAlert failed: ${String(err)}`);
  }
}

/** 最近告警历史（新 → 旧，含已回落的记录） */
export function recentAlerts(limit = 20, db?: Database): AlertRow[] {
  const rows = (db ?? getDb())
    .query(
      `SELECT ts, account_id, window, threshold, percent, active, status FROM alerts ORDER BY ts DESC LIMIT ?1`,
    )
    .all(limit) as Array<{
    ts: number;
    account_id: string;
    window: string;
    threshold: number;
    percent: number;
    active: number;
    status: string | null;
  }>;
  return rows.map((r) => ({
    ts: r.ts,
    accountId: r.account_id,
    window: r.window,
    threshold: r.threshold,
    percent: r.percent,
    active: !!r.active,
    status: r.status,
  }));
}

export function setState(s: Partial<AccountState> & { accountId: string }): void {
  const cur = getState(s.accountId);
  const next: AccountState = {
    accountId: s.accountId,
    cooldownUntil: s.cooldownUntil ?? cur?.cooldownUntil ?? 0,
    lastError: s.lastError !== undefined ? s.lastError : cur?.lastError ?? null,
    lastUsed: s.lastUsed ?? cur?.lastUsed ?? 0,
    invalid: s.invalid ?? cur?.invalid ?? false,
  };
  getDb()
    .query(
      `INSERT INTO account_state (account_id, cooldown_until, last_error, last_used, invalid)
       VALUES (?1,?2,?3,?4,?5)
       ON CONFLICT(account_id) DO UPDATE SET cooldown_until=excluded.cooldown_until, last_error=excluded.last_error, last_used=excluded.last_used, invalid=excluded.invalid`,
    )
    .run(next.accountId, next.cooldownUntil, next.lastError, next.lastUsed, next.invalid ? 1 : 0);
}

export function getState(accountId: string): AccountState | null {
  const r = getDb().query(`SELECT * FROM account_state WHERE account_id = ?1`).get(accountId) as
    | { account_id: string; cooldown_until: number; last_error: string | null; last_used: number; invalid: number }
    | null;
  if (!r) return null;
  return {
    accountId: r.account_id,
    cooldownUntil: r.cooldown_until,
    lastError: r.last_error,
    lastUsed: r.last_used,
    invalid: !!r.invalid,
  };
}

export function allStates(): AccountState[] {
  const rows = getDb().query(`SELECT * FROM account_state`).all() as Array<{
    account_id: string;
    cooldown_until: number;
    last_error: string | null;
    last_used: number;
    invalid: number;
  }>;
  return rows.map((r) => ({
    accountId: r.account_id,
    cooldownUntil: r.cooldown_until,
    lastError: r.last_error,
    lastUsed: r.last_used,
    invalid: !!r.invalid,
  }));
}
