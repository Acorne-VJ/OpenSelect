import { PAGE_LOCALE } from "./page_locale";
import { buildSpeedAnalysis } from "./speed_analysis";
import { loadCatalog } from "./catalog";
import {
  tokenStatsByTime,
  requestSpeedSamples,
  getDb,
  type AccountTokenStat,
  type ClientTokenStat,
  type ModelTokenStat,
  type ProviderTokenStat,
  type TimeTokenStat,
  type TokenTotals,
} from "./db";
import type { ModelInfo } from "./types";
import type { Runtime } from "./state";
import { navHtml } from "./ui";

export interface CostedTotals extends TokenTotals {
  costUsd: number | null;
}

export interface CostedProviderTokenStat extends ProviderTokenStat {
  costUsd: number | null;
}

export interface CostedModelTokenStat extends ModelTokenStat {
  costUsd: number | null;
}

export interface TokenStatsData {
  now: number;
  range: string;
  bucket: "hour" | "day";
  since: number;
  totals: CostedTotals;
  speedAnalysis: ReturnType<typeof buildSpeedAnalysis>;
  byProvider: CostedProviderTokenStat[];
  byModel: CostedModelTokenStat[];
  byAccount: AccountTokenStat[];
  byTime: TimeTokenStat[];
  activity: TimeTokenStat[];
  rhythm: TimeTokenStat[];
  byClient: ClientTokenStat[];
  accounts: Array<{ id: string; label: string; integration: string; enabled: boolean }>;
}

function parseRange(raw: string | null, now = Date.now()): { range: string; since: number; bucket: "hour" | "day" } {
  const range = raw === "today" || raw === "7d" || raw === "30d" || raw === "24h" || raw === "all" ? raw : "24h";
  let since = now - 24 * 3600_000;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    since = d.getTime();
  } else if (range === "7d") {
    since = now - 7 * 24 * 3600_000;
  } else if (range === "30d") {
    since = now - 30 * 24 * 3600_000;
  } else if (range === "all") {
    since = 0;
  }
  return { range, since, bucket: range === "7d" || range === "30d" || range === "all" ? "day" : "hour" };
}

function findModelInfo(catalog: Awaited<ReturnType<typeof loadCatalog>>, model: string, provider: string): ModelInfo | undefined {
  const direct = catalog.models[model];
  if (direct) return direct;
  return Object.values(catalog.models).find(
    (m) => m.upstreamModel === model && (m.provider === provider || !m.provider),
  );
}

function estimateCost(info: ModelInfo | undefined, t: TokenTotals): number | null {
  if (!info) return null;
  if (info.free) return 0;
  const c = info.cost;
  if (!c || (c.input === 0 && c.output === 0 && !c.cacheRead && !c.cacheWrite)) return null;
  return (
    (t.inputTokens / 1_000_000) * c.input +
    (t.outputTokens / 1_000_000) * c.output +
    (t.cacheReadTokens / 1_000_000) * (c.cacheRead ?? c.input) +
    (t.cacheWriteTokens / 1_000_000) * (c.cacheWrite ?? c.input)
  );
}

// A short, bounded snapshot avoids repeating the expensive aggregates when
// several clients refresh together. Both local and external SQLite writes
// invalidate it, including usage/duration updates to an existing request.
const TOKEN_STATS_CACHE_MS = 2000;
const tokenStatsCache = new WeakMap<Runtime, Map<string, {
  version: string; catalog: Awaited<ReturnType<typeof loadCatalog>>; data: TokenStatsData; expires: number;
}>>();

function statsDbVersion(): string {
  const db = getDb();
  const own = db.query("SELECT total_changes() AS value").get() as { value: number };
  const other = db.query("PRAGMA data_version").get() as { data_version: number };
  return `${own.value}:${other.data_version}`;
}

/** Materialize the selected rows once, then group the in-memory snapshot. */
function groupedTokenStats(since: number, until: number): {
  totals: TokenTotals; models: ModelTokenStat[]; providers: ProviderTokenStat[];
  accounts: AccountTokenStat[]; clients: ClientTokenStat[];
} {
  const agg = `COUNT(*) requests, COUNT(total_tokens) token_requests,
    SUM(CASE WHEN token_estimated=1 THEN 1 ELSE 0 END) estimated_requests,
    SUM(COALESCE(input_tokens,0)) input_tokens, SUM(COALESCE(output_tokens,0)) output_tokens,
    SUM(CASE WHEN duration_ms>0 AND output_tokens>0 AND token_estimated=0 AND status>=200 AND status<300 THEN output_tokens ELSE 0 END) speed_output,
    SUM(CASE WHEN duration_ms>0 AND output_tokens>0 AND token_estimated=0 AND status>=200 AND status<300 THEN duration_ms ELSE 0 END) speed_duration,
    SUM(CASE WHEN duration_ms>0 AND output_tokens>0 AND token_estimated=0 AND status>=200 AND status<300 THEN 1 ELSE 0 END) speed_requests,
    SUM(COALESCE(cache_read_tokens,0)) cache_read_tokens,
    SUM(CASE WHEN cache_read_known=1 AND COALESCE(token_estimated,0)=0 THEN 1 ELSE 0 END) cache_known_requests,
    SUM(CASE WHEN cache_read_known=1 AND COALESCE(token_estimated,0)=0 THEN COALESCE(input_tokens,0) ELSE 0 END) cache_known_input,
    SUM(CASE WHEN cache_read_known=1 AND COALESCE(token_estimated,0)=0 THEN COALESCE(cache_read_tokens,0) ELSE 0 END) cache_known_read,
    SUM(COALESCE(cache_write_tokens,0)) cache_write_tokens, SUM(COALESCE(total_tokens,0)) total_tokens,
    SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) errors, AVG(latency_ms) avg_latency, MAX(ts) last_ts`;
  const source = `WITH base AS MATERIALIZED (SELECT ts, model, served_model, provider, account_id, client, status, latency_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_read_known, cache_write_tokens, total_tokens, token_estimated, duration_ms
      FROM requests WHERE ts>=?1 AND ts<?2) `;
  const statements = [
    `SELECT 't' kind, NULL k1, NULL k2, ${agg} FROM base`,
    `SELECT 'm', COALESCE(NULLIF(served_model,''),model,'unknown'), COALESCE(NULLIF(provider,''),'unknown'), ${agg} FROM base GROUP BY model, provider`,
    `SELECT 'p', COALESCE(NULLIF(provider,''),'unknown'), NULL, ${agg} FROM base GROUP BY provider`,
    `SELECT 'a', account_id, COALESCE(NULLIF(provider,''),'unknown'), ${agg} FROM base GROUP BY account_id, provider`,
    `SELECT 'c', COALESCE(NULLIF(client,''),'unknown'), NULL, ${agg} FROM base GROUP BY client`,
  ];
  type Row = { kind: string; k1: string; k2: string; [k: string]: string | number | null };
  const rows = getDb().query(source + statements.join(" UNION ALL ")).all(since, until) as Row[];
  const cast = (r: Row): TokenTotals => ({
    requests: Number(r.requests), tokenRequests: Number(r.token_requests), estimatedRequests: Number(r.estimated_requests ?? 0),
    inputTokens: Number(r.input_tokens ?? 0), outputTokens: Number(r.output_tokens ?? 0),
    outputTokensPerSecond: r.speed_duration ? Number(r.speed_output ?? 0) * 1000 / Number(r.speed_duration) : null,
    speedRequests: Number(r.speed_requests ?? 0), cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheKnownRequests: Number(r.cache_known_requests ?? 0), cacheKnownInputTokens: Number(r.cache_known_input ?? 0),
    cacheKnownReadTokens: Number(r.cache_known_read ?? 0), cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
    totalTokens: Number(r.total_tokens ?? 0), errors: Number(r.errors ?? 0), avgLatencyMs: Number(r.avg_latency ?? 0), lastTs: Number(r.last_ts ?? 0),
  });
  const totals = cast(rows.find((r) => r.kind === 't')!);
  const models = rows.filter((r) => r.kind === 'm').map((r) => ({ model: r.k1, provider: r.k2, ...cast(r) }));
  const providers = rows.filter((r) => r.kind === 'p').map((r) => ({ provider: r.k1, ...cast(r) }));
  const accounts = rows.filter((r) => r.kind === 'a').map((r) => ({ accountId: r.k1, provider: r.k2, ...cast(r) }));
  const clients = rows.filter((r) => r.kind === 'c').map((r) => ({ client: r.k1, ...cast(r) }));
  const sort = (a: TokenTotals, b: TokenTotals) => b.totalTokens - a.totalTokens || b.requests - a.requests;
  const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  models.sort((a, b) => sort(a, b) || compareText(a.model, b.model));
  providers.sort(sort); accounts.sort((a, b) => sort(a, b) || compareText(a.accountId ?? '', b.accountId ?? '')); clients.sort(sort);
  return { totals, models, providers, accounts, clients };
}

