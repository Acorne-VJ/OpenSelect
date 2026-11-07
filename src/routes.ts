import { PAGE_LOCALE } from "./page_locale";
import { recentRequests, tokenStatsByProvider } from "./db";
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
import { codingAutoOrder, type CodingAutoStep } from "./coding_auto";
import { ROUTE_CAPABILITIES } from "./route_capabilities";
import { clientModelProfile } from "./client_profile";

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
  const a = eligible.find((account) => account.id === rt.forcedAccountId) ?? eligible[0]!;
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
  proxyPort: number;
  codingAutoOrder: CodingAutoStep[];
  routeCapabilities: typeof ROUTE_CAPABILITIES;
  clientProfile: ReturnType<typeof clientModelProfile>;
  routingMode: string;
  timezone: string;
  base: TimePricingData["base"];
  scoring: ScoringConfig;
  best: RouteCandidate | null;
  preferredAccount: { id: string; label: string } | null;
  lastRequest: { accountLabel: string | null; requestedModel: string | null; servedModel: string | null; status: number; ts: number } | null;
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
  const ranked = candidates.slice()
    .sort((a, b) => (a.available === b.available ? a.score - b.score : a.available ? -1 : 1));
  const best = ranked.find((c) => c.available && (!forcedHasCostCandidate || c.provider === forcedProvider)) ?? null;
  const last = recentRequests(1)[0];
  const lastAccount = last ? rt.config.accounts.find((a) => a.id === last.accountId) : undefined;
  return {
    now: now.getTime(),
    proxyPort: rt.config.proxy.port,
    codingAutoOrder: codingAutoOrder(rt.config.policy.codingAutoOrder),
    routeCapabilities: ROUTE_CAPABILITIES,
    clientProfile: clientModelProfile(rt),
    routingMode: rt.config.policy.routingMode ?? "manual",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    base: data.base,
    scoring,
    best,
    preferredAccount: forced ? { id: forced.id, label: forced.label } : null,
    lastRequest: last ? { accountLabel: lastAccount?.label ?? null, requestedModel: last.model, servedModel: last.servedModel ?? null, status: last.status, ts: last.ts } : null,
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
  #commandCard .fr label { flex-basis:150px; }
  #commandCard .fr code { flex:1 1 300px; min-width:0; overflow-wrap:anywhere; }
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

  <div class="card" id="routeContext" role="status"></div>
  <div class="card" style="margin-top:14px">
    <h2 style="margin-top:0" id="orderTitle"></h2>
    <p class="muted" id="orderHelp"></p>
    <div id="orderRows"></div>
    <div class="fr"><label id="modeLabel">排序模式</label><select id="routeMode"><option value="manual">Manual</option><option value="speed">Speed</option><option value="cost">Reference cost</option><option value="stable">Stability</option></select></div>
    <div class="btnrow"><button type="button" class="btn primary" id="orderSave"></button><span class="msg" id="orderMsg" role="status"></span></div>
    <h3 id="capabilityTitle"></h3>
    <p class="muted" id="capabilityHelp"></p>
    <div class="tablewrap"><table><thead id="capabilityHead"></thead><tbody id="capabilityRows"></tbody></table></div>
  </div>
  <div class="card" style="margin-top:14px">
    <h2 id="previewTitle">线路预览</h2>
    <p class="muted" id="previewHelp"></p>
    <div class="fr"><label>Thinking</label><select id="previewThinking"><option value="unspecified">Default</option><option value="on">On</option><option value="off">Off</option></select>
      <label>Image</label><select id="previewImage"><option value="">None</option><option value="base64">Base64</option><option value="url">URL</option><option value="file">File</option></select>
      <label>Context</label><input id="previewContext" type="number" min="1" value="1000000" style="width:130px">
      <label>Client</label><select id="previewClient"><option value="other">Other</option><option value="claude-code">Claude Code</option><option value="opencode">OpenCode</option></select>
      <label>Session</label><input id="previewSession" placeholder="Optional" style="width:150px">
      <button class="btn" id="previewRun">预览</button></div>
    <p id="previewResult" role="status"></p><div class="tablewrap"><table><thead id="previewHead"></thead><tbody id="previewRows"></tbody></table></div>
  </div>
  <div class="card" id="commandCard" style="margin-top:14px">
    <h2 style="margin-top:0" id="commandTitle">客户端启动命令</h2>
    <p class="muted" id="commandHelp"></p>
    <div class="fr"><label>Claude Code · auto-cli</label><code id="autoCommand"></code><button type="button" class="btn sm" data-copy-command="autoCommand">复制</button></div>
    <div class="fr"><label>Pi · pi-auto</label><code id="piCommand"></code><button type="button" class="btn sm" data-copy-command="piCommand">复制</button></div>
    <div class="fr"><label>OpenCode · opencode-auto</label><code id="opencodeCommand"></code><button type="button" class="btn sm" data-copy-command="opencodeCommand">复制</button></div>
    <div class="fr"><label>Hermes · hermes-auto</label><code id="hermesCommand"></code><button type="button" class="btn sm" data-copy-command="hermesCommand">复制</button></div>
    <div class="fr"><label>DeepSeek</label><code id="deepseekCommand"></code><button type="button" class="btn sm" data-copy-command="deepseekCommand">复制</button></div>
    <p class="muted" id="commandNotice" role="status"></p>
  </div>
  <div class="cards">
    <div class="card green"><div class="lbl"><span>建议线路</span><span class="pill" id="bestPill">—</span></div><div class="big" id="bestName">—</div><div class="sub" id="bestSub">加载中…</div></div>
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
function routeText(value){
  if(osLang!=="en" || value==null) return value;
  var text=String(value);
  var labels={"高峰":"Peak","非高峰":"Off-peak","无分时":"No time window","无分时切换":"No scheduled change","当前高峰":"Currently peak","无分时价格":"No time-based pricing","套餐额度；无分时折扣":"Plan credit; no off-peak discount"};
  if(labels[text]) return labels[text];
  return text.replace(/^当前非高峰，按 ([0-9]+)% 价格$/, "Currently off-peak; price $1%")
    .replace(/^套餐额度；当前非高峰，credits ([0-9]+)%$/, "Plan credit; off-peak credits $1%")
    .replace(/^套餐额度；当前(高峰|非高峰)，模型单价 (翻倍|标准)$/, function(_,w,p){return "Plan credit; "+(w==="高峰"?"peak":"off-peak")+"; model price "+(p==="翻倍"?"doubled":"standard");})
    .replace(/^套餐额度；当前(高峰|非高峰)$/,function(_,w){return "Plan credit; "+(w==="高峰"?"peak":"off-peak");});
}
function providerName(id, name){
  return id==="deepseek" && name==="DeepSeek 官方" ? osT("DeepSeek 官方","DeepSeek official") : name;
}
var orderRows=null, modeInitialized=false;
var orderLabels={zai:"Z.ai · GLM-5.3-Flash",minimax:"MiniMax · M3.1-Flash",opencode:"OpenCode Go · DeepSeek V4.1 Flash",deepseek:"DeepSeek API · DeepSeek Flash"};
function renderOrder(){
  document.getElementById("orderTitle").textContent=osT("coding-auto 线路优先级","coding-auto route priority");
  document.getElementById("orderHelp").textContent=osT("手动模式按此顺序尝试；自动模式把此顺序用于同分优先级。额度达到阈值或不可用时回退。至少选择一条，保存后对新请求生效。","Manual mode follows this order; automatic modes use it to break ties. Unavailable routes or accounts at their threshold fall back. Select at least one; saving affects new requests.");
  document.getElementById("orderSave").textContent=osT("保存线路顺序","Save route order");
  document.getElementById("orderRows").innerHTML=orderRows.map(function(row,index){return '<div class="fr"><input type="checkbox" data-order-toggle="'+row.id+'"'+(row.enabled?' checked':'')+' aria-label="'+esc(osT('启用 ','Enable ')+orderLabels[row.id])+'"><span>'+(index+1)+'. '+esc(orderLabels[row.id])+'</span><button type="button" class="btn sm" data-order-move="'+row.id+'" data-dir="-1" aria-label="'+esc(osT('上移 ','Move up ')+orderLabels[row.id])+'"'+(index===0?' disabled':'')+'>↑</button><button type="button" class="btn sm" data-order-move="'+row.id+'" data-dir="1" aria-label="'+esc(osT('下移 ','Move down ')+orderLabels[row.id])+'"'+(index===orderRows.length-1?' disabled':'')+'>↓</button></div>';}).join('');
}
function previewReason(value){
  var labels={ok:['正常','Eligible'],disabled:['已停用','Disabled'],'invalid-key':['密钥失效','Invalid key'],cooldown:['冷却中','Cooling down'],'rate-limited':['已限流','Rate limited'],'over-threshold':['达到切换阈值','At switch threshold'],'fallback-only':['仅兜底账号','Fallback-only account'],'model-not-enabled':['账号未启用此模型','Model not enabled'],'model-denied':['模型暂不可用','Model temporarily denied'],forced:['手动首选','Manual preference'],'client-pinned':['接入指定','Client preference'],sticky:['会话亲和','Session affinity'],'least-pressure':['最低压力','Lowest pressure'],'图片来源类型未验证或不支持':['图片来源未验证或不支持','Image source unsupported or unverified'],'关闭思考未验证或不支持':['不支持关闭思考','Thinking off unsupported'],'不满足客户端要求的上下文容量':['上下文容量不足或未知','Required context unavailable']};
  var pair=labels[value];return pair?osT(pair[0],pair[1]):value;
}
function render(d){
  document.getElementById("modeLabel").textContent=osT("排序模式","Ordering mode");
  var modeSelect=document.getElementById("routeMode");
  if(!modeInitialized){modeSelect.value=d.routingMode||"manual";modeInitialized=true;}
  Array.from(modeSelect.options||[]).forEach(function(o){o.textContent={manual:osT('手动顺序','Manual order'),speed:osT('速度优先','Speed first'),cost:osT('参考成本优先','Reference cost first'),stable:osT('稳定优先','Stability first')}[o.value];});
  document.getElementById("previewTitle").textContent=osT("线路预览（只读）","Route preview (read-only)");
  document.getElementById("previewRun").textContent=osT("预览已保存设置","Preview saved settings");
  document.getElementById("previewHead").innerHTML='<tr>'+[osT('线路','Route'),osT('状态','State'),osT('选择依据','Selection'),osT('账号状态','Account status'),osT('得分（越小越优）· 样本','Score (lower is better) · samples')].map(function(t){return '<th>'+esc(t)+'</th>';}).join('')+'</tr>';
  document.getElementById("previewHelp").textContent=osT("按已保存设置和当前账号状态预览；不调用模型、不扣额度、不绑定会话。自动排序只在已启用且兼容的线路中生效；速度与稳定性需要最近30分钟至少5个样本，速度得分包含失败惩罚；排序至少保持60秒，改善不足15%不切换。成本是目录单价按输入80%/输出20%的参考值，不含套餐和缓存优惠，不是实际账单。实际请求仍会重新检查状态。","Uses saved settings and current account state. No model calls, credits, or session changes. Automatic ordering uses enabled compatible routes; speed/stability need 5 samples in 30 minutes; speed scores penalize failures. Order holds for 60 seconds and changes only for at least 15% improvement. Cost uses catalogue rates at 80% input/20% output, excluding plan/cache discounts; not a bill. Live requests recheck state.");
  document.getElementById("capabilityTitle").textContent=osT("请求能力检查","Request capability checks");
  document.getElementById("capabilityHelp").textContent=osT("coding-auto 会跳过不满足图片或 Thinking 要求的线路。上下文列是容量元数据，不是本次请求的实际 token 数；可用 x-openselect-context-window 请求头指定所需容量（例如 1000000），或使用 coding-auto[1m]。实际占用仍由上游校验，不会删除图片或截断消息。未验证的图片来源会跳过。","coding-auto skips routes incompatible with image or Thinking requirements. Context is capacity metadata, not the actual prompt token count. Set x-openselect-context-window (e.g. 1000000), or use coding-auto[1m], to require a capacity. The upstream validates actual usage; images and messages are never removed to make a request fit. Unverified image sources are skipped.");
  document.getElementById("capabilityHead").innerHTML='<tr>'+[osT('线路','Route'),osT('图片来源','Image sources'),'Thinking',osT('关闭 Thinking','Thinking off'),osT('上下文容量','Context capacity')].map(function(s){return '<th>'+esc(s)+'</th>';}).join('')+'</tr>';
  var caps=d.routeCapabilities||{};
  document.getElementById("capabilityRows").innerHTML=Object.keys(caps).map(function(id){var c=caps[id];function support(v){return v===true?osT('支持','Supported'):v===false?osT('不支持','Unsupported'):osT('未验证','Unverified');}return '<tr><td title="'+esc(c.source)+'">'+esc(orderLabels[id]||id)+'</td><td>'+esc(Array.isArray(c.imageSources)?c.imageSources.join(', '):osT('未验证','Unverified'))+'</td><td>'+support(c.thinking)+'</td><td>'+support(c.thinkingDisabled)+'</td><td>'+esc(c.contextTokens==null?osT('未知','Unknown'):Number(c.contextTokens).toLocaleString())+'</td></tr>';}).join('');
  document.getElementById("hdr").textContent=osT("当前 ","Now ")+fmtT(d.now)+osT(" · 本机时区 "," · Local time zone ")+d.timezone+osT(" · 基准 "," · Baseline ")+usd(d.base.usdPerMillion)+"/M";
  var prefix="env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u OPENAI_BASE_URL NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 ANTHROPIC_BASE_URL=http://127.0.0.1:"+d.proxyPort+" ANTHROPIC_AUTH_TOKEN=openselect claude --model ";
  document.getElementById("commandTitle").textContent=osT("客户端启动命令","Client launch commands");
  document.getElementById("commandHelp").textContent=osT("复制并粘贴命令到终端，再输入对应名称启动；命令仅在当前终端生效，使用 coding-auto 和上方已保存的线路。Pi 和 Hermes 使用 ~/.config/openselect 下独立的客户端配置及会话，不会使用原有客户端的设置和会话。OpenCode 命令适用于 v2。", "Paste a command into your terminal, then run its name. Commands last for the current shell and use coding-auto with the saved routes above. Pi and Hermes use separate client settings and sessions under ~/.config/openselect, not their existing settings and sessions. The OpenCode command requires v2.");
  document.getElementById("autoCommand").textContent="alias auto-cli='"+prefix+'"coding-auto[1m]"'+"'";
  var base="http://127.0.0.1:"+d.proxyPort;
  var profile=d.clientProfile||{id:"coding-auto",name:"Coding Auto",contextWindow:1000000,maxTokens:32768,input:["text","image"],reasoning:true};
  var contextHeaders=profile.contextWindow?{'x-openselect-context-window':String(profile.contextWindow)}:{};
  var piConfig=JSON.stringify({providers:{openselect:{baseUrl:base,api:"anthropic-messages",apiKey:"openselect",headers:contextHeaders,models:[Object.assign({},profile,{thinkingLevelMap:{max:"max"},compat:{forceAdaptiveThinking:true,allowEmptySignature:true}})]}}});
  var openConfig=JSON.stringify({provider:{openselect:{npm:"@ai-sdk/anthropic",name:"OpenSelect",options:{baseURL:base+"/v1",apiKey:"openselect",headers:contextHeaders},models:{"coding-auto":{name:profile.name,reasoning:profile.reasoning,modalities:{input:profile.input,output:["text"]},limit:{context:profile.contextWindow,output:profile.maxTokens}}}}},model:"openselect/coding-auto"});
  var hermesConfig=JSON.stringify({model:{provider:"custom:openselect",default:profile.id,supports_vision:profile.input.indexOf("image")>=0,context_length:profile.contextWindow},providers:{openselect:{api:base,api_key:"openselect",transport:"anthropic_messages",default_model:profile.id}}});
  document.getElementById("piCommand").textContent="mkdir -p \\\"$HOME/.config/openselect/pi\\\" && printf %s '"+piConfig+"' > \\\"$HOME/.config/openselect/pi/models.json\\\" && pi-auto() { PI_CODING_AGENT_DIR=\\\"$HOME/.config/openselect/pi\\\" pi --provider openselect --model coding-auto \\\"$@\\\"; }";
  document.getElementById("opencodeCommand").textContent="opencode-auto() { OPENCODE_CONFIG_CONTENT='"+openConfig+"' opencode mini --standalone --model openselect/coding-auto \\\"$@\\\"; }";
  document.getElementById("hermesCommand").textContent="hermes-auto() { mkdir -p \\\"$HOME/.config/openselect/hermes\\\" && printf %s '"+hermesConfig+"' > \\\"$HOME/.config/openselect/hermes/config.yaml\\\" && HERMES_HOME=\\\"$HOME/.config/openselect/hermes\\\" hermes --provider custom:openselect --model coding-auto \\\"$@\\\"; }";
  document.getElementById("deepseekCommand").textContent=prefix+"'deepseek-v4.1-flash[1m]'";
  if(!orderRows){var active=d.codingAutoOrder||[]; orderRows=active.map(function(id){return {id:id,enabled:true};}).concat(Object.keys(orderLabels).filter(function(id){return active.indexOf(id)<0;}).map(function(id){return {id:id,enabled:false};})); renderOrder();}
  var last=d.lastRequest;
  document.getElementById("routeContext").textContent=osT("请求按已保存的排序模式执行；下方成本排行仅供参考。首选账号：","Requests follow the saved ordering mode; the cost rankings below are advisory. Preferred account: ")+(d.preferredAccount?d.preferredAccount.label:osT("未设置","None"))+osT("。最近一次请求：",". Last request: ")+(last?(last.accountLabel||osT("未落账号","Unassigned"))+" · "+(last.requestedModel||"—")+(last.servedModel && last.servedModel!==last.requestedModel?" → "+last.servedModel:"")+" · HTTP "+last.status+" · "+fmtT(last.ts):osT("暂无","None"));
  var b=d.best;
  if(b){
    document.getElementById("bestName").textContent=providerName(b.provider,b.providerName)+(b.kind==="plan"?" · "+b.name:"");
    document.getElementById("bestPill").textContent=b.kind==="plan"?osT("套餐","Plan"):"API";
    document.getElementById("bestSub").textContent=routeText(b.window)+" · "+(b.accountLabel||osT("无账号","No account"))+osT(" · 压力 "," · Pressure ")+pct(b.pressure)+osT(" · 质量 "," · Quality ")+pct(b.quality)+osT(" · 延迟 "," · Latency ")+(b.latencyMs==null?osT("无样本","No samples"):Math.round(b.latencyMs)+"ms")+osT(" · 可靠 "," · Reliability ")+(b.reliability==null?osT("无样本","No samples"):pct(b.reliability)+" ("+num(b.samples)+")");
    document.getElementById("bestCost").textContent=usd(b.costPerM);
    document.getElementById("bestReason").textContent=routeText(b.reason);
  } else {
    document.getElementById("bestName").textContent=osT("无可用线路","No available route");
    document.getElementById("bestPill").textContent="—";
    document.getElementById("bestSub").textContent=osT("检查账号启用/冷却/额度","Check account status, cooldown, and quota");
    document.getElementById("bestCost").textContent="—";
    document.getElementById("bestReason").textContent="—";
  }
  document.getElementById("windowName").textContent=b?routeText(b.window):"—";
  document.getElementById("windowPill").textContent=osT("建议线路","Suggested route");
  document.getElementById("nextChange").textContent=(d.providers||[]).filter(function(p){return p.nextChange && p.nextChange!=="无分时切换";}).slice(0,2).map(function(p){return providerName(p.id,p.name)+" "+routeText(p.nextChange);}).join(" · ")||osT("无分时切换","No scheduled change");
  document.getElementById("collectCount").textContent=(d.lastErrors&&d.lastErrors.length)?osT("有错误","Errors"):osT("正常","Healthy");
  document.getElementById("collectPill").textContent=d.lastRun?osT("已采集","Collected"):osT("未运行","Not run");
  document.getElementById("collectSub").textContent=osT("最近 ","Last run ")+(d.lastRun?fmtT(d.lastRun):osT("未运行","Not run"))+osT(" · 官方核验 "," · Verified ")+d.lastVerified+osT(" · 错误 "," · Errors ")+(d.lastErrors||[]).length;

  document.getElementById("candidateRows").innerHTML=(d.candidates||[]).map(function(c,i){
    var bar=Math.min(100,Math.round((c.pressure||0)*100));
    return '<tr><td class="rank">'+(i+1)+'</td><td><span class="pill '+(c.kind==="plan"?"ok":"dim")+'">'+(c.kind==="plan"?osT("套餐","Plan"):"API")+'</span></td><td><b>'+esc(providerName(c.provider,c.providerName))+'</b><br><span class="muted">'+esc(c.name)+'</span></td><td>'+esc(routeText(c.window))+'</td><td class="mono '+(c.available?'good':'bad')+'">'+usd(c.costPerM)+'</td><td><div class="bar"><i style="width:'+bar+'%"></i></div><span class="muted">'+pct(c.pressure)+'</span></td><td class="mono">'+pct(c.quality)+' / '+(c.latencyMs==null?"—":Math.round(c.latencyMs)+"ms")+' / '+(c.reliability==null?"—":pct(c.reliability)+" ("+num(c.samples)+")")+'</td><td>'+(c.available?'<span class="good">'+osT('可用','Available')+'</span>':'<span class="bad">'+osT('不可用','Unavailable')+'</span>')+'</td><td class="muted">'+esc(routeText(c.nextChange))+'</td><td class="muted">'+esc(routeText(c.reason))+'</td></tr>';
  }).join("")||'<tr><td colspan="10" class="muted">'+osT('暂无候选','No candidates')+'</td></tr>';

  document.getElementById("providerRows").innerHTML=(d.providers||[]).map(function(p){
    var peak=(p.peak||[]).map(function(w){return osT("周","Days ")+w.days.join(",")+" "+w.start+"-"+w.end;}).join("<br>")||osT("无","None");
    return '<tr><td><b>'+esc(providerName(p.id,p.name))+'</b></td><td class="mono">'+esc(p.timezone)+'</td><td>'+peak+'</td><td>'+pct(p.offPeakDiscount)+'</td><td>'+esc(routeText(p.currentWindow))+'</td><td class="muted">'+esc(routeText(p.nextChange))+'</td><td>'+esc(p.accountLabel||"—")+'</td><td class="src"><a href="'+esc(p.source)+'" target="_blank">'+osT("官方","Official")+'</a></td></tr>';
  }).join("")||'<tr><td colspan="8" class="muted">'+osT('暂无供应商','No providers')+'</td></tr>';

  document.getElementById("planRows").innerHTML=(d.plans||[]).map(function(p){
    return '<tr><td><b>'+esc(p.name)+'</b><br><span class="muted">'+esc(providerName(p.provider,p.providerName))+'</span></td><td class="mono">'+(p.monthlyUsd==null?"—":"$"+p.monthlyUsd)+'</td><td class="mono">'+(p.includedUsd==null?"—":"$"+p.includedUsd)+'</td><td>'+pct(p.baseRatio)+'</td><td>'+esc(routeText(p.currentWindow))+'</td><td class="muted">'+esc(routeText(p.nextChange))+'</td><td>'+pct(p.effectiveRatio)+'</td><td class="mono">'+usd(p.costPerM)+'</td><td class="mono">'+pct(p.quality)+' / '+(p.latencyMs==null?"—":Math.round(p.latencyMs)+"ms")+' / '+(p.reliability==null?"—":pct(p.reliability)+" ("+num(p.samples)+")")+'</td><td>'+(p.available?'<span class="good">'+osT('可用','Available')+'</span>':'<span class="bad">'+osT('不可用','Unavailable')+'</span>')+'</td></tr>';
  }).join("")||'<tr><td colspan="10" class="muted">'+osT('暂无套餐','No plans')+'</td></tr>';

  document.getElementById("collectInfo").textContent=osT("最近运行 ","Last run ")+(d.lastRun?fmtT(d.lastRun):osT("未运行","Not run"))+osT(" · 官方核验 "," · Verified ")+d.lastVerified+osT(" · 数据文件 data/time-pricing.json"," · Data file data/time-pricing.json");
  document.getElementById("collectErrors").textContent=(d.lastErrors||[]).join(" · ")||osT("采集无错误","No collection errors");
  document.getElementById("foot").textContent=osT("OpenSelect · 线路优化 · 每 30 秒自动刷新","OpenSelect · Route optimization · Refreshes every 30 seconds");
}
document.querySelectorAll("[data-copy-command]").forEach(function(button){
  button.addEventListener("click",function(){
    var command=document.getElementById(button.getAttribute("data-copy-command")).textContent;
    var notice=document.getElementById("commandNotice");
    if(!navigator.clipboard || !navigator.clipboard.writeText){ notice.textContent=osT("无法自动复制，请手动选择命令复制。","Clipboard unavailable; select and copy the command manually."); return; }
    navigator.clipboard.writeText(command).then(function(){notice.textContent=osT("命令已复制","Command copied");}).catch(function(){notice.textContent=osT("无法自动复制，请手动选择命令复制。","Clipboard unavailable; select and copy the command manually.");});
  });
});
document.getElementById("orderRows").addEventListener("change",function(event){
  var id=event.target.getAttribute("data-order-toggle"); if(!id) return;
  var row=orderRows.find(function(item){return item.id===id;}); if(row) row.enabled=event.target.checked;
});
document.getElementById("orderRows").addEventListener("click",function(event){
  var id=event.target.getAttribute("data-order-move"); if(!id) return;
  var index=orderRows.findIndex(function(item){return item.id===id;}), to=index+Number(event.target.getAttribute("data-dir"));
  if(index<0||to<0||to>=orderRows.length) return;
  var temp=orderRows[index]; orderRows[index]=orderRows[to]; orderRows[to]=temp; renderOrder();
});
document.getElementById("orderSave").addEventListener("click",function(){
  var button=this, msg=document.getElementById("orderMsg"), order=orderRows.filter(function(row){return row.enabled;}).map(function(row){return row.id;});
  if(!order.length){msg.textContent=osT("请至少选择一条线路","Select at least one route");return;}
  button.disabled=true;
  fetch("/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({codingAutoOrder:order,routingMode:document.getElementById('routeMode').value})})
    .then(function(r){return r.json().then(function(j){if(!r.ok||!j.ok) throw new Error(j.error||"save failed");});})
    .then(function(){msg.textContent=osT("已保存，新请求生效","Saved; applies to new requests");})
    .catch(function(e){msg.textContent=osT("保存失败：","Save failed: ")+e.message;})
    .finally(function(){button.disabled=false;});
});
document.getElementById("previewRun").addEventListener("click",function(){
  var query=new URLSearchParams({thinking:document.getElementById('previewThinking').value,image:document.getElementById('previewImage').value,context:document.getElementById('previewContext').value,client:document.getElementById('previewClient').value,session:document.getElementById('previewSession').value});
  fetch('/api/routes/preview?'+query).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'Preview failed');return d;});}).then(function(d){
    document.getElementById('previewResult').textContent=osT('当前首条可用线路：','First available route: ')+(d.selectedRoute?orderLabels[d.selectedRoute]:osT('无','None'))+(d.held?osT(' · 防抖保持当前首选',' · Holding current preference'):'');
    document.getElementById('previewRows').innerHTML=d.rows.map(function(r,i){return '<tr><td>'+(i+1)+'. '+esc(orderLabels[r.route])+'</td><td>'+esc(r.available?osT('可尝试','Eligible'):osT('跳过','Skip'))+'</td><td>'+esc(r.reasons.map(previewReason).join(' / ')||previewReason(r.selectionReason)||osT('无可用账号','No eligible account'))+'</td><td>'+esc(r.accounts.map(function(a){return (a.id===r.selectedAccount?'✓ ':'')+a.label+': '+previewReason(a.reason)+' ('+(a.pressure*100).toFixed(1)+'%)';}).join(' / '))+'</td><td>'+esc(r.score==null?osT('样本不足/未知','Insufficient samples/unknown'):Number(r.score).toFixed(4))+' · '+r.samples+'</td></tr>';}).join('');
  }).catch(function(e){document.getElementById('previewResult').textContent=e.message;});
});
function load(){
  fetch("/api/routes").then(function(r){return r.json();}).then(render).catch(function(e){document.getElementById("hdr").textContent=osT("加载失败：","Load failed: ")+e.message;});
}
document.getElementById("collectBtn").onclick=function(){
  var b=this; b.disabled=true; document.getElementById("collectMsg").textContent=osT("采集中…","Collecting…");
  fetch("/api/pricing/collect",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(function(r){return r.json();}).then(function(j){
    b.disabled=false;
    document.getElementById("collectMsg").textContent=j.ok?osT("✓ 采集完成","✓ Collection complete"):osT("采集完成（有错误）","Collection complete (with errors)");
    load();
  }).catch(function(e){ b.disabled=false; document.getElementById("collectMsg").textContent=osT("失败：","Failed: ")+e.message; });
};
load();
setInterval(load,30000);
</script>
${PAGE_LOCALE}
</body>
</html>`;
}
