import { expect, test } from "bun:test";
import { buildSpeedAnalysis, type SpeedSample } from "../src/speed_analysis";

const sample = (outputTokens: number, durationMs: number, extra: Partial<SpeedSample> = {}): SpeedSample => ({
  ts: 3600000, model: "m", provider: "p", outputTokens, durationMs, waitMs: 500, attempts: 1, ...extra,
});
test("speed analysis filters short replies and keeps provider/model groups distinct", () => {
  const x = buildSpeedAnalysis([sample(10, 10000), sample(100, 10000, { attempts: 2, waitMs: 9000 }), sample(200, 2000), sample(100, 1000, { provider: "other" })], 100, 3600000);
  expect(x.measuredRequests).toBe(4);
  expect(x.overall.samples).toBe(3);
  expect(x.overall.median).toBe(100);
  expect(x.overall.slowCount).toBe(1);
  expect(x.overall.slowRetryCount).toBe(1);
  expect(x.overall.slowWaitShare).toBe(.9);
  expect(x.overall.histogram.map((b) => b.count)).toEqual([1, 0, 0, 2, 0]);
  expect(x.overall.trend[0]?.tokensPerSecond).toBeCloseTo(400000 / 13000);
  expect(x.byModel.length).toBe(2);
  expect(x.byModel[0]?.samples).toBe(2);
  expect(x.overall.slowRequests[0]?.attempts).toBe(2);
});
test("no data stays unknown, boundary 20 is not slow, chronological buckets", () => {
  const empty = buildSpeedAnalysis([], 100, 3600000).overall;
  expect(empty.median).toBeNull();
  expect(empty.slowShare).toBeNull();
  const x = buildSpeedAnalysis([sample(100, 5000, { ts: 7200000, waitMs: null }), sample(100, 1000)], 0, 3600000).overall;
  expect(x.slowCount).toBe(0);
  expect(x.histogram.map((b) => b.count)).toEqual([0, 1, 0, 1, 0]);
  expect(x.trend.length).toBe(2);
  expect(x.trend[0]!.ts).toBeLessThan(x.trend[1]!.ts);
  expect(x.waitSamples).toBe(1);
});

test("speed trends use local midnight and distinguish repeated daylight-saving hours", () => {
  const moduleUrl = new URL("../src/speed_analysis.ts", import.meta.url).href;
  const run = (timezone: string, times: string[], bucketMs: number) => {
    const source = `import { buildSpeedAnalysis } from ${JSON.stringify(moduleUrl)};
      const rows = ${JSON.stringify(times)}.map((t) => ({ts: Date.parse(t), model:'m', provider:'p', outputTokens:100, durationMs:1000, waitMs:null, attempts:1}));
      console.log(JSON.stringify(buildSpeedAnalysis(rows, 0, ${bucketMs}).overall.trend.map(x => ({ts: new Date(x.ts).toISOString(), count:x.samples}))));`;
    const result = Bun.spawnSync([process.execPath, "-e", source], { env: { ...process.env, TZ: timezone }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()) as Array<{ts: string; count: number}>;
  };
  expect(run("Asia/Shanghai", ["2026-11-05T15:59:00Z", "2026-11-05T16:00:00Z"], 86_400_000)).toEqual([
    { ts: "2026-11-04T16:00:00.000Z", count: 1 }, { ts: "2026-11-05T16:00:00.000Z", count: 1 },
  ]);
  expect(run("America/New_York", ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"], 3_600_000)).toEqual([
    { ts: "2026-11-01T05:00:00.000Z", count: 1 }, { ts: "2026-11-01T06:00:00.000Z", count: 1 },
  ]);
  expect(run("America/New_York", ["2026-03-08T06:59:00Z", "2026-03-09T04:00:00Z"], 86_400_000)).toEqual([
    { ts: "2026-03-08T05:00:00.000Z", count: 1 }, { ts: "2026-03-09T04:00:00.000Z", count: 1 },
  ]);
  expect(run("Australia/Lord_Howe", ["2026-10-03T15:45:00Z"], 3_600_000)).toEqual([
    { ts: "2026-10-03T15:30:00.000Z", count: 1 },
  ]);
});
