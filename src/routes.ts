import { tokenStatsByProvider } from "./db";
import { accountPressure, isRateLimited } from "./policy";
import type { Runtime } from "./state";
import {
  loadTimePricing,
  nextTransition,
  ruleById,
  windowKind,
  windowLabel,
  type PlanTimeRule,
  type ProviderTimeRule,
  type ScoringConfig,
  type TimePricingData,
} from "./time_pricing";
import { UI_CSS, navHtml } from "./ui";

const PROVIDER_INTEGRATION: Record<string, string> = {
  opencode: "opencode-go",
  deepseek: "deepseek-api",
  zai: "zai",
  minimax: "minimax",
  commandcode: "commandcode",
  ollama: "ollama",
};

const INTEGRATION_PROVIDER: Record<string, string> = {
  "opencode-go": "opencode",
  "deepseek-api": "deepseek",
  zai: "zai",
  minimax: "minimax",
  commandcode: "commandcode",
  ollama: "ollama",
};

const PROVIDER_LABEL: Record<string, string> = {
  opencode: "OpenCode",
  deepseek: "DeepSeek 官方",
  zai: "Z.ai",
  minimax: "MiniMax",
  commandcode: "Command Code",
  ollama: "Ollama Cloud",
};

interface AccountRef {
  id: string;
  label: string;
  pressure: number;
}

function planMatches(account: { label: string; plan?: string }, plan: PlanTimeRule): boolean {
  if (account.plan) return account.plan === plan.id;
  const label = String(account.label || "").toLowerCase();
  if (plan.provider === "opencode") {
    if (plan.id === "opencode-go") return !/plus|teams/.test(label);
    if (plan.id === "opencode-plus") return /plus/.test(label);
    if (plan.id === "opencode-teams") return /teams/.test(label);
    return false;
  }
  if (plan.provider === "zai") return label.includes(plan.id.replace("zai-", ""));
  if (plan.provider === "ollama") return label.includes(plan.id.replace("ollama-", ""));
  if (plan.provider === "commandcode") return label.includes(plan.id.replace("commandcode-", ""));
  return false;
}

function pickAccount(rt: Runtime, provider: string, plan?: PlanTimeRule): AccountRef | null {
  const integration = PROVIDER_INTEGRATION[provider];
  if (!integration) return null;
  const now = Date.now();
  const eligible = rt.config.accounts.filter((a) => {
    if (a.integration !== integration || !a.enabled) return false;
    if (plan && !planMatches(a, plan)) return false;
    const st = rt.state(a.id);
    if (st.invalid || st.cooldownUntil > now) return false;
    if (isRateLimited(rt.usages.get(a.id))) return false;
    if (a.fallbackOnly) return false;
    if (accountPressure(rt.usages.get(a.id)) >= rt.config.policy.switchAt) return false;
    return true;
  });
  if (!eligible.length) return null;
  eligible.sort((a, b) => accountPressure(rt.usages.get(a.id)) - accountPressure(rt.usages.get(b.id)));
  const a = eligible[0]!;
  return { id: a.id, label: a.label, pressure: accountPressure(rt.usages.get(a.id)) };
}

