import { describe, expect, test } from "bun:test";
import {
  buildModelInfo,
  prettifyModelId,
  probeModelProtocol,
  reconcileCatalog,
  refreshWire,
} from "../src/sync";
import type { ModelInfo } from "../src/types";

function mk(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { id, name: id, family: "openai", free: false, cost: { input: 1, output: 2 }, ...extra };
}

const PROBE_BASE = "http://upstream.test/inference/go";
const BASE_PATH = new URL(PROBE_BASE).pathname;
const KEY = "oc_sk_test_key";

interface Route {
  status?: number;
  body: string;
}
/** ["精确 pathname"（或 "*" 通配）, 响应] */
type Routes = Array<[string, Route]>;

interface Call {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  bodyKeys: string[];
  /** 原始请求体文本（未发送时为 undefined；用于精确区分 {} / null / [] / 无正文） */
  bodyText?: string;
}

/** 假上游：按"精确 pathname"（base 路径 + 相对键）路由（杜绝错误 URL 后缀被放行），并记录 method/headers/body 形状。 */
function fakeFetch(routes: Routes, calls: Call[]) {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let bodyKeys: string[] = [];
    let bodyText: string | undefined;
    if (typeof init?.body === "string") {
      bodyText = init.body;
      try {
        const b = JSON.parse(init.body) as unknown;
        bodyKeys = b && typeof b === "object" ? Object.keys(b) : [];
      } catch {
        bodyKeys = ["<unparsable>"];
      }
    }
    calls.push({ url: url.href, path: url.pathname, method: init?.method ?? "GET", headers, bodyKeys, bodyText });
    const hit = routes.find(([k]) => k === "*" || url.pathname === BASE_PATH + k);
    if (!hit) return new Response("", { status: 404 });
    return new Response(hit[1].body, { status: hit[1].status ?? 400 });
  }) as unknown as typeof fetch;
}

/** 探测请求必须保持"零推理"形状：POST、无查询串、正文仅 model 字段（google 空体）、认证头互斥。 */
function expectProbeShape(calls: Call[]): void {
  for (const c of calls) {
    expect(c.method).toBe("POST");
    expect(new URL(c.url).search).toBe("");
    if (c.path.includes("/google/")) {
      expect(c.bodyText).toBe("{}"); // google 探测必须空 JSON 对象（不是无正文 / null / []）
    } else {
      expect(c.bodyKeys).toEqual(["model"]);
    }
    const auths = [c.headers["x-api-key"], c.headers["authorization"], c.headers["x-goog-api-key"]].filter(
      Boolean,
    );
    expect(auths.length).toBe(1);
    expect(c.headers["x-opencode-session"]).toBe("openselect-probe");
    if (c.path.includes("/anthropic/")) expect(c.headers["x-api-key"]).toBe(KEY);
    else if (c.path.includes("/openai/")) expect(c.headers["authorization"]).toBe(`Bearer ${KEY}`);
    else if (c.path.includes("/google/")) expect(c.headers["x-goog-api-key"]).toBe(KEY);
  }
}

/** 全级联（四探针均执行）时的规范路径顺序。 */
function expectProbePaths(calls: Call[], modelId = "m"): void {
  expect(calls.map((c) => c.path)).toEqual([
    "/inference/go/anthropic/v1/messages",
    "/inference/go/openai/v1/chat/completions",
    "/inference/go/openai/v1/responses",
    `/inference/go/google/v1beta/models/${modelId}:generateContent`,
  ]);
}

describe("prettifyModelId", () => {
  test("厂商风格派生（与既有目录风格大体一致）", () => {
    expect(prettifyModelId("kimi-k2.6")).toBe("Kimi K2.6");
    expect(prettifyModelId("qwen3.6-plus")).toBe("Qwen3.6 Plus");
    expect(prettifyModelId("omen-alpha")).toBe("Omen Alpha");
    expect(prettifyModelId("longcat-2.5-preview-free")).toBe("LongCat 2.5 Preview Free");
    expect(prettifyModelId("mimo-v2.5")).toBe("MiMo V2.5");
    expect(prettifyModelId("grok-4.6")).toBe("Grok 4.6");
  });
});

