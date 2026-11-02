import { join } from "node:path";
import { readJson, writeFileAtomic } from "./util";

export const TIME_PRICING_PATH = join(import.meta.dir, "..", "data", "time-pricing.json");

export interface PeakWindow {
  days: number[];
  start: string;
  end: string;
}

export interface ProviderTimeRule {
  id: string;
  name: string;
  timezone: string;
  appliesTo: "api" | "subscription" | "api+subscription" | "none";
  peak: PeakWindow[];
  offPeakDiscount: number;
  note: string;
  source: string;
  confidence: string;
  /** 可配置质量基准分 0–1；不是公开 benchmark，仅用于线路排序。 */
  quality?: number;
  lastChecked?: string;
}

export interface PlanTimeRule {
  id: string;
  provider: string;
  name: string;
  monthlyUsd: number | null;
  includedUsd: number | null;
  baseRatio: number | null;
  timeRule: string;
  /** price：分时直接作用在模型单价（额度是美元上限）；credits：分时作用在 credits 消耗速度。 */
  timeMode?: "price" | "credits" | "none";
  source: string;
}

export interface ScoringConfig {
  pressureWeight: number;
  latencyWeight: number;
  qualityWeight: number;
  reliabilityWeight: number;
  latencyNormalizeMs: number;
}

export interface TimePricingData {
  version: number;
  lastVerified: string;
  lastRun: string | null;
  lastErrors?: string[];
  scoring?: ScoringConfig;
  base: { name: string; usdPerMillion: number };
  providers: ProviderTimeRule[];
  plans: PlanTimeRule[];
}

