export interface SpeedSample {
  ts: number;
  model: string;
  provider: string;
  outputTokens: number;
  durationMs: number;
  waitMs: number | null;
  attempts: number;
  firstContentMs?: number | null;
  generationMs?: number | null;
  retryMs?: number | null;
}

/** Use local calendar boundaries, preserving both occurrences of a repeated DST hour. */
function speedBucketStart(ts: number, bucketMs: number): number {
  const date = new Date(ts);
  if (bucketMs === 86_400_000) {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  if (bucketMs !== 3_600_000) return Math.floor(ts / bucketMs) * bucketMs;

  const offset = date.getTimezoneOffset();
  const shifted = ts - offset * 60_000;
  const candidate = Math.floor(shifted / bucketMs) * bucketMs + offset * 60_000;
  const matches = (value: number) => {
    const d = new Date(value);
    return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() &&
      d.getDate() === date.getDate() && d.getHours() === date.getHours() && d.getTimezoneOffset() === offset;
  };
  if (matches(candidate)) return candidate;
  // Some zones change offset by 30 minutes in the middle of a local hour.
  let low = candidate, high = ts;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (matches(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function summarizeSpeed(samples: SpeedSample[], bucketMs: number) {
  const rates = samples.map((s) => s.outputTokens * 1000 / s.durationMs).sort((a, b) => a - b);
  const percentile = (values: number[], p: number): number | null => {
    if (!values.length) return null;
    const i = (values.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return values[lo]! + (values[hi]! - values[lo]!) * (i - lo);
  };
  const slow = samples.filter((s) => s.outputTokens * 1000 / s.durationMs < 20);
  const retryTimes = samples.flatMap((s) => s.retryMs == null || s.attempts <= 1 ? [] : [s.retryMs]).sort((a,b)=>a-b);
  const contentWaits = samples.flatMap((s) => s.firstContentMs == null ? [] : [s.firstContentMs]).sort((a,b)=>a-b);
  const generationRates = samples.flatMap((s) => s.generationMs != null && s.generationMs > 0 ? [s.outputTokens * 1000 / s.generationMs] : []).sort((a,b)=>a-b);
  const waits = samples.flatMap((s) => s.waitMs == null ? [] : [s.waitMs]).sort((a, b) => a - b);
  const timedSlow = slow.filter((s) => s.waitMs != null);
  const slowDuration = timedSlow.reduce((n, s) => n + s.durationMs, 0);
  const bounds = [0, 20, 50, 100, 150, Infinity];
  const histogram = bounds.slice(0, -1).map((min, i) => ({
    min, max: Number.isFinite(bounds[i + 1]) ? bounds[i + 1]! : null,
    count: rates.filter((v) => v >= min && v < bounds[i + 1]!).length,
  }));
  const buckets = new Map<number, SpeedSample[]>();
  for (const s of samples) {
    const key = speedBucketStart(s.ts, bucketMs);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s);
  }
  return {
    samples: samples.length,
    medianFirstContentMs: percentile(contentWaits, .5), contentTimingSamples: contentWaits.length,
    medianGenerationSpeed: percentile(generationRates, .5), generationSamples: generationRates.length,
    medianRetryMs: percentile(retryTimes, .5), retryTimingSamples: retryTimes.length,
    p10: percentile(rates, .1), median: percentile(rates, .5), p90: percentile(rates, .9),
    slowCount: slow.length, slowShare: samples.length ? slow.length / samples.length : null,
    medianWaitMs: percentile(waits, .5), waitSamples: waits.length,
    retryCount: samples.filter((s) => s.attempts > 1).length,
    slowRetryCount: slow.filter((s) => s.attempts > 1).length,
    slowWaitShare: slowDuration ? timedSlow.reduce((n, s) => n + Math.min(s.waitMs!, s.durationMs), 0) / slowDuration : null,
    histogram,
    trend: [...buckets].sort((a, b) => a[0] - b[0]).map(([ts, xs]) => ({
      ts, samples: xs.length,
      tokensPerSecond: xs.reduce((n, s) => n + s.outputTokens, 0) * 1000 / xs.reduce((n, s) => n + s.durationMs, 0),
    })),
    slowRequests: slow.sort((a, b) => b.ts - a.ts).slice(0, 20).map((s) => ({ ...s, tokensPerSecond: s.outputTokens * 1000 / s.durationMs })),
  };
}

export function buildSpeedAnalysis(samples: SpeedSample[], minimumOutput: number, bucketMs: number) {
  const eligible = samples.filter((s) => s.outputTokens >= minimumOutput);
  const groups = new Map<string, SpeedSample[]>();
  for (const s of eligible) {
    const key = JSON.stringify([s.provider, s.model]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  return {
    minimumOutput, measuredRequests: samples.length,
    overall: summarizeSpeed(eligible, bucketMs),
    byModel: [...groups].map(([key, xs]) => ({ key, provider: xs[0]!.provider, model: xs[0]!.model, ...summarizeSpeed(xs, bucketMs) }))
      .sort((a, b) => b.samples - a.samples),
  };
}
