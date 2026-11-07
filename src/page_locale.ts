/** Translate fixed UI copy in the analytics pages. Account/model names and API
 * error details are deliberately left untouched. Locale selection lives in ui.ts. */
export const PAGE_LOCALE = `<script>
(function(){
  if (window.osLang !== 'en') return;
  var words = {
    '统计':'Statistics','用量统计':'Usage statistics','模型 / 账号 / 时间矩阵与请求成功率':'Model, account, and time breakdowns with request success rates',
    '范围':'Range','今天':'Today','最近 24 小时':'Last 24 hours','最近 24h':'Last 24 hours','最近 7 天':'Last 7 days','最近 30 天':'Last 30 days','全部历史':'All time','全部':'All',
    '粒度':'Interval','按小时':'Hourly','按天':'Daily','刷新':'Refresh','模型用量':'Model usage','账号用量':'Account usage','实际模型':'Actual model','请求模型':'Requested model','请求数':'Requests','请求总数':'Total requests','占比':'Share','成功':'Success','失败':'Failed','平均耗时':'Average latency','最后调用':'Last request','账号':'Account','5小时 / 周 / 月':'5h / week / month','状态':'Status','模型 × 账号':'Model × account','时间 × 模型':'Time × model','时间 × 账号':'Time × account','模型':'Model','时间':'Time','其他':'Other','合计':'Total','成功率':'Success rate','模型数':'Models','配置账号':'Configured accounts','暂无数据':'No data',
    '模型可用性':'Model availability','按账号实际可用模型与覆盖差异':'Model availability and coverage by account','刷新各账号可用模型':'Refresh available models','模型明细':'Model details','账号明细':'Account details','只看有差异的模型':'Only show differences','免费':'Free','可用账号':'Available accounts','覆盖':'Coverage','缺失账号':'Missing accounts','最近探测':'Last checked','可用模型':'Available models','缺失模型':'Missing models','最近拉取':'Last fetched','账号数':'Accounts','覆盖结论':'Coverage summary','尚未拉取':'Not fetched','各组内全部一致':'All accounts match within each group','虚拟路由':'Virtual route','未拉取':'Not fetched','暂无账号':'No accounts',
    '请求流水':'Request log','切换记录':'Switch history','请求与切换台账 · 只读':'Request and switch history · read only','接入':'Client','搜索':'Search','查询':'Search','尝试':'Attempts','耗时':'Latency','路径':'Path','上一页':'Previous','下一页':'Next','类型':'Type','故障切换':'Failover','会话重绑':'Session rebind','从账号':'From account','到账号':'To account','原因':'Reason','会话':'Session','从':'From','到':'To','详情':'Details','主要原因':'Top reasons','原因种类':'Reason types','没有匹配的请求':'No matching requests','没有匹配的切换记录':'No matching switches','无':'None',
    'Token 消费统计':'Token usage','按供应商、账号、模型与时间追踪上游 usage；本地估算单独标记，缺失上报显示“未上报”。':'Track provider usage by account, model and time. Estimates are marked; missing usage is not reported.',
    '总 Token':'Total tokens','输入 — / 输出 —':'Input — / output —','估算支出':'Estimated cost','理论参考费用':'Reference cost','已知单价':'Known prices','不含订阅费 / 税费':'Excludes subscriptions and taxes','缓存命中':'Cache hit rate','缓存读取 —':'Cache read —','活跃账号 / 模型':'Active accounts / models','连接数 —':'Connections —','活跃度':'Activity','少':'Less','多':'More','24 小时节奏':'24-hour activity','供应商消费':'Provider usage','供应商':'Provider','连接数':'Connections','输入':'Input','输出':'Output','缓存读':'Cache read','账号消费排行':'Account usage ranking','模型消费排行':'Model usage ranking','Token 趋势':'Token trend','接入（客户端）消费':'Client usage','客户端':'Client','有 usage':'With usage','OpenSelect · Token 统计 · 每 15 秒自动刷新':'OpenSelect · Token usage · refreshes every 15 seconds',
    '建议线路':'Suggested route','Claude Code 启动命令':'Claude Code launch commands','自动线路':'Automatic route','复制':'Copy','线路优化':'Route optimization','当前时段 × 套餐额度 × 账号压力 → 最低有效成本线路':'Time window × plan allowance × account pressure → lowest effective cost','加载中…':'Loading…','当前最优线路':'Best available route','有效成本':'Effective cost','当前时段':'Current window','数据采集':'Data collection','线路排行':'Route ranking','成本 × 账号压力；不可用线路保留在表内':'Cost × account pressure; unavailable routes remain visible','供应商 / 套餐':'Provider / plan','账号压力':'Account pressure','质量 / 延迟 / 可靠':'Quality / latency / reliability','可用':'Available','不可用':'Unavailable','下一次切换':'Next change','理由':'Reason','供应商高峰 / 非高峰划分':'Provider peak / off-peak windows','时区':'Time zone','高峰窗口':'Peak window','非高峰折扣':'Off-peak discount','当前':'Current','来源':'Source','订阅套餐分时规则':'Plan time-window rules','套餐':'Plan','月费':'Monthly fee','内含额度':'Included credit','基准比例':'Base ratio','分时规则':'Time-window rule','有效比例':'Effective ratio','有效 $/M':'Effective $/M','算法':'Algorithm','自动采集':'Automatic collection','立即采集官方页面':'Collect official pages now','官方':'Official',
    '可用性来自各账号实际':'Availability comes from each account’s actual',
    '。默认先给结论；只有存在差异时才自动展开明细。账号多时请用搜索或「只看有差异的模型」。':'. The summary is shown first; details expand when differences exist. Use search or the differences filter for large account pools.',
    '默认最近 24h、每页 100 条；点「详情」查看会话、家族、实际服务模型与错误。筛选条件只影响当前查询。':'Defaults to the last 24 hours and 100 rows per page. Select Details to inspect the session, protocol, served model, and error.',
    '默认最近 24h、每页 100 条，并默认只看「故障切换」；会话重绑请把类型切到「会话重绑」。「原因」支持模糊匹配（如 429、invalid、403）。':'Defaults to the last 24 hours and 100 rows per page. Select Session rebind to view rebindings; Reason supports partial matches.',
    '有效成本':'Effective cost','线路得分':'Route score',
    '= 基准 $0.375/M × 套餐基准比例 × 当前分时倍率。':'= baseline $0.375/M × plan base ratio × current time multiplier.',
    '= 有效成本 × (1 + 账号压力 × 权重 + 延迟分 × 权重 + (1 − 质量分) × 权重 + (1 − 可靠性) × 权重)。':'= effective cost × (1 + weighted account pressure + weighted latency + weighted (1 − quality) + weighted (1 − reliability)).',
    '默认权重：压力 0.25、延迟 0.15、质量 0.20、可靠性 0.15；可在':'Default weights: pressure 0.25, latency 0.15, quality 0.20, reliability 0.15. Adjust',
    '的':'in', '调整。':'settings.',
    '延迟/可靠性取最近 24h 该供应商平均耗时与成功率；无样本按中性 0.5。质量分为可配置基准，不是公开 benchmark。':'Latency and reliability use provider averages over 24 hours; missing samples use a neutral 0.5. Quality is a configurable baseline, not a public benchmark.',
    '可用性优先：账号必须启用、未失效、未冷却、未限流。':'Availability first: accounts must be enabled, valid, not cooling down, and not rate-limited.',
    '选择得分最低且可用的线路；没有可用线路时显示“无可用线路”。':'Select the available route with the lowest score; show no available route when none qualify.',
    '套餐比例 = 月费 ÷ 内含 DeepSeek 官方等价额度；仅用于同口径比较。':'Plan ratio = monthly fee ÷ included DeepSeek-equivalent credit, for like-for-like comparison only.',
    '正常':'Healthy','已禁用':'Disabled','Key 无效':'Invalid key','冷却中':'Cooling down','已限流':'Rate limited','接近阈值':'Near threshold','未知':'Unknown','无分时':'No time window','高峰':'Peak','非高峰':'Off-peak','无分时切换':'No scheduled change','有错误':'Errors','已采集':'Collected','未运行':'Not run','无可用线路':'No available route','当前线路':'Current route','暂无候选':'No candidates','暂无供应商':'No providers','暂无套餐':'No plans','采集中…':'Collecting…','✓ 采集完成':'✓ Collection complete','采集完成（有错误）':'Collection complete (with errors)'
  };
  var attributes = {'搜索模型名或 ID':'Search model name or ID','路径 / 会话 / 错误':'Path / session / error','会话 / 详情 / 账号':'Session / details / account'};
  var staticAreas = 'h1,h2,h3,th,option,button,label,summary,.hint,.lbl,.pill,footer,title,.hero p,.algo';
  function translateNode(node){
    if(node.nodeType!==3 || !node.parentElement) return;
    var p=node.parentElement, raw=node.nodeValue, trimmed=raw.trim();
    if(!trimmed || !p.closest('main,footer,title')) return;
    // Account/client choices are populated from user data; only fixed filter options are translatable.
    if(p.tagName==='OPTION' && !p.closest('select#range,select#bucket,select#status,select#kind')) return;
    // Never rewrite account names, model IDs, paths, upstream errors or other user data.
    if(p.closest('tbody') && !p.matches('button,span.ok,span.bad,span.warn,span.yes,span.no,span.good')) return;
    if(!p.matches(staticAreas) && !p.closest(staticAreas) && !p.matches('.statusline,.msg,.sub,.big')) return;
    var replacement=words[trimmed];
    if(replacement) node.nodeValue=raw.replace(trimmed,replacement);
  }
  function translate(root){
    if(root.nodeType===3){translateNode(root); return;}
    if(root.nodeType!==1 && root.nodeType!==9) return;
    if(root.nodeType===1 && /^(SCRIPT|STYLE)$/.test(root.tagName)) return;
    var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); var n;
    while((n=walker.nextNode())) translateNode(n);
    if(root.querySelectorAll) root.querySelectorAll('[placeholder]').forEach(function(el){var x=attributes[el.getAttribute('placeholder')];if(x) el.setAttribute('placeholder',x);});
  }
  function start(){
    var note=document.querySelector('.note');
    if(note && location.pathname==='/tokens') note.textContent='Usage includes provider-reported values and separately marked local estimates. Cache rates cover only requests with reported cache data; other requests are unknown. Costs are theoretical estimates, not provider bills; historical unreported usage cannot be recovered.';
    translate(document);
    new MutationObserver(function(records){records.forEach(function(r){if(r.type==='characterData') translateNode(r.target); else r.addedNodes.forEach(translate);});}).observe(document.body,{subtree:true,childList:true,characterData:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start); else start();
})();
</script>`;