export interface TimePricingCollectResult {
  ok: boolean;
  lastRun: string;
  updated: string[];
  errors: string[];
  data: TimePricingData;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export async function loadTimePricing(): Promise<TimePricingData> {
  const raw = await readJson<TimePricingData>(TIME_PRICING_PATH, {
    version: 1,
    lastVerified: "",
    lastRun: null,
    base: { name: "DeepSeek 官方 deepseek-flash 非高峰", usdPerMillion: 0.375 },
    providers: [],
    plans: [],
  });
  return {
    ...raw,
    providers: Array.isArray(raw.providers) ? raw.providers : [],
    plans: Array.isArray(raw.plans) ? raw.plans : [],
  };
}

export async function saveTimePricing(data: TimePricingData): Promise<void> {
  await writeFileAtomic(TIME_PRICING_PATH, JSON.stringify(data, null, 2) + "\n", 0o644);
}

export function ruleById(data: TimePricingData, id: string): ProviderTimeRule | undefined {
  return data.providers.find((p) => p.id === id);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const hit = FORMATTERS.get(timezone);
  if (hit) return hit;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  FORMATTERS.set(timezone, fmt);
  return fmt;
}

/** 取指定时区的星期与分钟数（不依赖本机时区）。 */
export function zonedParts(date: Date, timezone: string): { day: number; minutes: number } {
  try {
    const parts = formatterFor(timezone).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const day = WEEKDAY[get("weekday")] ?? 0;
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    return { day, minutes: hour * 60 + minute };
  } catch {
    return { day: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
  }
}

export function isPeak(rule: ProviderTimeRule, date: Date): boolean {
  if (!rule.peak.length) return false;
  const { day, minutes } = zonedParts(date, rule.timezone);
  return rule.peak.some((w) => w.days.includes(day) && minutes >= minutesOf(w.start) && minutes < minutesOf(w.end));
}

export function windowKind(rule: ProviderTimeRule, date: Date): "peak" | "off-peak" | "flat" {
  if (!rule.peak.length) return "flat";
  return isPeak(rule, date) ? "peak" : "off-peak";
}

export function windowLabel(rule: ProviderTimeRule, date: Date): string {
  const k = windowKind(rule, date);
  return k === "peak" ? "高峰" : k === "off-peak" ? "非高峰" : "无分时";
}

export function nextTransition(rule: ProviderTimeRule, date: Date): Date | null {
  if (!rule.peak.length) return null;
  const start = isPeak(rule, date);
  for (let i = 1; i <= 7 * 24 * 60; i++) {
    const t = new Date(date.getTime() + i * 60_000);
    if (isPeak(rule, t) !== start) return t;
  }
  return null;
}

function normalizeText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string): Promise<string> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return normalizeText(await res.text());
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function weekdayPeak(start: string, end: string): PeakWindow[] {
  return [{ days: [1, 2, 3, 4, 5], start, end }];
}

/**
 * 自动采集第 1、2 项：
 * - 供应商 API 的分时窗口
 * - 订阅套餐的分时规则（继承 provider 的 timeRule）
 *
 * 解析失败时保留旧值，不把未验证的窗口写进数据。
 */
export async function collectTimePricing(): Promise<TimePricingCollectResult> {
  const data = await loadTimePricing();
  const now = new Date();
  const updated: string[] = [];
  const errors: string[] = [];

  const patch = async (
    id: string,
    url: string,
    parse: (text: string) => { peak: PeakWindow[]; timezone?: string; offPeakDiscount?: number } | null,
  ): Promise<void> => {
    const p = data.providers.find((x) => x.id === id);
    if (!p) return;
    try {
      const text = await fetchText(url);
      const parsed = parse(text);
      if (!parsed) {
        errors.push(`${id}: 未匹配到分时窗口，保留旧值`);
      } else {
        p.peak = parsed.peak;
        if (parsed.timezone) p.timezone = parsed.timezone;
        if (parsed.offPeakDiscount != null) p.offPeakDiscount = parsed.offPeakDiscount;
        p.lastChecked = now.toISOString();
        p.confidence = "collected";
        updated.push(id);
      }
    } catch (e) {
      errors.push(`${id}: ${String(e)}`);
    }
  };

  await patch("deepseek", "https://api-docs.deepseek.com/quick_start/pricing", (text) => {
    const m = text.match(
      /Peak hours are\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s+and\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})\s+UTC,\s+Monday through Friday/i,
    );
    if (!m) return null;
    return {
      peak: [
        { days: [1, 2, 3, 4, 5], start: m[1]!, end: m[2]! },
        { days: [1, 2, 3, 4, 5], start: m[3]!, end: m[4]! },
      ],
      timezone: "UTC",
      offPeakDiscount: 0.5,
    };
  });

  await patch("ollama", "https://ollama.com/pricing", (text) => {
    const m = text.match(
      /Off-peak pricing apply outside\s+(\d{2}:\d{2})\s+and\s+(\d{2}:\d{2})\s+UTC on weekdays and all day on weekends/i,
    );
    if (!m) return null;
    return { peak: weekdayPeak(m[1]!, m[2]!), timezone: "UTC", offPeakDiscount: 0.5 };
  });

  await patch("zai", "https://docs.z.ai/devpack/overview", (text) => {
    const m = text.match(
      /Peak hours\s*:?\s*Monday to Friday,\s*(\d{2}:\d{2})[–-](\d{2}:\d{2})\s*Singapore Standard Time/i,
    );
    if (!m) return null;
    return { peak: weekdayPeak(m[1]!, m[2]!), timezone: "Asia/Singapore", offPeakDiscount: 0.5 };
  });

  await patch("opencode", "https://opencode.ai/docs/go/", (text) => {
    const m = text.match(
      /DeepSeek V4\.1 Flash \/ V4 Pro:\s*Peak hours are\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s+and\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s+UTC,\s+Monday through Friday/i,
    );
    if (!m) return null;
    return {
      peak: [
        { days: [1, 2, 3, 4, 5], start: m[1]!, end: m[2]! },
        { days: [1, 2, 3, 4, 5], start: m[3]!, end: m[4]! },
      ],
      timezone: "UTC",
      offPeakDiscount: 0.5,
    };
  });

  // 没有公开分时价的供应商：只做可达性检查，保留“无分时”的既有结论。
  for (const [id, url] of [
    ["minimax", "https://platform.minimax.io/docs/guides/pricing"],
    ["commandcode", "https://commandcode.ai/pricing"],
  ] as const) {
    try {
      await fetchText(url);
      const p = data.providers.find((x) => x.id === id);
      if (p) {
        p.lastChecked = now.toISOString();
        p.confidence = "checked";
      }
    } catch (e) {
      errors.push(`${id}: ${String(e)}`);
    }
  }

  data.lastRun = now.toISOString();
  if (errors.length === 0) data.lastVerified = now.toISOString().slice(0, 10);
  data.lastErrors = errors;
  await saveTimePricing(data);
  return { ok: errors.length === 0, lastRun: data.lastRun, updated, errors, data };
}
