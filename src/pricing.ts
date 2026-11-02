/**
 * 首页价格对比表。
 *
 * 基准：DeepSeek 官方 deepseek-flash（非高峰、缓存未命中、输入:输出 = 1:1）。
 * 比例 < 100% = 比 DeepSeek 官方便宜；> 100% = 更贵。
 * 所有数字均来自官方页面，未公布美元额度的套餐不编造比例。
 */
export const PRICING_AS_OF = "2026-10-31";

export const DEEPSEEK_BASE = {
  input: 0.15,
  output: 0.6,
  blended: 0.375,
} as const;

interface PlanRow {
  provider: string;
  plan: string;
  price: string;
  included: string;
  ratio: number | null;
  ratioNote?: string;
  note: string;
}

interface ApiRow {
  provider: string;
  model: string;
  input: string;
  output: string;
  blended: string;
  ratio: number | null;
  ratioNote?: string;
  note: string;
}

function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function ratioClass(n: number | null): string {
  if (n == null) return "muted";
  if (n < 1) return "ratio-good";
  if (n > 1) return "ratio-bad";
  return "ratio-base";
}

function ratioCell(n: number | null, note?: string): string {
  const main = `<span class="${ratioClass(n)}">${pct(n)}</span>`;
  return note ? `${main}<br><span class="muted">${note}</span>` : main;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Z.ai 套餐的 DeepSeek 官方等价月成本。
 *
 * 官方 credit 规则（GLM-5.3-Flash）：输入 2.3、输出 8 credits / 10,000 tokens。
 * 1:1 输入输出时，1M input + 1M output = (2.3 + 8) * 1,000,000 / 10,000 = 1,030 credits。
 * 因此 weeklyCredits / 1030 = 每周可用的「百万 input + 百万 output」对数。
 */
function zaiMonthlyEquivalent(weeklyCredits: number): number {
  const millionPairsPerWeek = weeklyCredits / 1030;
  const weeklyUsd = millionPairsPerWeek * (DEEPSEEK_BASE.input + DEEPSEEK_BASE.output);
  return (weeklyUsd * 52) / 12;
}

function zaiPlan(
  plan: string,
  monthly: number,
  yearly: number,
  weeklyCredits: number,
  note: string,
): PlanRow {
  const equivalent = zaiMonthlyEquivalent(weeklyCredits);
  return {
    provider: "Z.ai",
    plan,
    price: `$${monthly}/月（年付 $${yearly}/月）`,
    included: `${weeklyCredits.toLocaleString("en-US")} credits/周 ≈ $${equivalent.toFixed(1)}/月 DeepSeek 等价`,
    ratio: monthly / equivalent,
    ratioNote: `年付 ${pct(yearly / equivalent)}`,
    note,
  };
}

const PLAN_ROWS: PlanRow[] = [
  {
    provider: "OpenCode",
    plan: "Go",
    price: "$10/月",
    included: "$100/月 DeepSeek V4.1 Flash 额度",
    ratio: 10 / 100,
    note: "官方标注的 DeepSeek V4.1 Flash 月度额度；高峰单价翻倍，比例为非高峰口径",
  },
  {
    provider: "OpenCode",
    plan: "Go Plus",
    price: "$40/月",
    included: "$200/月 DeepSeek V4.1 Flash 额度",
    ratio: 40 / 200,
    note: "官方标注的 DeepSeek V4.1 Flash 月度额度；高峰单价翻倍，比例为非高峰口径",
  },
  {
    provider: "OpenCode",
    plan: "Go Teams",
    price: "$20/人/月",
    included: "$105/人/月 DeepSeek V4.1 Flash 额度",
    ratio: 20 / 105,
    note: "按成员计费；官方标注的 DeepSeek V4.1 Flash 月度额度；高峰单价翻倍",
  },
  {
    provider: "Command Code",
    plan: "Go",
    price: "$1/月 + 处理费",
    included: "$10 额度（促销最高 ~$15 等效）",
    ratio: 1 / 10,
    ratioNote: "促销等效 $15 时 6.7%",
    note: "按模型分配额度；处理费未计入比例",
  },
  {
    provider: "Command Code",
    plan: "GOAT",
    price: "$10/月 + 处理费",
    included: "最高 $100 额度",
    ratio: 10 / 100,
    note: "含 API 访问；处理费未计入比例",
  },
  {
    provider: "Command Code",
    plan: "Pro",
    price: "$20/月 + 处理费",
    included: "最高 $110 额度",
    ratio: 20 / 110,
    note: "处理费未计入比例",
  },
  {
    provider: "Command Code",
    plan: "Max 10×",
    price: "$100/月 + 处理费",
    included: "$150 额度（最高 ~$300 等效）",
    ratio: 100 / 150,
    note: "处理费未计入比例；促销等效 $300 时 33.3%",
  },
  {
    provider: "Command Code",
    plan: "Max 20×",
    price: "$200/月 + 处理费",
    included: "$300 额度",
    ratio: 200 / 300,
    note: "页面未单列等效上限；处理费未计入比例",
  },
  {
    provider: "Command Code",
    plan: "Teams",
    price: "$40/人/月",
    included: "共享额度池，未公布美元额度",
    ratio: null,
    note: "不编造额度比例",
  },
  zaiPlan(
    "Lite",
    18,
    12.6,
    10_000,
    "按官方 credit 公式折算；未计缓存/MCP；DeepSeek 非高峰价",
  ),
  zaiPlan(
    "Pro",
    80,
    56,
    60_000,
    "6× Lite 用量；按官方 credit 公式折算；未计缓存/MCP",
  ),
  zaiPlan(
    "Max",
    168,
    117.6,
    140_000,
    "14× Lite 用量；按官方 credit 公式折算；未计缓存/MCP",
  ),
  {
    provider: "MiniMax",
    plan: "M Plan Go",
    price: "$22/月（年付 $220/年）",
    included: "额度未公布（官方只给 1× 相对值）",
    ratio: null,
    note: "不编造美元额度比例",
  },
  {
    provider: "MiniMax",
    plan: "M Plan Explore",
    price: "$55/月（年付 $550/年）",
    included: "3× Go 用量，未公布美元额度",
    ratio: null,
    note: "不编造美元额度比例",
  },
  {
    provider: "MiniMax",
    plan: "M Plan Build",
    price: "$132/月（年付 $1,320/年）",
    included: "7.5× Go 用量，未公布美元额度",
    ratio: null,
    note: "不编造美元额度比例",
  },
  {
    provider: "Ollama Cloud",
    plan: "Pay as you go",
    price: "$0 + 按 token",
    included: "无订阅额度；按模型单价计费",
    ratio: null,
    note: "3 并发；用多少付多少",
  },
  {
    provider: "Ollama Cloud",
    plan: "Pro",
    price: "$20/月（年付 $16.67/月）",
    included: "$60/月 usage credits",
    ratio: 20 / 60,
    ratioNote: "年付 27.8%",
    note: "3 并发；含较大 Pro 模型",
  },
  {
    provider: "Ollama Cloud",
    plan: "Max",
    price: "$100/月",
    included: "$300/月 usage credits",
    ratio: 100 / 300,
    note: "10 并发；含最新模型 early access",
  },
  {
    provider: "Ollama Cloud",
    plan: "Team",
    price: "$500/月",
    included: "$1,000/月共享 credits",
    ratio: 500 / 1000,
    note: "不限用户；共享额度池",
  },
  {
    provider: "Ollama Cloud",
    plan: "Enterprise",
    price: "定制报价",
    included: "未公布美元额度",
    ratio: null,
    note: "模型访问控制 / 预算 / 专属支持",
  },
];

const API_ROWS: ApiRow[] = [
  {
    provider: "DeepSeek 官方",
    model: "deepseek-flash（非高峰）",
    input: "$0.15",
    output: "$0.60",
    blended: "$0.375",
    ratio: 1,
    note: "基准；缓存命中 $0.003/$0.006（非高峰/高峰）",
  },
  {
    provider: "DeepSeek 官方",
    model: "deepseek-flash（高峰）",
    input: "$0.30",
    output: "$1.20",
    blended: "$0.75",
    ratio: 2,
    note: "高峰时段输入/输出单价翻倍",
  },
  {
    provider: "MiniMax 官方",
    model: "M3.1 Flash",
    input: "$0.15",
    output: "$0.60",
    blended: "$0.375",
    ratio: 1,
    note: "缓存输入 $0.015/M",
  },
  {
    provider: "Z.ai 官方",
    model: "GLM-5.3-Flash",
    input: "$0.15",
    output: "$0.50",
    blended: "$0.325",
    ratio: 0.325 / 0.375,
    note: "按 1:1 输入输出混合；缓存价未计入",
  },
  {
    provider: "Command Code",
    model: "Provider API",
    input: "按上游原价",
    output: "按上游原价",
    blended: "零加价",
    ratio: 1,
    ratioNote: "GLM-5.3-Flash 为 86.7%",
    note: "$15/月平台费 + 处理费；DeepSeek 模型按官方价",
  },
  {
    provider: "Ollama Cloud",
    model: "deepseek-v4.1-flash（标准）",
    input: "$0.30",
    output: "$1.20",
    blended: "$0.75",
    ratio: 2,
    note: "需 API Key；off-peak 为 $0.15/$0.60/$0.375 = 100%",
  },
  {
    provider: "Ollama Cloud",
    model: "deepseek-v4.1-flash（off-peak）",
    input: "$0.15",
    output: "$0.60",
    blended: "$0.375",
    ratio: 1,
    note: "工作日 12:00/18:00 UTC 之外 + 周末",
  },
];

function planTable(): string {
  const rows = PLAN_ROWS.map(
    (r) => `<tr>
<td><b>${esc(r.provider)}</b><br><span class="muted">${esc(r.plan)}</span></td>
<td class="mono">${esc(r.price)}</td>
<td>${esc(r.included)}</td>
<td class="mono">${ratioCell(r.ratio, r.ratioNote)}</td>
<td class="pricing-note-cell">${esc(r.note)}</td>
</tr>`,
  ).join("\n");
  return `<div class="tablewrap"><table class="pricing-table">
<thead><tr><th>供应商 / 套餐</th><th>价格</th><th>内含额度 / 等价用量</th><th>相对 DeepSeek 官方</th><th>说明</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

interface MultiplierRow {
  provider: string;
  plan: string;
  price: string;
  quota: string;
  multiplier: string;
  scope: string;
}

function fmtMultiple(quota: number, price: number): string {
  const n = quota / price;
  return `${Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2).replace(/0$/, "")}×`;
}

const MULTIPLIER_ROWS: MultiplierRow[] = [
  {
    provider: "OpenCode",
    plan: "Go",
    price: "$10/月",
    quota: "$100/月 DeepSeek V4.1 Flash",
    multiplier: fmtMultiple(100, 10),
    scope: "DeepSeek 专用额度（官方标注）",
  },
  {
    provider: "OpenCode",
    plan: "Go Plus",
    price: "$40/月",
    quota: "$200/月 DeepSeek V4.1 Flash",
    multiplier: fmtMultiple(200, 40),
    scope: "DeepSeek 专用额度（官方标注）",
  },
  {
    provider: "OpenCode",
    plan: "Go Teams",
    price: "$20/人/月",
    quota: "$105/人/月 DeepSeek V4.1 Flash",
    multiplier: fmtMultiple(105, 20),
    scope: "DeepSeek 专用额度（官方标注）",
  },
  {
    provider: "Command Code",
    plan: "Go",
    price: "$1/月 + 处理费",
    quota: "$10（促销最高 ~$15 等效）",
    multiplier: `${fmtMultiple(10, 1)}（促销 ${fmtMultiple(15, 1)}）`,
    scope: "通用额度，可跑 DeepSeek；处理费未计入",
  },
  {
    provider: "Command Code",
    plan: "GOAT",
    price: "$10/月 + 处理费",
    quota: "最高 $100",
    multiplier: fmtMultiple(100, 10),
    scope: "通用额度，可跑 DeepSeek；处理费未计入",
  },
  {
    provider: "Command Code",
    plan: "Pro",
    price: "$20/月 + 处理费",
    quota: "最高 $110",
    multiplier: fmtMultiple(110, 20),
    scope: "通用额度，可跑 DeepSeek；处理费未计入",
  },
  {
    provider: "Command Code",
    plan: "Max 10×",
    price: "$100/月 + 处理费",
    quota: "$150（最高 ~$300 等效）",
    multiplier: `${fmtMultiple(150, 100)}（促销 ${fmtMultiple(300, 100)}）`,
    scope: "通用额度，可跑 DeepSeek；处理费未计入",
  },
  {
    provider: "Command Code",
    plan: "Max 20×",
    price: "$200/月 + 处理费",
    quota: "$300",
    multiplier: fmtMultiple(300, 200),
    scope: "通用额度，可跑 DeepSeek；处理费未计入",
  },
  {
    provider: "Ollama Cloud",
    plan: "Pay as you go",
    price: "$0 + 按 token",
    quota: "无订阅额度",
    multiplier: "—",
    scope: "按量计费，无返还倍数；可跑 DeepSeek",
  },
  {
    provider: "Ollama Cloud",
    plan: "Pro",
    price: "$20/月",
    quota: "$60/月 credits",
    multiplier: fmtMultiple(60, 20),
    scope: "通用额度，可跑 DeepSeek；年付 $16.67 时 3.6×",
  },
  {
    provider: "Ollama Cloud",
    plan: "Max",
    price: "$100/月",
    quota: "$300/月 credits",
    multiplier: fmtMultiple(300, 100),
    scope: "通用额度，可跑 DeepSeek",
  },
  {
    provider: "Ollama Cloud",
    plan: "Team",
    price: "$500/月",
    quota: "$1,000/月共享 credits",
    multiplier: fmtMultiple(1000, 500),
    scope: "通用额度，可跑 DeepSeek；团队共享",
  },
];

function multiplierTable(): string {
  const rows = MULTIPLIER_ROWS.map(
    (r) => `<tr>
<td><b>${esc(r.provider)}</b><br><span class="muted">${esc(r.plan)}</span></td>
<td class="mono">${esc(r.price)}</td>
<td>${esc(r.quota)}</td>
<td class="mono"><span class="ratio-good">${esc(r.multiplier)}</span></td>
<td class="pricing-note-cell">${esc(r.scope)}</td>
</tr>`,
  ).join("\n");
  return `<div class="tablewrap"><table class="pricing-table">
<thead><tr><th>订阅</th><th>月费</th><th>可用于 DeepSeek 的额度</th><th>额度倍数</th><th>口径</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

function apiTable(): string {
  const rows = API_ROWS.map(
    (r) => `<tr>
<td><b>${esc(r.provider)}</b><br><span class="muted">${esc(r.model)}</span></td>
<td class="mono">${esc(r.input)}</td>
<td class="mono">${esc(r.output)}</td>
<td class="mono">${esc(r.blended)}</td>
<td class="mono">${ratioCell(r.ratio, r.ratioNote)}</td>
<td class="pricing-note-cell">${esc(r.note)}</td>
</tr>`,
  ).join("\n");
  return `<div class="tablewrap"><table class="pricing-table">
<thead><tr><th>供应商 / 模型</th><th>输入 / M</th><th>输出 / M</th><th>1:1 混合 / M</th><th>相对 DeepSeek 官方</th><th>说明</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

const SOURCES: Array<[string, string]> = [
  ["DeepSeek 官方 API 定价", "https://api-docs.deepseek.com/quick_start/pricing"],
  ["OpenCode Go 官方文档", "https://opencode.ai/docs/go/"],
  ["Command Code 定价", "https://commandcode.ai/pricing"],
  ["Z.ai 订阅页", "https://z.ai/subscribe"],
  ["Z.ai credit 规则", "https://docs.z.ai/devpack/overview"],
  ["Z.ai GLM-5.3-Flash 价格", "https://z.ai/blog/glm-5.3-flash"],
  ["MiniMax M Plan", "https://www.minimax.io/m-plan"],
  ["MiniMax API 定价", "https://platform.minimax.io/docs/pricing/overview"],
  ["Ollama Cloud 定价", "https://ollama.com/pricing"],
];

export function pricingTablesHtml(): string {
  const sources = SOURCES.map(
    ([name, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a>`,
  ).join(" · ");
  return `<div class="pricing">
<div class="pricing-banner"><b>基准：DeepSeek 官方 API = 100%</b><br>
deepseek-flash 非高峰、缓存未命中、输入:输出 = 1:1，混合价 $0.375/M。比例 = 实际支付价格 ÷ 同等用量按 DeepSeek 官方 API 计算的金额；低于 100% 表示更便宜，高于 100% 表示更贵。</div>
<h3>套餐（订阅制）</h3>
${planTable()}
<div class="more">套餐比例 = 月费 ÷ 内含额度按上述基准折算的美元价值。年付比例见括号。未公布美元额度的套餐标为「—」，不编造。Ollama Cloud 需要 API Key，按量或订阅 credits 计费；本地 Ollama 已移除。</div>
<h3>DeepSeek 订阅额度倍数</h3>
${multiplierTable()}
<div class="more">倍数 = 可用于 DeepSeek 的额度 ÷ 月费。OpenCode Go 是官方标注的 DeepSeek V4.1 Flash 专用额度；Command Code、Ollama Cloud 是通用模型额度，可跑 DeepSeek，但不是 DeepSeek 专用。Z.ai / MiniMax 不含 DeepSeek，未列入本表；DeepSeek 官方 API 是按量计费，没有订阅返还。</div>
<h3>API（按量计费）</h3>
${apiTable()}
<div class="more">API 比例 = 1:1 混合单价 ÷ $0.375/M。缓存命中、阶梯价、处理费、税费未计入；实际账单以官方为准。</div>
<div class="pricing-sources"><b>数据截至 ${PRICING_AS_OF}：</b>${sources}<br>
价格可能变化，购买前请以官方页面为准。</div>
</div>`;
}
