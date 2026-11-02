import {
  requestTotals,
  statsByAccount,
  statsByModel,
  statsByModelAccount,
  statsByTime,
  type AccountUsageStat,
  type ModelAccountUsageStat,
  type ModelUsageStat,
  type RequestTotals,
  type TimeUsageStat,
} from "./db";
import { accountPressure, isRateLimited } from "./policy";
import type { Runtime } from "./state";
import { UI_CSS, navHtml } from "./ui";

export interface StatsAccount {
  id: string;
  label: string;
  status: string;
  pressure: number;
  cooldownLeftMs: number;
  usage: {
    rolling: { percent: number; status: string; resetsAt: string | null };
    weekly: { percent: number; status: string; resetsAt: string | null };
    monthly: { percent: number; status: string; resetsAt: string | null };
  } | null;
}

export interface StatsData {
  now: number;
  range: string;
  bucket: "hour" | "day";
  since: number;
  totals: RequestTotals;
  byModel: ModelUsageStat[];
  byAccount: AccountUsageStat[];
  byModelAccount: ModelAccountUsageStat[];
  byTimeModel: TimeUsageStat[];
  byTimeAccount: TimeUsageStat[];
  accounts: StatsAccount[];
}

function parseRange(raw: string | null): { range: string; since: number } {
  const now = Date.now();
  const range = raw === "today" || raw === "7d" || raw === "30d" || raw === "24h" ? raw : "24h";
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { range, since: d.getTime() };
  }
  if (range === "7d") return { range, since: now - 7 * 24 * 3600_000 };
  if (range === "30d") return { range, since: now - 30 * 24 * 3600_000 };
  return { range: "24h", since: now - 24 * 3600_000 };
}

export function buildStats(rt: Runtime, url: URL): StatsData {
  const now = Date.now();
  const { range, since } = parseRange(url.searchParams.get("range"));
  let bucket: "hour" | "day" = url.searchParams.get("bucket") === "day" ? "day" : "hour";
  if (range === "30d" && bucket === "hour") bucket = "day";
  const until = now + 1;

  const accounts: StatsAccount[] = rt.config.accounts.map((a) => {
    const st = rt.state(a.id);
    const u = rt.usages.get(a.id);
    let status = "正常";
    if (!a.enabled) status = "已禁用";
    else if (st.invalid) status = "Key 无效";
    else if (st.cooldownUntil > now) status = "冷却中";
    else if (isRateLimited(u)) status = "已限流";
    else if (accountPressure(u) >= rt.config.policy.switchAt) status = "接近阈值";
    return {
      id: a.id,
      label: a.label,
      status,
      pressure: accountPressure(u),
      cooldownLeftMs: Math.max(0, st.cooldownUntil - now),
      usage: u ? { rolling: u.rolling, weekly: u.weekly, monthly: u.monthly } : null,
    };
  });

  return {
    now,
    range,
    bucket,
    since,
    totals: requestTotals(since, until),
    byModel: statsByModel(since, until),
    byAccount: statsByAccount(since, until, new Set(accounts.map((a) => a.id))),
    byModelAccount: statsByModelAccount(since, until),
    byTimeModel: statsByTime(since, until, bucket, "model"),
    byTimeAccount: statsByTime(since, until, bucket, "account"),
    accounts,
  };
}

