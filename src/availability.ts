import { UI_CSS, navHtml } from "./ui";

/**
 * 独立「模型可用性」页。
 *
 * 主控制台只保留一行摘要；这里默认先给结论（全量一致 / 差异数量），
 * 明细折叠在 <details> 里。账号多时不再把 N 个账号铺成矩阵列。
 */
export function availabilityPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>OpenSelect · 模型可用性</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  header { padding: 16px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; }
  header .muted { color: #8b949e; font-size: 12px; }
  main { padding: 20px 24px 60px; max-width: 1500px; margin: 0 auto; }
  h2 { font-size: 15px; margin: 26px 0 10px; color: #8b949e; font-weight: 600; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 14px 16px; min-width: 0; }
  .filters { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .filters label { font-size: 12px; color: #8b949e; }
  .input { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 8px; font-size: 12.5px; min-width: 260px; }
  .btn { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn:hover { background: #30363d; }
  .btn.primary { background: #238636; border-color: #2ea043; }
  .btn.primary:hover { background: #2ea043; }
  .btn:disabled { opacity: .5; cursor: wait; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 0; }
  .summary .card { padding: 12px 14px; }
  .summary .lbl { font-size: 12px; color: #8b949e; }
  .summary .big { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 420px; }
  th { color: #8b949e; font-weight: 500; }
  .mono { font-family: ui-monospace, monospace; }
  .muted { color: #8b949e; }
  .yes { color: #3fb950; }
  .no { color: #f85149; }
  .warn { color: #d29922; }
  .chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .chip { font-size: 11px; padding: 1px 7px; border: 1px solid #30363d; border-radius: 999px; color: #8b949e; }
  details { margin-top: 10px; }
  details summary { cursor: pointer; color: #8b949e; font-size: 13px; padding: 6px 0; }
  details[open] summary { margin-bottom: 8px; }
  .hint { margin-top: 12px; color: #8b949e; font-size: 12px; }
  .msg { font-size: 12px; }
  .msg.ok { color: #3fb950; }
  .msg.err { color: #f85149; }
</style>
<style>${UI_CSS}</style>
</head>
<body>
${navHtml("models")}
<main>
  <div class="hero">
    <div><h1>模型可用性</h1><p>按账号实际可用模型与覆盖差异</p></div>
    <div class="statusline" id="hdr"></div>
  </div>
  <div class="filters card">
    <button id="refresh" class="btn primary">刷新各账号可用模型</button>
    <span id="msg" class="msg"></span>
  </div>

  <div class="summary" id="summary"></div>

  <details id="modelDetails">
    <summary id="modelSummary">模型明细</summary>
    <div class="filters" style="margin-bottom:8px">
      <input id="search" class="input" placeholder="搜索模型名或 ID">
      <label><input type="checkbox" id="onlyDiff"> 只看有差异的模型</label>
    </div>
    <div class="tablewrap card" style="padding:0">
      <table>
        <thead><tr><th>模型</th><th>免费</th><th>可用账号</th><th>覆盖</th><th>缺失账号</th><th>最近探测</th></tr></thead>
        <tbody id="modelRows"></tbody>
      </table>
    </div>
  </details>

  <details id="accountDetails">
    <summary id="accountSummary">账号明细</summary>
    <div class="tablewrap card" style="padding:0">
      <table>
        <thead><tr><th>账号</th><th>可用模型</th><th>覆盖</th><th>缺失模型</th><th>最近拉取</th></tr></thead>
        <tbody id="accountRows"></tbody>
      </table>
    </div>
  </details>

  <div class="hint">可用性来自各账号实际 <code>GET /v1/models</code>。默认先给结论；只有存在差异时才自动展开明细。账号多时请用搜索或「只看有差异的模型」。</div>
</main>
<script>
var state = null;
var initialized = false;
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];}); }
function num(n){ return (n==null||isNaN(n))?"0":Number(n).toLocaleString("zh-CN"); }
function pct(p){ return (p==null||!isFinite(p))?"-":(p*100).toFixed(1)+"%"; }
function ago(ts){ if(!ts) return "从未"; var s=Math.floor((Date.now()-ts)/1000); if(s<60) return s+"s 前"; var m=Math.floor(s/60); if(m<60) return m+"m"+(s%60)+"s 前"; var h=Math.floor(m/60); return h+"h"+(m%60)+"m 前"; }
function card(lbl,val){ return '<div class="card"><div class="lbl">'+lbl+'</div><div class="big">'+val+'</div></div>'; }
function chip(s){ return '<span class="chip">'+esc(s)+'</span>'; }
function load(){
  fetch("/api/state").then(function(r){ return r.json(); }).then(function(s){ state=s; render(); }).catch(function(e){ document.getElementById("msg").textContent="加载失败："+e.message; document.getElementById("msg").className="msg err"; });
}
function render(){
  var s=state||{};
  var accounts=(s.accounts||[]).filter(function(a){
    return a.integration==="opencode-go" || a.integration==="zai" || a.integration==="minimax" || a.integration==="deepseek-api" || a.integration==="commandcode" || a.integration==="ollama";
  });
  var cache=s.models||{};
  var cat={}; (s.catalog||[]).forEach(function(m){ cat[m.id]=m; });
  var groups={};
  accounts.forEach(function(a){ var g=a.integration||"opencode-go"; (groups[g]=groups[g]||[]).push(a); });
  var groupInfo={}; var all={}; var diff=0; var fetchedCount=0; var lastTs=0;
  Object.keys(groups).forEach(function(g){
    var list=groups[g];
    var fetched=list.filter(function(a){ return !!cache[a.id]; });
    var union={}; fetched.forEach(function(a){ (cache[a.id].ids||[]).forEach(function(id){ union[id]=1; }); });
    var ids=Object.keys(union);
    ids.forEach(function(id){ all[id]=1; });
    var missing={}; var gdiff=0;
    ids.forEach(function(id){
      var miss=fetched.filter(function(a){ return (cache[a.id].ids||[]).indexOf(id)<0; });
      missing[id]=miss;
      if(miss.length) gdiff++;
    });
    groupInfo[g]={ accounts:list, fetched:fetched, ids:ids, missing:missing, diff:gdiff };
    diff += gdiff;
    fetchedCount += fetched.length;
    fetched.forEach(function(a){ lastTs=Math.max(lastTs, cache[a.id].ts||0); });
  });
  if (cat["coding-auto"]) all["coding-auto"] = 1;
  var ids=Object.keys(all);
  var pending=accounts.length-fetchedCount;
  var coverage=fetchedCount===0
    ? '<span class="warn">尚未拉取</span>'
    : pending
      ? '<span class="warn">'+pending+' 个账号未拉取</span>'
      : diff
        ? '<span class="warn">'+diff+' 个模型有组内差异</span>'
        : '<span class="yes">各组内全部一致</span>';
  document.getElementById("hdr").textContent=accounts.length+" 个账号 · "+ids.length+" 个模型"+(pending?" · "+pending+" 个未拉取":"")+" · 最近拉取 "+ago(lastTs);
  document.getElementById("summary").innerHTML=
    card("账号数",num(accounts.length))+
    card("模型数",num(ids.length))+
    card("覆盖结论",coverage)+
    card("最近拉取",ago(lastTs));

  var modelDetails=document.getElementById("modelDetails");
  var accountDetails=document.getElementById("accountDetails");
  if(fetchedCount===0){
    modelDetails.open=false;
    accountDetails.open=false;
    document.getElementById("modelSummary").textContent="模型明细（尚未拉取）";
    document.getElementById("accountSummary").textContent="账号覆盖（尚未拉取）";
    document.getElementById("modelRows").innerHTML='<tr><td colspan="6" class="muted">点上方「刷新各账号可用模型」</td></tr>';
    document.getElementById("accountRows").innerHTML='<tr><td colspan="5" class="muted">点上方「刷新各账号可用模型」</td></tr>';
    initialized=false;
    return;
  }
  if(!initialized){
    document.getElementById("onlyDiff").checked=diff>0;
    modelDetails.open=diff>0 || pending>0;
    accountDetails.open=diff>0 || pending>0;
    initialized=true;
  }
  document.getElementById("modelSummary").textContent=diff? ("模型差异（"+diff+" 个）") : ("全部模型（"+ids.length+" 个，各组内无差异）");
  document.getElementById("accountSummary").textContent=pending? ("账号覆盖（"+pending+" 个未拉取）") : diff? "账号差异" : ("账号覆盖（"+fetchedCount+" 个，各组内一致）");

  var q=(document.getElementById("search").value||"").trim().toLowerCase();
  var onlyDiff=document.getElementById("onlyDiff").checked;
  var rows=ids.map(function(id){
    var m=cat[id]||{id:id,name:id,free:false};
    var provider=m.provider||"opencode-go";
    var groupKey=provider==="deepseek"?"deepseek-api":provider;
    if(provider==="auto"){
      return { id:id, m:m, provider:provider, miss:[], avail:0, total:0, cov:"虚拟", last:0, virtual:true };
    }
    var gi=groupInfo[groupKey];
    var gAccounts=gi?gi.fetched:[];
    var miss=gi?(gi.missing[id]||[]):[];
    var avail=gAccounts.length-miss.length;
    var cov=gAccounts.length?avail+"/"+gAccounts.length:"0/0";
    var last=0; gAccounts.forEach(function(a){ if((cache[a.id].ids||[]).indexOf(id)>=0) last=Math.max(last,cache[a.id].ts||0); });
    return { id:id, m:m, provider:provider, miss:miss, avail:avail, total:gAccounts.length, cov:cov, last:last, virtual:false };
  }).filter(function(r){
    if(r.virtual && onlyDiff) return false;
    if(onlyDiff && r.miss.length===0) return false;
    if(!q) return true;
    return (r.id+" "+(r.m.name||"")).toLowerCase().indexOf(q)>=0;
  }).sort(function(a,b){
    if(a.miss.length!==b.miss.length) return b.miss.length-a.miss.length;
    var fa=a.m.free?0:1, fb=b.m.free?0:1;
    if(fa!==fb) return fa-fb;
    return a.id<b.id?-1:a.id>b.id?1:0;
  });
  document.getElementById("modelRows").innerHTML=rows.map(function(r){
    var pname=r.provider==="auto"?"Auto":r.provider==="zai"?"Z.ai":r.provider==="minimax"?"MiniMax":r.provider==="deepseek"?"DeepSeek":r.provider==="commandcode"?"Command Code":r.provider==="ollama"?"Ollama":"OpenCode";
    var missHtml=r.virtual
      ? '<span class="muted">虚拟路由</span>'
      : (r.miss.length
          ? '<span title="'+esc(r.miss.map(function(a){return a.label||a.id;}).join("、"))+'">'+r.miss.slice(0,3).map(function(a){return chip(a.label||a.id);}).join("")+(r.miss.length>3?'<span class="muted"> 等 '+r.miss.length+' 个</span>':'')+'</span>'
          : '<span class="muted">—</span>');
    return '<tr><td><b>'+esc(r.m.name||r.id)+'</b> <span class="chip">'+esc(pname)+'</span><div class="mono muted" style="font-size:11px">'+esc(r.id)+'</div></td>'
      + '<td>'+(r.m.free?'<span class="yes">免费</span>':'<span class="muted">—</span>')+'</td>'
      + '<td class="mono">'+esc(r.cov)+'</td>'
      + '<td class="mono '+(r.miss.length?'warn':'yes')+'">'+(r.virtual?'—':pct(r.total?r.avail/r.total:0))+'</td>'
      + '<td>'+missHtml+'</td>'
      + '<td class="muted">'+(r.virtual?'—':ago(r.last))+'</td></tr>';
  }).join("") || '<tr><td colspan="6" class="muted">'+(onlyDiff?'各组内全部一致，没有差异':'没有匹配的模型')+'</td></tr>';

  var accRows=accounts.map(function(a){
    var c=cache[a.id];
    var gi=groupInfo[a.integration||"opencode-go"];
    var groupIds=gi?gi.ids:[];
    if(!c) return { a:a, loaded:false, avail:0, total:groupIds.length, miss:groupIds, ts:0 };
    var miss=groupIds.filter(function(id){ return (c.ids||[]).indexOf(id)<0; });
    return { a:a, loaded:true, avail:groupIds.length-miss.length, total:groupIds.length, miss:miss, ts:c.ts||0 };
  }).sort(function(x,y){
    if(x.loaded!==y.loaded) return x.loaded?1:-1;
    if(x.miss.length!==y.miss.length) return y.miss.length-x.miss.length;
    return String(x.a.label||x.a.id)<String(y.a.label||y.a.id)?-1:1;
  });
  document.getElementById("accountRows").innerHTML=accRows.map(function(r){
    var missHtml=!r.loaded
      ? '<span class="muted">未拉取</span>'
      : (r.miss.length
          ? '<span title="'+esc(r.miss.join("、"))+'">'+r.miss.slice(0,4).map(function(id){return chip(id);}).join("")+(r.miss.length>4?'<span class="muted"> 等 '+r.miss.length+' 个</span>':'')+'</span>'
          : '<span class="muted">—</span>');
    return '<tr><td>'+esc(r.a.label||r.a.id)+'</td>'
      + '<td class="mono">'+(r.loaded?r.avail+"/"+r.total:'—')+'</td>'
      + '<td class="mono '+(r.loaded&&r.miss.length?'warn':'yes')+'">'+(r.loaded?pct(r.total?r.avail/r.total:0):'—')+'</td>'
      + '<td>'+missHtml+'</td>'
      + '<td class="muted">'+(r.loaded?ago(r.ts):'—')+'</td></tr>';
  }).join("") || '<tr><td colspan="5" class="muted">暂无账号</td></tr>';
}
document.getElementById("search").oninput=render;
document.getElementById("onlyDiff").onchange=render;
document.getElementById("refresh").onclick=function(){
  var b=this; var msg=document.getElementById("msg");
  b.disabled=true; msg.textContent="刷新中（逐账号 GET /v1/models）…"; msg.className="msg";
  fetch("/api/models/refresh",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})
    .then(function(r){ return r.json(); })
    .then(function(j){
      b.disabled=false;
      if(!j.ok){ msg.textContent=(j.error||"刷新失败"); msg.className="msg err"; return; }
      var ok=0, fail=0;
      var res=j.results||{};
      Object.keys(res).forEach(function(k){ if(res[k].ok) ok++; else fail++; });
      msg.textContent="✓ 完成："+ok+" 个账号成功"+(fail?("，"+fail+" 个失败"):""); msg.className="msg ok";
      load();
    })
    .catch(function(e){ b.disabled=false; msg.textContent="刷新失败："+e.message; msg.className="msg err"; });
};
load();
</script>
</body>
</html>`;
}
