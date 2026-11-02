import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate HOME before importing modules that capture it
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-usage-"));

const { parseWindow, fetchAccountUsage, fetchAccountModels } = await import("../src/usage");

import type { Account } from "../src/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetchOnce(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const account: Account = {
  id: "a1",
  label: "a1",
  integration: "opencode-go",
  key: "oc_sk_test",
  enabled: true,
  addedAt: 0,
};


test("parseWindow maps 0..100 API scale to 0..1", () => {
  const w = parseWindow({ percent: 97.5, status: "ok", resetsAt: "2026-10-20T00:00:00Z" });
  expect(w.percent).toBeCloseTo(0.975);
  expect(w.status).toBe("ok");
  expect(w.resetsAt).toBe("2026-10-20T00:00:00Z");
});

test("parseWindow preserves low percentages (regression: 2% must not become 200%)", () => {
  expect(parseWindow({ percent: 0 }).percent).toBe(0);
  expect(parseWindow({ percent: 0.5 }).percent).toBeCloseTo(0.005);
  expect(parseWindow({ percent: 1 }).percent).toBeCloseTo(0.01);
  expect(parseWindow({ percent: 2 }).percent).toBeCloseTo(0.02);
  expect(parseWindow({ percent: 5 }).percent).toBeCloseTo(0.05);
  expect(parseWindow({ percent: 78 }).percent).toBeCloseTo(0.78);
  expect(parseWindow({ percent: 100 }).percent).toBeCloseTo(1);
});

test("parseWindow clamps, and tolerates missing/invalid fields", () => {
  expect(parseWindow({ percent: 500 }).percent).toBe(1.5);
  expect(parseWindow({ percent: 150 }).percent).toBe(1.5);
  expect(parseWindow({ percent: -5 }).percent).toBe(0);
  expect(parseWindow({ percent: "nope" }).percent).toBe(0);
  expect(parseWindow(undefined).status).toBe("unknown");
  expect(parseWindow(undefined).percent).toBe(0);
});

test("fetchAccountUsage normalizes the real 0..100 response shape", async () => {
  mockFetchOnce({
    usage: {
      rolling: { percent: 5, status: "ok", resetsAt: "2026-10-19T19:22:53.000Z" },
      weekly: { percent: 2, status: "ok", resetsAt: "2026-10-26T00:00:00.000Z" },
      monthly: { percent: 78, status: "ok", resetsAt: "2026-11-08T00:58:08.000Z" },
    },
  });
  const r = await fetchAccountUsage("http://up.test", account);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.usage.rolling.percent).toBeCloseTo(0.05);
    expect(r.usage.weekly.percent).toBeCloseTo(0.02);
    expect(r.usage.monthly.percent).toBeCloseTo(0.78);
  }
});

test("fetchAccountModels 响应校验：缺失/畸形 data 与空清单 → ok:false（避免空清单触发错误删除）", async () => {
  const cases: unknown[] = [
    {},
    { data: [] },
    { data: [{ name: "no-id" }] },
    { data: [{ id: 42 }] },
    { data: "nope" },
    null,
    42,
  ];
  for (const body of cases) {
    mockFetchOnce(body);
    const r = await fetchAccountModels("http://up.test", account);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(200); // HTTP 200 + 畸形/空清单：保留 HTTP 状态，不误报网络失败
      expect(r.error).toContain("响应格式异常");
    }
  }
});

test("fetchAccountModels 正常清单 → ok:true 且保序", async () => {
  mockFetchOnce({ data: [{ id: "m1" }, { id: "m2", object: "model" }] });
  const r = await fetchAccountModels("http://up.test", account);
  expect(r).toEqual({ ok: true, ids: ["m1", "m2"] });
});

test("fetchAccountModels 非 JSON 响应 → ok:false 且保留 HTTP 状态", async () => {
  mockFetchOnce("<html>oops</html>");
  const r = await fetchAccountModels("http://up.test", account);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.status).toBe(200); // HTTP 200 + 非 JSON：保留真实状态，不误报网络失败
    expect(r.error).toContain("响应格式异常");
  }
});