export async function buildTokenStats(rt: Runtime, url: URL): Promise<TokenStatsData> {
  const now = Date.now();
  const { range, since, bucket: defaultBucket } = parseRange(url.searchParams.get("range"), now);
  const bucket = url.searchParams.get("bucket") === "hour" ? "hour" : url.searchParams.get("bucket") === "day" ? "day" : defaultBucket;
  const until = now + 1;

  const catalog = await loadCatalog();
  const minOutput = [0, 100, 500].includes(Number(url.searchParams.get("speedMin"))) && url.searchParams.has("speedMin") ? Number(url.searchParams.get("speedMin")) : 100;
  const key = `${range}:${bucket}:${minOutput}`;
  const version = statsDbVersion();
  let cache = tokenStatsCache.get(rt);
  if (!cache) { cache = new Map(); tokenStatsCache.set(rt, cache); }
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now() && cached.version === version && cached.catalog === catalog) {
    return { ...cached.data, accounts: rt.config.accounts.map((a) => ({ id: a.id, label: a.label, integration: a.integration, enabled: a.enabled })) };
  }
  const grouped = groupedTokenStats(since, until);
  const totals = grouped.totals;
  const byModel = grouped.models.map((m) => ({
    ...m,
    costUsd: estimateCost(findModelInfo(catalog, m.model, m.provider), m),
  }));
  const byProvider = grouped.providers.map((p) => {
    let cost: number | null = null;
    for (const m of byModel) {
      if (m.provider !== p.provider || m.costUsd == null) continue;
      cost = (cost ?? 0) + m.costUsd;
    }
    return { ...p, costUsd: cost };
  });
  let totalCost: number | null = null;
  for (const m of byModel) {
    if (m.costUsd == null) continue;
    totalCost = (totalCost ?? 0) + m.costUsd;
  }

  const byTime = tokenStatsByTime(since, until, bucket);
  // The 24h/hour views cover exactly the same time window.
  const rhythm = range === "24h" && bucket === "hour" ? byTime : tokenStatsByTime(now - 24 * 3600_000, until, "hour");
  const data: TokenStatsData = {
    now,
    range,
    bucket,
    since,
    totals: { ...totals, costUsd: totalCost },
    speedAnalysis: buildSpeedAnalysis(requestSpeedSamples(since, until), minOutput, bucket === "hour" ? 3600_000 : 86400_000),
    byProvider,
    byModel,
    byAccount: grouped.accounts,
    byTime,
    activity: tokenStatsByTime(now - 91 * 24 * 3600_000, until, "day"),
    rhythm,
    byClient: grouped.clients,
    accounts: rt.config.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      integration: a.integration,
      enabled: a.enabled,
    })),
  };
  if (statsDbVersion() === version) {
    if (cache.size >= 32) cache.clear();
    cache.set(key, { version, catalog, data, expires: Date.now() + TOKEN_STATS_CACHE_MS });
  }
  return data;
}

