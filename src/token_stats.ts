import { PAGE_LOCALE } from "./page_locale";
import { loadCatalog } from "./catalog";
import {
  tokenStatsByAccount,
  tokenStatsByClient,
  tokenStatsByModel,
  tokenStatsByProvider,
  tokenStatsByTime,
  tokenTotals,
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
  byProvider: CostedProviderTokenStat[];
  byModel: CostedModelTokenStat[];
  byAccount: AccountTokenStat[];
  byTime: TimeTokenStat[];
  activity: TimeTokenStat[];
  rhythm: TimeTokenStat[];
  byClient: ClientTokenStat[];
  accounts: Array<{ id: string; label: string; integration: string; enabled: boolean }>;
}

function parseRange(raw: string | null): { range: string; since: number; bucket: "hour" | "day" } {
  const now = Date.now();
  const range = raw === "today" || raw === "7d" || raw === "30d" || raw === "24h" || raw === "all" ? raw : "24h";
  let since = now - 24 * 3600_000;
  if (range === "today") {
    const d = new Date();
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

export async function buildTokenStats(rt: Runtime, url: URL): Promise<TokenStatsData> {
  const now = Date.now();
  const { range, since, bucket: defaultBucket } = parseRange(url.searchParams.get("range"));
  const bucket = url.searchParams.get("bucket") === "hour" ? "hour" : url.searchParams.get("bucket") === "day" ? "day" : defaultBucket;
  const until = now + 1;

  const catalog = await loadCatalog();
  const totals = tokenTotals(since, until);
  const byModel = tokenStatsByModel(since, until).map((m) => ({
    ...m,
    costUsd: estimateCost(findModelInfo(catalog, m.model, m.provider), m),
  }));
  const byProvider = tokenStatsByProvider(since, until).map((p) => {
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

  return {
    now,
    range,
    bucket,
    since,
    totals: { ...totals, costUsd: totalCost },
    byProvider,
    byModel,
    byAccount: tokenStatsByAccount(since, until),
    byTime: tokenStatsByTime(since, until, bucket),
    activity: tokenStatsByTime(now - 91 * 24 * 3600_000, until, "day"),
    rhythm: tokenStatsByTime(now - 24 * 3600_000, until, "hour"),
    byClient: tokenStatsByClient(since, until),
    accounts: rt.config.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      integration: a.integration,
      enabled: a.enabled,
    })),
  };
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
  .cards { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:14px; margin:16px 0 20px; }
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
  .rhythm .rb { flex:1; min-width:3px; background:linear-gradient(180deg,#4c8dff,#1e5eff); border-radius:3px 3px 0 0; min-height:2px; opacity:.9; }
  .rhythm-labels { display:flex; justify-content:space-between; color:var(--muted); font-size:10px; margin-top:4px; }
  .heat-meta { color:var(--muted); font-size:11px; margin-top:8px; }
  .chart svg { width:100%; height:240px; display:block; }
  .chart .empty { color:var(--muted); padding:40px 10px; text-align:center; }
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
      <div class="lbl"><span>估算支出</span><span class="pill">已知单价</span></div>
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
  </div>

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
          <thead><tr><th>模型</th><th>供应商</th><th>连接数</th><th>总 Token</th><th>缓存命中</th><th>估算支出</th></tr></thead>
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
    流式翻译路径（OpenAI→Anthropic）的 usage 由本地翻译器估算，页面标记为“估算”；上游未返回 usage 的请求显示“未上报”。
    历史请求没有 provider/token 时不计入 Token 排行；连接数仍可在请求日志查看。
    估算支出按已知模型标准单价计算，未按高峰/off-peak 逐请求重算；高峰时段可能低估。不含订阅费、平台费、税费与折扣；未知单价显示“—”。
  </div>
  <footer id="foot">OpenSelect · Token 统计 · 每 15 秒自动刷新</footer>
</main>
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
    return '<span class="heat '+(c.future?'future ':'')+'l'+lv+'" title="'+esc(c.k)+(c.future?osT(' · 未来',' · future'):' · '+fmtTok(c.v)+' tokens · '+num(c.req)+osT(' 次',' requests'))+'"></span>';
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
    return '<span class="rb" style="height:'+Math.max(2,h)+'%" title="'+String(i).padStart(2,"0")+':00 · '+fmtTok(v)+' tokens · '+num(reqs[i])+osT(' 次',' requests')+'"></span>';
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
    return '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(0,bh).toFixed(1)+'" rx="3" fill="url(#barGrad)"><title>'+esc(r.bucket)+' · '+fmtTok(v)+' tokens · '+num(r.requests)+osT(' 次',' requests')+'</title></rect>';
  }).join("");
  var grid="";
  for(var g=0;g<=4;g++){ var gy=padT+innerH-(innerH*g/4); var gv=Math.round(max*g/4); grid+='<line x1="'+padL+'" y1="'+gy+'" x2="'+(w-padR)+'" y2="'+gy+'" stroke="#223047" stroke-width="1" stroke-dasharray="3 5"></line><text x="'+(padL-8)+'" y="'+(gy+3)+'" fill="#8b98a9" font-size="10" text-anchor="end">'+fmtTok(gv)+'</text>'; }
  var step=Math.max(1,Math.ceil(rows.length/8));
  var labels=rows.map(function(r,i){ if(i%step!==0 && i!==rows.length-1) return ""; var x=padL+(i+0.5)*(innerW/rows.length); return '<text x="'+x.toFixed(1)+'" y="'+(h-8)+'" fill="#8b98a9" font-size="10" text-anchor="middle">'+esc(r.bucket.slice(5))+'</text>'; }).join("");
  el.innerHTML='<svg viewBox="0 0 1000 220" preserveAspectRatio="none"><defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4c8dff"/><stop offset="1" stop-color="#1e5eff"/></linearGradient></defs>'+grid+bars+labels+'</svg>';
}
function load(){
  var range=document.getElementById("range").value;
  var bucket=document.getElementById("bucket").value;
  var msg=document.getElementById("msg"); msg.textContent=osT("加载中…","Loading…"); msg.className="msg";
  fetch("/api/tokens?range="+encodeURIComponent(range)+"&bucket="+encodeURIComponent(bucket))
    .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(d){ render(d); msg.textContent=""; })
    .catch(function(e){ msg.textContent=osT("加载失败：","Load failed: ")+e.message; msg.className="msg bad"; });
}
function render(d){
  var t=d.totals||{};
  var total=t.totalTokens||0;
  document.getElementById("totalTokens").textContent=fmtTok(total);
  document.getElementById("totalSub").textContent=osT("输入 ","Input ")+fmtTok(t.inputTokens)+osT(" / 输出 "," / Output ")+fmtTok(t.outputTokens)+osT(" · 缓存 "," · Cache ")+fmtTok(t.cacheReadTokens);
  document.getElementById("tokenRows").textContent=(t.tokenRequests||0)+osT(" 条有 usage · "," with usage · ")+(t.estimatedRequests||0)+osT(" 条估算"," estimated");
  document.getElementById("totalCost").textContent=fmtUsd(t.costUsd);
  document.getElementById("costSub").textContent=osT("按已知模型单价 · 含估算 · 不含订阅费","Known model prices · Includes estimates · Excludes subscriptions");
  var denom=(t.inputTokens||0)+(t.cacheReadTokens||0);
  var hit=denom?((t.cacheReadTokens||0)/denom):null;
  document.getElementById("cacheHit").textContent=hit==null?"—":pct(hit);
  document.getElementById("cacheSub").textContent=osT("缓存读取 ","Cache read ")+fmtTok(t.cacheReadTokens)+osT(" / 输入 "," / Input ")+fmtTok(t.inputTokens);
  document.getElementById("cachePill").textContent=(t.cacheReadTokens||0)?fmtTok(t.cacheReadTokens):osT("无缓存","No cache");
  renderHeatmap(d.activity||[]);
  renderRhythm(d.rhythm||[]);
  var providers=(d.byProvider||[]).filter(function(p){return p.totalTokens>0 || (p.requests>0 && p.provider!=="unknown");});
  var activeAccounts=(d.byAccount||[]).filter(function(a){return a.totalTokens>0;}).length;
  var activeModels=(d.byModel||[]).filter(function(m){return m.totalTokens>0;}).length;
  document.getElementById("active").textContent=activeAccounts+" / "+activeModels;
  document.getElementById("activeSub").textContent=osT("账号 / 模型 · 连接数 ","Accounts / models · Connections ")+num(t.requests);
  document.getElementById("reqPill").textContent=num(t.requests)+osT(" 次"," requests");
  document.getElementById("providerMeta").textContent=" · "+providers.length+osT(" 个供应商 · 记录 "," providers · Recorded ")+num(t.tokenRequests)+osT(" / 估算 "," / Estimated ")+num(t.estimatedRequests);
  document.getElementById("providerRows").innerHTML=providers.map(function(p){
    var share=total?(p.totalTokens/total):0;
    return '<tr><td><span class="dot" style="background:'+providerColor(p.provider)+'"></span><b>'+esc(providerLabel(p.provider))+'</b></td><td>'+num(p.requests)+'</td><td class="mono">'+fmtTok(p.inputTokens)+'</td><td class="mono">'+fmtTok(p.outputTokens)+'</td><td class="mono">'+fmtTok(p.cacheReadTokens)+'</td><td class="mono"><b>'+fmtTok(p.totalTokens)+'</b></td><td>'+pct(share)+'</td><td class="mono">'+fmtUsd(p.costUsd)+'</td></tr>';
  }).join("")||empty(8);

  var labels={}; (d.accounts||[]).forEach(function(a){labels[a.id]=a.label||a.id;});
  var accounts=(d.byAccount||[]).filter(function(a){return a.totalTokens>0;}).slice(0,12);
  document.getElementById("accountMeta").textContent=" · "+accounts.length+osT(" 个账号/来源"," accounts / sources");
  document.getElementById("accountRows").innerHTML=accounts.map(function(a){
    var share=total?(a.totalTokens/total):0;
    return '<tr><td>'+esc(labels[a.accountId]||a.accountId)+'</td><td class="muted">'+esc(providerLabel(a.provider))+'</td><td>'+num(a.requests)+'</td><td class="mono"><b>'+fmtTok(a.totalTokens)+'</b></td><td>'+pct(share)+'</td></tr>';
  }).join("")||empty(5);

  var models=(d.byModel||[]).filter(function(m){return m.totalTokens>0;}).slice(0,12);
  document.getElementById("modelMeta").textContent=" · "+models.length+osT(" 个模型"," models");
  document.getElementById("modelRows").innerHTML=models.map(function(m){
    var dnm=(m.inputTokens||0)+(m.cacheReadTokens||0);
    var ch=dnm?((m.cacheReadTokens||0)/dnm):null;
    return '<tr><td><b>'+esc(short(m.model,32))+'</b></td><td class="muted">'+esc(providerLabel(m.provider))+'</td><td>'+num(m.requests)+'</td><td class="mono">'+fmtTok(m.totalTokens)+'</td><td>'+pct(ch)+'</td><td class="mono">'+fmtUsd(m.costUsd)+'</td></tr>';
  }).join("")||empty(6);

  var clients=(d.byClient||[]).filter(function(c){return c.totalTokens>0;});
  document.getElementById("clientRows").innerHTML=clients.map(function(c){
    var share=total?(c.totalTokens/total):0;
    return '<tr><td>'+esc(clientLabel(c.client))+'</td><td>'+num(c.requests)+'</td><td>'+num(c.tokenRequests)+'</td><td class="mono">'+fmtTok(c.totalTokens)+'</td><td>'+pct(share)+'</td></tr>';
  }).join("")||empty(5);

  document.getElementById("trendMeta").textContent=" · "+(d.bucket==="hour"?osT("按小时","Hourly"):osT("按天","Daily"))+osT(" · 峰值 "," · Peak ")+fmtTok(Math.max.apply(null,(d.byTime||[]).map(function(x){return x.totalTokens||0;}).concat([0])));
  renderTrend(d.byTime||[]);
  cardSpark("sparkTotal",d.byTime,"totalTokens");
  cardSpark("sparkCost",d.byTime,"totalTokens");
  cardSpark("sparkCache",d.byTime,"cacheReadTokens");
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
