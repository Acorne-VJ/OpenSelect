import { PAGE_LOCALE } from "./page_locale";
import { UI_CSS, navHtml, type NavKey } from "./ui";

/**
 * 独立日志页：请求流水 / 切换记录。
 *
 * 主控制台只保留最近 24h 摘要；完整表格放到独立页，带过滤、分页和详情，
 * 避免账号/请求一多就把主面板撑爆。
 */

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  header { padding: 16px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  header .muted { color: #8b949e; font-size: 12px; }
  main { padding: 20px 24px 60px; max-width: 1600px; margin: 0 auto; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 14px 16px; min-width: 0; }
  .filterbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .filterbar label { font-size: 12px; color: #8b949e; display: flex; gap: 6px; align-items: center; }
  select, .input { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 8px; font-size: 12.5px; }
  .input { min-width: 160px; }
  .btn { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn:hover { background: #30363d; }
  .btn.primary { background: #238636; border-color: #2ea043; }
  .btn.primary:hover { background: #2ea043; }
  .btn:disabled { opacity: .45; cursor: default; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0; }
  .summary .card { padding: 12px 14px; }
  .summary .lbl { font-size: 12px; color: #8b949e; }
  .summary .big { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
  th { color: #8b949e; font-weight: 500; }
  .mono { font-family: ui-monospace, monospace; }
  .muted { color: #8b949e; }
  .ok { color: #3fb950; }
  .bad { color: #f85149; }
  .warn { color: #d29922; }
  .pill { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid #30363d; }
  .pill.ok { color: #3fb950; border-color: #238636; }
  .pill.bad { color: #f85149; border-color: #da3633; }
  .pill.warn { color: #d29922; border-color: #9e6a03; }
  .pager { display: flex; gap: 12px; align-items: center; justify-content: flex-end; margin-top: 12px; flex-wrap: wrap; }
  .detail td { background: #0d1117; white-space: normal; }
  .detail .kv { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; color: #8b949e; }
  .hint { margin-top: 12px; color: #8b949e; font-size: 12px; }
  a { color: #58a6ff; }
` + UI_CSS;

const COMMON_JS = `
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];}); }
function num(n){ return (n==null||isNaN(n))?"0":Number(n).toLocaleString("zh-CN"); }
function pct(p){ return (p==null||!isFinite(p))?"-":(p*100).toFixed(1)+"%"; }
function dur(ms){ if(ms==null||ms<0||!isFinite(ms)) return "-"; var s=Math.floor(ms/1000); if(s<60) return s+"s"; var m=Math.floor(s/60); if(m<60) return m+"m"+(s%60)+"s"; var h=Math.floor(m/60); return h+"h"+(m%60)+"m"; }
function fmtT(ts){ if(!ts) return "-"; var d=new Date(ts); return d.toLocaleString("zh-CN",{hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}); }
function qs(obj){ return Object.keys(obj).filter(function(k){return obj[k]!=null&&obj[k]!=="";}).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(obj[k]);}).join("&"); }
function knownClientLabel(kind, fallback){
  if(osLang!=="en") return fallback;
  return {"anthropic-compat":"Anthropic-compatible client","openai-responses":"OpenAI Responses client","openai-compat":"OpenAI Chat-compatible client","other":"Other client"}[kind] || fallback;
}
function fillSelect(id, items, valueKey, labelKey){
  var el=document.getElementById(id); if(!el) return;
  items.forEach(function(it){ var o=document.createElement("option"); o.value=it[valueKey]; o.textContent=id==="client"?knownClientLabel(it[valueKey],it[labelKey]||it[valueKey]):(it[labelKey]||it[valueKey]); el.appendChild(o); });
}
["client","account","from","to"].forEach(function(id){
  var select=document.getElementById(id);
  if(select && select.options[0] && select.options[0].value==="") select.options[0].textContent=osT("全部","All");
});
function pageButtons(total, offset, limit){
  var pages=Math.max(1,Math.ceil(total/limit));
  var page=Math.floor(offset/limit)+1;
  document.getElementById("pageInfo").textContent=osT("共 ","Total: ")+num(total)+osT(" 条 · 第 "," · Page ")+page+"/"+pages+osT(" 页","");
  document.getElementById("prev").disabled=offset<=0;
  document.getElementById("next").disabled=offset+limit>=total;
}
`;

function shell(title: string, active: NavKey, body: string, script: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>OpenSelect · ${title}</title>
<style>${CSS}</style>
</head>
<body>
${navHtml(active)}
<main>
  <div class="hero">
    <div><h1>${title}</h1><p>请求与切换台账 · 只读</p></div>
    <div class="statusline" id="hdr"></div>
  </div>
  ${body}
</main>
<script>${COMMON_JS}
${script}
</script>
${PAGE_LOCALE}
</body>
</html>`;
}

const REQUESTS_BODY = `
  <div class="filterbar card">
    <label>范围 <select id="range"><option value="24h" selected>最近 24h</option><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部</option></select></label>
    <label>接入 <select id="client"><option value="">全部</option></select></label>
    <label>账号 <select id="account"><option value="">全部</option></select></label>
    <label>状态 <select id="status"><option value="">全部</option><option value="ok">成功</option><option value="error">失败</option></select></label>
    <label>模型 <input id="model" class="input" placeholder="model / free"></label>
    <label>搜索 <input id="q" class="input" placeholder="路径 / 会话 / 错误"></label>
    <button id="apply" class="btn primary">查询</button>
    <button id="refresh" class="btn">刷新</button>
  </div>
  <div class="summary" id="summary"></div>
  <div class="tablewrap card" style="padding:0">
    <table>
      <thead><tr><th>时间</th><th>接入</th><th>模型</th><th>账号</th><th>状态</th><th>尝试</th><th>耗时</th><th>路径</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="pager"><button id="prev" class="btn">上一页</button><span id="pageInfo" class="muted"></span><button id="next" class="btn">下一页</button></div>
  <div class="hint">默认最近 24h、每页 100 条；点「详情」查看会话、家族、实际服务模型与错误。筛选条件只影响当前查询。</div>
`;

const REQUESTS_JS = `
var meta={accounts:[],clients:[]};
var curOffset=0, curLimit=100, curTotal=0;
function labels(){
  var a={}; (meta.accounts||[]).forEach(function(x){a[x.id]=x.label||x.id;});
  return a;
}
function clientLabel(kind){
  var c=(meta.clients||[]).filter(function(x){return x.kind===kind;})[0];
  return c?knownClientLabel(kind,c.label):kind||"-";
}
function loadMeta(){
  fetch("/api/state").then(function(r){return r.json();}).then(function(s){
    meta={accounts:s.accounts||[],clients:s.clients||[]};
    fillSelect("client", meta.clients, "kind", "label");
    fillSelect("account", meta.accounts, "id", "label");
    load(0);
  }).catch(function(e){ document.getElementById("rows").innerHTML='<tr><td colspan="9" class="bad">'+osT("加载失败：","Load failed: ")+esc(e.message)+'</td></tr>'; });
}
function params(offset){
  return qs({
    range: document.getElementById("range").value,
    client: document.getElementById("client").value,
    account: document.getElementById("account").value,
    status: document.getElementById("status").value,
    model: document.getElementById("model").value.trim(),
    q: document.getElementById("q").value.trim(),
    limit: curLimit,
    offset: offset
  });
}
function load(offset){
  curOffset=offset||0;
  fetch("/api/requests?"+params(curOffset)).then(function(r){return r.json();}).then(function(d){
    curTotal=d.total||0;
    var s=d.summary||{};
    var rate=s.requests?s.ok/s.requests:0;
    document.getElementById("hdr").textContent=osT("范围 ","Range: ")+document.getElementById("range").value+osT(" · 共 "," · Total: ")+num(d.total)+osT(" 条","");
    document.getElementById("summary").innerHTML=
      '<div class="card"><div class="lbl">请求数</div><div class="big">'+num(s.requests)+'</div></div>'+
      '<div class="card"><div class="lbl">成功率</div><div class="big">'+pct(rate)+'</div></div>'+
      '<div class="card"><div class="lbl">失败</div><div class="big">'+num(s.errors)+'</div></div>'+
      '<div class="card"><div class="lbl">平均耗时</div><div class="big">'+dur(s.avgLatencyMs)+'</div></div>';
    var acc=labels();
    document.getElementById("rows").innerHTML=(d.rows||[]).map(function(x){
      var cls=x.status>=400?"bad":(x.attempts>1?"warn":"ok");
      var model=esc(x.model||"-")+(x.servedModel&&x.servedModel!==x.model?' <span class="ok">→ '+esc(x.servedModel)+'</span>':'');
      var accText=acc[x.accountId]||(x.accountId==="zen-local"?osT("zen 本地","Local zen"):x.accountId==="-"? osT("未落账号","Unassigned"):osT("失败尝试链","Failed attempts"));
      return '<tr><td class="mono">'+fmtT(x.ts)+'</td>'
        +'<td>'+esc(clientLabel(x.client))+'</td>'
        +'<td>'+model+'</td>'
        +'<td title="'+esc(x.accountId||"")+'">'+esc(accText)+'</td>'
        +'<td><span class="pill '+cls+'">'+x.status+'</span></td>'
        +'<td>'+x.attempts+'</td>'
        +'<td>'+dur(x.latencyMs)+'</td>'
        +'<td class="mono muted">'+esc(x.path||"-")+'</td>'
        +'<td><button class="btn" onclick="toggleReq('+x.id+')">'+osT("详情","Details")+'</button></td></tr>'
        +'<tr id="d-'+x.id+'" class="detail" style="display:none"><td colspan="9"><div class="kv">'
        +'<span>'+osT('会话 ','Session ')+'<span class="mono">'+esc(x.sessionId||"-")+'</span></span>'
        +'<span>'+osT('账号 ','Account ')+'<span class="mono">'+esc(x.accountId||"-")+'</span></span>'
        +'<span>'+osT('家族 ','Protocol ')+esc(x.family||"-")+'</span>'
        +'<span>'+osT('实际服务模型 ','Served model ')+esc(x.servedModel||x.model||"-")+'</span>'
        +'<span>'+osT('错误 ','Error ')+esc(x.error||"-")+'</span>'
        +'</div></td></tr>';
    }).join("") || '<tr><td colspan="9" class="muted">'+osT('没有匹配的请求','No matching requests')+'</td></tr>';
    pageButtons(curTotal,curOffset,curLimit);
  }).catch(function(e){ document.getElementById("rows").innerHTML='<tr><td colspan="9" class="bad">'+osT("加载失败：","Load failed: ")+esc(e.message)+'</td></tr>'; });
}
function toggleReq(id){ var e=document.getElementById("d-"+id); if(e) e.style.display=e.style.display==="none"?"table-row":"none"; }
document.getElementById("apply").onclick=function(){ load(0); };
document.getElementById("refresh").onclick=function(){ load(curOffset); };
document.getElementById("prev").onclick=function(){ load(Math.max(0,curOffset-curLimit)); };
document.getElementById("next").onclick=function(){ load(curOffset+curLimit); };
loadMeta();
`;

const SWITCHES_BODY = `
  <div class="filterbar card">
    <label>范围 <select id="range"><option value="24h" selected>最近 24h</option><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部</option></select></label>
    <label>类型 <select id="kind"><option value="failover" selected>故障切换</option><option value="rebind">会话重绑</option><option value="all">全部</option></select></label>
    <label>从账号 <select id="from"><option value="">全部</option></select></label>
    <label>到账号 <select id="to"><option value="">全部</option></select></label>
    <label>原因 <input id="reason" class="input" placeholder="429 / invalid / 403"></label>
    <label>搜索 <input id="q" class="input" placeholder="会话 / 详情 / 账号"></label>
    <button id="apply" class="btn primary">查询</button>
    <button id="refresh" class="btn">刷新</button>
  </div>
  <div class="summary" id="summary"></div>
  <div class="tablewrap card" style="padding:0">
    <table>
      <thead><tr><th>时间</th><th>会话</th><th>从</th><th>到</th><th>原因</th><th>详情</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="pager"><button id="prev" class="btn">上一页</button><span id="pageInfo" class="muted"></span><button id="next" class="btn">下一页</button></div>
  <div class="hint">默认最近 24h、每页 100 条，并默认只看「故障切换」；会话重绑请把类型切到「会话重绑」。「原因」支持模糊匹配（如 429、invalid、403）。</div>
`;

const SWITCHES_JS = `
var meta={accounts:[]};
var curOffset=0, curLimit=100, curTotal=0;
function labels(){ var a={}; (meta.accounts||[]).forEach(function(x){a[x.id]=x.label||x.id;}); return a; }
function loadMeta(){
  fetch("/api/state").then(function(r){return r.json();}).then(function(s){
    meta={accounts:s.accounts||[]};
    fillSelect("from", meta.accounts, "id", "label");
    fillSelect("to", meta.accounts, "id", "label");
    load(0);
  }).catch(function(e){ document.getElementById("rows").innerHTML='<tr><td colspan="6" class="bad">'+osT("加载失败：","Load failed: ")+esc(e.message)+'</td></tr>'; });
}
function params(offset){
  return qs({
    range: document.getElementById("range").value,
    kind: document.getElementById("kind").value,
    from: document.getElementById("from").value,
    to: document.getElementById("to").value,
    reason: document.getElementById("reason").value.trim(),
    q: document.getElementById("q").value.trim(),
    limit: curLimit,
    offset: offset
  });
}
function load(offset){
  curOffset=offset||0;
  fetch("/api/switches?"+params(curOffset)).then(function(r){return r.json();}).then(function(d){
    curTotal=d.total||0;
    var s=d.summary||{total:0,reasons:[]};
    var top=(s.reasons||[]).slice(0,3).map(function(x){return esc(x.reason)+' '+x.count;}).join(' · ')||osT('无','None');
    var kind=document.getElementById("kind").value;
    var totalLabel=kind==="rebind"?osT("会话重绑次数","Session rebinds"):(kind==="all"?osT("切换记录数","Switches"):osT("故障切换次数","Failovers"));
    document.getElementById("hdr").textContent=osT("范围 ","Range: ")+document.getElementById("range").value+osT(" · 共 "," · Total: ")+num(d.total)+osT(" 条","");
    document.getElementById("summary").innerHTML=
      '<div class="card"><div class="lbl">'+totalLabel+'</div><div class="big">'+num(s.total)+'</div></div>'+
      '<div class="card"><div class="lbl">主要原因</div><div class="big" style="font-size:15px">'+top+'</div></div>'+
      '<div class="card"><div class="lbl">原因种类</div><div class="big">'+num((s.reasons||[]).length)+'</div></div>';
    var acc=labels();
    document.getElementById("rows").innerHTML=(d.rows||[]).map(function(x){
      var cls=String(x.reason||"").indexOf("429")===0?"warn":(String(x.reason||"").indexOf("invalid")===0?"bad":"ok");
      return '<tr><td class="mono">'+fmtT(x.ts)+'</td>'
        +'<td class="mono muted">'+esc(x.sessionId?x.sessionId.slice(-12):"-")+'</td>'
        +'<td>'+esc(acc[x.fromAccount]||x.fromAccount||"-")+'</td>'
        +'<td>'+esc(acc[x.toAccount]||x.toAccount||"-")+'</td>'
        +'<td><span class="pill '+cls+'">'+esc(x.reason||"-")+'</span></td>'
        +'<td class="muted" title="'+esc(x.detail||"")+'">'+esc(x.detail||"-")+'</td></tr>';
    }).join("") || '<tr><td colspan="6" class="muted">'+osT('没有匹配的切换记录','No matching switches')+'</td></tr>';
    pageButtons(curTotal,curOffset,curLimit);
  }).catch(function(e){ document.getElementById("rows").innerHTML='<tr><td colspan="6" class="bad">'+osT("加载失败：","Load failed: ")+esc(e.message)+'</td></tr>'; });
}
document.getElementById("apply").onclick=function(){ load(0); };
document.getElementById("refresh").onclick=function(){ load(curOffset); };
document.getElementById("prev").onclick=function(){ load(Math.max(0,curOffset-curLimit)); };
document.getElementById("next").onclick=function(){ load(curOffset+curLimit); };
loadMeta();
`;

export function requestsPage(): string {
  return shell("请求流水", "requests", REQUESTS_BODY, REQUESTS_JS);
}

export function switchesPage(): string {
  return shell("切换记录", "switches", SWITCHES_BODY, SWITCHES_JS);
}