describe("buildModelInfo", () => {
  test("free 后缀 / family 映射 / responses 子协议", () => {
    const free = buildModelInfo("step-5-preview-free", "openai-chat");
    expect(free.free).toBe(true);
    expect(free.family).toBe("openai");
    expect(free.api).toBeUndefined();

    const resp = buildModelInfo("grok-4.6", "openai-responses");
    expect(resp.family).toBe("openai");
    expect(resp.api).toBe("responses");
    expect(resp.free).toBe(false);

    expect(buildModelInfo("minimax-m2.5", "anthropic").family).toBe("anthropic");
    expect(buildModelInfo("gemini-x", "google").family).toBe("google");

    const unknown = buildModelInfo("omen-alpha", "unknown");
    expect(unknown.family).toBe("openai");
    expect(unknown.api).toBeUndefined();
  });
});

describe("reconcileCatalog", () => {
  test("增删结构正确；既有条目（含 curation）保留且顺序不变", () => {
    const current: Record<string, ModelInfo> = {
      "glm-5.2": mk("glm-5.2", { name: "GLM-5.2" }),
      "gone-model": mk("gone-model"),
    };
    const live = ["glm-5.2", "kimi-k2.6", "omen-alpha"];
    const rec = reconcileCatalog(current, live, (id) => buildModelInfo(id, "openai-chat"));

    expect(Object.keys(rec.next)).toEqual(["glm-5.2", "kimi-k2.6", "omen-alpha"]);
    expect(rec.added).toEqual(["kimi-k2.6", "omen-alpha"]);
    expect(rec.removed).toEqual(["gone-model"]);
    expect(rec.kept).toBe(1);
    expect(rec.next["glm-5.2"]!.name).toBe("GLM-5.2");
  });

  test("空目录全量新增 / 全量移除", () => {
    const rec1 = reconcileCatalog({}, ["a", "b"], (id) => buildModelInfo(id, "unknown"));
    expect(rec1.added).toEqual(["a", "b"]);
    expect(rec1.removed).toEqual([]);
    const rec2 = reconcileCatalog({ a: mk("a") }, [], (id) => buildModelInfo(id, "unknown"));
    expect(rec2.added).toEqual([]);
    expect(rec2.removed).toEqual(["a"]);
    expect(rec2.next).toEqual({});
  });
});

