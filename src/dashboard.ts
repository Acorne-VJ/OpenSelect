import { CLIENT_KINDS, CLIENT_LABELS, isClientKind } from "./client";
import { existsSync } from "node:fs";
import { isFreeFirstEligible, loadCatalog, resetCatalogCache } from "./catalog";
import { createBackup, listBackups, pruneBackups, verifyBackupCached, BACKUP_KEEP_DEFAULT } from "./backup";
import { hasTrustAnchor, publicKeyFingerprint } from "./keys";
import { clientStats, deleteSession, queryRequests, querySwitches, recentAlerts, recentRequests, recentSwitches, requestTotals, setState, switchSummary, usageHistory } from "./db";
import { accountPressure, isRateLimited } from "./policy";
import type { Runtime } from "./state";
import type { AccountUsage } from "./types";
import { fetchAccountModels, fetchAccountUsage } from "./usage";
import { addAccount, BACKUP_DIR, isHhMm, loadConfig, saveConfig, SWITCH_AT_MAX, SWITCH_AT_MIN } from "./config";
import { maskKey } from "./util";
import { listZenModels, zenDenyMap, isZenModelId } from "./zen";
import { proxyBaseURL, unwireGlobal, wireGlobal, wireStatus } from "./wire";
import { connectKey } from "./opencode";
import { buildStats, statsPage } from "./stats";
import { buildTokenStats, tokenStatsPage } from "./token_stats";
import { buildRouteAdvice, routesPage } from "./routes";
import { collectTimePricing } from "./time_pricing";
import { availabilityPage } from "./availability";
import { requestsPage, switchesPage } from "./logs";
import { isProviderIntegration, providerModelIds, PROVIDER_LABELS } from "./providers";
import { pricingTablesHtml } from "./pricing";
import { UI_CSS, navHtml } from "./ui";
import { codingAutoOrder, isCodingAutoOrder } from "./coding_auto";
import { DASHBOARD_EN, PRICING_EN } from "./dashboard_locale";

/** per-account available-model cache (populated on demand via /api/models/refresh) */
const modelCache = new Map<string, { ts: number; ids: string[] }>();