export function tokenStatsPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>OpenSelect · Token 消费统计</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f17; --panel:#121924; --panel2:#0f1621; --line:#223047; --text:#e6edf3; --muted:#8b98a9; --blue:#4c8dff; --cyan:#36d6c3; --purple:#a879ff; --green:#3fb950; --red:#f85149; --amber:#d29922; }
  * { box-sizing: border-box; }
  body { margin:0; background: radial-gradient(1200px 600px at 10% -10%, #16233b 0%, var(--bg) 45%, #080b11 100%); color:var(--text); font:14px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  a { color:inherit; text-decoration:none; }
  header.top { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:18px; padding:14px 26px; background:rgba(11,15,23,.86); backdrop-filter:blur(16px); border-bottom:1px solid rgba(34,48,71,.8); flex-wrap:wrap; }
  .brand { font-weight:800; letter-spacing:.3px; font-size:16px; }
  .brand span { color:var(--blue); }
  nav { display:flex; gap:6px; flex-wrap:wrap; }
  nav a { padding:7px 12px; border-radius:9px; color:var(--muted); font-size:13px; }
  nav a:hover { color:var(--text); background:#182235; }
  nav a.active { color:#fff; background:#1b2a45; box-shadow:inset 0 0 0 1px #2c4b7d; }
  .top .right { margin-left:auto; display:flex; gap:8px; align-items:center; }
  .btn { border:1px solid var(--line); background:#172235; color:var(--text); border-radius:9px; padding:7px 12px; font-size:12.5px; cursor:pointer; }
  .btn:hover { background:#1d2b43; }
  .btn.primary { background:#1e5eff; border-color:#3b7bff; }
  .btn.primary:hover { background:#2f6bff; }
  main { max-width:1500px; margin:0 auto; padding:24px 26px 70px; }
  .hero { display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap; margin:6px 0 18px; }
  .hero h1 { margin:0; font-size:26px; letter-spacing:-.4px; }
  .hero p { margin:6px 0 0; color:var(--muted); font-size:12.5px; }
  .filters { display:flex; gap:10px; align-items:center; flex-wrap:wrap; padding:10px 12px; background:rgba(18,25,36,.8); border:1px solid var(--line); border-radius:12px; }
  .filters label { color:var(--muted); font-size:12px; display:flex; gap:6px; align-items:center; }
  select { background:#0b111b; color:var(--text); border:1px solid #2a3a54; border-radius:7px; padding:6px 8px; font-size:12.5px; }
  .msg { color:var(--muted); font-size:12px; }
  .msg.bad { color:var(--red); }
  .cards { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:14px; margin:16px 0 20px; }
  .card { background:linear-gradient(180deg, rgba(20,29,44,.95), rgba(14,21,32,.95)); border:1px solid var(--line); border-radius:14px; padding:16px 16px 12px; min-width:0; overflow:hidden; position:relative; }
  .card:before { content:""; position:absolute; inset:0 0 auto 0; height:2px; background:linear-gradient(90deg, var(--blue), transparent); opacity:.8; }
  .card.purple:before { background:linear-gradient(90deg, var(--purple), transparent); }
  .card.cyan:before { background:linear-gradient(90deg, var(--cyan), transparent); }
  .card.green:before { background:linear-gradient(90deg, var(--green), transparent); }
  .lbl { color:var(--muted); font-size:12px; display:flex; justify-content:space-between; gap:8px; }
  .big { font-size:29px; font-weight:800; letter-spacing:-.8px; margin:5px 0 2px; }
  .sub { color:var(--muted); font-size:11.5px; min-height:18px; }
  .spark { width:100%; height:34px; display:block; margin-top:6px; opacity:.9; }
  h2 { font-size:14px; color:#c7d3e3; margin:24px 0 10px; font-weight:600; }
  h2 .muted { font-size:11.5px; font-weight:400; }
  .tablewrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:rgba(15,22,33,.72); }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th,td { text-align:left; padding:8px 11px; border-bottom:1px solid rgba(34,48,71,.7); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; background:rgba(18,25,36,.7); }
  tbody tr:hover { background:rgba(29,43,67,.35); }
  tbody tr:last-child td { border-bottom:0; }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color:var(--muted); }
  .ok { color:var(--green); }
  .bad { color:var(--red); }
  .warn { color:var(--amber); }
  .pill { display:inline-block; padding:1px 7px; border-radius:999px; font-size:10.5px; border:1px solid #2a3a54; color:var(--muted); }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:7px; vertical-align:1px; }
  .split { display:grid; grid-template-columns:1fr 1fr; gap:14px; min-width:0; }
  .split > div { min-width:0; }
  .tablewrap { min-width:0; max-width:100%; }
  .chart { padding:12px 12px 6px; }
  .heatmap { display:grid; grid-template-columns:repeat(13,minmax(0,1fr)); grid-template-rows:repeat(7,15px); grid-auto-flow:column; gap:3px; margin-top:10px; }
  .heat { border-radius:3px; background:#182235; border:1px solid #1f2c42; min-width:0; }
  .heat.l1 { background:#17335c; border-color:#1f4477; }
  .heat.l2 { background:#1e5eff; border-color:#2f6bff; }
  .heat.l3 { background:#4c8dff; border-color:#6ba0ff; }
  .heat.l4 { background:#8cc0ff; border-color:#a8d0ff; }
  .heat.future { background:transparent; border-color:transparent; }
  .heat-legend { display:flex; gap:6px; align-items:center; margin-top:8px; color:var(--muted); font-size:10.5px; }
  .heat-legend i { width:11px; height:11px; border-radius:2px; display:inline-block; }
  .rhythm { display:flex; align-items:flex-end; gap:4px; height:150px; margin-top:10px; padding:8px 4px 0; border-bottom:1px solid #223047; }
  .rhythm .rb { flex:1; min-width:3px; height:100%; display:flex; align-items:flex-end; }
  .rhythm .rf { display:block; width:100%; background:linear-gradient(180deg,#4c8dff,#1e5eff); border-radius:3px 3px 0 0; min-height:2px; opacity:.9; }
  .rhythm-labels { display:flex; justify-content:space-between; color:var(--muted); font-size:10px; margin-top:4px; }
  .heat-meta { color:var(--muted); font-size:11px; margin-top:8px; }
  .chart svg { width:100%; height:240px; display:block; }
  .chart .empty { color:var(--muted); padding:40px 10px; text-align:center; }
  .chart-tip { position:fixed; z-index:1000; max-width:min(360px, calc(100vw - 16px)); padding:9px 12px; border:1px solid #3d5980; border-radius:8px; background:#111d2d; color:#e8f1ff; font-size:12px; box-shadow:0 6px 22px #0008; pointer-events:none; }
  .chart-tip[hidden] { display:none; }
  [data-chart-tip] { cursor:crosshair; }
  [data-chart-tip]:focus-visible { outline:2px solid #8cc0ff; outline-offset:2px; }
  .note { color:var(--muted); font-size:11.5px; margin-top:8px; line-height:1.7; }
  footer { color:var(--muted); font-size:11.5px; text-align:center; padding:20px 0 0; }
  @media (max-width: 1200px) { .cards { grid-template-columns:repeat(2,minmax(0,1fr)); } .split { grid-template-columns:1fr; } }
  @media (max-width: 620px) {
    main { padding:18px 14px 50px; }
    .cards { grid-template-columns:1fr; }
    .hero h1 { font-size:21px; }
    header.top { padding:12px 14px; }
    .top .right { display:none; }
    nav { order:3; width:100%; flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; }
    nav::-webkit-scrollbar { display:none; }
    nav a { flex:0 0 auto; }
  }
</style>
</head>
<body>
${navHtml("tokens")}
<main>
  <div class="hero">
    <div>
      <h1>Token 消费统计</h1>
      <p>按供应商、账号、模型与时间追踪上游 usage；本地估算单独标记，缺失上报显示“未上报”。</p>
    </div>
    <div class="filters">
      <label>范围
        <select id="range">
          <option value="today">今天</option>
          <option value="24h" selected>最近 24 小时</option>
          <option value="7d">最近 7 天</option>
          <option value="30d">最近 30 天</option>
          <option value="all">全部历史</option>
        </select>
      </label>
      <label>粒度
        <select id="bucket">
          <option value="hour" selected>按小时</option>
          <option value="day">按天</option>
        </select>
      </label>
      <button class="btn primary" id="refresh">刷新</button>
      <span class="msg" id="msg"></span>
    </div>
  </div>

  <div class="cards">
    <div class="card">
      <div class="lbl"><span>总 Token</span><span class="pill" id="tokenRows">—</span></div>
      <div class="big" id="totalTokens">—</div>
      <div class="sub" id="totalSub">输入 — / 输出 —</div>
      <svg class="spark" id="sparkTotal" viewBox="0 0 240 34" preserveAspectRatio="none"></svg>
    </div>
    <div class="card purple">
      <div class="lbl"><span>理论参考费用</span><span class="pill">已知单价</span></div>
      <div class="big" id="totalCost">—</div>
      <div class="sub" id="costSub">不含订阅费 / 税费</div>
      <svg class="spark" id="sparkCost" viewBox="0 0 240 34" preserveAspectRatio="none"></svg>
    </div>
    <div class="card cyan">
      <div class="lbl"><span>缓存命中</span><span class="pill" id="cachePill">—</span></div>
      <div class="big" id="cacheHit">—</div>
      <div class="sub" id="cacheSub">缓存读取 —</div>
      <svg class="spark" id="sparkCache" viewBox="0 0 240 34" preserveAspectRatio="none"></svg>
    </div>
    <div class="card green">
      <div class="lbl"><span>活跃账号 / 模型</span><span class="pill" id="reqPill">—</span></div>
      <div class="big" id="active">—</div>
      <div class="sub" id="activeSub">连接数 —</div>
      <svg class="spark" id="sparkReq" viewBox="0 0 240 34" preserveAspectRatio="none"></svg>
    </div>
    <div class="card">
      <div class="lbl"><span id="speedLabel">平均输出速度</span><span class="pill" id="speedPill">—</span></div>
      <div class="big" id="speed">—</div>
      <div class="sub" id="speedSub">输出 Token / 完整耗时（含等待）</div>
    </div>
  </div>

  <section id="speedAnalysis">
    <h2 id="analysisTitle">输出速度分析</h2>
    <div class="filters">
      <label><span id="analysisModelLabel">模型 / 供应商</span> <select id="analysisModel"><option value="">全部</option></select></label>
      <label><span id="analysisMinLabel">最少输出 Token</span> <select id="analysisMin"><option value="100" selected>100</option><option value="0">0</option><option value="500">500</option></select></label>
    </div>
    <p class="note" id="analysisScope"></p>
    <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr))">
      <div class="card"><div id="analysisMedianLabel" class="lbl"></div><div id="analysisMedian" class="big">—</div><div id="analysisSpread" class="sub"></div></div>
      <div class="card"><div id="analysisSlowLabel" class="lbl"></div><div id="analysisSlow" class="big">—</div><div id="analysisSlowCount" class="sub"></div></div>
      <div class="card"><div id="analysisWaitLabel" class="lbl"></div><div id="analysisWait" class="big">—</div><div id="analysisWaitCount" class="sub"></div></div>
      <div class="card"><div class="lbl" id="contentWaitLabel"></div><div class="big" id="contentWait">—</div><div class="sub" id="contentSamples"></div></div>
      <div class="card"><div class="lbl" id="generationLabel"></div><div class="big" id="generationSpeed">—</div><div class="sub" id="generationSamples"></div></div>
      <div class="card"><div id="analysisRetryLabel" class="lbl"></div><div id="analysisRetry" class="big">—</div><div id="analysisRetryCount" class="sub"></div></div>
    </div>
    <p id="analysisInsight" class="note"></p>
    <div class="split">
      <div class="card"><h2 id="distributionTitle" style="margin-top:0"></h2><div id="speedDistribution" class="rhythm"></div><div class="rhythm-labels"><span>&lt;20</span><span>20–50</span><span>50–100</span><span>100–150</span><span>≥150 tokens/s</span></div></div>
      <div class="card"><h2 id="speedTrendTitle" style="margin-top:0"></h2><div id="speedTrend" class="chart"></div></div>
    </div>
    <h2 id="speedCompareTitle"></h2>
    <div class="tablewrap"><table><thead id="speedCompareHead"></thead><tbody id="speedCompareRows"></tbody></table></div>
    <h2 id="slowRequestsTitle"></h2>
    <div class="tablewrap"><table><thead id="slowRequestsHead"></thead><tbody id="slowRequestsRows"></tbody></table></div>
  </section>
  <div class="split">
    <div class="card">
      <h2 style="margin-top:0">活跃度 <span class="muted" id="heatMeta"></span></h2>
      <div class="heatmap" id="heatmap"></div>
      <div class="heat-legend"><span id="heatLess">少</span><i class="heat"></i><i class="heat l1"></i><i class="heat l2"></i><i class="heat l3"></i><i class="heat l4"></i><span id="heatMore">多</span><span id="heatLegend" style="margin-left:auto"></span></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">24 小时节奏 <span class="muted" id="rhythmMeta"></span></h2>
      <div class="rhythm" id="rhythm"></div>
      <div class="rhythm-labels"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    </div>
  </div>

  <h2>供应商消费 <span class="muted" id="providerMeta"></span></h2>
  <div class="tablewrap">
    <table>
      <thead><tr><th>供应商</th><th>连接数</th><th>输入</th><th>输出</th><th>缓存读</th><th>总 Token</th><th>占比</th><th>估算支出</th></tr></thead>
      <tbody id="providerRows"></tbody>
    </table>
  </div>

  <div class="split">
    <div>
      <h2>账号消费排行 <span class="muted" id="accountMeta"></span></h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>账号</th><th>供应商</th><th>连接数</th><th>总 Token</th><th>占比</th></tr></thead>
          <tbody id="accountRows"></tbody>
        </table>
      </div>
    </div>
    <div>
      <h2>模型消费排行 <span class="muted" id="modelMeta"></span></h2>
      <div class="tablewrap">
        <table>
          <thead><tr><th>模型</th><th>供应商</th><th>连接数</th><th>总 Token</th><th>缓存命中</th><th id="speedColumn">输出速度</th><th>估算支出</th></tr></thead>
          <tbody id="modelRows"></tbody>
        </table>
      </div>
    </div>
  </div>

  <h2>Token 趋势 <span class="muted" id="trendMeta"></span></h2>
  <div class="card chart" id="trend"></div>

  <h2>接入（客户端）消费</h2>
  <div class="tablewrap">
    <table>
      <thead><tr><th>客户端</th><th>连接数</th><th>有 usage</th><th>总 Token</th><th>占比</th></tr></thead>
      <tbody id="clientRows"></tbody>
    </table>
  </div>

  <div class="note">
    Token 口径：input 为未命中缓存的输入，cacheRead 为命中缓存的输入，output 为输出；total = input + cacheRead + cacheWrite + output。
    流式翻译优先使用上游返回的用量；上游未完整返回时使用本地估算并标记为“估算”。
    历史请求没有 provider/token 时不计入 Token 排行；连接数仍可在请求日志查看。
    <span id="speedNote"></span>
    理论费用按已知模型标准单价及页面用量计算，包含本地估算，并非供应商账单；未计入订阅费、税费或实际折扣。缓存仅统计上游明确上报的记录；历史未上报记录无法还原。
  </div>
  <footer id="foot">OpenSelect · Token 统计 · 每 15 秒自动刷新</footer>
</main>
<div id="chartTip" class="chart-tip" role="tooltip" hidden></div>
<script>
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];}); }
function num(n){ return (n==null||isNaN(n))?"0":Number(n).toLocaleString("zh-CN"); }
function fmtTok(n){ n=Number(n)||0; if(n>=1e9) return (n/1e9).toFixed(2)+"B"; if(n>=1e6) return (n/1e6).toFixed(2)+"M"; if(n>=1e3) return (n/1e3).toFixed(1)+"K"; return String(Math.round(n)); }
function fmtUsd(n){ if(n==null||!isFinite(n)) return "—"; return "$"+Number(n).toFixed(2); }
function pct(p){ return (p==null||!isFinite(p))?"—":(p*100).toFixed(1)+"%"; }
function fmtT(ts){ if(!ts) return "—"; var d=new Date(ts); return d.toLocaleString("zh-CN",{hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}); }
function short(s,n){ s=String(s||""); return s.length>n?s.slice(0,n-1)+"…":s; }
function providerLabel(p){ return {"opencode-go":"OpenCode","zai":"Z.ai","minimax":"MiniMax","deepseek":"DeepSeek","deepseek-api":osT("DeepSeek 官方","DeepSeek official"),"commandcode":"Command Code","ollama":"Ollama Cloud","zen":osT("Zen 免费","Zen free"),"google":"Google","anthropic":"Anthropic","openai":"OpenAI","xai":"xAI","unknown":osT("未标记","Unknown")}[p]||p||osT("未标记","Unknown"); }
function providerColor(p){ return {"opencode-go":"#4c8dff","zai":"#36d6c3","minimax":"#a879ff","deepseek":"#f0883e","deepseek-api":"#f0883e","commandcode":"#f778ba","ollama":"#3fb950","zen":"#8b98a9","unknown":"#8b98a9"}[p]||"#8b98a9"; }
function clientLabel(c){ return {"opencode":"OpenCode","claude-code":"Claude Code","codex":"Codex","cursor":"Cursor","cline":"Cline","unknown":osT("未标记","Unknown")}[c]||c||osT("未标记","Unknown"); }
function empty(cols){ return '<tr><td colspan="'+cols+'" class="muted">'+osT('暂无数据','No data')+'</td></tr>'; }
function cardSpark(id, rows, key){
  var el=document.getElementById(id); if(!el) return;
  var vals=(rows||[]).map(function(r){return Number(r[key])||0;});
  if(vals.length<2){ el.innerHTML=""; return; }
  var max=Math.max.apply(null,vals.concat([1])), w=240,h=34,step=w/(vals.length-1);
  var pts=vals.map(function(v,i){return (i*step).toFixed(1)+","+(h-2-(v/max)*(h-6)).toFixed(1);}).join(" ");
  el.innerHTML='<polyline fill="none" stroke="#4c8dff" stroke-width="1.6" points="'+pts+'" opacity="0.95"></polyline>';
}
function dayKey(d){
  var y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return y+"-"+m+"-"+day;
}
document.getElementById("heatLess").textContent=osT("少","Less");
document.getElementById("heatMore").textContent=osT("多","More");
function renderHeatmap(rows){
  var el=document.getElementById("heatmap"), meta=document.getElementById("heatMeta"), legend=document.getElementById("heatLegend");
  if(!el) return;
  var map={}; (rows||[]).forEach(function(r){ map[r.bucket]=r; });
  var today=new Date(); today.setHours(0,0,0,0);
  var end=new Date(today); end.setDate(end.getDate()+(6-end.getDay()));
  var start=new Date(end); start.setDate(start.getDate()-90);
  var cells=[], max=0, total=0;
  for(var i=0;i<91;i++){
    var d=new Date(start); d.setDate(start.getDate()+i);
    var future=d>today;
    var k=dayKey(d), r=map[k]||{totalTokens:0,requests:0};
    if(!future){ max=Math.max(max, Number(r.totalTokens)||0); total+=Number(r.totalTokens)||0; }
    cells.push({k:k,v:future?0:Number(r.totalTokens)||0,req:future?0:Number(r.requests)||0,future:future});
  }
  el.innerHTML=cells.map(function(c){
    var lv=c.v===0?0:Math.min(4,Math.max(1,Math.ceil(c.v/Math.max(1,max)*4)));
    var tip=c.k+(c.future?osT(' · 未来',' · future'):' · '+num(c.v)+' tokens · '+num(c.req)+osT(' 次请求',' requests'));
    return '<span class="heat '+(c.future?'future ':'')+'l'+lv+'"'+(c.future?'':' data-chart-tip="'+esc(tip)+'" tabindex="0" role="img" aria-label="'+esc(tip)+'"')+'></span>';
  }).join("");
  meta.textContent=osT(" · 91 天 · "," · 91 days · ")+fmtTok(total)+" tokens";
  if(legend) legend.textContent=osT("峰值 ","Peak ")+fmtTok(max);
}
function renderRhythm(rows){
  var el=document.getElementById("rhythm"), meta=document.getElementById("rhythmMeta");
  if(!el) return;
  var hours=new Array(24).fill(0), reqs=new Array(24).fill(0);
  (rows||[]).forEach(function(r){
    var h=Number(String(r.bucket||"").slice(-5,-3));
    if(h>=0&&h<24){ hours[h]+=Number(r.totalTokens)||0; reqs[h]+=Number(r.requests)||0; }
  });
  var max=Math.max.apply(null,hours.concat([1]));
  el.innerHTML=hours.map(function(v,i){
    var h=Math.round((v/max)*100);
    var start=String(i).padStart(2,"0")+":00", end=String((i+1)%24).padStart(2,"0")+":00";
    var tip=start+"–"+end+osT("（本地时间）"," (local time)")+" · "+num(v)+" tokens · "+num(reqs[i])+osT(" 次请求"," requests");
    return '<span class="rb" data-chart-tip="'+esc(tip)+'" tabindex="0" role="img" aria-label="'+esc(tip)+'"><span class="rf" style="height:'+Math.max(2,h)+'%"></span></span>';
  }).join("");
  var peak=hours.indexOf(Math.max.apply(null,hours));
  meta.textContent=osT(" · 峰值 "," · Peak ")+String(peak).padStart(2,"0")+":00 · "+fmtTok(hours[peak]);
}
function renderTrend(rows){
  var el=document.getElementById("trend");
  if(!rows||!rows.length){ el.innerHTML='<div class="empty">'+osT('暂无 Token 数据 —— 先发一条请求，usage 会写入台账','No token data yet. Send a request to record usage.')+'</div>'; return; }
  var max=Math.max.apply(null,rows.map(function(r){return Number(r.totalTokens)||0;}).concat([1]));
  var w=1000,h=220,padL=48,padR=18,padT=14,padB=30, innerW=w-padL-padR, innerH=h-padT-padB;
  var bw=Math.max(2,innerW/rows.length*0.62);
  var bars=rows.map(function(r,i){
    var v=Number(r.totalTokens)||0, bh=(v/max)*innerH, x=padL+(i+0.5)*(innerW/rows.length)-bw/2, y=padT+innerH-bh;
    var tip=String(r.bucket||"")+osT("（本地时间）"," (local time)")+" · "+num(v)+" tokens · "+num(r.requests)+osT(" 次请求"," requests");
    var hitX=padL+i*(innerW/rows.length), hitW=innerW/rows.length;
    return '<g data-chart-tip="'+esc(tip)+'" tabindex="0" role="img" aria-label="'+esc(tip)+'"><rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0,bh).toFixed(1)+'" rx="3" fill="url(#barGrad)"></rect><rect x="'+hitX.toFixed(1)+'" y="'+padT+'" width="'+hitW.toFixed(1)+'" height="'+innerH+'" fill="transparent" pointer-events="all"></rect></g>';
  }).join("");
  var grid="";
  for(var g=0;g<=4;g++){ var gy=padT+innerH-(innerH*g/4); var gv=Math.round(max*g/4); grid+='<line x1="'+padL+'" y1="'+gy+'" x2="'+(w-padR)+'" y2="'+gy+'" stroke="#223047" stroke-width="1" stroke-dasharray="3 5"></line><text x="'+(padL-8)+'" y="'+(gy+3)+'" fill="#8b98a9" font-size="10" text-anchor="end">'+fmtTok(gv)+'</text>'; }
  var step=Math.max(1,Math.ceil(rows.length/8));
  var labels=rows.map(function(r,i){ if(i%step!==0 && i!==rows.length-1) return ""; var x=padL+(i+0.5)*(innerW/rows.length); return '<text x="'+x.toFixed(1)+'" y="'+(h-8)+'" fill="#8b98a9" font-size="10" text-anchor="middle">'+esc(r.bucket.slice(5))+'</text>'; }).join("");
  el.innerHTML='<svg viewBox="0 0 1000 220" preserveAspectRatio="none"><defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c8dff"/><stop offset="1" stop-color="#1e5eff"/></linearGradient></defs>'+grid+bars+labels+'</svg>';
}
var chartTip=document.getElementById("chartTip");
function positionChartTip(x,y){
  var margin=8, left=Math.min(x+14,window.innerWidth-chartTip.offsetWidth-margin), top=Math.min(y+14,window.innerHeight-chartTip.offsetHeight-margin);
  chartTip.style.left=Math.max(margin,left)+"px";
  chartTip.style.top=Math.max(margin,top)+"px";
}
function showChartTip(target,x,y){
  chartTip.textContent=target.getAttribute("data-chart-tip")||"";
  chartTip.hidden=false;
  var rect=target.getBoundingClientRect();
  positionChartTip(x==null?rect.left+rect.width/2:x,y==null?rect.top:y);
}
document.querySelectorAll("#heatmap,#rhythm,#trend,#speedDistribution,#speedTrend").forEach(function(chart){
  chart.addEventListener("pointerover",function(e){var t=e.target.closest("[data-chart-tip]");if(t&&chart.contains(t)) showChartTip(t,e.clientX,e.clientY);});
  chart.addEventListener("pointermove",function(e){if(!chartTip.hidden) positionChartTip(e.clientX,e.clientY);});
  chart.addEventListener("pointerout",function(e){var t=e.target.closest("[data-chart-tip]");if(t&&(!e.relatedTarget||!t.contains(e.relatedTarget))) chartTip.hidden=true;});
  chart.addEventListener("focusin",function(e){var t=e.target.closest("[data-chart-tip]");if(t) showChartTip(t);});
  chart.addEventListener("focusout",function(){chartTip.hidden=true;});
  chart.addEventListener("click",function(e){var t=e.target.closest("[data-chart-tip]");if(t) showChartTip(t,e.clientX,e.clientY);});
});
document.addEventListener("keydown",function(e){if(e.key==="Escape") chartTip.hidden=true;});
var speedData=null;
function speedValue(v){return v==null?"—":Number(v).toFixed(1);}
function speedSeconds(v){return v==null?"—":(v/1000).toFixed(1)+" s";}
function renderSpeedAnalysis(){
  if(!speedData) return;
  var select=document.getElementById("analysisModel"), chosen=select.value, groups=speedData.byModel||[];
  select.innerHTML='<option value="">'+osT("全部模型","All models")+'</option>'+groups.map(function(g){return '<option value="'+esc(g.key)+'">'+esc(providerLabel(g.provider)+" / "+g.model)+'</option>';}).join("");
  select.value=chosen;
  if(select.selectedIndex<0) select.value="";
  var selected=groups.find(function(g){return g.key===select.value;});
  var a=selected||speedData.overall;
  var labels={analysisTitle:osT("输出速度分析","Output speed analysis"),analysisModelLabel:osT("模型 / 供应商","Model / provider"),analysisMinLabel:osT("最少输出 Token","Minimum output tokens"),analysisMedianLabel:osT("速度中位数","Median speed"),analysisSlowLabel:osT("慢请求比例（<20 tokens/s）","Slow requests (<20 tokens/s)"),analysisWaitLabel:osT("响应前等待中位数","Median response wait"),analysisRetryLabel:osT("发生重试的请求","Requests with retries"),distributionTitle:osT("速度分布 · 悬停查看请求数","Speed distribution · Hover for counts"),speedTrendTitle:osT("速度趋势 · tokens/s","Speed over time · tokens/s"),speedCompareTitle:osT("模型 / 供应商速度对比","Speed by model / provider"),slowRequestsTitle:osT("最近慢请求 · 最多 20 条","Recent slow requests · Up to 20")};
  Object.keys(labels).forEach(function(id){document.getElementById(id).textContent=labels[id];});
  document.getElementById("analysisScope").textContent=osT("跟随上方时间范围；完整成功响应、上游真实用量，输出 ≥ ","Uses the time range above; completed successful requests with provider-reported usage, output ≥ ")+speedData.minimumOutput+osT(" Token。速度含等待和重试，不能当作模型纯生成速度。"," tokens. Speed includes waiting and retries, not pure model generation speed.")+osT(" 当前样本："," Samples: ")+num(a.samples)+osT("；未满足条件或历史缺少耗时的记录不参与。","; incomplete measurements and older records are excluded.");
  document.getElementById("analysisMedian").textContent=speedValue(a.median)+" tokens/s";
  document.getElementById("analysisSpread").textContent="P10 "+speedValue(a.p10)+" / P90 "+speedValue(a.p90)+" tokens/s";
  document.getElementById("analysisSlow").textContent=pct(a.slowShare);
  document.getElementById("analysisSlowCount").textContent=num(a.slowCount)+" / "+num(a.samples)+osT(" 次请求"," requests");
  document.getElementById("analysisWait").textContent=speedSeconds(a.medianWaitMs);
  document.getElementById("analysisWaitCount").textContent=num(a.waitSamples)+osT(" 个等待时间样本（首批响应）"," wait samples (initial response)");
  document.getElementById("contentWaitLabel").textContent=osT("首个内容等待","Time to first content");
  document.getElementById("generationLabel").textContent=osT("流式输出阶段速度中位数","Median streaming output speed");
  document.getElementById("contentWait").textContent=speedSeconds(a.medianFirstContentMs);
  document.getElementById("generationSpeed").textContent=speedValue(a.medianGenerationSpeed)+" tokens/s";
  document.getElementById("contentSamples").textContent=num(a.contentTimingSamples||0)+osT(" 个实测样本；历史未知"," measured samples; older records unknown");
  document.getElementById("generationSamples").textContent=num(a.generationSamples||0)+osT(" 个样本；首末内容间隔"," samples; first-to-last content interval");
  document.getElementById("analysisRetry").textContent=a.samples?pct(a.retryCount/a.samples):"—";
  document.getElementById("analysisRetryCount").textContent=num(a.retryCount)+" / "+num(a.samples)+osT(" 次请求；重试耗时中位数 "," requests; median retry time ")+speedSeconds(a.medianRetryMs);
  document.getElementById("analysisInsight").textContent=!a.samples?osT("暂无符合条件的速度数据；新请求完成后会自动更新。","No matching speed measurements yet; updates as requests finish."):a.slowCount?osT("慢请求中，响应前等待占总耗时 ","For slow requests, initial waiting accounts for ")+pct(a.slowWaitShare)+osT("；其中 ","; ")+num(a.slowRetryCount)+osT(" 次发生重试。等待可能含网络、排队、预处理和故障切换，现有数据不能确定具体上游线路。"," had retries. Waiting can include network, queuing, preprocessing and failover; these measurements cannot identify the internal upstream route."):osT("当前筛选没有低于 20 tokens/s 的请求。","No requests below 20 tokens/s in this selection.");
  var maxCount=Math.max.apply(null,a.histogram.map(function(b){return b.count;}).concat([1]));
  document.getElementById("speedDistribution").innerHTML=a.histogram.map(function(b){
    var label=b.max==null?"≥"+b.min:b.min+"–"+b.max, tip=label+" tokens/s · "+num(b.count)+osT(" 次请求"," requests")+" · "+pct(a.samples?b.count/a.samples:0);
    return '<span class="rb" tabindex="0" role="img" aria-label="'+esc(tip)+'" data-chart-tip="'+esc(tip)+'"><span class="rf" style="height:'+Math.max(2,b.count/maxCount*100)+'%"></span></span>';
  }).join("");
  var trend=a.trend||[], maxSpeed=Math.max.apply(null,trend.map(function(t){return t.tokensPerSecond;}).concat([1]));
  document.getElementById("speedTrend").innerHTML=!trend.length?'<div class="empty">'+osT("暂无数据","No data")+'</div>':'<svg viewBox="0 0 1000 220" preserveAspectRatio="none">'+[0,1,2].map(function(i){var y=180-i*75;return '<text x="45" y="'+y+'" fill="#8b98a9" font-size="12" text-anchor="end">'+speedValue(maxSpeed*i/2)+'</text><line x1="55" y1="'+y+'" x2="990" y2="'+y+'" stroke="#223047"/>';}).join("")+trend.map(function(t,i){
    var w=935/trend.length,x=55+i*w,h=t.tokensPerSecond/maxSpeed*150,tip=fmtT(t.ts)+" · "+speedValue(t.tokensPerSecond)+" tokens/s · "+num(t.samples)+osT(" 个样本"," samples");
    return '<g tabindex="0" role="img" aria-label="'+esc(tip)+'" data-chart-tip="'+esc(tip)+'"><rect x="'+(x+w*.2)+'" y="'+(180-h)+'" width="'+(w*.6)+'" height="'+h+'" fill="#4c8dff" rx="2"/><rect x="'+x+'" y="20" width="'+w+'" height="160" fill="transparent"/>'+(i===0||i===trend.length-1?'<text x="'+(x+w/2)+'" y="210" fill="#8b98a9" font-size="12" text-anchor="middle">'+esc(fmtT(t.ts))+'</text>':"")+'</g>';
  }).join("")+'</svg>';
  document.getElementById("speedCompareHead").innerHTML="<tr>"+[osT("模型 / 供应商","Model / provider"),osT("样本","Samples"),osT("中位数 tokens/s","Median tokens/s"),"P10 / P90",osT("慢请求比例","Slow share"),osT("等待中位数","Median wait"),osT("重试比例","Retry share")].map(function(v){return "<th>"+v+"</th>";}).join("")+"</tr>";
  var compared=selected?[selected]:groups;
  document.getElementById("speedCompareRows").innerHTML=compared.map(function(g){return "<tr><td>"+esc(g.model)+"<br><span class=muted>"+esc(providerLabel(g.provider))+"</span></td><td>"+num(g.samples)+"</td><td>"+speedValue(g.median)+"</td><td>"+speedValue(g.p10)+" / "+speedValue(g.p90)+"</td><td>"+pct(g.slowShare)+"</td><td>"+speedSeconds(g.medianWaitMs)+"</td><td>"+pct(g.samples?g.retryCount/g.samples:null)+"</td></tr>";}).join("")||empty(7);
  document.getElementById("slowRequestsHead").innerHTML="<tr>"+[osT("时间","Time"),osT("模型 / 供应商","Model / provider"),"tokens/s",osT("输出 Token","Output tokens"),osT("总耗时","Total time"),osT("响应前等待","Initial wait"),osT("重试耗时","Retry time"),osT("尝试次数","Attempts")].map(function(v){return "<th>"+v+"</th>";}).join("")+"</tr>";
  document.getElementById("slowRequestsRows").innerHTML=a.slowRequests.map(function(s){return "<tr><td>"+esc(fmtT(s.ts))+"</td><td>"+esc(s.model)+"<br><span class=muted>"+esc(providerLabel(s.provider))+"</span></td><td>"+speedValue(s.tokensPerSecond)+"</td><td>"+num(s.outputTokens)+"</td><td>"+speedSeconds(s.durationMs)+"</td><td>"+speedSeconds(s.waitMs)+"</td><td>"+speedSeconds(s.retryMs)+"</td><td>"+num(s.attempts)+"</td></tr>";}).join("")||empty(8);
}
document.getElementById("analysisModel").addEventListener("change",renderSpeedAnalysis);
document.getElementById("analysisMin").addEventListener("change",load);
function load(){
  var range=document.getElementById("range").value;
  var bucket=document.getElementById("bucket").value;
  var msg=document.getElementById("msg"); msg.textContent=osT("加载中…","Loading…"); msg.className="msg";
  fetch("/api/tokens?range="+encodeURIComponent(range)+"&bucket="+encodeURIComponent(bucket)+"&speedMin="+document.getElementById("analysisMin").value)
    .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(d){ render(d); msg.textContent=""; })
    .catch(function(e){ msg.textContent=osT("加载失败：","Load failed: ")+e.message; msg.className="msg bad"; });
}
function render(d){
  speedData=d.speedAnalysis; renderSpeedAnalysis();
  var t=d.totals||{};
  var total=t.totalTokens||0;
  document.getElementById("totalTokens").textContent=fmtTok(total);
  document.getElementById("totalTokens").title=num(total);
  document.getElementById("totalSub").textContent=osT("输入 ","Input ")+fmtTok(t.inputTokens)+osT(" / 输出 "," / Output ")+fmtTok(t.outputTokens)+osT(" · 已上报缓存 "," · Reported cache ")+((t.cacheKnownRequests||0)?fmtTok(t.cacheKnownReadTokens):osT("未知","Unknown"));
  document.getElementById("tokenRows").textContent=(t.tokenRequests||0)+osT(" 条用量 · 其中估算 "," with usage · estimated ")+(t.estimatedRequests||0);
  document.getElementById("totalCost").textContent=fmtUsd(t.costUsd);
  document.getElementById("costSub").textContent=osT("理论参考 · 含估算 · 非实际账单","Reference only · Includes estimates · Not a bill");
  var denom=(t.cacheKnownInputTokens||0)+(t.cacheKnownReadTokens||0);
  var hit=denom?((t.cacheKnownReadTokens||0)/denom):null;
  document.getElementById("cacheHit").textContent=hit==null?"—":pct(hit);
  document.getElementById("cacheSub").textContent=osT("已上报缓存的请求 ","Requests reporting cache ")+num(t.cacheKnownRequests||0)+" / "+num(t.requests||0)+osT("；其余未知","; others unknown");
  document.getElementById("cachePill").textContent=(t.cacheKnownRequests||0)?osT("部分或全部已上报","Reported subset"):osT("未知","Unknown");
  renderHeatmap(d.activity||[]);
  renderRhythm(d.rhythm||[]);
  var providers=(d.byProvider||[]).filter(function(p){return p.totalTokens>0 || (p.requests>0 && p.provider!=="unknown");});
  var activeAccounts=(d.byAccount||[]).filter(function(a){return a.totalTokens>0;}).length;
  var activeModels=(d.byModel||[]).filter(function(m){return m.totalTokens>0;}).length;
  document.getElementById("active").textContent=activeAccounts+" / "+activeModels;
  document.getElementById("activeSub").textContent=osT("账号 / 模型 · 连接数 ","Accounts / models · Connections ")+num(t.requests);
  document.getElementById("reqPill").textContent=num(t.requests)+osT(" 次"," requests");
  document.getElementById("speedLabel").textContent=osT("平均输出速度","Average output speed");
  document.getElementById("speedColumn").textContent=osT("输出速度","Output speed");
  document.getElementById("speed").textContent=t.outputTokensPerSecond==null?"—":t.outputTokensPerSecond.toFixed(1)+" tokens/s";
  document.getElementById("speedPill").textContent=num(t.speedRequests||0)+osT(" 个样本"," samples");
  document.getElementById("speedSub").textContent=osT("输出 Token / 完整耗时（含等待）","Output tokens / total time (includes waiting)");
  document.getElementById("speedNote").textContent=osT("输出速度仅统计成功完成且上游上报输出用量的请求；历史请求缺少完整耗时，无法计算。","Output speed includes completed requests with provider-reported output usage; older requests lack total duration.");
  document.getElementById("providerMeta").textContent=" · "+providers.length+osT(" 个供应商 · 记录 "," providers · Recorded ")+num(t.tokenRequests)+osT(" / 估算 "," / Estimated ")+num(t.estimatedRequests);
  document.getElementById("providerRows").innerHTML=providers.map(function(p){
    var share=total?(p.totalTokens/total):0;
    return '<tr><td><span class="dot" style="background:'+providerColor(p.provider)+'"></span><b>'+esc(providerLabel(p.provider))+'</b></td><td>'+num(p.requests)+'</td><td class="mono">'+fmtTok(p.inputTokens)+'</td><td class="mono">'+fmtTok(p.outputTokens)+'</td><td class="mono">'+(p.cacheKnownRequests?fmtTok(p.cacheKnownReadTokens):'—')+'</td><td class="mono"><b>'+fmtTok(p.totalTokens)+'</b></td><td>'+pct(share)+'</td><td class="mono">'+fmtUsd(p.costUsd)+'</td></tr>';
  }).join("")||empty(8);

  var labels={}; (d.accounts||[]).forEach(function(a){labels[a.id]=a.label||a.id;});
  var accounts=(d.byAccount||[]).filter(function(a){return a.totalTokens>0;}).slice(0,12);
  document.getElementById("accountMeta").textContent=" · "+accounts.length+osT(" 个账号/来源"," accounts / sources");
  document.getElementById("accountRows").innerHTML=accounts.map(function(a){
    var share=total?(a.totalTokens/total):0;
    return '<tr><td>'+esc(labels[a.accountId]||a.accountId)+'</td><td class="muted">'+esc(providerLabel(a.provider))+'</td><td>'+num(a.requests)+'</td><td class="mono"><b>'+fmtTok(a.totalTokens)+'</b><br><span class="muted">'+num(a.totalTokens)+'</span></td><td>'+pct(share)+'</td></tr>';
  }).join("")||empty(5);

  var models=(d.byModel||[]).filter(function(m){return m.totalTokens>0;}).slice(0,12);
  document.getElementById("modelMeta").textContent=" · "+models.length+osT(" 个模型"," models");
  document.getElementById("modelRows").innerHTML=models.map(function(m){
    var dnm=(m.cacheKnownInputTokens||0)+(m.cacheKnownReadTokens||0);
    var ch=dnm?((m.cacheKnownReadTokens||0)/dnm):null;
    var speed=m.outputTokensPerSecond==null?"—":m.outputTokensPerSecond.toFixed(1)+" tokens/s";
    return '<tr><td><b>'+esc(short(m.model,32))+'</b></td><td class="muted">'+esc(providerLabel(m.provider))+'</td><td>'+num(m.requests)+'</td><td class="mono">'+fmtTok(m.totalTokens)+'</td><td>'+pct(ch)+'</td><td class="mono">'+speed+'<br><span class="muted">'+num(m.speedRequests||0)+osT(" 个样本"," samples")+'</span></td><td class="mono">'+fmtUsd(m.costUsd)+'</td></tr>';
  }).join("")||empty(7);

  var clients=(d.byClient||[]).filter(function(c){return c.totalTokens>0;});
  document.getElementById("clientRows").innerHTML=clients.map(function(c){
    var share=total?(c.totalTokens/total):0;
    return '<tr><td>'+esc(clientLabel(c.client))+'</td><td>'+num(c.requests)+'</td><td>'+num(c.tokenRequests)+'</td><td class="mono">'+fmtTok(c.totalTokens)+'</td><td>'+pct(share)+'</td></tr>';
  }).join("")||empty(5);

  document.getElementById("trendMeta").textContent=" · "+(d.bucket==="hour"?osT("按小时","Hourly"):osT("按天","Daily"))+osT(" · 峰值 "," · Peak ")+fmtTok(Math.max.apply(null,(d.byTime||[]).map(function(x){return x.totalTokens||0;}).concat([0])));
  renderTrend(d.byTime||[]);
  cardSpark("sparkTotal",d.byTime,"totalTokens");
  // 费用和缓存历史不可从总 Token 曲线推断。
  cardSpark("sparkReq",d.byTime,"requests");
  document.getElementById("foot").textContent=osT("OpenSelect · Token 统计 · 更新于 ","OpenSelect · Token usage · Updated ")+fmtT(d.now)+osT(" · 每 15 秒自动刷新"," · Refreshes every 15 seconds");
}
document.getElementById("range").onchange=function(){ document.getElementById("bucket").value=(this.value==="7d"||this.value==="30d"||this.value==="all")?"day":"hour"; load(); };
document.getElementById("bucket").onchange=load;
document.getElementById("refresh").onclick=load;
load();
setInterval(load,15000);
</script>
${PAGE_LOCALE}
</body>
</html>`;
}