export function statsPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>OpenSelect · 统计</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  header { padding: 16px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  header .muted { color: #8b949e; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
  main { padding: 20px 24px 60px; max-width: 1500px; margin: 0 auto; }
  h2 { font-size: 15px; margin: 26px 0 10px; color: #8b949e; font-weight: 600; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 14px 16px; min-width: 0; }
  .filters { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .filters label { font-size: 12px; color: #8b949e; }
  select { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 8px; font-size: 12.5px; }
  .btn { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn:hover { background: #30363d; }
  .btn.primary { background: #238636; border-color: #2ea043; }
  .btn.primary:hover { background: #2ea043; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0; }
  .summary .card { padding: 12px 14px; }
  .summary .lbl { font-size: 12px; color: #8b949e; }
  .summary .big { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid #21262d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
  th { color: #8b949e; font-weight: 500; }
  .mono { font-family: ui-monospace, monospace; }
  .muted { color: #8b949e; }
  .ok { color: #3fb950; }
  .bad { color: #f85149; }
  .warn { color: #d29922; }
  .matrix th, .matrix td { padding: 4px 8px; }
  .matrix th:first-child, .matrix td:first-child { position: sticky; left: 0; z-index: 2; background: #161b22; min-width: 150px; }
  .matrix thead th:first-child { z-index: 3; }
  .matrix td { text-align: center; }
  .matrix td:first-child { text-align: left; }
  .matrix th:not(:first-child) { text-align: center; }
  footer { padding: 8px 24px; color: #8b949e; font-size: 12px; border-top: 1px solid #21262d; }
</style>
<style>${UI_CSS}</style>
</head>
<body>
${navHtml("stats")}
<main>
  <div class="hero">
    <div><h1>用量统计</h1><p>模型 / 账号 / 时间矩阵与请求成功率</p></div>
    <div class="statusline" id="hdr"></div>
  </div>
  <div class="filters card">
    <label>范围
      <select id="range">
        <option value="today">今天</option>
        <option value="24h" selected>最近 24 小时</option>
        <option value="7d">最近 7 天</option>
        <option value="30d">最近 30 天</option>
      </select>
    </label>
    <label>粒度
      <select id="bucket">
        <option value="hour" selected>按小时</option>
        <option value="day">按天</option>
      </select>
    </label>
    <button class="btn primary" id="refresh">刷新</button>
    <span class="msg muted" id="msg"></span>
  </div>

  <div class="summary" id="summary"></div>

  <h2>模型用量 <span class="muted" id="modelMeta"></span></h2>
  <div class="tablewrap card" style="padding:0">
    <table>
      <thead><tr><th>实际模型</th><th>请求模型</th><th>请求数</th><th>占比</th><th>成功</th><th>失败</th><th>平均耗时</th><th>最后调用</th></tr></thead>
      <tbody id="modelRows"></tbody>
    </table>
  </div>

  <h2>账号用量 <span class="muted" id="accountMeta"></span></h2>
  <div class="tablewrap card" style="padding:0">
    <table>
      <thead><tr><th>账号</th><th>请求数</th><th>占比</th><th>成功</th><th>失败</th><th>平均耗时</th><th>最后调用</th><th>5小时 / 周 / 月</th><th>状态</th></tr></thead>
      <tbody id="accountRows"></tbody>
    </table>
  </div>

  <h2>模型 × 账号</h2>
  <div class="tablewrap card" style="padding:0"><table class="matrix" id="modelAccountMatrix"></table></div>

  <h2>时间 × 模型</h2>
  <div class="tablewrap card" style="padding:0"><table class="matrix" id="modelMatrix"></table></div>

  <h2>时间 × 账号</h2>
  <div class="tablewrap card" style="padding:0"><table class="matrix" id="accountMatrix"></table></div>
</main>
<footer id="foot"></footer>
<script>
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];}); }
function num(n){ return (n==null||isNaN(n))?"0":Number(n).toLocaleString("zh-CN"); }
function pct(p){ return (p==null||!isFinite(p))?"-":(p*100).toFixed(1)+"%"; }
function dur(ms){ if(ms==null||ms<0||!isFinite(ms)) return "-"; var s=Math.floor(ms/1000); if(s<60) return s+"s"; var m=Math.floor(s/60); if(m<60) return m+"m"+(s%60)+"s"; var h=Math.floor(m/60); return h+"h"+(m%60)+"m"; }
function fmtT(ts){ if(!ts) return "-"; var d=new Date(ts); return d.toLocaleString("zh-CN",{hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}); }
function short(s,n){ s=String(s||""); return s.length>n?s.slice(0,n-1)+"…":s; }
function rangeLabel(r){ return r==="today"?"今天":r==="7d"?"最近 7 天":r==="30d"?"最近 30 天":"最近 24 小时"; }
function card(lbl,val){ return '<div class="card"><div class="lbl">'+lbl+'</div><div class="big">'+val+'</div></div>'; }
function empty(cols){ return '<tr><td colspan="'+cols+'" class="muted">暂无数据</td></tr>'; }
function statusClass(s){ if(s==="zen"||s==="失败") return "muted"; return (s==="冷却中"||s==="已限流"||s==="Key 无效"||s==="已禁用")?"bad":(s==="接近阈值"?"warn":"ok"); }
function load(){
  var range=document.getElementById("range").value;
  var bucket=document.getElementById("bucket").value;
  var msg=document.getElementById("msg");
  msg.textContent="加载中…"; msg.className="msg muted";
  fetch("/api/stats?range="+encodeURIComponent(range)+"&bucket="+encodeURIComponent(bucket))
    .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(d){ render(d); msg.textContent=""; })
    .catch(function(e){ msg.textContent="加载失败："+e.message; msg.className="msg bad"; });
}
function render(d){
  document.getElementById("hdr").textContent="范围 "+rangeLabel(d.range)+" · 粒度 "+(d.bucket==="hour"?"小时":"天")+" · 更新于 "+fmtT(d.now);
  var t=d.totals||{requests:0,ok:0,errors:0,avgLatencyMs:0,models:0,accounts:0};
  var rate=t.requests?t.ok/t.requests:0;
  document.getElementById("summary").innerHTML=
    card("请求总数",num(t.requests))+card("成功率",pct(rate))+card("失败",num(t.errors))+
    card("平均耗时",dur(t.avgLatencyMs))+card("模型数",num(t.models))+card("配置账号",num((d.accounts||[]).length));

  var total=t.requests||1;
  var byModel=d.byModel||[];
  document.getElementById("modelMeta").textContent=" · "+byModel.length+" 个模型";
  document.getElementById("modelRows").innerHTML=byModel.map(function(m){
    var req=(m.requestedModels||[]).filter(function(x){return x!==m.model;});
    return '<tr><td><b>'+esc(m.model)+'</b></td><td class="muted mono">'+esc(req.length?req.join(", "):"-")+'</td><td>'+num(m.requests)+'</td><td>'+pct(m.requests/total)+'</td><td class="ok">'+num(m.ok)+'</td><td class="bad">'+num(m.errors)+'</td><td>'+dur(m.avgLatencyMs)+'</td><td class="muted">'+fmtT(m.lastTs)+'</td></tr>';
  }).join("")||empty(8);

  var byAccount=d.byAccount||[];
  var statMap={}; byAccount.forEach(function(a){statMap[a.accountId]=a;});
  var accounts=(d.accounts||[]).slice();
  byAccount.forEach(function(a){
    if(accounts.some(function(x){return x.id===a.accountId;})) return;
    var extra = a.accountId==="zen-local"
      ? {label:"zen 本地（不占账号）",status:"zen"}
      : a.accountId==="-"
        ? {label:"未落账号（失败请求）",status:"失败"}
        : a.accountId==="__other__"
          ? {label:"其他（失败尝试链）",status:"失败"}
          : {label:a.accountId,status:"未知"};
    accounts.push({id:a.accountId,label:extra.label,status:extra.status,pressure:0,cooldownLeftMs:0,usage:null});
  });
  accounts.sort(function(a,b){ var ra=(statMap[a.id]||{}).requests||0, rb=(statMap[b.id]||{}).requests||0; return rb-ra; });
  document.getElementById("accountMeta").textContent=" · "+accounts.length+" 个账号/来源";
  document.getElementById("accountRows").innerHTML=accounts.map(function(a){
    var s=statMap[a.id]||{requests:0,ok:0,errors:0,avgLatencyMs:0,lastTs:0};
    var u=a.usage||{};
    var usage=[["5h",u.rolling],["周",u.weekly],["月",u.monthly]].map(function(x){ return x[0]+" "+pct(x[1]&&x[1].percent); }).join(" / ");
    var stText=a.status+(a.cooldownLeftMs>0?" · "+dur(a.cooldownLeftMs):"");
    return '<tr><td>'+esc(a.label||a.id)+'</td><td>'+num(s.requests)+'</td><td>'+pct(s.requests/total)+'</td><td class="ok">'+num(s.ok)+'</td><td class="bad">'+num(s.errors)+'</td><td>'+dur(s.avgLatencyMs)+'</td><td class="muted">'+fmtT(s.lastTs)+'</td><td class="mono">'+esc(usage)+'</td><td><span class="'+statusClass(a.status)+'">'+esc(stText)+'</span></td></tr>';
  }).join("")||empty(9);

  var labels={}; (d.accounts||[]).forEach(function(a){labels[a.id]=a.label||a.id;});
  var maRows=(d.byModelAccount||[]).map(function(x){ return {bucket:x.model,key:x.accountId,requests:x.requests}; });
  renderMatrix("modelAccountMatrix",maRows,(d.accounts||[]).map(function(a){return a.id;}),"模型",labels);
  renderMatrix("modelMatrix",d.byTimeModel,byModel.slice(0,10).map(function(m){return m.model;}),"时间",{});
  renderMatrix("accountMatrix",d.byTimeAccount,(d.accounts||[]).map(function(a){return a.id;}),"时间",labels);
  document.getElementById("foot").textContent="统计只读 · 每 15 秒自动刷新 · 时间按本机时区（"+new Date().toLocaleTimeString("zh-CN",{hour12:false})+"）";
}
function renderMatrix(id,rows,columns,firstLabel,labels){
  var table=document.getElementById(id);
  var buckets=[], seen={};
  (rows||[]).forEach(function(r){ if(!seen[r.bucket]){seen[r.bucket]=1;buckets.push(r.bucket);} });
  var colSet={}; columns.forEach(function(c){colSet[c]=1;});
  var data={};
  (rows||[]).forEach(function(r){
    data[r.bucket]=data[r.bucket]||{};
    var k=colSet[r.key]?r.key:"__other__";
    data[r.bucket][k]=(data[r.bucket][k]||0)+r.requests;
  });
  var head='<thead><tr><th>'+esc(firstLabel)+'</th>'+columns.map(function(c){return '<th title="'+esc(labels[c]||c)+'">'+esc(short(labels[c]||c,18))+'</th>';}).join("")+'<th>其他</th><th>合计</th></tr></thead>';
  var body=buckets.map(function(b){
    var cells=columns.map(function(c){var v=(data[b]||{})[c]||0;return '<td class="'+(v?"":"muted")+'">'+(v||"—")+'</td>';}).join("");
    var other=(data[b]||{})["__other__"]||0;
    var sum=columns.reduce(function(a,c){return a+((data[b]||{})[c]||0);},0)+other;
    return '<tr><td class="mono">'+esc(b)+'</td>'+cells+'<td class="'+(other?"":"muted")+'">'+(other||"—")+'</td><td>'+sum+'</td></tr>';
  }).join("");
  table.innerHTML=head+'<tbody>'+(body||'<tr><td colspan="'+(columns.length+3)+'" class="muted">暂无数据</td></tr>')+'</tbody>';
}
document.getElementById("range").onchange=function(){
  document.getElementById("bucket").value=(this.value==="7d"||this.value==="30d")?"day":"hour";
  load();
};
document.getElementById("bucket").onchange=load;
document.getElementById("refresh").onclick=load;
load();
setInterval(load,15000);
</script>
</body>
</html>`;
}