/** curated integration choices for the add-account form (ids verified against `opencode api GET /api/integration`) */
const INTEGRATION_OPTIONS = [
  { id: "opencode-go", name: "OpenCode Go（用量监控 + 自动切换）" },
  { id: "google", name: "Google / Gemini（仅注册凭据）" },
  { id: "opencode", name: "OpenCode Console（仅注册凭据）" },
  { id: "anthropic", name: "Anthropic（仅注册凭据）" },
  { id: "openai", name: "OpenAI（仅注册凭据）" },
  { id: "deepseek", name: "DeepSeek（仅注册凭据）" },
  { id: "deepseek-api", name: "DeepSeek 官方（直连，仅兜底）" },
  { id: "xai", name: "xAI（仅注册凭据）" },
  { id: "zai", name: "Z.ai GLM（直连 + 5h/周用量）" },
  { id: "minimax", name: "MiniMax M Plan（直连 + 5h/周用量）" },
  { id: "commandcode", name: "Command Code Provider（直连 + API Key）" },
  { id: "ollama", name: "Ollama Cloud（API Key）" },
];

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>OpenSelect</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #e6edf3; font: 14px/1.5 -apple-system, "PingFang SC", "Segoe UI", sans-serif; overflow-x: hidden; }
  header { padding: 16px 24px; border-bottom: 1px solid #21262d; display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; flex: 0 0 auto; }
  header .muted { color: #8b949e; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
  main { padding: 20px 24px 60px; max-width: 1320px; margin: 0 auto; }
  h2 { font-size: 15px; margin: 28px 0 10px; color: #8b949e; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 14px; }
  .grid.accgrid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 12px; }
  .accfilter { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: -4px 0 10px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 14px 16px; min-width: 0; }
  .card .top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .card .name { font-weight: 600; font-size: 15px; }
  .card .key { color: #8b949e; font-size: 12px; font-family: ui-monospace, monospace; }
  .pill { font-size: 12px; padding: 2px 10px; border-radius: 999px; border: 1px solid #30363d; white-space: nowrap; }
  .pill.ok { color: #3fb950; border-color: #238636; }
  .pill.warn { color: #d29922; border-color: #9e6a03; }
  .pill.bad { color: #f85149; border-color: #da3633; }
  .pill.dim { color: #8b949e; }
  .win { margin-top: 10px; }
  .win .lbl { display: flex; justify-content: space-between; font-size: 12px; color: #8b949e; margin-bottom: 3px; }
  .bar { position: relative; height: 16px; background: #21262d; border-radius: 6px; overflow: hidden; }
  .bar .fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px; }
  .bar .fill.green { background: #238636; }
  .bar .fill.amber { background: #9e6a03; }
  .bar .fill.red { background: #da3633; }
  .bar span { position: absolute; right: 6px; top: 0; font-size: 11px; line-height: 16px; color: #e6edf3; font-family: ui-monospace, monospace; }
  .more { margin-top: 8px; font-size: 12px; color: #8b949e; }
  .pricing h3 { font-size: 14px; margin: 18px 0 8px; }
  .pricing-banner { padding: 10px 12px; border: 1px solid #30363d; border-radius: 8px; background: #0d1117; color: #c9d1d9; font-size: 12.5px; line-height: 1.65; }
  .pricing-table td { white-space: normal; overflow: visible; text-overflow: clip; max-width: none; vertical-align: top; }
  .pricing-table th { white-space: nowrap; }
  .pricing-note-cell { min-width: 210px; color: #8b949e; }
  .pricing-sources { margin-top: 12px; padding-top: 10px; border-top: 1px solid #21262d; font-size: 11.5px; line-height: 1.7; color: #8b949e; }
  .pricing-sources a { color: #58a6ff; text-decoration: none; }
  .ratio-good { color: #3fb950; font-weight: 600; }
  .ratio-bad { color: #f85149; font-weight: 600; }
  .ratio-base { color: #e6edf3; font-weight: 600; }
  .spark { margin-top: 10px; }
  .spark svg { width: 100%; height: 34px; display: block; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; }
  .lg { display: flex; gap: 12px; font-size: 11px; color: #8b949e; margin-top: 4px; align-items: center; }
  .lg i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid #21262d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
  th { color: #8b949e; font-weight: 500; }
  td.mono { font-family: ui-monospace, monospace; }
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 8px; border-radius: 8px; }
  .tablewrap table { min-width: 100%; }
  .tablewrap::-webkit-scrollbar { height: 8px; }
  .tablewrap::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }
  .matrix th, .matrix td { padding: 4px 8px; }
  .matrix th:first-child, .matrix td:first-child { position: sticky; left: 0; z-index: 2; background: #161b22; min-width: 220px; max-width: 260px; }
  .matrix thead th:first-child { z-index: 3; }
  .matrix th.acct { max-width: 120px; text-align: center; }
  .matrix td.mark { text-align: center; }
  .matrix .thsub { font-weight: 400; font-size: 10px; color: #8b949e; }
  /* 账号卡：三窗口并排 + 曲线折叠，账号多时更紧凑 */
  .acc .usages { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: 10px; }
  .acc .u { min-width: 0; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 6px 7px; }
  .acc .u .lbl { display: flex; justify-content: space-between; gap: 4px; font-size: 11px; color: #8b949e; }
  .acc .u .lbl b { font-weight: 600; color: #e6edf3; }
  .acc .u .track { height: 6px; background: #21262d; border-radius: 3px; margin-top: 4px; overflow: hidden; }
  .acc .u .track i { display: block; height: 100%; border-radius: 3px; }
  .acc .u .track i.green { background: #238636; }
  .acc .u .track i.amber { background: #9e6a03; }
  .acc .u .track i.red { background: #da3633; }
  .acc .u .sub { margin-top: 3px; font-size: 10px; color: #8b949e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acc details.curve { margin-top: 4px; }
  .acc .more { margin-top: 4px; }
  .acc .btnrow { margin-top: 6px; }
  .muted { color: #8b949e; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 8px 24px; background: #0d1117ee; border-top: 1px solid #21262d; color: #8b949e; font-size: 12px; display: flex; gap: 18px; }
  .btn { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
  .btn:hover { background: #30363d; }
  .btn.primary { background: #238636; border-color: #2ea043; }
  .btn.primary:hover { background: #2ea043; }
  .btn.danger { color: #f85149; border-color: #7d2a27; }
  .btn:disabled { opacity: .5; cursor: wait; }
  .btn.sm { padding: 2px 9px; font-size: 11.5px; }
  .input { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 8px; font-size: 12.5px; width: 100%; }
  .fr { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .fr label { flex: 0 0 76px; font-size: 12px; color: #8b949e; }
  .fr > input:not([type=range]), .fr > select { min-width: 0; }
  .chk { display: flex; gap: 6px; align-items: center; margin-top: 10px; font-size: 12px; color: #8b949e; }
  .btnrow { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .msg { font-size: 12px; }
  .msg.ok { color: #3fb950; }
  .msg.err { color: #f85149; }
  .msg.warn { color: #d29922; }
  details { margin-top: 10px; font-size: 12px; color: #8b949e; }
  details summary { cursor: pointer; }
  details ol { margin: 6px 0 0 18px; padding: 0; }
  details li { margin: 4px 0; line-height: 1.5; }
  code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
  .yes { color: #3fb950; }
  .no { color: #484f58; }
</style>
<style>${UI_CSS}</style>
</head>
<body>
${navHtml("dashboard")}
<main>
  <div class="hero" data-view="dashboard">
    <div><h1>控制台</h1><p>本机多账号池 · 自动切换 · 统一出口</p></div>
    <div class="statusline" id="hdr"></div>
  </div>
  <div class="cards" data-view="dashboard">
    <div class="card"><div class="lbl"><span>账号池</span><span class="pill" id="dashAccountPill">—</span></div><div class="big" id="dashAccounts">—</div><div class="sub" id="dashAccountsSub">加载中…</div></div>
    <div class="card purple"><div class="lbl"><span>24h 请求</span><span class="pill" id="dashReqPill">—</span></div><div class="big" id="dashRequests">—</div><div class="sub" id="dashRequestsSub">加载中…</div></div>
    <div class="card cyan"><div class="lbl"><span>24h 切换</span><span class="pill" id="dashSwitchPill">—</span></div><div class="big" id="dashSwitches">—</div><div class="sub" id="dashSwitchesSub">加载中…</div></div>
    <div class="card green"><div class="lbl"><span>模型目录</span><span class="pill" id="dashModelPill">—</span></div><div class="big" id="dashModels">—</div><div class="sub" id="dashModelsSub">加载中…</div></div>
  </div>
  <div class="hero" data-view="connect">
    <div><h1>接入</h1><p>添加账号、opencode 接入与客户端指定</p></div>
  </div>
  <div class="hero" data-view="settings">
    <div><h1>设置</h1><p>运行参数、免费模型与备份</p></div>
  </div>
  <h2 data-view="dashboard">账号池</h2>
  <div class="more" data-view="dashboard" id="tzHint" style="margin:-6px 0 8px">重置时间按本机时区显示（上游给的是 UTC 绝对时刻）。</div>
  <div class="accfilter" data-view="dashboard">
    <label class="chk" style="margin:0"><input type="checkbox" id="showAllAccounts" checked> 显示全部账号（含已耗尽 / 冷却 / 仅凭据）</label>
    <span class="muted" id="accCount"></span>
    <a class="btn" href="/connect" style="margin-left:auto">添加账号 / 接入 →</a>
  </div>
  <div class="grid accgrid" id="accounts" data-view="dashboard"></div>

  <h2 data-view="dashboard">建议线路 <span class="muted">仅供参考，不改变实际请求路由</span></h2>
  <div class="card" data-view="dashboard" id="bestRouteCard">加载中…</div>

  <h2 data-view="connect">接入控制 <span class="muted">添加账号 / opencode 接入</span></h2>
  <h2 data-view="settings">参数设置 <span class="muted">切换阈值 / 轮询 / 免费模型</span></h2>
  <div class="grid">
    <div class="card" data-view="connect">
      <div class="top"><div class="name">添加账号</div></div>
      <div class="fr"><label>标签</label><input id="addLabel" class="input" placeholder="如 go-03（可空）"></div>
      <div class="fr"><label>Key</label><input id="addKey" class="input" type="password" placeholder="粘贴账号 Key"></div>
      <div class="fr"><label>类型</label><select id="addType" class="input"></select></div>
      <div class="fr" id="addPlanRow" style="display:none"><label>套餐</label><select id="addPlan" class="input"></select></div>
      <div class="fr" id="addCustomRow" style="display:none"><label>集成 ID</label><input id="addCustom" class="input" placeholder="opencode 集成 ID，如 anthropic"></div>
      <label class="chk"><input type="checkbox" id="addConnect" checked> 同时注册到 opencode 凭据</label>
      <div class="btnrow"><button id="addBtn" class="btn primary">添加并校验</button><span id="addMsg" class="msg"></span></div>
      <div class="more">opencode-go：全功能（用量监控 + 自动切换）。其他类型：仅注册凭据，不入切换池。</div>
    </div>
    <div class="card" data-view="settings">
      <div class="top"><div class="name">运行设置</div></div>
      <div class="fr"><label>切换阈值</label><input id="setSwitch" type="range" min="95" max="99" step="0.5" style="flex:1"><span id="setSwitchVal" class="mono" style="min-width:44px;text-align:right"></span></div>
      <div class="fr"><label>轮询间隔</label><input id="setPoll" type="number" class="input" min="10" max="3600" step="5" style="width:90px"><span class="muted">秒</span></div>
      <div class="fr"><label>免费模型</label><span class="muted">选用哪些免费模型、按什么优先级中转 → 见下方「免费模型」区块（可勾选、排序、切换模式）</span></div>
      <div class="fr"><label>告警阈值</label><input id="setAlert" class="input" style="flex:1" placeholder="90, 95, 97"><span class="muted">百分比，逗号分隔（全局默认）</span></div>
      <div class="fr"><label>分窗口</label><input id="setAlertR" class="input" style="width:110px" placeholder="rolling"><input id="setAlertW" class="input" style="width:110px" placeholder="weekly"><input id="setAlertM" class="input" style="width:110px" placeholder="monthly"><span class="muted">留空=跟随全局</span></div>
      <div class="fr"><label>静默时段</label><input id="setQuietFrom" class="input" type="time" style="width:110px"><span class="muted">→</span><input id="setQuietTo" class="input" type="time" style="width:110px"><span class="muted">（只记台账，不发通知）</span></div>
      <label class="chk"><input type="checkbox" id="setAuto"> 切换后自动激活 opencode 凭据</label>
      <div class="btnrow"><button id="setBtn" class="btn primary">保存设置</button><span id="setMsg" class="msg"></span></div>
      <div class="more">任一用量窗口达到阈值即自动切走（95%–99%，默认 97%）；告警阈值只负责提醒，与切换阈值互相独立。</div>
    </div>
    <div class="card" data-view="connect">
      <div class="top"><div class="name">opencode 接入</div><span class="pill dim" id="wirePill">…</span></div>
      <div class="more" id="wireInfo">加载中…</div>
      <div class="more" id="wireTraffic" style="margin-top:4px">实测流量：加载中…</div>
      <div class="btnrow"><button id="wireBtn" class="btn primary">注入 / 更新</button><button id="unwireBtn" class="btn">撤销注入</button><span id="wireMsg" class="msg"></span></div>
      <details><summary>接入指引（含 Google 模型）</summary><ol>
        <li><b>「接入」= 把 opencode 这个客户端接到账号池</b>：点"注入 / 更新"后，opencode 配置里 opencode-go 家族模型的 baseURL 指向本代理 <code id="wireBase"></code>，opencode 的请求才进池子（才能用上自动换号、免费优先、用量监控）。</li>
        <li>只想给某个客户端指定账号，去下面的「接入（客户端）」区块按接入逐个指定；这里的注入只负责"接进来"。</li>
        <li>重启 opencode 后生效；之后增删账号无需重新注入。</li>
        <li>Google 家族模型（gemini-*）：需在 opencode.ai 工作区 Privacy settings 勾选 "Allow paid endpoints that train on request data"，否则上游返回 400。</li>
        <li>"撤销注入"会按备份恢复注入前的原配置。</li>
      </ol></details>
      <details><summary>本机统一出口（Claude Code / OpenAI 客户端）</summary><ol>
        <li><b>Claude Code</b>：<code>ANTHROPIC_BASE_URL=http://127.0.0.1:8788 ANTHROPIC_API_KEY=openselect claude --model claude-haiku-5-5</code>（用 family=anthropic 的模型：claude-haiku-5-5、qwen3.8-max、minimax-m3…）。</li>
        <li><b>OpenAI 兼容</b>：base_url <code>http://127.0.0.1:8788/v1</code>，api_key 任意占位；<code>GET /v1/models</code> 查看可用模型（含 family / free 字段）。</li>
        <li>会话头由代理自动合成、跨协议由上游拒绝（400）、免费模型不占配额——详见 README「本机统一出口」。</li>
      </ol></details>
    </div>
  </div>

  <h2 data-view="settings">免费模型<span class="muted" style="font-size:12px;font-weight:400" id="freeMeta"></span></h2>
  <div class="card" data-view="settings">
    <div class="fr">
      <label>中转模式</label>
      <select id="freeMode" class="input" style="width:auto;min-width:280px">
        <option value="off">关闭 —— 完全不替换，质量完全由你决定</option>
        <option value="first">优先 —— 先用免费模型承接（省额度，质量按免费模型）</option>
        <option value="fallback">兜底 —— 平时用付费模型，付费全部不可用时才用免费模型</option>
      </select>
      <button id="freeSave" class="btn primary">保存</button><span id="freeMsg" class="msg"></span><span id="freeDirty" class="msg"></span>
    </div>
    <div class="tablewrap"><table><thead><tr><th>选用</th><th>免费模型</th><th>上游端点</th><th>优先级</th><th>可用账号</th><th>近期中转</th><th>接入示例（复制即用）</th></tr></thead><tbody id="freeRows"></tbody></table></div>
    <div class="more" id="freeHint">加载中…</div>
  </div>

  <h2 data-view="dashboard">模型可用性<span class="muted" style="font-size:12px;font-weight:400" id="modelsMeta"></span></h2>
  <div class="card" data-view="dashboard">
    <div class="btnrow" style="margin-top:0"><button id="modelsBtn" class="btn primary">刷新各账号可用模型</button><span id="modelsMsg" class="msg"></span></div>
    <div id="modelsWrap" class="more">尚未拉取 —— 点"刷新"获取每个账号实际可用模型（含免费标记）。各账号模型可能不同。</div>
  </div>

  <h2 data-view="dashboard">价格对比<span class="muted" style="font-size:12px;font-weight:400">（DeepSeek 官方 API = 100%）</span></h2>
  <div class="card" data-view="dashboard">${pricingTablesHtml()}</div>

  <h2 data-view="dashboard">当前连接</h2>
  <div class="card" data-view="dashboard" id="currentCard">加载中…</div>
  <h2 data-view="connect">接入（客户端）</h2>
  <div class="card" data-view="connect">
    <div class="more">「接入」= 哪个客户端在用本代理（按 User-Agent / 请求路径自动识别）。给某个接入指定账号后，<b>该接入的流量优先走这个账号</b>；优先级：接入指定 &gt; 全局手动指定（设为首选）&gt; 会话粘性 &gt; 最低压力。指定只影响「优先」：账号被停用、Key 失效、限流或<b>用量超阈值</b>时该指定自动忽略，按正常策略故障转移（不会把流量锁死）。</div>
    <div class="tablewrap"><table><thead><tr><th>接入</th><th>最近请求<span class="muted" style="font-weight:400">（最近 500 条）</span></th><th>当前实际服务</th><th>接入指定账号</th></tr></thead><tbody id="clients"></tbody></table></div>
  </div>
  <section data-view="connect">
    <h2>仅凭据账号<span class="muted" id="credMeta"></span></h2>
    <div class="card">
      <div class="more">这些是搜索 / 客户端 / 工具凭据，不参与账号池切换，也不显示 5h/周/月用量。它们只用于注册 opencode 凭据或 DeepSeek Search。</div>
      <div class="tablewrap"><table><thead><tr><th>标签</th><th>集成</th><th>Key</th><th>状态</th><th>操作</th></tr></thead><tbody id="credRows"></tbody></table></div>
    </div>
  </section>
  <h2 data-view="dashboard">切换记录</h2>
  <div class="card" data-view="dashboard" id="switchSummary">加载中…</div>
  <h2 data-view="dashboard">最近请求</h2>
  <div class="card" data-view="dashboard" id="requestSummary">加载中…</div>
  <h2 data-view="dashboard">用量告警</h2>
  <div class="tablewrap card" data-view="dashboard" style="padding:0"><table><thead><tr><th>时间</th><th>账号</th><th>窗口</th><th>阈值</th><th>用量</th></tr></thead><tbody id="alerts"></tbody></table></div>
  <h2 data-view="settings">备份与签名</h2>
  <div class="card" data-view="settings">
    <div class="btnrow" style="margin-top:0">
      <button id="backupBtn" class="btn primary">立即备份</button>
      <button id="backupSignBtn" class="btn">备份并签名</button>
      <span id="backupMsg" class="msg"></span>
    </div>
    <div class="more" id="backupInfo">加载中…</div>
    <div class="tablewrap"><table><thead><tr><th>归档</th><th>时间</th><th>大小</th><th>文件</th><th>签名</th><th>验签</th></tr></thead><tbody id="backups"></tbody></table></div>
  </div>
</main>
<footer id="foot"></footer>
<script>
if (osLang === "en") {
  var dashboardEnglish = ${JSON.stringify(DASHBOARD_EN)};
  var pricingEnglish = ${JSON.stringify(PRICING_EN)};
  var dashboardWalker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
  var dashboardText;
  while ((dashboardText = dashboardWalker.nextNode())) {
    var originalText = dashboardText.nodeValue;
    var trimmedText = originalText.trim();
    if (dashboardText.parentElement && dashboardText.parentElement.closest(".pricing")) {
      pricingEnglish.forEach(function(pair) { originalText = originalText.split(pair[0]).join(pair[1]); });
      dashboardText.nodeValue = originalText;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(dashboardEnglish, trimmedText)) {
      dashboardText.nodeValue = originalText.replace(trimmedText, dashboardEnglish[trimmedText]);
    }
  }
  document.getElementById('addLabel').placeholder = 'e.g. go-03 (optional)';
  document.getElementById('addKey').placeholder = 'Paste account key';
  document.getElementById('addCustom').placeholder = 'OpenCode integration ID, e.g. anthropic';
}
function parseAlerts(v){ return String(v||"").split(/[,，\\s]+/).filter(Boolean).map(function(x){ return Number(x); }); }
var BACKUP_DIR_TEXT = ${JSON.stringify(BACKUP_DIR)};
var CLIENT_LABELS = ${JSON.stringify(CLIENT_LABELS)};
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }
function num(n){ return (n==null||isNaN(n))?"0":Number(n).toLocaleString("zh-CN"); }
function usd(n){ return (n==null||!isFinite(n))?"—":"$"+Number(n).toFixed(4); }
function pct(p){ return p==null ? "-" : (p*100).toFixed(1)+"%"; }
function dur(ms){ if(ms==null||ms<0||!isFinite(ms)) return "-"; var s=Math.floor(ms/1000); if(s<60) return s+"s"; var m=Math.floor(s/60); if(m<60) return m+"m"+(s%60)+"s"; var h=Math.floor(m/60); return h+"h"+(m%60)+"m"; }
function ago(ts){ if(!ts) return osT("从未", "never"); return dur(Date.now()-ts)+osT("前", " ago"); }
function fmtT(ts){ if(!ts) return "-"; var d=new Date(ts); return d.toLocaleString("zh-CN",{hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}); }
function fmtReset(x){ if(!x) return "-"; try { return new Date(x).toLocaleString("zh-CN",{hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}); } catch(e){ return x; } }
/** 距离重置还有多久（上游给的是 UTC 绝对时刻，这里按本机时区换算成倒计时，便于和官方页的 "Resets in Xh" 对照） */
function fmtIn(x){ if(!x) return ""; var t=new Date(x).getTime(); if(isNaN(t)) return ""; var ms=t-Date.now(); if(ms<=0) return osT("已过","elapsed"); var m=Math.floor(ms/60000); if(m<60) return (osLang==="en"?"in ":"")+m+"m"+osT(" 后",""); var h=Math.floor(m/60); if(h<24) return (osLang==="en"?"in ":"")+h+"h"+(m%60? (m%60)+"m":"")+osT(" 后",""); var d=Math.floor(h/24); return (osLang==="en"?"in ":"")+d+"d"+(h%24? (h%24)+"h":"")+osT(" 后",""); }
/** 本机时区（重置时间按本机时区显示，避免与上游 UTC 时刻混淆） */
function tzLabel(){ try { var off=-new Date().getTimezoneOffset(); var sign=off>=0?"+":"-"; var a=Math.abs(off); return "UTC"+sign+Math.floor(a/60)+(a%60? ":"+("0"+a%60).slice(-2):""); } catch(e){ return ""; } }
/**
 * 把任意字符串安全地放进 HTML 属性里的 JS 字符串字面量。
 * 顺序很重要：先转义 & < >（否则 "&quot;" 会被二次解码成引号，可提前闭合 JS 字符串），
 * 再把 " 转成 &quot;。
 */
function q(s){ return JSON.stringify(String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function bar(p, status){
  var w = Math.min(100, Math.max(0, (p||0)*100));
  var cls = (status==="rate-limited"||(p!=null&&p>=0.95)) ? "red" : (p!=null&&p>=0.7) ? "amber" : "green";
  return '<div class="bar"><div class="fill '+cls+'" style="width:'+w+'%"></div><span>'+pct(p)+'</span></div>';
}
function pillClass(a){
  if(!a.enabled||a.status==="Key 无效") return "bad";
  if(a.status==="冷却中"||a.status==="已限流") return "bad";
  if(a.status==="接近阈值") return "warn";
  return "ok";
}
function winRow(label, w){
  var rel = w && w.resetsAt ? fmtIn(w.resetsAt) : '';
  var reset = w && w.resetsAt ? osT(' · 重置 ',' · Resets ')+fmtReset(w.resetsAt)+(rel? ' ('+rel+')':'') : '';
  return '<div class="win"><div class="lbl"><span>'+label+(w&&w.status==="rate-limited"?' <span style="color:#f85149">'+osT('已限流','Rate limited')+'</span>':'')+'</span><span>'+esc(reset)+'</span></div>'+bar(w?w.percent:null, w?w.status:"")+'</div>';
}
/** 账号卡：三窗口并排的紧凑用量条（账号多时单卡高度约减半） */
function winMini(label, w){
  var p = w ? w.percent : null;
  var wd = Math.min(100, Math.max(0, (p||0)*100));
  var cls = (w && w.status==="rate-limited")||(p!=null&&p>=0.95) ? "red" : (p!=null&&p>=0.7) ? "amber" : "green";
  var reset = (w && w.resetsAt) ? fmtIn(w.resetsAt) : "-";
  var full = (w && w.resetsAt) ? fmtReset(w.resetsAt) : "";
  return '<div class="u"><div class="lbl"><span>'+label+'</span><b>'+pct(p)+'</b></div>'
    + '<div class="track"><i class="'+cls+'" style="width:'+wd+'%"></i></div>'
    + '<div class="sub" title="'+(full?(osT('重置 ','Resets ')+esc(full)):'')+'">'+(w&&w.status==="rate-limited"?osT('已限流 · ','Rate limited · '):'')+((w&&w.resetsAt)?'↻ ':'')+esc(reset)+'</div></div>';
}
var SPARK_SERIES = [["rolling","#58a6ff"],["weekly","#d2a8ff"],["monthly","#7ee787"]];
function spark(hist, threshold){
  if(!hist || hist.length < 2) return '<div class="more">'+osT('用量曲线：已积累 ','Usage history: ')+((hist||[]).length)+osT(' 个采样（每 45s 一个，≥2 后显示走势）',' samples (one every 45s; at least 2 needed)')+'</div>';
  var H = 34, W = 100;
  function line(key){
    var pts = [];
    for(var i=0;i<hist.length;i++){
      var v = Math.max(0, Math.min(1, hist[i][key]));
      var x = i/(hist.length-1)*W;
      var y = 1 + (1-v)*(H-2);
      pts.push(x.toFixed(2)+","+y.toFixed(2));
    }
    return pts.join(" ");
  }
  var ty = (1 + (1-Math.max(0,Math.min(1,threshold)))*(H-2)).toFixed(2);
  var polys = SPARK_SERIES.map(function(c){
    return '<polyline fill="none" stroke="'+c[1]+'" stroke-width="1.2" vector-effect="non-scaling-stroke" points="'+line(c[0])+'"></polyline>';
  }).join("");
  var legend = SPARK_SERIES.map(function(c){ return '<span><i style="background:'+c[1]+'"></i>'+c[0]+'</span>'; }).join("")
    + '<span style="margin-left:auto">'+osT('阈值 ','Threshold ')+(threshold*100).toFixed(0)+'%</span>';
  return '<div class="spark"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'
    + '<line x1="0" y1="'+ty+'" x2="'+W+'" y2="'+ty+'" stroke="#f85149" stroke-dasharray="3,2" stroke-width="0.6" vector-effect="non-scaling-stroke" opacity="0.8"></line>'
    + polys + '</svg><div class="lg">'+legend+'</div></div>';
}
function api(method, url, body){
  var opt = { method: method, headers: {} };
  if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
  return fetch(url, opt).then(function(r){ return r.json().then(function(j){ return {status:r.status, j:j}; }, function(){ return {status:r.status, j:{}}; }); });
}
function setMsg(id, text, cls){ var e=document.getElementById(id); e.textContent=text||""; e.className="msg "+(cls||""); }
var __typeBuilt=false;
var PLAN_OPTIONS={
  "opencode-go":[["opencode-go","Go"],["opencode-plus","Go Plus"],["opencode-teams","Go Teams"]],
  "zai":[["zai-lite","Lite"],["zai-pro","Pro"],["zai-max","Max"]],
  "minimax":[["minimax-go","M Plan Go"],["minimax-explore","M Plan Explore"],["minimax-build","M Plan Build"]],
  "ollama":[["ollama-pro","Pro"],["ollama-max","Max"],["ollama-team","Team"]],
  "commandcode":[["commandcode-go","Go"],["commandcode-goat","GOAT"],["commandcode-pro","Pro"],["commandcode-max10","Max 10×"],["commandcode-max20","Max 20×"]]
};
function planOptionsFor(integration){ return PLAN_OPTIONS[integration]||[]; }
function planOptionsHtml(integration, selected){
  var opts=planOptionsFor(integration);
  if(!opts.length) return '<option value="">'+osT('未设置','Not set')+'</option>';
  return '<option value="">'+osT('未设置','Not set')+'</option>'+opts.map(function(o){return '<option value="'+esc(o[0])+'"'+(o[0]===selected?' selected':'')+'>'+esc(o[1])+'</option>';}).join("");
}
function updatePlanOptions(integration){
  var row=document.getElementById("addPlanRow"), sel=document.getElementById("addPlan");
  if(!row||!sel) return;
  var opts=planOptionsFor(integration);
  row.style.display=opts.length?"flex":"none";
  sel.innerHTML=opts.map(function(o){return '<option value="'+esc(o[0])+'">'+esc(o[1])+'</option>';}).join("");
}
function buildTypes(s){
  if(__typeBuilt || !s.integrationOptions) return;
  var sel=document.getElementById("addType");
  s.integrationOptions.forEach(function(o){
    var englishIntegrations = {"opencode-go":"OpenCode Go (usage monitoring + failover)","google":"Google / Gemini (credentials only)","opencode":"OpenCode Console (credentials only)","anthropic":"Anthropic (credentials only)","openai":"OpenAI (credentials only)","deepseek":"DeepSeek (credentials only)","deepseek-api":"DeepSeek (direct, fallback only)","xai":"xAI (credentials only)","zai":"Z.ai GLM (direct, 5h/week usage)","minimax":"MiniMax M Plan (direct, 5h/week usage)","commandcode":"Command Code Provider (direct, API key)","ollama":"Ollama Cloud (API key)"};
    var op=document.createElement("option"); op.value=o.id; op.textContent=osLang === "en" ? (englishIntegrations[o.id]||o.name) : o.name;
    if(o.id==="opencode-go") op.selected=true;
    sel.appendChild(op);
  });
  var op=document.createElement("option"); op.value="__custom__"; op.textContent=osT("其他集成（自定义 ID）…", "Other integration (custom ID)…");
  sel.appendChild(op);
  sel.onchange=function(){
    document.getElementById("addCustomRow").style.display = this.value==="__custom__" ? "flex" : "none";
    updatePlanOptions(this.value);
  };
  updatePlanOptions(sel.value);
  __typeBuilt=true;
}
function renderCredentials(s){
  var list=(s.accounts||[]).filter(function(a){return !isPoolAcct(a);});
  var meta=document.getElementById("credMeta"), rows=document.getElementById("credRows");
  if(!meta || !rows) return;
  meta.textContent=" · "+list.length+osT(" 个", "");
  rows.innerHTML=list.map(function(a){
    return '<tr><td>'+esc(a.label||a.id)+'</td><td class="muted">'+esc(a.integration)+'</td><td class="mono">'+esc(a.keyMasked||"")+'</td><td><span class="pill dim">'+osT('仅凭据','Credentials only')+'</span></td><td><button class="btn sm danger" onclick="delAcct('+q(a.id)+')">'+osT('删除','Delete')+'</button></td></tr>';
  }).join("") || '<tr><td colspan="5" class="muted">'+osT('暂无仅凭据账号','No credentials-only accounts')+'</td></tr>';
}
function renderModels(s){
  var wrap=document.getElementById("modelsWrap"), meta=document.getElementById("modelsMeta");
  var accts=(s.accounts||[]).filter(function(a){
    return a.integration==="opencode-go" || a.integration==="zai" || a.integration==="minimax" || a.integration==="deepseek-api" || a.integration==="commandcode" || a.integration==="ollama";
  });
  var cache=s.models||{};
  var groups={};
  accts.forEach(function(a){ (groups[a.integration]=groups[a.integration]||[]).push(a); });
  var names={ "opencode-go":"OpenCode", "zai":"Z.ai", "minimax":"MiniMax", "deepseek-api":"DeepSeek", "commandcode":"Command Code", "ollama":"Ollama Cloud" };
  var parts=[], totalDiff=0, fetchedAll=0, lastTs=0, pending=0;
  Object.keys(groups).forEach(function(g){
    var list=groups[g];
    var fetched=list.filter(function(a){return cache[a.id];});
    pending += list.length-fetched.length;
    if(!fetched.length){ parts.push('<b>'+esc(names[g]||g)+'</b> '+osT('未拉取','Not fetched')); return; }
    fetchedAll += fetched.length;
    var union={};
    fetched.forEach(function(a){ (cache[a.id].ids||[]).forEach(function(id){ union[id]=1; }); });
    var ids=Object.keys(union);
    var diff=0;
    ids.forEach(function(id){
      if(fetched.some(function(a){ return (cache[a.id].ids||[]).indexOf(id)<0; })) diff++;
    });
    totalDiff += diff;
    lastTs=Math.max.apply(null, fetched.map(function(a){return cache[a.id].ts;}).concat([lastTs]));
    parts.push('<b>'+esc(names[g]||g)+'</b> '+fetched.length+'×'+ids.length
      +(diff?' <span style="color:#d29922">'+osT('差异 ','Differences ')+diff+'</span>':' <span class="yes">'+osT('一致','Match')+'</span>'));
  });
  if(!fetchedAll){ meta.textContent=""; wrap.className="more"; wrap.textContent=osT("尚未拉取 —— 点“刷新”获取每个账号实际可用模型（含免费标记）。各账号模型可能不同。","Not fetched yet — refresh to retrieve available models for each account."); return; }
  meta.textContent=osT(" · 最近拉取 "," · Last fetched ")+ago(lastTs);
  wrap.className="more";
  wrap.innerHTML=parts.join(' · ')
    +(pending?' · <span style="color:#d29922">'+pending+osT(' 个账号未拉取',' accounts not fetched')+'</span>':'')
    +' · <a href="/models" target="_blank">'+osT('查看完整可用性 →','View model availability →')+'</a>'
    +(totalDiff?'<div class="more" style="margin-top:4px">'+osT('组内差异已收进独立页；主面板不再铺账号矩阵。','View account differences on the models page.')+'</div>':'');
}
function isPoolAcct(a){
  return a.integration==="opencode-go" || a.integration==="zai" || a.integration==="minimax" || a.integration==="deepseek-api" || a.integration==="commandcode" || a.integration==="ollama";
}
function accountUsable(a){
  if(!a.enabled) return false;
  if(a.status==="Key 无效" || a.status==="已禁用" || a.status==="仅凭据") return false;
  var u=a.usage||{};
  var exhausted=[u.rolling,u.weekly,u.monthly].some(function(w){
    return w && (w.status==="rate-limited" || (w.percent!=null && w.percent>=1));
  });
  if(exhausted) return false;
  if(a.status==="已限流") return false;
  // 3s 瞬时冷却仍算可用；>60s 的长冷却（周/月额度耗尽）隐藏
  if(a.status==="冷却中" && a.cooldownLeftMs > 60000) return false;
  return true;
}
function pinClient(kind, accountId){
  api("POST","/api/clients/pin",{client:kind, accountId: accountId||null}).then(function(r){
    if(r.status!==200||!r.j.ok){ alert((r.j&&r.j.error)||osT("操作失败","Operation failed")); return; }
    refresh();
  });
}
function clearCooldown(id){
  api("POST","/api/accounts/"+encodeURIComponent(id),{clearCooldown:true}).then(function(r){
    if(r.status!==200||!r.j.ok){ alert((r.j&&r.j.error)||osT("清除失败","Failed to clear cooldown")); return; }
    refresh();
  });
}
function setPlan(id, plan){
  api("POST","/api/accounts/"+encodeURIComponent(id),{plan: plan||null}).then(function(r){
    if(r.status!==200||!r.j.ok){ alert((r.j&&r.j.error)||osT("套餐设置失败","Failed to update plan")); return; }
    refresh();
  });
}
function forceAcct(id){
  api("POST","/api/accounts/force",{accountId:id}).then(function(r){
    if(r.status!==200||!r.j.ok){ alert((r.j&&r.j.error)||osT("操作失败","Operation failed")); return; }
    refresh();
  });
}
function delAcct(id){
  if(!confirm(osT("删除账号 "+id+"？（仅从 OpenSelect 移除，不影响 opencode 凭据）", "Remove account "+id+" from OpenSelect? OpenCode credentials will not be changed."))) return;
  api("DELETE","/api/accounts/"+encodeURIComponent(id)).then(function(r){
    if(r.status!==200||!r.j.ok){ alert((r.j&&r.j.error)||osT("删除失败","Delete failed")); }
    refresh();
  });
}
function bindActions(){
  document.getElementById("addBtn").onclick=function(){
    var b=this;
    var type=document.getElementById("addType").value;
    var integration= type==="__custom__" ? document.getElementById("addCustom").value.trim() : type;
    var payload={
      key: document.getElementById("addKey").value.trim(),
      label: document.getElementById("addLabel").value.trim()||undefined,
      integration: integration||"opencode-go",
      plan: (document.getElementById("addPlan")||{}).value || undefined,
      connect: document.getElementById("addConnect").checked
    };
    if(!payload.key){ setMsg("addMsg",osT("请填写 Key","Enter an API key"),"err"); return; }
    b.disabled=true; setMsg("addMsg",osT("校验中…（拉取官方用量）","Validating and fetching usage…"));
    api("POST","/api/accounts",payload).then(function(r){
      b.disabled=false;
      if(r.status!==200||!r.j.ok){ setMsg("addMsg",(r.j&&r.j.error)||(osT("失败 HTTP ","Failed HTTP ")+r.status),"err"); return; }
      var j=r.j, parts=[];
      parts.push((j.added?osT("✓ 已添加 ","✓ Added "):osT("已存在 ","Already exists "))+j.account.id+" ("+j.account.keyMasked+")");
      if(j.usage) parts.push("rolling "+pct(j.usage.rolling.percent)+" / weekly "+pct(j.usage.weekly.percent)+" / monthly "+pct(j.usage.monthly.percent));
      if(j.checkError) parts.push(osT("用量校验失败: ","Usage check failed: ")+String(j.checkError).slice(0,80));
      if(j.opencode&&j.opencode.attempted) parts.push(j.opencode.ok?osT("已注册 opencode 凭据","OpenCode credentials registered"):osT("opencode 注册失败: ","OpenCode registration failed: ")+String(j.opencode.detail).slice(0,80));
      if(j.poolHint) parts.push(j.poolHint);
      setMsg("addMsg", parts.join(" · "), j.checkError?"err":"ok");
      if(j.added){ document.getElementById("addKey").value=""; refresh(); }
    }, function(){ b.disabled=false; setMsg("addMsg",osT("网络错误","Network error"),"err"); });
  };
  document.getElementById("setSwitch").oninput=function(){ document.getElementById("setSwitchVal").textContent=Number(this.value).toFixed(1)+"%"; };
  document.getElementById("setBtn").onclick=function(){
    var b=this;
    var payload={ switchAt: Number(document.getElementById("setSwitch").value)/100, pollSec: Number(document.getElementById("setPoll").value), autoActivate: document.getElementById("setAuto").checked, alertAt: document.getElementById("setAlert").value.split(/[,，\\s]+/).filter(Boolean).map(function(x){ return Number(x); }), alertAtByWindow: { rolling: parseAlerts(document.getElementById("setAlertR").value), weekly: parseAlerts(document.getElementById("setAlertW").value), monthly: parseAlerts(document.getElementById("setAlertM").value) }, alertQuiet: (function(){ var f=document.getElementById("setQuietFrom").value, t=document.getElementById("setQuietTo").value; return (f&&t)?{from:f,to:t}:null; })() };
    b.disabled=true; setMsg("setMsg",osT("保存中…","Saving…"));
    api("POST","/api/settings",payload).then(function(r){
      b.disabled=false;
      if(r.status!==200||!r.j.ok){ setMsg("setMsg",(r.j&&r.j.error)||(osT("失败 HTTP ","Failed HTTP ")+r.status),"err"); return; }
      setMsg("setMsg",osT("✓ 已保存并热生效","✓ Saved and applied"),"ok"); refresh();
    }, function(){ b.disabled=false; setMsg("setMsg",osT("网络错误","Network error"),"err"); });
  };
  function doBackup(sign){
    var b=document.getElementById(sign?"backupSignBtn":"backupBtn");
    b.disabled=true; setMsg("backupMsg", sign?osT("备份并签名中…","Backing up and signing…"):osT("备份中…","Backing up…"));
    api("POST","/api/backup",{sign:!!sign}).then(function(r){
      b.disabled=false;
      if(r.status!==200||!r.j.ok){ setMsg("backupMsg",(r.j&&r.j.error)||(osT("失败 HTTP ","Failed HTTP ")+r.status),"err"); return; }
      setMsg("backupMsg",osT("✓ 已备份","✓ Backup complete")+(r.j.signed?osT("并签名"," and signed"):""),"ok");
      refresh();
    }, function(){ b.disabled=false; setMsg("backupMsg",osT("网络错误","Network error"),"err"); });
  }
  document.getElementById("backupBtn").onclick=function(){ doBackup(false); };
  document.getElementById("backupSignBtn").onclick=function(){ doBackup(true); };
  document.getElementById("wireBtn").onclick=function(){
    var b=this; b.disabled=true; setMsg("wireMsg",osT("注入中…","Connecting…"));
    api("POST","/api/wire",{}).then(function(r){
      b.disabled=false;
      if(r.status!==200||!r.j.ok){ setMsg("wireMsg",(r.j&&r.j.error)||osT("失败","Failed"),"err"); return; }
      setMsg("wireMsg", r.j.changed>0 ? osT("✓ 已注入 "+r.j.changed+" 个模型（共 "+r.j.models+"）· 重启 opencode 生效", "✓ Connected "+r.j.changed+" models ("+r.j.models+" total). Restart OpenCode to apply.") : osT("已是最新，无需变更","Already up to date"), "ok");
      refresh();
    }, function(){ b.disabled=false; setMsg("wireMsg",osT("网络错误","Network error"),"err"); });
  };
  document.getElementById("unwireBtn").onclick=function(){
    if(!confirm(osT("撤销 opencode 中的 baseURL 注入？", "Restore the previous OpenCode base URL configuration?"))) return;
    var b=this; b.disabled=true; setMsg("wireMsg",osT("撤销中…","Restoring…"));
    api("POST","/api/unwire",{}).then(function(r){
      b.disabled=false;
      if(r.status!==200||!r.j.ok){ setMsg("wireMsg",(r.j&&r.j.error)||osT("失败","Failed"),"err"); return; }
      setMsg("wireMsg",osT("✓ 已撤销 "+r.j.removed+" 个注入","✓ Restored "+r.j.removed+" entries"),"ok"); refresh();
    }, function(){ b.disabled=false; setMsg("wireMsg",osT("网络错误","Network error"),"err"); });
  };
  document.getElementById("modelsBtn").onclick=function(){
    var b=this; b.disabled=true; setMsg("modelsMsg",osT("拉取中（逐账号 GET /v1/models）…","Fetching models for each account…"));
    api("POST","/api/models/refresh",{}).then(function(r){
      b.disabled=false;
      if(r.status!==200||!r.j.ok){ setMsg("modelsMsg",(r.j&&r.j.error)||osT("失败","Failed"),"err"); return; }
      var okc=0, errs=[];
      var results=r.j.results||{};
      Object.keys(results).forEach(function(k){ if(results[k].ok) okc++; else errs.push(k+": "+results[k].error); });
      setMsg("modelsMsg",osT("✓ 完成：","✓ Complete: ")+okc+osT(" 个账号成功"," accounts succeeded")+(errs.length?(osT("；失败 ","; failed ")+errs.length+" ("+errs.join("; ").slice(0,120)+")"):""), errs.length?"err":"ok");
      refresh();
    }, function(){ b.disabled=false; setMsg("modelsMsg",osT("网络错误","Network error"),"err"); });
  };
}
// ---- 免费模型编辑器（选用 + 优先级 + 模式） ----
var freeOrder = [];     // 有序的免费模型 id（候选顺序在前，其余在后）
var freeSelSet = {};    // id -> 是否被选用
var freeState = null;   // 最近一次 /api/state
var freeDirty = false;  // 本地有未保存的修改（防止 5s 自动刷新覆盖用户编辑）
function freeModels(){
  return (freeState&&freeState.catalog||[]).filter(function(m){ return m.free; });
}
function freeInitState(s){
  var wasDirty=freeDirty;
  freeState=s;
  if(wasDirty){
    // 有未保存的修改：只更新非编辑区数据（可用账号/中转次数），保留用户的选择、顺序与模式
    renderFreeTable();
    return;
  }
  var ff=(s.config&&s.config.freeFirst)||[];
  freeOrder=ff.slice();
  freeModels().forEach(function(m){ if(freeOrder.indexOf(m.id)<0) freeOrder.push(m.id); });
  freeSelSet={};
  ff.forEach(function(id){ freeSelSet[id]=true; });
  var md=document.getElementById("freeMode");
  if(md) md.value=(s.config&&s.config.freeFirstMode)||"first";
}
function freeSelectedOrdered(){
  return freeOrder.filter(function(id){ return !!freeSelSet[id]; });
}
function freeToggle(id,on){
  if(on) freeSelSet[id]=true; else delete freeSelSet[id];
  freeDirty=true;
  renderFreeTable();
}
function freeMove(id,dir){
  var i=freeOrder.indexOf(id), j=i+dir;
  if(i<0||j<0||j>=freeOrder.length) return;
  var t=freeOrder[i]; freeOrder[i]=freeOrder[j]; freeOrder[j]=t;
  freeDirty=true;
  renderFreeTable();
}
function renderFreeTable(){
  var tb=document.getElementById("freeRows");
  if(!tb) return;
  var s=freeState||{};
  var accs=(s.accounts||[]);
  var relayed={};
  (s.requests||[]).forEach(function(r){ if(r.servedModel&&r.servedModel!==r.model){ relayed[r.servedModel]=(relayed[r.servedModel]||0)+1; } });
  var sel=freeSelectedOrdered();
  var rows=freeOrder.map(function(id){
    var m=freeModels().filter(function(x){return x.id===id;})[0]||{id:id,api:"chat"};
    var names=accs.filter(function(a){ var mm=s.models&&s.models[a.id]; return mm&&(mm.ids||[]).indexOf(id)>=0; }).map(function(a){return a.label;});
    var checked=!!freeSelSet[id];
    var rank=checked? ('<span class="yes">#'+(sel.indexOf(id)+1)+'</span>') : '<span class="muted">'+osT('未选用','Not selected')+'</span>';
    // Claude Code 对"目录里没有的模型"会提示并按 200k 窗口估算 → 附上开关避免窗口误判
    var snip = 'ANTHROPIC_BASE_URL=http://127.0.0.1:'+((s.ports&&s.ports.proxy)||8788)
      +' ANTHROPIC_AUTH_TOKEN=openselect ANTHROPIC_MODEL='+id
      +' CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 claude';
    var isZen = !!m.zen;
    var zenDeny = (s.zenDeny||{})[id];
    var zenAvail = zenDeny
      ? '<span class="pill bad">已耗尽（'+esc(zenDeny.reason)+'）</span><div class="muted" style="font-size:10px">'+fmtT(zenDeny.until)+' 恢复（'+fmtIn(zenDeny.until)+'）</div>'
      : '<span class="pill ok">'+osT('可用','Available')+'</span><div class="muted" style="font-size:10px">'+osT('不占账号额度','Does not use account quota')+'</div>';
    var epCell = isZen
      ? '<span class="pill ok">'+osT('zen 直通','Zen direct')+'</span><div class="mono muted" style="font-size:10px">'+osT('本地 opencode serve','Local OpenCode server')+'</div>'
      : esc(m.api==="responses"?osT("responses 端点","Responses endpoint"):osT("chat 端点","Chat endpoint"));
    var availCell = isZen ? zenAvail
      : (names.length
          ? '<span title="'+esc(names.join("、"))+'">'+names.slice(0,3).map(function(n){return esc(n);}).join("、")+(names.length>3?' 等 '+names.length+' 个':'')+'</span>'
          : '<span class="muted">'+osT('未探测/不可用','Not checked / unavailable')+'</span>');
    var checkCell = '<input type="checkbox" '+(checked?"checked":"")+' onchange="freeToggle('+q(id)+',this.checked)"'
      +(isZen?' title="勾选后进入免费链：优先模式先于付费模型使用；该模型耗尽时自动换下一个"':'')+'>';
    var rankCell = rank+' <button class="btn sm" onclick="freeMove('+q(id)+',-1)">↑</button> <button class="btn sm" onclick="freeMove('+q(id)+',1)">↓</button>';
    return '<tr><td>'+checkCell+'</td>'
      + '<td>'+esc(m.name||id)+(isZen?' <span class="pill ok">zen</span>':'')+'<div class="mono muted" style="font-size:11px">'+esc(id)+'</div></td>'
      + '<td>'+epCell+'</td>'
      + '<td>'+rankCell+'</td>'
      + '<td>'+availCell+'</td>'
      + '<td>'+(relayed[id]||0)+'</td>'
      + '<td><button class="btn sm" onclick="copyFree('+q(snip)+')">'+osT('复制 Claude 命令','Copy Claude command')+'</button>'
      + '<div class="mono muted" style="font-size:10px;margin-top:3px" title="OpenAI 兼容：base_url=http://127.0.0.1:'+((s.ports&&s.ports.proxy)||8788)+'/v1 · model='+esc(id)+'">OpenAI: /v1 · '+esc(id)+'</div></td></tr>';
  }).join("");
  tb.innerHTML = rows || '<tr><td colspan="7" class="muted">'+osT('目录里没有免费模型','No free models in the catalog')+'</td></tr>';
  var dirtyTip=document.getElementById("freeDirty");
  if(dirtyTip){
    dirtyTip.textContent = freeDirty ? osT("有未保存的修改","Unsaved changes") : "";
    dirtyTip.className = freeDirty ? "msg warn" : "msg";
  }
  var saveBtn=document.getElementById("freeSave");
  if(saveBtn) saveBtn.className = freeDirty ? "btn primary" : "btn";
  var hint=document.getElementById("freeHint");
  if(hint){
    var mode=(document.getElementById("freeMode")||{}).value||"first";
    var modeText = mode==="off"
      ? "当前：<b>关闭</b> —— 不做任何模型替换，客户端请求什么就用什么（不省额度，质量完全由你决定）。"
      : mode==="fallback"
        ? "当前：<b>兜底</b> —— 平时用客户端请求的付费模型；只有付费模型<b>所有账号都不可用</b>（额度用尽/限流/超阈值）时，才用选中的免费模型接着，不让会话中断。"
        : "当前：<b>优先</b> —— 客户端请求付费模型时，<b>先</b>用选中的免费模型承接（省额度，但质量按免费模型算）。";
    var tail = mode==="off"
      ? "当前模式关闭，勾选与顺序都不生效。"
      : "优先级按表格 <b>↑↓</b> 从上到下依次尝试；某个免费模型不可用就换下一个；"+ (mode==="fallback" ? "免费候选全部不可用时再回到付费模型。" : "免费候选全部不可用时回落到客户端请求的付费模型。");
    hint.innerHTML = modeText + '<br>' + tail
      + '<br><b>zen 免费链</b>（带 <span class="pill ok">zen</span> 标记的行）：走本地 opencode server，<b>不占账号额度</b>。勾选后参与免费链：'
      + '<b>优先</b>模式 = zen 免费 → go 免费 → 付费；<b>兜底</b>模式 = 付费 → go 免费 → zen。'
      + '某个 zen 模型额度耗尽会<b>自动换下一个</b>，冷却时间（恢复时刻）直接显示在本行；恢复后自动重新可用。'
      + '<br>硬约束：普通免费模型只在 <b>chat 端点</b>（<code>/v1/chat/completions</code>）上服务；走 <b>responses 端点</b>的客户端（opencode 默认的 gpt-6-luna 等）不会被免费模型承接。'
      + '<br>近 '+(s.requests||[]).length+' 条请求里有 <b>'+(Object.keys(relayed).reduce(function(a,k){return a+relayed[k];},0))+'</b> 条被免费模型承接（可在「最近请求」表看到 请求模型 → 实际服务模型）。';
    if (osLang === 'en') hint.innerHTML = (mode==='off' ? 'Free-model routing is off; the requested model is used.' : mode==='fallback' ? 'Fallback: selected free models are tried when all eligible paid accounts are unavailable.' : 'Free first: selected free models are tried before the requested paid model.') + '<br>Use the arrows to set priority. Zen models use the local OpenCode server; free-model routing applies only to compatible chat endpoints.';
  }
}
function copyFree(text){
  var done=function(){ setMsg("freeMsg",osT("✓ 已复制到剪贴板","✓ Copied to clipboard"),"ok"); };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, function(){ setMsg("freeMsg",osT("复制失败，请手动选中复制","Copy failed; please copy manually"),"err"); });
  } else {
    var ta=document.createElement("textarea");
    ta.value=text; ta.setAttribute("readonly","");
    ta.style.position="fixed"; ta.style.left="-9999px"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.select();
    var okCopy=false;
    try{ okCopy = document.execCommand("copy"); }catch(e){ okCopy=false; }
    document.body.removeChild(ta);
    if(okCopy) done(); else setMsg("freeMsg",osT("复制失败，请手动选中复制","Copy failed; please copy manually"),"err");
  }
}
function freeSave(){
  var mode=(document.getElementById("freeMode")||{}).value||"first";
  api("POST","/api/settings",{freeFirst: freeSelectedOrdered(), freeFirstMode: mode}).then(function(r){
    if(r.status!==200||!r.j.ok){ setMsg("freeMsg",(r.j&&r.j.error)||osT("保存失败","Save failed"),"err"); return; }
    freeDirty=false;
    setMsg("freeMsg",osT("✓ 已保存","✓ Saved"),"ok"); refresh();
  });
}
function render(s){
  var __mode = s.config.freeFirstMode==="off"?osT("关闭","Off"):s.config.freeFirstMode==="fallback"?osT("兜底","Fallback"):osT("优先","Free first");
  var __chain = (s.config.freeFirst||[]);
  var hdr = document.getElementById("hdr");
  hdr.textContent = osT("代理 :","Proxy :") + s.ports.proxy + osT(" · 面板 :"," · Dashboard :") + s.ports.dashboard + osT(" · 阈值 "," · Threshold ") + (s.config.switchAt*100).toFixed(0) + osT("% · 轮询 ","% · Polling ") + s.config.pollSec + osT("s · 上游 ","s · Upstream ") + s.upstreamBase + osT(" · 目录 "," · Models ") + s.modelCount + osT(" 个模型 · 免费链 "," · Free chain ") + __chain.length + " (" + __mode + ")";
  hdr.title = __chain.join(", ");
  var accounts=(s.accounts||[]).filter(isPoolAcct);
  var enabled=accounts.filter(function(a){return a.enabled;}).length;
  var goCount=accounts.filter(function(a){return a.integration==="opencode-go";}).length;
  document.getElementById("dashAccounts").textContent=enabled+" / "+accounts.length;
  document.getElementById("dashAccountPill").textContent=goCount+" OpenCode";
  document.getElementById("dashAccountsSub").textContent=osT("启用 / 全部 · 直连 ","Enabled / total · Direct ")+accounts.filter(function(a){return a.integration!=="opencode-go" && a.enabled;}).length;
  var rq=s.activity&&s.activity.requests24h?s.activity.requests24h:{requests:0,ok:0,errors:0};
  document.getElementById("dashRequests").textContent=num(rq.requests||0);
  document.getElementById("dashReqPill").textContent="24h";
  document.getElementById("dashRequestsSub").textContent=osT("成功率 ","Success rate ")+pct(rq.requests?rq.ok/rq.requests:null)+osT(" · 失败 "," · Failed ")+num(rq.errors||0);
  var sw=s.activity&&s.activity.switches24h?s.activity.switches24h:{failovers:0,rebinds:0};
  document.getElementById("dashSwitches").textContent=num(sw.failovers||0);
  document.getElementById("dashSwitchPill").textContent=osT("故障切换","Failovers");
  document.getElementById("dashSwitchesSub").textContent=osT("会话重绑 ","Session rebindings ")+num(sw.rebinds||0)+osT(" · 原因 "," · Reason types ")+(sw.reasons||[]).length;
  document.getElementById("dashModels").textContent=num(s.modelCount||0);
  document.getElementById("dashModelPill").textContent=osT("免费 ","Free ")+__chain.length;
  document.getElementById("dashModelsSub").textContent=osT("免费链 ","Free chain ")+__chain.length+" ("+__mode+")";
  buildTypes(s);
  var wp=document.getElementById("wirePill");
  if(s.wire){
    wp.textContent = s.wire.wired ? (osT("已接入 ","Connected ")+s.wire.written+"/"+s.wire.total) : osT("未接入","Not connected");
    wp.className = "pill " + (s.wire.wired?"ok":"dim");
    document.getElementById("wireInfo").innerHTML = osT("目标 ","Target ")+"<code>"+esc(s.wire.baseURL)+"</code>"+osT(" · 配置 "," · Configuration ")+"<span class='mono'>"+esc(s.wire.path)+"</span>"+(s.wire.configExists?"":" · <span style='color:#d29922'>"+osT("配置文件不存在","Configuration file not found")+"</span>");
    document.getElementById("wireBase").textContent = s.wire.baseURL;
  }
  // 实测流量：opencode 接入是否真的进池
  var ocClient=(s.clients||[]).find(function(c){ return c.kind==="opencode"; });
  var wt=document.getElementById("wireTraffic");
  if(wt){
    if(ocClient && ocClient.requests>0){
      wt.innerHTML = osT('实测流量：opencode 近 500 条请求里 <b>','Observed traffic: <b>')+ocClient.requests+osT('</b> 条进池（最近一条由 <b>','</b> OpenCode requests in the last 500 entered the pool (most recent account: <b>')+esc(ocClient.lastAccountLabel||osT("未知账号","Unknown account"))+'</b>, '+ago(ocClient.lastAt)+')';
    } else {
      wt.innerHTML = osT('实测流量：<span class="muted">还没观察到 opencode 的请求进池（注入后需重启 opencode 生效）</span>','Observed traffic: <span class="muted">No OpenCode requests observed yet (restart OpenCode after connecting).</span>');
    }
  }
  var ssw=document.getElementById("setSwitch");
  if(document.activeElement!==ssw){ ssw.value=Math.round(s.config.switchAt*1000)/10; document.getElementById("setSwitchVal").textContent=(s.config.switchAt*100).toFixed(1)+"%"; }
  var sp=document.getElementById("setPoll");
  if(document.activeElement!==sp){ sp.value=s.config.pollSec; }
  var sa=document.getElementById("setAuto");
  if(document.activeElement!==sa){ sa.checked=!!s.config.autoActivate; }
  var sa2=document.getElementById("setAlert");
  if(document.activeElement!==sa2){ sa2.value=(s.config.alertAt||[]).map(function(x){ return Math.round(x*100); }).join(", "); }
  var showAll = document.getElementById("showAllAccounts").checked;
  var allAccs = (s.accounts || []).filter(isPoolAcct);
  var visibleAccs = showAll ? allAccs : allAccs.filter(accountUsable);
  document.getElementById("accCount").textContent = osT("显示 ","Showing ")+visibleAccs.length+" / "+allAccs.length+osT(" 个账号"," accounts")
    +(showAll ? "" : osT("（已隐藏 "+(allAccs.length-visibleAccs.length)+" 个已耗尽/冷却/仅凭据）", " (hidden: "+(allAccs.length-visibleAccs.length)+" exhausted, cooling down or credentials-only)"));
  var acc = document.getElementById("accounts");
  acc.innerHTML = visibleAccs.map(function(a){
    var u = a.usage || {};
    var cd = a.cooldownLeftMs > 0 ? '<span class="muted">'+osT(' · 冷却剩 ',' · Cooldown ')+dur(a.cooldownLeftMs)+'</span>' : "";
    var mc = (s.models && s.models[a.id]) ? osT(' · 可用模型 ',' · Available models ')+s.models[a.id].ids.length : '';
    var isPool = a.integration==="opencode-go" || a.integration==="zai" || a.integration==="minimax" || a.integration==="deepseek-api" || a.integration==="commandcode" || a.integration==="ollama";
    var fallbackPill = a.fallbackOnly ? ' <span class="pill warn" style="font-size:10px">'+osT('兜底','Fallback')+'</span>' : '';
    var bal = u.balance ? '<div class="more" style="color:#58a6ff">'+osT('余额 ','Balance ')+esc(u.balance.currency)+' '+Number(u.balance.total).toFixed(2)+(u.balance.available?'':osT(' · 不可用',' · Unavailable'))+'</div>' : '';
    var actions = '<div class="btnrow">'
      + (isPool && planOptionsFor(a.integration).length
          ? '<select class="input" style="width:auto;max-width:150px" onchange="setPlan('+q(a.id)+',this.value)">'+planOptionsHtml(a.integration,a.plan)+'</select>'
          : isPool ? '' : '<span class="pill dim">'+osT('仅凭据','Credentials only')+'</span>')
      + (isPool && !a.fallbackOnly ? '<button class="btn sm" onclick="forceAcct('+q(a.id)+')">'+(s.current&&s.current.forcedAccountId===a.id?osT('取消首选','Clear preference'):osT('设为首选','Prefer'))+'</button>' : '')
      + (a.cooldownLeftMs > 0 ? '<button class="btn sm" onclick="clearCooldown('+q(a.id)+')">'+osT('清除冷却','Clear cooldown')+'</button>' : '')
      + '<button class="btn sm danger" onclick="delAcct('+q(a.id)+')">'+osT('删除','Delete')+'</button></div>';
    return '<div class="card acc">'
      + '<div class="top"><div style="min-width:0"><div class="name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+esc(a.label)+'">'+esc(a.label)+(s.preferredAccountId===a.id?' <span class="pill ok" style="font-size:10px">'+osT('首选','Preferred')+'</span>':'')+fallbackPill+'</div>'
      + '<div class="key" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+esc(a.keyMasked+' · '+a.integration)+'">'+esc(a.keyMasked)+' · '+esc(a.integration)+'</div></div>'
      + '<span class="pill '+pillClass(a)+'">'+esc(osLang==='en'?({'正常':'Healthy','Key 无效':'Invalid key','冷却中':'Cooling down','已限流':'Rate limited','接近阈值':'Near threshold','已禁用':'Disabled','仅凭据':'Credentials only'}[a.status]||a.status):a.status)+'</span></div>'
      + '<div class="usages">'+winMini(osT("5小时","5h"), u.rolling)+winMini(osT("周","Week"), u.weekly)+winMini(osT("月","Month"), u.monthly)+'</div>'
      + bal
      + '<details class="curve"><summary>'+osT('用量曲线','Usage history')+'</summary>'+spark(a.history, s.config.switchAt)+'</details>'
      + '<div class="more" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+osT('压力 ','Pressure ')+pct(a.pressure)+osT(' · 最近使用 ',' · Last used ')+ago(a.lastUsed)+cd+mc+(a.usage?osT(' · 采集于 ',' · Updated ')+ago(a.usage.ts):'')+'</div>'
      + (a.lastError?'<div class="more" style="color:#d29922;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+esc(a.lastError)+'">'+esc(a.lastError).slice(0,80)+'</div>':'')
      + actions
      + '</div>';
  }).join("") || '<div class="muted">'+osT('没有可用账号 — 勾选「显示全部账号」查看已耗尽/冷却/仅凭据账号','No available accounts — select Show all accounts to view exhausted, cooling down, and credentials-only accounts')+'</div>';
  var act=s.activity||{};
  var rq=act.requests24h||{requests:0,ok:0,errors:0,avgLatencyMs:0};
  var sw=act.switches24h||{total:0,failovers:0,rebinds:0,reasons:[]};
  var okRate=rq.requests? rq.ok/rq.requests : 0;
  var topReasons=(sw.reasons||[]).filter(function(x){return String(x.reason).indexOf("policy:")!==0;}).slice(0,3).map(function(x){return esc(x.reason)+' '+x.count;}).join(' · ') || osT('无','None');
  document.getElementById("requestSummary").innerHTML =
    '<div class="fr"><label>'+osT('最近 24h','Last 24h')+'</label><b>'+rq.requests+'</b><span class="muted">'+osT(' 请求 · 成功率 ',' requests · Success ')+pct(okRate)+osT(' · 平均 ',' · Average ')+dur(rq.avgLatencyMs)+osT(' · 失败 ',' · Failed ')+rq.errors+'</span></div>'
    + '<div class="more"><a href="/requests" target="_blank">'+osT('查看完整请求流水 →','View request history →')+'</a></div>';
  document.getElementById("switchSummary").innerHTML =
    '<div class="fr"><label>'+osT('最近 24h','Last 24h')+'</label><b>'+sw.failovers+'</b><span class="muted">'+osT(' 次故障切换 · 会话重绑 ',' failovers · Session rebindings ')+sw.rebinds+osT(' 次 · 主要原因：',' · Top reasons: ')+topReasons+'</span></div>'
    + '<div class="more"><a href="/switches" target="_blank">'+osT('查看完整切换记录 →','View switch history →')+'</a></div>';
  // 接入（客户端）→ 账号
  var clientRows=(s.clients||[]);
  var enabledAccs=(s.accounts||[]).filter(function(a){return a.enabled;});
  document.getElementById("clients").innerHTML = clientRows.map(function(c){
    var opts='<option value="">'+osT('未指定（按自然策略）','Not assigned (automatic)')+'</option>';
    var pinnedFound=false;
    enabledAccs.forEach(function(a){
      var isSel = (a.id===c.pinnedAccountId) ? " selected" : "";
      if(a.id===c.pinnedAccountId) pinnedFound=true;
      opts += '<option value="'+esc(a.id)+'"'+isSel+'>'+esc(a.label)+'</option>';
    });
    if(c.pinnedAccountId && !pinnedFound){
      var why = (c.pinState==="disabled") ? osT("（账号已停用）"," (account disabled)") : osT("（账号已不存在）"," (account no longer exists)");
      opts += '<option value="'+esc(c.pinnedAccountId)+'" selected>'+esc(c.pinnedAccountId)+why+'</option>';
    }
    var sel='<select class="input" style="width:auto;min-width:160px" onchange="pinClient('+q(c.kind)+',this.value)">'+opts+'</select>';
    var clientEnglish={'opencode':'OpenCode','claude-code':'Claude Code','anthropic-compat':'Anthropic-compatible client','openai-responses':'OpenAI Responses client','openai-compat':'OpenAI Chat client','other':'Other client'};
    return '<tr><td>'+esc(osLang==='en'?(clientEnglish[c.kind]||c.label):c.label)+'</td><td>'+(c.requests||0)+'</td><td>'+esc(c.lastAccountLabel||osT("暂无","None"))+(c.lastAt?' <span class="muted">· '+ago(c.lastAt)+'</span>':'')+'</td><td>'+sel+'</td></tr>';
  }).join("") || '<tr><td colspan="4" class="muted">'+osT('暂无接入流量','No client traffic')+'</td></tr>';
  var cur=s.current||{forcedAccountId:null,lastAccountId:null,sessionCount:0,sessions:[]};
  var accById={}; (s.accounts||[]).forEach(function(a){ accById[a.id]=a; });
  var sessHtml=(cur.sessions||[]).slice(0,6).map(function(x){
    return '<span class="mono" style="margin-right:8px">'+esc((x.sessionId||"").slice(-8))+'→'+esc(accById[x.accountId]?accById[x.accountId].label:x.accountId)+'</span>';
  }).join("") || '<span class="muted">'+osT('暂无活跃会话','No active sessions')+'</span>';
  document.getElementById("currentCard").innerHTML =
      '<div class="fr"><label>'+osT('正在服务','Serving')+'</label><b>'+esc(cur.lastAccountId?(accById[cur.lastAccountId]?accById[cur.lastAccountId].label:cur.lastAccountId):osT('暂无','None'))+'</b><span class="muted">'+osT(' · 最近一次请求选中的账号',' · Account selected for the latest request')+'</span></div>'
    + '<div class="fr"><label>'+osT('手动指定','Manual preference')+'</label><b>'+esc(cur.forcedAccountId?(accById[cur.forcedAccountId]?accById[cur.forcedAccountId].label:cur.forcedAccountId):osT('未设置（按自然策略）','Not set (automatic)'))+'</b>'+(cur.forcedAccountId?' <button class="btn sm" onclick="forceAcct(null)">'+osT('解除','Clear')+'</button>':'')+'</div>'
    + '<div class="fr"><label>'+osT('活跃会话','Active sessions')+'</label><b>'+cur.sessionCount+'</b><div style="margin-top:4px">'+sessHtml+'</div></div>'
    + '<div class="more">'+osT('手动指定后：新流量优先走该账号，已有会话会立即重绑过去；该账号被停用或 Key 失效时自动回退到自然策略。','New traffic prefers the selected account and existing sessions rebind immediately. Disabled or invalid accounts fall back to automatic selection.')+'</div>';
  // 免费模型：勾选哪些进入中转 + 优先级顺序 + 模式
  freeInitState(s);
  renderFreeTable();
  var fm=document.getElementById("freeMeta");
  if(fm) fm.textContent = freeModels().length ? (osT("目录内 ","In catalog ")+freeModels().length+osT(" 个 · 已选 "," · Selected ")+freeSelectedOrdered().length) : "";
  var bk=s.backups||{list:[],keyFingerprint:null,hasKey:false,remote:null};
  var remoteLine = bk.remote
    ? '<br>异地备份远端 <code>'+esc(bk.remote)+'</code> <span class="muted">（每日 03:30 定时任务自动推送；推送/拉取在 CLI：<code>opensel backup --push/--fetch</code>）</span>'
      + (bk.encryptRemote ? '<br><span class="muted">已配置加密；运行 <code>opensel install</code> 更新定时任务，并向 launchd 提供 OPENSELECT_BACKUP_PASSPHRASE。缺少口令时拒绝推送。</span>' : '<br><span style="color:#d29922">⚠ 当前配置为明文远端备份（含账号 Key）；使用 <code>opensel backup --remote &lt;url&gt; --encrypt</code> 启用加密。</span>')
    : '<br><span class="muted">未配置异地备份远端（<code>opensel backup --remote &lt;url&gt;</code> 设置；推送/拉取在 CLI）</span>';
  if (osLang === 'en') remoteLine = bk.remote
    ? '<br>Remote backup <code>'+esc(bk.remote)+'</code> <span class="muted">(scheduled push daily at 03:30; use <code>opensel backup --push/--fetch</code> for manual push/pull)</span>'
      + (bk.encryptRemote ? '<br><span class="muted">Encryption configured; run <code>opensel install</code> to update the schedule and provide OPENSELECT_BACKUP_PASSPHRASE to launchd. A missing passphrase prevents the push.</span>' : '<br><span style="color:#d29922">⚠ Remote backup is configured as plaintext and includes account keys. Enable encryption using <code>opensel backup --remote &lt;url&gt; --encrypt</code>.</span>')
    : '<br><span class="muted">No remote backup configured. Set one with <code>opensel backup --remote &lt;url&gt;</code>; push/pull through the CLI.</span>';
  document.getElementById("backupInfo").innerHTML = (bk.hasKey
    ? (osT("信任锚已配置（指纹 <b>","Trust anchor configured (fingerprint <b>")+esc(bk.keyFingerprint||"-")+osT("</b>）· 备份目录 ","</b>) · Backup directory ")+esc(BACKUP_DIR_TEXT)+osT(" · 签名备份可被远端验签"," · Signed backups can be verified remotely"))
    : (osT("未配置信任锚（<code>opensel keygen</code>）· 仅完整性校验，无法证明来源 · 备份目录 ","No trust anchor (<code>opensel keygen</code>); integrity checks alone do not prove origin · Backup directory ")+esc(BACKUP_DIR_TEXT))) + remoteLine;
  document.getElementById("backups").innerHTML = (bk.list||[]).map(function(b){
    var sig = b.signed ? (b.verified===true ? '<span class="yes">'+osT('已验签','Verified')+'</span>' : (b.verified===false ? '<span class="no">'+osT('验签失败','Verification failed')+'</span>' : '<span class="muted">'+osT('未验签','Not verified')+'</span>')) : '<span class="muted">'+osT('无签名','Unsigned')+'</span>';
    return '<tr><td class="mono">'+esc(b.name)+(b.safety?' <span class="muted">'+osT('[安全备份]','[safety backup]')+'</span>':'')+'</td><td class="mono">'+esc(b.createdAt||"-")+'</td><td>'+(b.bytes/1024).toFixed(1)+'KB</td><td>'+b.files+'</td><td>'+(b.signed?'<span class="yes">'+osT('有','Yes')+'</span>':'<span class="muted">'+osT('无','No')+'</span>')+'</td><td>'+sig+'</td></tr>';
  }).join("") || '<tr><td colspan="6" class="muted">'+osT('暂无备份','No backups')+'</td></tr>';
  var tzh=document.getElementById("tzHint");
  if(tzh){
    var ex="";
    try{
      var accts=s.accounts||[];
      var wz=null;
      for(var i=0;i<accts.length;i++){ var u=accts[i].usage; if(u&&u.weekly&&u.weekly.resetsAt){ wz=u.weekly.resetsAt; break; } }
      if(wz){ ex=osT(" 例如 weekly 上游边界 "," Example: weekly boundary ")+String(wz).replace(/\\.\\d+Z$/,"Z")+osT(" = 本机 "," = local ")+fmtReset(wz)+" ("+fmtIn(wz)+")."; }
    }catch(e){}
    tzh.textContent=osT("重置时间按本机时区显示（当前 "+tzLabel()+"）；上游给的是 UTC 绝对时刻，本页已按本机时区换算。","Reset times use your local time zone ("+tzLabel()+"); upstream UTC timestamps are converted locally.")+ex;
  }
  document.getElementById("alerts").innerHTML = (s.alerts||[]).map(function(a){
    return '<tr><td class="mono">'+fmtT(a.ts)+'</td><td>'+esc(a.accountId)+'</td><td>'+esc(a.window)+'</td><td>'+pct(a.threshold)+'</td><td>'+pct(a.percent)+'</td></tr>';
  }).join("") || '<tr><td colspan="5" class="muted">'+osT('暂无告警','No alerts')+'</td></tr>';
  renderModels(s);
  renderCredentials(s);
  document.getElementById("foot").textContent = osT("刷新于 ","Updated ") + fmtT(s.now) + osT(" · 每 10 秒自动刷新"," · Refreshes every 10 seconds");
}
var routeRefreshing = false;
function refreshBestRoute(){
  if (routeRefreshing) return;
  routeRefreshing = true;
  fetch("/api/routes").then(function(r){ return r.json(); }).then(function(d){
    var el=document.getElementById("bestRouteCard"); if(!el) return;
    var b=d.best;
    if(!b){ el.innerHTML='<div class="more">'+osT('无可用线路；检查账号启用/冷却/额度，或去 ','No route available; check account status, cooldown and quota, or open ')+'<a href="/routes">'+osT('线路优化 →','Route optimization →')+'</a></div>'; return; }
    var windowEn={'高峰':'Peak','非高峰':'Off-peak','无分时':'No time window','无分时切换':'No scheduled change'};
    var reasonText=b.reason;
    if(osLang==='en' && b.kind==='plan') {
      reasonText=reasonText.replace('套餐额度；当前非高峰，credits ','Plan allowance; off-peak credits ').replace('套餐额度；当前高峰，模型单价 翻倍','Plan allowance; peak model price doubled').replace('套餐额度；当前非高峰，模型单价 标准','Plan allowance; off-peak standard model price').replace('套餐额度；当前高峰','Plan allowance; peak').replace('套餐额度；当前非高峰','Plan allowance; off-peak').replace('套餐额度；无分时折扣','Plan allowance; no time discount');
    }
    el.innerHTML='<div class="top"><div><div class="name">'+esc(b.providerName)+(b.kind==="plan"?" · "+esc(b.name):"")+'</div><div class="more">'+esc(reasonText)+osT(' · 账号 ',' · Account ')+esc(b.accountLabel||"—")+osT(' · 压力 ',' · Pressure ')+pct(b.pressure)+osT(' · 质量 ',' · Quality ')+pct(b.quality)+osT(' · 延迟 ',' · Latency ')+(b.latencyMs==null?osT("无样本","No samples"):Math.round(b.latencyMs)+"ms")+osT(' · 可靠 ',' · Reliability ')+(b.reliability==null?osT("无样本","No samples"):pct(b.reliability))+'</div></div><div class="big" style="font-size:24px;margin:0">'+usd(b.costPerM)+'<span class="muted" style="font-size:12px;font-weight:400"> /M</span></div></div><div class="more">'+osT('当前 ','Current ')+esc(osLang==='en'?(windowEn[b.window]||b.window):b.window)+osT(' · 下一次切换 ',' · Next change ')+esc(osLang==='en'?(windowEn[b.nextChange]||b.nextChange):b.nextChange)+' · <a href="/routes">'+osT('查看线路优化 →','View route optimization →')+'</a></div>';
  }).catch(function(){}).finally(function(){ routeRefreshing = false; });
}
var refreshing = false;
function refresh(){
  if (refreshing) return;
  refreshing = true;
  fetch("/api/state?view="+encodeURIComponent(VIEW)).then(function(r){ return r.json(); }).then(render).catch(function(){}).finally(function(){ refreshing = false; });
}
document.getElementById("freeSave").onclick=freeSave;
document.getElementById("freeMode").onchange=function(){ freeDirty=true; renderFreeTable(); };
bindActions();
var VIEW = location.pathname === "/connect" ? "connect" : location.pathname === "/settings" ? "settings" : "dashboard";
function applyView(){
  document.body.dataset.view=VIEW;
  document.querySelectorAll("[data-view]").forEach(function(el){
    var views=String(el.getAttribute("data-view")||"").split(/\\s+/);
    el.style.display=views.indexOf(VIEW)>=0 ? "" : "none";
  });
  document.querySelectorAll("header.top nav a").forEach(function(a){
    var href=a.getAttribute("href");
    a.classList.toggle("active", VIEW==="dashboard" ? href==="/" : href==="/"+VIEW);
  });
}
applyView();
var showAllEl = document.getElementById("showAllAccounts");
try {
  var savedShowAll = localStorage.getItem("openselect.showAllAccounts.v2");
  showAllEl.checked = savedShowAll == null ? true : savedShowAll === "1";
} catch(e) { showAllEl.checked = true; }
showAllEl.onchange = function(){
  try { localStorage.setItem("openselect.showAllAccounts.v2", this.checked ? "1" : "0"); } catch(e) {}
  refresh();
};
refresh();
refreshBestRoute();
setInterval(refresh, 10000);
setInterval(refreshBestRoute, 30000);
</script>
</body>
</html>
`;

function json(data: Record<string, unknown>, status = 200): Response {
  return Response.json(data, { status });
}

/** CSRF 防护：写端点仅接受无 Origin（CLI/curl）或本机来源的请求（AC-CDX r7 发现 #3） */
function writeAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

function jsonContent(req: Request): boolean {
  const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  return ct === "application/json" || ct.endsWith("+json");
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 100_000) return null;
    const j = JSON.parse(text) as unknown;
    return typeof j === "object" && j !== null ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pubAccount(a: { id: string; label: string; integration: string; key: string; enabled: boolean; plan?: string; fallbackOnly?: boolean }) {
  return {
    id: a.id,
    label: a.label,
    integration: a.integration,
    keyMasked: maskKey(a.key),
    enabled: a.enabled,
    plan: a.plan ?? null,
    fallbackOnly: !!a.fallbackOnly,
  };
}

function pubConfig(cfg: Runtime["config"]) {
  return {
    switchAt: cfg.policy.switchAt,
    pollSec: cfg.monitor.pollSec,
    autoActivate: cfg.opencode.autoActivate,
    maxAttempts: cfg.policy.maxAttempts,
    cooldownFallbackSec: cfg.policy.cooldownFallbackSec,
    sessionTtlSec: cfg.policy.sessionTtlSec,
    freeFirst: cfg.policy.freeFirst ?? [],
    freeFirstMode: cfg.policy.freeFirstMode ?? "first",
    alertAt: cfg.policy.alertAt ?? [],
    alertCooldownSec: cfg.policy.alertCooldownSec ?? 21600,
    alertAtByWindow: cfg.policy.alertAtByWindow ?? {},
    alertQuiet: cfg.policy.alertQuiet ?? null,
    alertEmail: cfg.policy.alertEmail ? { to: cfg.policy.alertEmail.to, from: cfg.policy.alertEmail.from, host: cfg.policy.alertEmail.host, port: cfg.policy.alertEmail.port } : null,
  };
}

/** Refresh available-model lists for opencode-go accounts (one or all enabled). */
async function refreshModels(rt: Runtime, only?: string): Promise<Record<string, { ok: boolean; count?: number; error?: string }>> {
  const cfg = rt.config;
  const targets = cfg.accounts.filter(
    (a) => (a.integration === "opencode-go" || isProviderIntegration(a.integration)) && (only ? a.id === only : a.enabled),
  );
  const out: Record<string, { ok: boolean; count?: number; error?: string }> = {};
  await Promise.all(
    targets.map(async (a) => {
      const r = await fetchAccountModels(cfg.upstream.base, a);
      if (r.ok) {
        modelCache.set(a.id, { ts: Date.now(), ids: r.ids });
        out[a.id] = { ok: true, count: r.ids.length };
      } else {
        out[a.id] = { ok: false, error: r.error };
      }
    }),
  );
  // Ollama Cloud 的目录随账号可用模型变化；刷新后清缓存，下一次 /v1/models 会重新探测。
  if (targets.some((a) => a.integration === "ollama")) resetCatalogCache();
  return out;
}

/**
 * 接入（客户端）面板数据：每个接入的最近请求数、当前实际服务的账号、面板上指定的账号。
 * 「指定账号」是按接入维度（比全局「设为首选」更细），实际生效顺序见 policy.pickAccount。
 */
function buildClientsState(rt: Runtime): Array<{
  kind: string;
  label: string;
  requests: number;
  lastAccountId: string | null;
  lastAccountLabel: string | null;
  lastAt: number;
  pinnedAccountId: string | null;
}> {
  const stats = clientStats(500);
  const byKind = new Map(stats.map((s) => [s.client, s]));
  const pins = rt.config.policy.clientAccounts ?? {};
  const labelOf = (id: string | null): string | null => {
    if (!id) return null;
    const a = rt.config.accounts.find((x) => x.id === id);
    return a ? a.label : id;
  };
  return CLIENT_KINDS.map((kind) => {
    const st = byKind.get(kind);
    // 只有已知账号 id 才认作"服务的账号"（失败请求记的是尝试链，不是账号 id）
    const lastAccountId = st?.lastAccountId && rt.config.accounts.some((a) => a.id === st.lastAccountId)
      ? st.lastAccountId
      : null;
    const pinnedAccountId = pins[kind] ?? null;
    const pinnedAcc = pinnedAccountId ? rt.config.accounts.find((a) => a.id === pinnedAccountId) : undefined;
    return {
      kind,
      label: CLIENT_LABELS[kind],
      requests: st?.requests ?? 0,
      lastAccountId,
      lastAccountLabel: labelOf(lastAccountId),
      lastAt: st?.lastAt ?? 0,
      pinnedAccountId,
      // 面板据此区分「账号已停用」与「账号已不存在」两种失效文案
      pinState: !pinnedAccountId ? "none" : pinnedAcc ? (pinnedAcc.enabled ? "ok" : "disabled") : "missing",
    };
  });
}

async function buildState(rt: Runtime, includeBackups = false) {
  const catalog = await loadCatalog();
  const now = Date.now();
  const cfg = rt.config;
  const accounts = cfg.accounts.map((a) => {
    const st = rt.state(a.id);
    const u = rt.usages.get(a.id);
    let status = "正常";
    if (!a.enabled) status = a.integration === "opencode-go" || isProviderIntegration(a.integration) ? "已禁用" : "仅凭据";
    else if (st.invalid) status = "Key 无效";
    else if (st.cooldownUntil > now) status = "冷却中";
    else if (isRateLimited(u)) status = "已限流";
    else if (accountPressure(u) >= cfg.policy.switchAt) status = "接近阈值";
    return {
      id: a.id,
      label: a.label,
      integration: a.integration,
      enabled: a.enabled,
      keyMasked: maskKey(a.key),
      plan: a.plan ?? null,
      fallbackOnly: !!a.fallbackOnly,
      status,
      cooldownLeftMs: Math.max(0, st.cooldownUntil - now),
      lastUsed: st.lastUsed,
      lastError: st.lastError,
      pressure: accountPressure(u),
      usage: u ? { ts: u.ts, rolling: u.rolling, weekly: u.weekly, monthly: u.monthly, balance: u.balance ?? null } : null,
      history: usageHistory(a.id, 120),
    };
  });
  const ws = await wireStatus(cfg);
  return {
    now,
    ports: { proxy: cfg.proxy.port, dashboard: cfg.dashboard.port },
    upstreamBase: cfg.upstream.base,
    policy: cfg.policy,
    preferredAccountId: rt.preferredAccountId,
    accounts,
    switches: recentSwitches(40),
    requests: recentRequests(80),
    alerts: recentAlerts(20),
    backups: includeBackups
      ? await buildBackupsState()
      : { list: [], keyFingerprint: publicKeyFingerprint(), hasKey: hasTrustAnchor(), remote: (cfg.backup?.remote ?? null), encryptRemote: cfg.backup?.encryptRemote === true },
    current: {
      forcedAccountId: rt.forcedAccountId,
      // 服务刚重启还没有请求时，回退到最近活跃会话所在的账号
      lastAccountId: rt.preferredAccountId ?? rt.sessionBindings(1)[0]?.accountId ?? null,
      sessionCount: rt.sessionBindings(500).length,
      sessions: rt.sessionBindings(12),
    },
    clients: buildClientsState(rt),
    activity: {
      requests24h: requestTotals(now - 24 * 3600_000, now + 1),
      switches24h: switchSummary(now - 24 * 3600_000, now + 1),
    },
    modelCount: Object.keys(catalog.models).length,
    catalog: [
      ...Object.values(catalog.models).map((m) => ({
        id: m.id,
        name: m.name,
        family: m.family,
        free: m.free,
        api: m.api ?? "chat",
        provider: m.provider,
        upstreamModel: m.upstreamModel,
      })),
      // zen 免费层直通模型（本地 opencode server /generate，不占账号额度）
      ...(await listZenModels().catch(() => [])).map((z) => ({
        id: z.id,
        name: z.name,
        family: "openai" as const,
        free: true,
        api: "chat",
        zen: true,
      })),
    ],
    models: (() => {
      const m: Record<string, { ts: number; ids: string[] }> = Object.fromEntries(
        [...modelCache.entries()].map(([id, c]) => [id, { ts: c.ts, ids: c.ids }]),
      );
      for (const a of cfg.accounts) {
        if (isProviderIntegration(a.integration)) {
          const ids = providerModelIds(a.integration);
          // Ollama Cloud 的模型来自 /v1/models，由「刷新各账号可用模型」写入 modelCache；
          // 这里不能用空数组覆盖已拉取结果。
          if (ids.length > 0) m[a.id] = { ts: Date.now(), ids };
        }
      }
      return m;
    })(),
    zenDeny: zenDenyMap(),
    wire: { wired: ws.wired, written: ws.written, stale: ws.stale, total: ws.total, baseURL: ws.baseURL, path: ws.path, configExists: ws.configExists },
    config: pubConfig(cfg),
    integrationOptions: INTEGRATION_OPTIONS,
  };
}

interface BackupRow {
  name: string;
  bytes: number;
  createdAt: string;
  files: number;
  signed: boolean;
  verified: boolean | null;
  safety: boolean;
}

/** 面板用：备份列表 + 签名状态（只读校验最新几份，不做重活） */
let backupStateCache: { ts: number; value: Awaited<ReturnType<typeof buildBackupsStateUncached>> } | null = null;

async function buildBackupsStateUncached(): Promise<{
  list: BackupRow[];
  keyFingerprint: string | null;
  hasKey: boolean;
  remote: string | null;
  encryptRemote: boolean;
}> {
  const keyFingerprint = publicKeyFingerprint();
  const hasKey = hasTrustAnchor();
  const list: BackupRow[] = [];
  const all = listBackups().slice(0, 8);
  for (const [idx, b] of all.entries()) {
    const signed = existsSync(`${b.path}.sig`);
    // 只对最新 2 份做验签（带 60s 缓存）：面板每 5 秒轮询，逐份解包验签会阻塞与代理共享的事件循环
    const cached = signed && hasKey && idx < 2 ? await verifyBackupCached(b.path) : null;
    const verified = cached ? cached.verified ?? null : null;
    list.push({
      name: b.name,
      bytes: b.bytes,
      createdAt: b.createdAt,
      files: b.fileCount,
      signed,
      verified,
      safety: b.safety,
    });
  }
  const backup = (await loadConfig()).backup;
  return { list, keyFingerprint, hasKey, remote: backup?.remote ?? null, encryptRemote: backup?.encryptRemote === true };
}

async function buildBackupsState(): Promise<{
  list: BackupRow[];
  keyFingerprint: string | null;
  hasKey: boolean;
  remote: string | null;
  encryptRemote: boolean;
}> {
  if (backupStateCache && Date.now() - backupStateCache.ts < 60_000) return backupStateCache.value;
  const value = await buildBackupsStateUncached();
  backupStateCache = { ts: Date.now(), value };
  return value;
}

/** 面板：立即备份（可选签名） */
async function handleBackup(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ ok: false, error: "请求体 JSON 无效" }, 400);
  const sign = body.sign === true;
  try {
    const r = await createBackup({ sign });
    // 与 CLI/定时任务同一保留策略，避免面板备份让目录无限增长
    pruneBackups(BACKUP_KEEP_DEFAULT);
    backupStateCache = null;
    return json({
      ok: true,
      path: r.path,
      signed: !!r.signed,
      sha256: r.sha256,
      files: r.manifest.files.map((f) => f.name),
    });
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 200) }, 500);
  }
}

/**
 * 手动切换账号：设为首选（forcedAccountId）并把已绑定会话重绑过去（在途会话立即换号）；
 * 传 null 解除强制，回到自然选号策略。
 */
async function handleForceAccount(rt: Runtime, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ ok: false, error: "请求体 JSON 无效" }, 400);
  const raw = body.accountId;
  const cfg = await loadConfig();
  if (raw === null || raw === "") {
    cfg.policy.forcedAccountId = null;
    await saveConfig(cfg);
    rt.forcedAccountId = null;
    rt.config = cfg;
    return json({ ok: true, forcedAccountId: null, rebound: 0 });
  }
  if (typeof raw !== "string" || !cfg.accounts.some((a) => a.id === raw)) {
    return json({ ok: false, error: "账号不存在" }, 400);
  }
  const acc = cfg.accounts.find((a) => a.id === raw)!;
  if (!acc.enabled) return json({ ok: false, error: "账号已停用，无法设为首选" }, 400);
  cfg.policy.forcedAccountId = raw;
  await saveConfig(cfg);
  rt.config = cfg;
  const rebound = rt.forceAccount(raw);
  return json({ ok: true, forcedAccountId: raw, rebound });
}

/**
 * 按接入（客户端）指定账号：{client: kind, accountId: id|null}。
 * accountId=null 表示解除该接入的指定（回到自然策略）。
 */
async function handleClientPin(rt: Runtime, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ ok: false, error: "请求体 JSON 无效" }, 400);
  const kind = typeof body.client === "string" ? body.client.trim() : "";
  if (!isClientKind(kind)) return json({ ok: false, error: "接入类型无效" }, 400);
  const cfg = await loadConfig();
  const raw = body.accountId;
  if (raw === null || raw === "") {
    delete (cfg.policy.clientAccounts ?? {})[kind];
    cfg.policy.clientAccounts = cfg.policy.clientAccounts ?? {};
    await saveConfig(cfg);
    rt.config = cfg;
    return json({ ok: true, client: kind, pinnedAccountId: null });
  }
  if (typeof raw !== "string") return json({ ok: false, error: "账号参数无效" }, 400);
  const acc = cfg.accounts.find((a) => a.id === raw);
  if (!acc) return json({ ok: false, error: "账号不存在" }, 400);
  if (!acc.enabled) return json({ ok: false, error: "账号已停用，无法指定" }, 400);
  cfg.policy.clientAccounts = { ...(cfg.policy.clientAccounts ?? {}), [kind]: acc.id };
  await saveConfig(cfg);
  rt.config = cfg;
  return json({ ok: true, client: kind, pinnedAccountId: acc.id });
}

async function handleAddAccount(rt: Runtime, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ ok: false, error: "请求体 JSON 无效" }, 400);
  const integration = (typeof body.integration === "string" && body.integration.trim()) || "opencode-go";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(integration)) return json({ ok: false, error: "集成 ID 格式无效" }, 400);
  const isOllama = integration === "ollama";
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (key.length < 8) return json({ ok: false, error: "Key 无效（至少 8 个字符）" }, 400);
  const label = typeof body.label === "string" ? body.label.trim() || undefined : undefined;
  const connect = body.connect !== false;
  const isGo = integration === "opencode-go";
  const isProvider = isProviderIntegration(integration);
  const isPool = isGo || isProvider;
  const fallbackOnly = body.fallbackOnly === true || integration === "deepseek-api" ? true : undefined;
  const region = body.region === "global" ? "global" : body.region === "cn" ? "cn" : undefined;
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() || undefined : undefined;
  const defaultEffort =
    body.defaultEffort === "low" ||
    body.defaultEffort === "medium" ||
    body.defaultEffort === "high" ||
    body.defaultEffort === "xhigh" ||
    body.defaultEffort === "max"
      ? body.defaultEffort
      : undefined;
  const models = Array.isArray(body.models)
    ? body.models.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim())
    : undefined;
  const plan = typeof body.plan === "string" && body.plan.trim() ? body.plan.trim() : undefined;

  const cfg = await loadConfig();
  const { account, added } = await addAccount(cfg, {
    key,
    label,
    integration,
    note: isOllama
      ? "Ollama Cloud（API Key）"
      : isProvider
        ? fallbackOnly
          ? "直连供应商（仅兜底）"
          : "直连供应商（参与切换池）"
        : isGo
          ? undefined
          : "仅凭据（不在切换池）",
    region,
    baseUrl,
    defaultEffort,
    models,
    plan,
    fallbackOnly,
  });
  if (!added) {
    // 已存在 key：在任何用量状态更新/setState/connectKey/保存之前直接返回，零副作用（AC-CDX r8 发现 #1）
    return json({
      ok: true,
      added: false,
      account: pubAccount(account),
      usage: null,
      checkError: null,
      opencode: { attempted: false, ok: false, detail: "" },
      poolHint: `账号已存在（类型 ${account.integration}、enabled=${account.enabled}）；未做任何变更`,
    });
  }

  // —— 仅新增路径：用量校验（失败 → 停用入档）、保存、注册凭据 ——
  let usage: AccountUsage | null = null;
  let checkError: string | null = null;
  if (isPool) {
    const r = await fetchAccountUsage(cfg.upstream.base, account);
    if (r.ok) {
      usage = r.usage;
      rt.setUsage(r.usage);
      const s = rt.state(account.id);
      s.invalid = false;
      s.cooldownUntil = 0;
      s.lastError = null;
      setState({ accountId: account.id, invalid: false, cooldownUntil: 0, lastError: null });
    } else {
      checkError = r.error;
      // 接入即启用：用量校验失败不回滚启用状态，交给运行期冷却/故障转移处理。
    }
  }
  // 非切换池：仅凭据存档
  if (!isPool) account.enabled = false;
  await saveConfig(cfg);
  rt.config = cfg;
  if (isOllama) resetCatalogCache();

  let opencode: { attempted: boolean; ok: boolean; detail: string } = { attempted: false, ok: false, detail: "" };
  if (connect && !isProvider) {
    const res = connectKey(integration, key, account.label);
    opencode = { attempted: true, ok: res.ok, detail: res.detail };
  } else if (connect && isProvider) {
    opencode = { attempted: false, ok: false, detail: "直连供应商账号不写入 opencode 凭据" };
  }
  const hints: string[] = [];
  if (!isPool) hints.push("非切换池类型：仅注册 opencode 凭据，不参与用量监控与自动切换");
  else if (checkError) hints.push("用量校验失败：账号已启用，但用量暂不可用；请求会按失败进入冷却/故障转移");
  else if (isOllama) hints.push("Ollama Cloud：需要 API Key，模型由 ollama.com/v1 提供；按量/订阅额度见价格表");
  else if (isProvider) hints.push(fallbackOnly ? "DeepSeek 官方：仅兜底，其它账号/供应商都不可用时才使用" : "直连供应商：已参与 5h/周额度监控与自动切换");
  return json({
    ok: true,
    added,
    account: pubAccount(account),
    usage,
    checkError,
    opencode,
    poolHint: hints.join("；") || null,
  });
}

async function handleUpdateAccount(rt: Runtime, id: string, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ ok: false, error: "请求体 JSON 无效" }, 400);
  const cfg = await loadConfig();
  const a = cfg.accounts.find((x) => x.id === id);
  if (!a) return json({ ok: false, error: "账号不存在" }, 404);
  if (body.clearCooldown === true) {
    const s = rt.state(id);
    s.cooldownUntil = 0;
    s.lastError = null;
    setState({ accountId: id, cooldownUntil: 0, lastError: null });
    return json({ ok: true, cleared: true, account: pubAccount(a) });
  }
  if (body.plan !== undefined) {
    a.plan = typeof body.plan === "string" && body.plan.trim() ? body.plan.trim() : undefined;
    await saveConfig(cfg);
    rt.config = cfg;
    return json({ ok: true, account: pubAccount(a) });
  }
  if (a.integration !== "opencode-go" && !isProviderIntegration(a.integration)) {
    return json({ ok: false, error: "仅凭据类型不支持启停" }, 400);
  }
  if (typeof body.enabled !== "boolean") return json({ ok: false, error: "enabled 须为布尔值" }, 400);
  a.enabled = body.enabled;
  await saveConfig(cfg);
  rt.config = cfg;
  return json({ ok: true, account: pubAccount(a) });
}

async function handleDeleteAccount(rt: Runtime, id: string): Promise<Response> {
  const cfg = await loadConfig();
  const idx = cfg.accounts.findIndex((x) => x.id === id);
  if (idx < 0) return json({ ok: false, error: "账号不存在" }, 404);
  const [removed] = cfg.accounts.splice(idx, 1);
  // 删除被手动指定的账号时，一并解除指定（避免配置里残留幽灵账号）
  if (cfg.policy.forcedAccountId === id) {
    cfg.policy.forcedAccountId = null;
    rt.forcedAccountId = null;
  }
  // 同样清掉按接入指定的引用（否则该接入会静默指向已删除的账号）
  const pins = { ...(cfg.policy.clientAccounts ?? {}) };
  let pinsChanged = false;
  for (const [kind, accId] of Object.entries(pins)) {
    if (accId === id) {
      delete pins[kind];
      pinsChanged = true;
    }
  }
  if (pinsChanged) cfg.policy.clientAccounts = pins;
  await saveConfig(cfg);
  rt.config = cfg;
  rt.states.delete(id);
  rt.usages.delete(id);
  modelCache.delete(id);
  // 最近服务的账号若正是被删账号 → 清空（面板不再显示已删账号的裸 id）
  if (rt.preferredAccountId === id) rt.preferredAccountId = null;
  // 清理指向该账号的会话绑定（内存 + 台账）：否则「正在服务」与「活跃会话」仍显示已删账号
  for (const [sid, b] of [...rt.sessions.entries()]) {
    if (b.accountId === id) {
      rt.sessions.delete(sid);
      deleteSession(sid);
    }
  }
  return json({ ok: true, removed: removed ? pubAccount(removed) : null });
}

async function handleSettings(rt: Runtime, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ ok: false, error: "请求体 JSON 无效" }, 400);
  const cfg = await loadConfig();
  const catalog = await loadCatalog();
  const errs: string[] = [];
  if ("codingAutoOrder" in body) {
    if (!isCodingAutoOrder(body.codingAutoOrder)) errs.push("coding-auto 至少选择一条线路，且线路不能重复或未知");
    else cfg.policy.codingAutoOrder = codingAutoOrder(body.codingAutoOrder);
  }
  if ("switchAt" in body) {
    const v = Number(body.switchAt);
    if (!Number.isFinite(v) || v < SWITCH_AT_MIN || v > SWITCH_AT_MAX) errs.push(`阈值须在 ${SWITCH_AT_MIN}–${SWITCH_AT_MAX} 之间`);
    else cfg.policy.switchAt = v;
  }
  if ("pollSec" in body) {
    const v = Number(body.pollSec);
    if (!Number.isInteger(v) || v < 10 || v > 3600) errs.push("轮询间隔须为 10–3600 的整数秒");
    else cfg.monitor.pollSec = v;
  }
  if ("autoActivate" in body) {
    if (typeof body.autoActivate !== "boolean") errs.push("autoActivate 须为布尔值");
    else cfg.opencode.autoActivate = body.autoActivate;
  }
  if ("freeFirst" in body) {
    const raw = body.freeFirst;
    if (!Array.isArray(raw) || raw.some((m) => typeof m !== "string" || m.trim() === "")) {
      errs.push("免费优先须为模型 ID 数组");
    } else {
      // 只保留目录里存在、且具备中转资格（openai/chat 家族）的模型；去重并保持顺序
      const ids = (raw as string[]).map((m) => m.trim()).filter((m) => m !== "");
      const valid: string[] = [];
      for (const id of ids) {
        if (valid.includes(id)) continue;
        if (!catalog.models[id] && !isZenModelId(id)) {
          errs.push(`模型 ${id} 不在目录中`);
          continue;
        }
        if (!isZenModelId(id) && !isFreeFirstEligible(catalog, id)) {
          errs.push(`模型 ${id} 不是可替换的免费模型（须在目录中、标记为免费，且属于 openai/chat 家族）`);
          continue;
        }
        valid.push(id);
      }
      if (!errs.length) cfg.policy.freeFirst = valid;
    }
  }
  if ("freeFirstMode" in body) {
    const raw = body.freeFirstMode;
    if (raw !== "off" && raw !== "first" && raw !== "fallback") errs.push("freeFirstMode 须为 off / first / fallback");
    else cfg.policy.freeFirstMode = raw;
  }
  if ("alertAt" in body) {
    const raw = body.alertAt;
    if (!Array.isArray(raw) || raw.some((n) => typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 150)) {
      errs.push("告警阈值须为 1–150 的百分比数组");
    } else {
      cfg.policy.alertAt = [...new Set((raw as number[]).map((n) => Math.round(n * 1000) / 100000))].sort((a, b) => a - b);
    }
  }
  if ("alertAtByWindow" in body) {
    const raw = body.alertAtByWindow;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errs.push("分窗口阈值须为对象");
    } else {
      const out: Record<string, number[]> = {};
      for (const w of ["rolling", "weekly", "monthly"]) {
        const list = (raw as Record<string, unknown>)[w];
        if (list === undefined || list === null) continue;
        if (!Array.isArray(list) || list.some((n) => typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 150)) {
          errs.push(`分窗口阈值 ${w} 须为 1–150 的百分比数组`);
          continue;
        }
        const cleaned = [...new Set((list as number[]).map((n) => Math.round(n * 1000) / 100000))].sort((a, b) => a - b);
        if (cleaned.length > 0) out[w] = cleaned; // 空 = 跟随全局
      }
      if (!errs.length) cfg.policy.alertAtByWindow = out;
    }
  }
  if ("alertQuiet" in body) {
    const q = body.alertQuiet;
    if (q === null) {
      cfg.policy.alertQuiet = undefined;
    } else if (
      q &&
      typeof q === "object" &&
      typeof (q as Record<string, unknown>).from === "string" &&
      typeof (q as Record<string, unknown>).to === "string" &&
      isHhMm((q as Record<string, unknown>).from) &&
      isHhMm((q as Record<string, unknown>).to)
    ) {
      cfg.policy.alertQuiet = { from: (q as { from: string }).from, to: (q as { to: string }).to };
    } else {
      errs.push("静默时段须为 HH:MM 起止时间（留空可关闭）");
    }
  }
  if (errs.length) return json({ ok: false, error: errs.join("；") }, 400);
  await saveConfig(cfg);
  rt.config = cfg;
  return json({ ok: true, config: pubConfig(cfg) });
}

async function handleWire(rt: Runtime): Promise<Response> {
  const cfg = await loadConfig();
  const res = await wireGlobal(cfg);
  return json({ ok: true, changed: res.changed, models: res.models, path: res.path, backup: res.backup ?? null });
}

async function handleUnwire(rt: Runtime): Promise<Response> {
  const cfg = await loadConfig();
  const res = await unwireGlobal(cfg);
  return json({ ok: true, removed: res.removed, restored: res.restored, path: res.path });
}

async function handleModelsRefresh(rt: Runtime, req: Request): Promise<Response> {
  const body = (await readJsonBody(req)) ?? {};
  const only = typeof body.account === "string" && body.account ? body.account : undefined;
  if (only && !rt.config.accounts.some((a) => a.id === only)) return json({ ok: false, error: "账号不存在" }, 404);
  const results = await refreshModels(rt, only);
  return json({ ok: true, results });
}

function rangeSince(raw: string | null): number {
  const now = Date.now();
  if (raw === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (raw === "7d") return now - 7 * 24 * 3600_000;
  if (raw === "30d") return now - 30 * 24 * 3600_000;
  if (raw === "all") return 0;
  return now - 24 * 3600_000;
}

function handleRequests(url: URL): Response {
  const q = url.searchParams;
  const statusRaw = q.get("status");
  const status = statusRaw === "ok" || statusRaw === "error" ? statusRaw : undefined;
  const res = queryRequests({
    limit: Number(q.get("limit") ?? 100) || 100,
    offset: Number(q.get("offset") ?? 0) || 0,
    since: rangeSince(q.get("range")),
    until: Date.now() + 1,
    client: q.get("client") || undefined,
    model: q.get("model") || undefined,
    accountId: q.get("account") || undefined,
    status,
    q: q.get("q") || undefined,
  });
  return Response.json({ ...res, now: Date.now() });
}

function handleSwitches(url: URL): Response {
  const q = url.searchParams;
  const kindRaw = q.get("kind");
  const kind = kindRaw === "failover" || kindRaw === "rebind" || kindRaw === "all" ? kindRaw : undefined;
  const res = querySwitches({
    limit: Number(q.get("limit") ?? 100) || 100,
    offset: Number(q.get("offset") ?? 0) || 0,
    since: rangeSince(q.get("range")),
    until: Date.now() + 1,
    fromAccount: q.get("from") || undefined,
    toAccount: q.get("to") || undefined,
    reason: q.get("reason") || undefined,
    q: q.get("q") || undefined,
    kind,
  });
  return Response.json({ ...res, now: Date.now() });
}

export function startDashboard(rt: Runtime, opts: { hostname?: string; port?: number } = {}): {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
} {
  const server = Bun.serve({
    hostname: opts.hostname ?? rt.config.dashboard.host,
    port: opts.port ?? rt.config.dashboard.port,
    idleTimeout: 30,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const p = url.pathname;
        if ((req.method === "POST" || req.method === "DELETE") && p.startsWith("/api/")) {
          if (!writeAllowed(req)) return json({ ok: false, error: "跨站请求被拒绝（Origin 校验失败）" }, 403);
          if (req.method === "POST" && !jsonContent(req)) return json({ ok: false, error: "Content-Type 须为 application/json" }, 415);
        }
        if (p === "/connect/" || p === "/settings/") {
          return Response.redirect(new URL(p.slice(0, -1), url).toString(), 302);
        }
        if (p === "/api/state") return Response.json(await buildState(rt, url.searchParams.get("view") === "settings"));
        if (p === "/api/stats") return Response.json(buildStats(rt, url));
        if (p === "/api/tokens") return Response.json(await buildTokenStats(rt, url));
        if (p === "/api/routes") return Response.json(await buildRouteAdvice(rt));
        if (p === "/api/pricing/collect" && req.method === "POST") return Response.json(await collectTimePricing());
        if (p === "/api/requests") return handleRequests(url);
        if (p === "/api/switches") return handleSwitches(url);
        if (p === "/stats") return new Response(statsPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (p === "/tokens") return new Response(tokenStatsPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (p === "/routes") return new Response(routesPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (p === "/models") return new Response(availabilityPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (p === "/requests") return new Response(requestsPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (p === "/switches") return new Response(switchesPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (p === "/api/backup" && req.method === "POST") return handleBackup(req);
        if (p === "/api/accounts/force" && req.method === "POST") return handleForceAccount(rt, req);
        if (p === "/api/clients/pin" && req.method === "POST") return handleClientPin(rt, req);
        if (p === "/healthz") return Response.json({ ok: true, service: "openselect-dashboard" });
        if (p === "/" || p === "/index.html" || p === "/connect" || p === "/settings") {
          return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        if (p === "/api/accounts" && req.method === "POST") return handleAddAccount(rt, req);
        if (p === "/api/settings" && req.method === "POST") return handleSettings(rt, req);
        if (p === "/api/wire" && req.method === "POST") return handleWire(rt);
        if (p === "/api/unwire" && req.method === "POST") return handleUnwire(rt);
        if (p === "/api/models/refresh" && req.method === "POST") return handleModelsRefresh(rt, req);
        const m = p.match(/^\/api\/accounts\/([^/]+)$/);
        if (m) {
          const id = decodeURIComponent(m[1]!);
          if (req.method === "POST") return handleUpdateAccount(rt, id, req);
          if (req.method === "DELETE") return handleDeleteAccount(rt, id);
        }
        return new Response("not found", { status: 404 });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    },
  });
  return { server, stop: () => void server.stop(true) };
}