function fmtInTz(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function fmtNext(date: Date | null, rule?: ProviderTimeRule): string {
  if (!date) return "无分时切换";
  return rule ? `${fmtInTz(date, rule.timezone)}（${rule.timezone}）` : date.toISOString();
}

const DEFAULT_SCORING = { pressureWeight: 0.25, latencyWeight: 0.15, qualityWeight: 0.2, reliabilityWeight: 0.15, latencyNormalizeMs: 5000 };

function qualityFor(data: TimePricingData, provider: string): number {
  return ruleById(data, provider)?.quality ?? 0.85;
}

function latencyFor(map: Map<string, number>, provider: string, normalizeMs: number): { ms: number | null; score: number } {
  const key = PROVIDER_INTEGRATION[provider] ?? provider;
  const ms = map.get(key) ?? null;
  return { ms, score: ms == null ? 0.5 : Math.min(1, Math.max(0, ms / Math.max(1, normalizeMs))) };
}

function scoreOf(cost: number, pressure: number, latencyScore: number, quality: number, reliability: number, scoring: typeof DEFAULT_SCORING): number {
  return cost * (
    1 +
    pressure * scoring.pressureWeight +
    latencyScore * scoring.latencyWeight +
    (1 - quality) * scoring.qualityWeight +
    (1 - reliability) * scoring.reliabilityWeight
  );
}

function reliabilityFor(map: Map<string, { reliability: number; samples: number }>, provider: string): { reliability: number | null; samples: number } {
  const key = PROVIDER_INTEGRATION[provider] ?? provider;
  const v = map.get(key);
  return v ? { reliability: v.reliability, samples: v.samples } : { reliability: null, samples: 0 };
}

export interface RouteCandidate {
  id: string;
  kind: "api" | "plan";
  provider: string;
  providerName: string;
  name: string;
  model: string;
  monthlyUsd: number | null;
  includedUsd: number | null;
  baseRatio: number | null;
  effectiveRatio: number | null;
  costPerM: number;
  window: string;
  windowLabel: string;
  nextChange: string;
  available: boolean;
  accountId: string | null;
  accountLabel: string | null;
  pressure: number;
  quality: number;
  latencyMs: number | null;
  latencyScore: number;
  reliability: number | null;
  samples: number;
  score: number;
  reason: string;
}

export interface ProviderTimeView extends ProviderTimeRule {
  currentWindow: string;
  nextChange: string;
  accountId: string | null;
  accountLabel: string | null;
  pressure: number;
  quality: number;
  latencyMs: number | null;
  latencyScore: number;
  reliability: number | null;
  samples: number;
  available: boolean;
}

export interface PlanTimeView extends PlanTimeRule {
  providerName: string;
  currentWindow: string;
  nextChange: string;
  effectiveRatio: number | null;
  costPerM: number | null;
  available: boolean;
  accountId: string | null;
  accountLabel: string | null;
  pressure: number;
  quality: number;
  latencyMs: number | null;
  latencyScore: number;
  reliability: number | null;
  samples: number;
}

export interface RouteAdvice {
  now: number;
  timezone: string;
  base: TimePricingData["base"];
  scoring: ScoringConfig;
  best: RouteCandidate | null;
  candidates: RouteCandidate[];
  providers: ProviderTimeView[];
  plans: PlanTimeView[];
  lastVerified: string;
  lastRun: string | null;
  lastErrors: string[];
}

function apiCandidate(
  rt: Runtime,
  data: TimePricingData,
  opts: {
    id: string;
    provider: string;
    model: string;
    ruleId: string;
    offPeakPrice: number;
    peakPrice: number;
    flatPrice?: number;
    note?: string;
  },
  now: Date,
  scoring: typeof DEFAULT_SCORING,
  latencyMap: Map<string, number>,
  reliabilityMap: Map<string, { reliability: number; samples: number }>,
): RouteCandidate {
  const rule = ruleById(data, opts.ruleId);
  const kind = rule ? windowKind(rule, now) : "flat";
  const cost = opts.flatPrice ?? (kind === "peak" ? opts.peakPrice : opts.offPeakPrice);
  const account = pickAccount(rt, opts.provider);
  const pressure = account?.pressure ?? 0;
  const quality = qualityFor(data, opts.provider);
  const latency = latencyFor(latencyMap, opts.provider, scoring.latencyNormalizeMs);
  const rel = reliabilityFor(reliabilityMap, opts.provider);
  const next = rule ? nextTransition(rule, now) : null;
  const window = rule ? windowLabel(rule, now) : "无分时";
  return {
    id: opts.id,
    kind: "api",
    provider: opts.provider,
    providerName: PROVIDER_LABEL[opts.provider] ?? opts.provider,
    name: opts.model,
    model: opts.model,
    monthlyUsd: null,
    includedUsd: null,
    baseRatio: null,
    effectiveRatio: null,
    costPerM: cost,
    window,
    windowLabel: window,
    nextChange: fmtNext(next, rule),
    available: !!account,
    accountId: account?.id ?? null,
    accountLabel: account?.label ?? null,
    pressure,
    quality,
    latencyMs: latency.ms,
    latencyScore: latency.score,
    reliability: rel.reliability,
    samples: rel.samples,
    score: account ? scoreOf(cost, pressure, latency.score, quality, rel.reliability ?? 0.5, scoring) : Number.POSITIVE_INFINITY,
    reason:
      opts.note ??
      (kind === "off-peak"
        ? `当前非高峰，按 ${Math.round((opts.offPeakPrice / (opts.peakPrice || opts.offPeakPrice)) * 100)}% 价格`
        : kind === "peak"
          ? "当前高峰"
          : "无分时价格"),
  };
}

function planCandidate(rt: Runtime, data: TimePricingData, plan: PlanTimeRule, now: Date, scoring: typeof DEFAULT_SCORING, latencyMap: Map<string, number>, reliabilityMap: Map<string, { reliability: number; samples: number }>): RouteCandidate {
  const rule = plan.timeRule === "none" ? undefined : ruleById(data, plan.timeRule);
  const kind = rule ? windowKind(rule, now) : "flat";
  const mode = plan.timeMode ?? "credits";
  const mult = rule && kind === "off-peak" ? rule.offPeakDiscount : 1;
  const priceMult = rule && kind === "peak" ? 1 / Math.max(0.01, rule.offPeakDiscount) : 1;
  const effectiveRatio =
    plan.baseRatio == null
      ? null
      : mode === "price"
        ? plan.baseRatio * priceMult
        : plan.baseRatio * mult;
  const cost = effectiveRatio == null ? Number.POSITIVE_INFINITY : data.base.usdPerMillion * effectiveRatio;
  const account = pickAccount(rt, plan.provider, plan);
  const pressure = account?.pressure ?? 0;
  const quality = qualityFor(data, plan.provider);
  const latency = latencyFor(latencyMap, plan.provider, scoring.latencyNormalizeMs);
  const rel = reliabilityFor(reliabilityMap, plan.provider);
  const next = rule ? nextTransition(rule, now) : null;
  return {
    id: plan.id,
    kind: "plan",
    provider: plan.provider,
    providerName: PROVIDER_LABEL[plan.provider] ?? plan.provider,
    name: plan.name,
    model: plan.name,
    monthlyUsd: plan.monthlyUsd,
    includedUsd: plan.includedUsd,
    baseRatio: plan.baseRatio,
    effectiveRatio,
    costPerM: cost,
    window: rule ? windowLabel(rule, now) : "无分时",
    windowLabel: rule ? windowLabel(rule, now) : "无分时",
    nextChange: fmtNext(next, rule),
    available: !!account && Number.isFinite(cost),
    accountId: account?.id ?? null,
    accountLabel: account?.label ?? null,
    pressure,
    quality,
    latencyMs: latency.ms,
    latencyScore: latency.score,
    reliability: rel.reliability,
    samples: rel.samples,
    score: account && Number.isFinite(cost) ? scoreOf(cost, pressure, latency.score, quality, rel.reliability ?? 0.5, scoring) : Number.POSITIVE_INFINITY,
    reason:
      rule && mode === "price"
        ? `套餐额度；当前${windowLabel(rule, now)}，模型单价 ${kind === "peak" ? "翻倍" : "标准"}`
        : rule && kind === "off-peak"
          ? `套餐额度；当前非高峰，credits ${Math.round(rule.offPeakDiscount * 100)}%`
          : rule
            ? `套餐额度；当前${windowLabel(rule, now)}`
            : "套餐额度；无分时折扣",
  };
}

export async function buildRouteAdvice(rt: Runtime): Promise<RouteAdvice> {
  const data = await loadTimePricing();
  const now = new Date();
  const scoring = data.scoring ?? DEFAULT_SCORING;
  const latencyMap = new Map<string, number>();
  const reliabilityMap = new Map<string, { reliability: number; samples: number }>();
  for (const row of tokenStatsByProvider(now.getTime() - 24 * 3600_000, now.getTime() + 1)) {
    if (row.requests > 0 && Number.isFinite(row.avgLatencyMs)) latencyMap.set(row.provider, row.avgLatencyMs);
    if (row.requests > 0) {
      reliabilityMap.set(row.provider, {
        reliability: Math.max(0, Math.min(1, (row.requests - row.errors) / row.requests)),
        samples: row.requests,
      });
    }
  }
  const candidates: RouteCandidate[] = [
    apiCandidate(rt, data, { id: "api-deepseek", provider: "deepseek", model: "deepseek-flash", ruleId: "deepseek", offPeakPrice: 0.375, peakPrice: 0.75 }, now, scoring, latencyMap, reliabilityMap),
    apiCandidate(rt, data, { id: "api-ollama", provider: "ollama", model: "deepseek-v4.1-flash", ruleId: "ollama", offPeakPrice: 0.375, peakPrice: 0.75 }, now, scoring, latencyMap, reliabilityMap),
    ...data.plans.map((p) => planCandidate(rt, data, p, now, scoring, latencyMap, reliabilityMap)),
  ];

  const providers: ProviderTimeView[] = data.providers.map((p) => {
    const account = pickAccount(rt, p.id);
    const next = nextTransition(p, now);
    return {
      ...p,
      currentWindow: windowLabel(p, now),
      nextChange: fmtNext(next, p),
      accountId: account?.id ?? null,
      accountLabel: account?.label ?? null,
      pressure: account?.pressure ?? 0,
      quality: p.quality ?? 0.85,
      latencyMs: latencyFor(latencyMap, p.id, scoring.latencyNormalizeMs).ms,
      latencyScore: latencyFor(latencyMap, p.id, scoring.latencyNormalizeMs).score,
      reliability: reliabilityFor(reliabilityMap, p.id).reliability,
      samples: reliabilityFor(reliabilityMap, p.id).samples,
      available: !!account,
    };
  });

  const plans: PlanTimeView[] = data.plans.map((p) => {
    const rule = p.timeRule === "none" ? undefined : ruleById(data, p.timeRule);
    const kind = rule ? windowKind(rule, now) : "flat";
    const mode = p.timeMode ?? "credits";
    const mult = rule && kind === "off-peak" ? rule.offPeakDiscount : 1;
    const priceMult = rule && kind === "peak" ? 1 / Math.max(0.01, rule.offPeakDiscount) : 1;
    const effectiveRatio =
      p.baseRatio == null ? null : mode === "price" ? p.baseRatio * priceMult : p.baseRatio * mult;
    const account = pickAccount(rt, p.provider, p);
    return {
      ...p,
      providerName: PROVIDER_LABEL[p.provider] ?? p.provider,
      currentWindow: rule ? windowLabel(rule, now) : "无分时",
      nextChange: fmtNext(rule ? nextTransition(rule, now) : null, rule),
      effectiveRatio,
      costPerM: effectiveRatio == null ? null : data.base.usdPerMillion * effectiveRatio,
      available: !!account && effectiveRatio != null,
      accountId: account?.id ?? null,
      accountLabel: account?.label ?? null,
      pressure: account?.pressure ?? 0,
      quality: qualityFor(data, p.provider),
      latencyMs: latencyFor(latencyMap, p.provider, scoring.latencyNormalizeMs).ms,
      latencyScore: latencyFor(latencyMap, p.provider, scoring.latencyNormalizeMs).score,
      reliability: reliabilityFor(reliabilityMap, p.provider).reliability,
      samples: reliabilityFor(reliabilityMap, p.provider).samples,
    };
  });

  const forced = rt.forcedAccountId ? rt.config.accounts.find((a) => a.id === rt.forcedAccountId) : undefined;
  const forcedProvider = forced ? INTEGRATION_PROVIDER[forced.integration] : undefined;
  const forcedHasCostCandidate = forcedProvider
    ? candidates.some((c) => c.provider === forcedProvider && c.available)
    : false;
  const ranked = candidates
    .filter((c) => !forcedProvider || !forcedHasCostCandidate || c.provider === forcedProvider)
    .slice()
    .sort((a, b) => (a.available === b.available ? a.score - b.score : a.available ? -1 : 1));
  const best = ranked.find((c) => c.available) ?? null;
  return {
    now: now.getTime(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    base: data.base,
    scoring,
    best,
    candidates: ranked,
    providers,
    plans,
    lastVerified: data.lastVerified,
    lastRun: data.lastRun,
    lastErrors: data.lastErrors ?? [],
  };
}

export function routesPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>OpenSelect · 线路优化</title>
<style>${UI_CSS}</style>
<style>
  .route-grid { display:grid; grid-template-columns:1.1fr .9fr; gap:14px; }
  .best { padding:20px; }
  .best .provider { color:var(--muted); font-size:12px; }
  .best .name { font-size:24px; font-weight:800; margin:4px 0; }
  .best .cost { font-size:34px; font-weight:800; color:var(--green); letter-spacing:-1px; }
  .best .reason { color:var(--muted); font-size:12px; margin-top:8px; }
  .route-table td { vertical-align:top; }
  .rank { color:var(--muted); font-family:ui-monospace, monospace; }
  .good { color:var(--green); font-weight:600; }
  .bad { color:var(--red); }
  .muted { color:var(--muted); }
  .mono { font-family:ui-monospace, monospace; }
  .bar { height:6px; background:#223047; border-radius:4px; overflow:hidden; min-width:70px; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg,#4c8dff,#36d6c3); }
  .src { font-size:11px; color:var(--muted); }
  .src a { color:#58a6ff; }
  .collect { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .algo { line-height:1.8; color:var(--muted); font-size:12.5px; }
  .algo b { color:var(--text); }
  @media (max-width: 1000px) { .route-grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
${navHtml("routes")}
<main>
  <div class="hero">
    <div><h1>线路优化</h1><p>当前时段 × 套餐额度 × 账号压力 → 最低有效成本线路</p></div>
    <div class="statusline" id="hdr">加载中…</div>
  </div>

  <div class="cards">
    <div class="card green"><div class="lbl"><span>当前最优线路</span><span class="pill" id="bestPill">—</span></div><div class="big" id="bestName">—</div><div class="sub" id="bestSub">加载中…</div></div>
    <div class="card"><div class="lbl"><span>有效成本</span><span class="pill">$/M tokens</span></div><div class="big" id="bestCost">—</div><div class="sub" id="bestReason">—</div></div>
    <div class="card cyan"><div class="lbl"><span>当前时段</span><span class="pill" id="windowPill">—</span></div><div class="big" id="windowName">—</div><div class="sub" id="nextChange">—</div></div>
    <div class="card purple"><div class="lbl"><span>数据采集</span><span class="pill" id="collectPill">—</span></div><div class="big" id="collectCount">—</div><div class="sub" id="collectSub">—</div></div>
  </div>

  <h2>线路排行 <span class="muted">成本 × 账号压力；不可用线路保留在表内</span></h2>
  <div class="tablewrap card" style="padding:0">
    <table class="route-table">
      <thead><tr><th>#</th><th>类型</th><th>供应商 / 套餐</th><th>当前时段</th><th>有效成本</th><th>账号压力</th><th>质量 / 延迟 / 可靠</th><th>可用</th><th>下一次切换</th><th>理由</th></tr></thead>
      <tbody id="candidateRows"></tbody>
    </table>
  </div>

  <h2>供应商高峰 / 非高峰划分</h2>
  <div class="tablewrap card" style="padding:0">
    <table>
      <thead><tr><th>供应商</th><th>时区</th><th>高峰窗口</th><th>非高峰折扣</th><th>当前</th><th>下一次切换</th><th>账号</th><th>来源</th></tr></thead>
      <tbody id="providerRows"></tbody>
    </table>
  </div>

  <h2>订阅套餐分时规则</h2>
  <div class="tablewrap card" style="padding:0">
    <table>
      <thead><tr><th>套餐</th><th>月费</th><th>内含额度</th><th>基准比例</th><th>分时规则</th><th>当前</th><th>有效比例</th><th>有效 $/M</th><th>质量 / 延迟 / 可靠</th><th>可用</th></tr></thead>
      <tbody id="planRows"></tbody>
    </table>
  </div>

  <div class="route-grid">
    <div class="card">
      <h2 style="margin-top:0">算法</h2>
      <div class="algo">
        <b>有效成本</b> = 基准 $0.375/M × 套餐基准比例 × 当前分时倍率。<br>
        <b>线路得分</b> = 有效成本 × (1 + 账号压力 × 权重 + 延迟分 × 权重 + (1 − 质量分) × 权重 + (1 − 可靠性) × 权重)。<br>
        默认权重：压力 0.25、延迟 0.15、质量 0.20、可靠性 0.15；可在 <code>data/time-pricing.json</code> 的 <code>scoring</code> 调整。<br>
        延迟/可靠性取最近 24h 该供应商平均耗时与成功率；无样本按中性 0.5。质量分为可配置基准，不是公开 benchmark。<br>
        可用性优先：账号必须启用、未失效、未冷却、未限流。<br>
        选择得分最低且可用的线路；没有可用线路时显示“无可用线路”。<br>
        套餐比例 = 月费 ÷ 内含 DeepSeek 官方等价额度；仅用于同口径比较。
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">自动采集</h2>
      <div class="collect">
        <button class="btn primary" id="collectBtn">立即采集官方页面</button>
        <span class="muted" id="collectMsg"></span>
      </div>
      <div class="more" id="collectInfo">加载中…</div>
      <div class="src" id="collectErrors"></div>
    </div>
  </div>

  <footer id="foot"></footer>
</main>
<script>
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];}); }
function usd(n){ return n==null||!isFinite(n)?"—":"$"+Number(n).toFixed(4); }
function num(n){ return (n==null||isNaN(n))?"0":Number(n).toLocaleString("zh-CN"); }
function pct(n){ return n==null||!isFinite(n)?"—":(n*100).toFixed(1)+"%"; }
function fmtT(ts){ if(!ts) return "—"; return new Date(ts).toLocaleString("zh-CN",{hour12:false,month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}); }
function windowLabel(w){ return w==="peak"?"高峰":w==="off-peak"?"非高峰":"无分时"; }
function render(d){
  document.getElementById("hdr").textContent="当前 "+fmtT(d.now)+" · 本机时区 "+d.timezone+" · 基准 "+usd(d.base.usdPerMillion)+"/M";
  var b=d.best;
  if(b){
    document.getElementById("bestName").textContent=b.providerName+(b.kind==="plan"?" · "+b.name:"");
    document.getElementById("bestPill").textContent=b.kind==="plan"?"套餐":"API";
    document.getElementById("bestSub").textContent=b.window+" · "+(b.accountLabel||"无账号")+" · 压力 "+pct(b.pressure)+" · 质量 "+pct(b.quality)+" · 延迟 "+(b.latencyMs==null?"无样本":Math.round(b.latencyMs)+"ms")+" · 可靠 "+(b.reliability==null?"无样本":pct(b.reliability)+"（"+num(b.samples)+"）");
    document.getElementById("bestCost").textContent=usd(b.costPerM);
    document.getElementById("bestReason").textContent=b.reason;
  } else {
    document.getElementById("bestName").textContent="无可用线路";
    document.getElementById("bestPill").textContent="—";
    document.getElementById("bestSub").textContent="检查账号启用/冷却/额度";
    document.getElementById("bestCost").textContent="—";
    document.getElementById("bestReason").textContent="—";
  }
  document.getElementById("windowName").textContent=b?b.window:"—";
  document.getElementById("windowPill").textContent="当前线路";
  document.getElementById("nextChange").textContent=(d.providers||[]).filter(function(p){return p.nextChange && p.nextChange!=="无分时切换";}).slice(0,2).map(function(p){return p.name+" "+p.nextChange;}).join(" · ")||"无分时切换";
  document.getElementById("collectCount").textContent=(d.lastErrors&&d.lastErrors.length)?"有错误":"正常";
  document.getElementById("collectPill").textContent=d.lastRun?"已采集":"未运行";
  document.getElementById("collectSub").textContent="最近 "+(d.lastRun?fmtT(d.lastRun):"未运行")+" · 官方核验 "+d.lastVerified+" · 错误 "+(d.lastErrors||[]).length;

  document.getElementById("candidateRows").innerHTML=(d.candidates||[]).map(function(c,i){
    var bar=Math.min(100,Math.round((c.pressure||0)*100));
    return '<tr><td class="rank">'+(i+1)+'</td><td><span class="pill '+(c.kind==="plan"?"ok":"dim")+'">'+(c.kind==="plan"?"套餐":"API")+'</span></td><td><b>'+esc(c.providerName)+'</b><br><span class="muted">'+esc(c.name)+'</span></td><td>'+esc(c.window)+'</td><td class="mono '+(c.available?'good':'bad')+'">'+usd(c.costPerM)+'</td><td><div class="bar"><i style="width:'+bar+'%"></i></div><span class="muted">'+pct(c.pressure)+'</span></td><td class="mono">'+pct(c.quality)+' / '+(c.latencyMs==null?"—":Math.round(c.latencyMs)+"ms")+' / '+(c.reliability==null?"—":pct(c.reliability)+" ("+num(c.samples)+")")+'</td><td>'+(c.available?'<span class="good">可用</span>':'<span class="bad">不可用</span>')+'</td><td class="muted">'+esc(c.nextChange)+'</td><td class="muted">'+esc(c.reason)+'</td></tr>';
  }).join("")||'<tr><td colspan="10" class="muted">暂无候选</td></tr>';

  document.getElementById("providerRows").innerHTML=(d.providers||[]).map(function(p){
    var peak=(p.peak||[]).map(function(w){return "周"+w.days.join(",")+" "+w.start+"-"+w.end;}).join("<br>")||"无";
    return '<tr><td><b>'+esc(p.name)+'</b></td><td class="mono">'+esc(p.timezone)+'</td><td>'+peak+'</td><td>'+pct(p.offPeakDiscount)+'</td><td>'+esc(p.currentWindow)+'</td><td class="muted">'+esc(p.nextChange)+'</td><td>'+esc(p.accountLabel||"—")+'</td><td class="src"><a href="'+esc(p.source)+'" target="_blank">官方</a></td></tr>';
  }).join("")||'<tr><td colspan="8" class="muted">暂无供应商</td></tr>';

  document.getElementById("planRows").innerHTML=(d.plans||[]).map(function(p){
    return '<tr><td><b>'+esc(p.name)+'</b><br><span class="muted">'+esc(p.providerName)+'</span></td><td class="mono">'+(p.monthlyUsd==null?"—":"$"+p.monthlyUsd)+'</td><td class="mono">'+(p.includedUsd==null?"—":"$"+p.includedUsd)+'</td><td>'+pct(p.baseRatio)+'</td><td>'+esc(p.currentWindow)+'</td><td class="muted">'+esc(p.nextChange)+'</td><td>'+pct(p.effectiveRatio)+'</td><td class="mono">'+usd(p.costPerM)+'</td><td class="mono">'+pct(p.quality)+' / '+(p.latencyMs==null?"—":Math.round(p.latencyMs)+"ms")+' / '+(p.reliability==null?"—":pct(p.reliability)+" ("+num(p.samples)+")")+'</td><td>'+(p.available?'<span class="good">可用</span>':'<span class="bad">不可用</span>')+'</td></tr>';
  }).join("")||'<tr><td colspan="10" class="muted">暂无套餐</td></tr>';

  document.getElementById("collectInfo").textContent="最近运行 "+(d.lastRun?fmtT(d.lastRun):"未运行")+" · 官方核验 "+d.lastVerified+" · 数据文件 data/time-pricing.json";
  document.getElementById("collectErrors").textContent=(d.lastErrors||[]).join(" · ")||"采集无错误";
  document.getElementById("foot").textContent="OpenSelect · 线路优化 · 每 30 秒自动刷新";
}
function load(){
  fetch("/api/routes").then(function(r){return r.json();}).then(render).catch(function(e){document.getElementById("hdr").textContent="加载失败："+e.message;});
}
document.getElementById("collectBtn").onclick=function(){
  var b=this; b.disabled=true; document.getElementById("collectMsg").textContent="采集中…";
  fetch("/api/pricing/collect",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(function(r){return r.json();}).then(function(j){
    b.disabled=false;
    document.getElementById("collectMsg").textContent=j.ok?"✓ 采集完成":"采集完成（有错误）";
    load();
  }).catch(function(e){ b.disabled=false; document.getElementById("collectMsg").textContent="失败："+e.message; });
};
load();
setInterval(load,30000);
</script>
</body>
</html>`;
}