describe("probeModelProtocol（零推理判别）", () => {
  test("anthropic 命中：字段校验错误即判定（精确 URL + 零推理形状）", async () => {
    const calls: Call[] = [];
    const fn = fakeFetch(
      [
        [
          "/anthropic/v1/messages",
          {
            status: 400,
            body: JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: "messages: Field required" },
            }),
          },
        ],
      ],
      calls,
    );
    const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
    expect(r.protocol).toBe("anthropic");
    expect(r.steps).toEqual([{ probe: "anthropic", status: 400, verdict: "accepted" }]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${PROBE_BASE}/anthropic/v1/messages`);
    expectProbeShape(calls);
  });

  test("anthropic 不支持 → openai-chat 命中（Bearer 头）", async () => {
    const calls: Call[] = [];
    const fn = fakeFetch(
      [
        ["/anthropic/v1/messages", { status: 400, body: "ModelProtocolUnsupported" }],
        [
          "/openai/v1/chat/completions",
          {
            status: 400,
            body: JSON.stringify({
              error: { type: "invalid_request_error", message: "The 'messages' field cannot be empty." },
            }),
          },
        ],
      ],
      calls,
    );
    const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
    expect(r.protocol).toBe("openai-chat");
    expect(r.steps.map((s) => s.verdict)).toEqual(["unsupported", "accepted"]);
    expect(calls[1]!.path).toBe("/inference/go/openai/v1/chat/completions");
    expectProbeShape(calls);
  });

  test("responses-only：chat 不支持 + responses 报 Endpoint is unavailable 视为命中", async () => {
    const calls: Call[] = [];
    const fn = fakeFetch(
      [
        ["/anthropic/v1/messages", { status: 400, body: "ModelProtocolUnsupported" }],
        ["/openai/v1/chat/completions", { status: 400, body: "ModelProtocolUnsupported" }],
        [
          "/openai/v1/responses",
          {
            status: 422,
            body: JSON.stringify({
              error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." },
            }),
          },
        ],
      ],
      calls,
    );
    const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "grok-x", fetchFn: fn });
    expect(r.protocol).toBe("openai-responses");
    expect(r.steps.map((s) => s.probe)).toEqual(["anthropic", "openai-chat", "openai-responses"]);
    expectProbeShape(calls);
  });

  test("google 命中：四路级联到底", async () => {
    const calls: Call[] = [];
    const fn = fakeFetch(
      [
        ["/anthropic/v1/messages", { status: 400, body: "ModelProtocolUnsupported" }],
        ["/openai/v1/chat/completions", { status: 400, body: "ModelProtocolUnsupported" }],
        ["/openai/v1/responses", { status: 400, body: "ModelProtocolUnsupported" }],
        [
          "/google/v1beta/models/gemini-x:generateContent",
          { status: 400, body: JSON.stringify({ error: { message: "contents is required" } }) },
        ],
      ],
      calls,
    );
    const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "gemini-x", fetchFn: fn });
    expect(r.protocol).toBe("google");
    expect(calls[3]!.url).toBe(`${PROBE_BASE}/google/v1beta/models/gemini-x:generateContent`);
    expectProbeShape(calls);
  });

  test("RegionError 无法判定（不误判）；全部不匹配 → unknown", async () => {
    const calls: Call[] = [];
    const fn = fakeFetch(
      [["*", { status: 403, body: JSON.stringify({ error: { type: "RegionError", message: "not available" } }) }]],
      calls,
    );
    const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
    expect(r.protocol).toBe("unknown");
    expect(r.steps.every((s) => s.verdict === "inconclusive")).toBe(true);
    expectProbePaths(calls);
    expectProbeShape(calls);

    const calls2: Call[] = [];
    const fn2 = fakeFetch([["*", { status: 400, body: "ModelProtocolUnsupported" }]], calls2);
    const r2 = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn2 });
    expect(r2.protocol).toBe("unknown");
    expect(r2.steps.length).toBe(4);
    expectProbePaths(calls2);
    expectProbeShape(calls2);
  });

  test("404（路径异常）不误判为命中", async () => {
    const calls: Call[] = [];
    const fn = fakeFetch([], calls); // 全部 404
    const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
    expect(r.protocol).toBe("unknown");
    expect(r.steps.every((s) => s.verdict === "error")).toBe(true);
    expectProbePaths(calls);
    expectProbeShape(calls);
  });

  test("错误边界：401/403/429/500 均非协议证据（不误判 anthropic）", async () => {
    const cases: Array<{ name: string; status: number; body: string }> = [
      { name: "401", status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) },
      { name: "403", status: 403, body: JSON.stringify({ error: { message: "forbidden" } }) },
      { name: "429", status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
      { name: "500", status: 500, body: JSON.stringify({ error: { message: "internal" } }) },
    ];
    for (const c of cases) {
      const calls: Call[] = [];
      const fn = fakeFetch([["*", { status: c.status, body: c.body }]], calls);
      const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
      expect(r.protocol).toBe("unknown");
      expect(r.steps.length).toBe(4);
      expect(r.steps.every((s) => s.verdict === "inconclusive")).toBe(true);
      expectProbePaths(calls);
      expectProbeShape(calls);
    }
  });

  test("错误边界：非 JSON 400（HTML）不视为命中", async () => {
    const calls: Call[] = [];
    const fn = fakeFetch([["*", { status: 400, body: "<html>Bad Request</html>" }]], calls);
    const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
    expect(r.protocol).toBe("unknown");
    expect(r.steps.every((s) => s.verdict === "inconclusive")).toBe(true);
    expectProbePaths(calls);
    expectProbeShape(calls);
  });

  test("错误边界：400 空 JSON / 无错误标识 JSON 不视为命中（反例 400 {}）", async () => {
    for (const body of ["{}", '{"foo":"bar"}', "[]", "null"]) {
      const calls: Call[] = [];
      const fn = fakeFetch([["*", { status: 400, body }]], calls);
      const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
      expect(r.protocol).toBe("unknown");
      expect(r.steps.every((s) => s.verdict === "inconclusive")).toBe(true);
      expectProbePaths(calls);
      expectProbeShape(calls);
    }
  });

  test("错误边界：2xx 携带协议/地域错误标记不视为命中", async () => {
    const cases: Array<[string, "unsupported" | "inconclusive"]> = [
      ["ModelProtocolUnsupported", "unsupported"],
      ["RegionError", "inconclusive"],
    ];
    for (const [body, verdict] of cases) {
      const calls: Call[] = [];
      const fn = fakeFetch([["*", { status: 200, body }]], calls);
      const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
      expect(r.protocol).toBe("unknown");
      expect(r.steps.every((s) => s.verdict === verdict)).toBe(true);
      expectProbePaths(calls);
      expectProbeShape(calls);
    }
  });

  test("错误边界：404/405 优先于正文标记（error）", async () => {
    for (const status of [404, 405]) {
      const calls: Call[] = [];
      const fn = fakeFetch([["*", { status, body: "ModelProtocolUnsupported RegionError" }]], calls);
      const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
      expect(r.protocol).toBe("unknown");
      expect(r.steps.every((s) => s.verdict === "error")).toBe(true);
      expectProbePaths(calls);
      expectProbeShape(calls);
    }
  });

  test("错误边界：网络异常 → inconclusive（status 0，不误判）", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await probeModelProtocol({ base: PROBE_BASE, key: KEY, modelId: "m", fetchFn: fn });
    expect(r.protocol).toBe("unknown");
    expect(r.steps.length).toBe(4);
    expect(r.steps.every((s) => s.status === 0 && s.verdict === "inconclusive")).toBe(true);
  });
});

describe("refreshWire（目录变更后的注入刷新）", () => {
  test("成功路径：按 unwire → wire 顺序执行", async () => {
    const order: string[] = [];
    const rr = await refreshWire({
      unwire: async () => {
        order.push("unwire");
      },
      wire: async () => {
        order.push("wire");
      },
    });
    expect(rr).toEqual({ refreshed: true });
    expect(order).toEqual(["unwire", "wire"]);
  });

  test("wire 首次失败 → 完整重试（unwire → wire）一次后成功", async () => {
    const order: string[] = [];
    let wireAttempts = 0;
    const rr = await refreshWire({
      unwire: async () => {
        order.push("unwire");
      },
      wire: async () => {
        order.push("wire");
        wireAttempts++;
        if (wireAttempts === 1) throw new Error("disk full");
      },
    });
    expect(rr).toEqual({ refreshed: true });
    expect(order).toEqual(["unwire", "wire", "unwire", "wire"]);
  });

  test("unwire 首次失败 → 完整重试成功（可清除首次残留）", async () => {
    let unwireAttempts = 0;
    let wired = 0;
    const rr = await refreshWire({
      unwire: async () => {
        unwireAttempts++;
        if (unwireAttempts === 1) throw new Error("transient");
      },
      wire: async () => {
        wired++;
      },
    });
    expect(unwireAttempts).toBe(2);
    expect(wired).toBe(1);
    expect(rr).toEqual({ refreshed: true });
  });

  test("持续失败 → 警告含 unwire && wire 清理指引", async () => {
    let wireAttempts = 0;
    const rr = await refreshWire({
      unwire: async () => {},
      wire: async () => {
        wireAttempts++;
        throw new Error("io error");
      },
    });
    expect(wireAttempts).toBe(3); // 完整重试一次 + 尽力恢复一次
    expect(rr.refreshed).toBe(false);
    expect(rr.warning).toContain("opensel unwire && opensel wire");
  });

  test("unwire 持续失败 → 重试后仍失败，尽力保持注入并给出清理指引", async () => {
    let wired = 0;
    let unwireAttempts = 0;
    const rr = await refreshWire({
      unwire: async () => {
        unwireAttempts++;
        throw new Error("corrupt config");
      },
      wire: async () => {
        wired++;
      },
    });
    expect(unwireAttempts).toBe(2);
    expect(wired).toBe(1);
    expect(rr.refreshed).toBe(false);
    expect(rr.warning).toContain("opensel unwire && opensel wire");
  });
});
