import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate ~/.openselect before importing modules that capture HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-"));

const { Runtime } = await import("../src/state");
const { startProxy } = await import("../src/proxy");
const { recentRequests, recentSwitches } = await import("../src/db");
const { pickAccount } = await import("../src/policy");

import type { Config, Account } from "../src/types";

function mkAccount(id: string, key: string): Account {
  return { id, label: id, integration: "opencode-go", key, enabled: true, addedAt: 0 };
}

interface Seen {
  path: string;
  auth: string;
  apiKey: string;
  googKey: string;
  session: string;
  model?: string;
  bodyLen: number;
  body: string;
  anthropicVersion: string;
  anthropicBeta: string;
  accept: string;
  userAgent: string;
}

const seen: Seen[] = [];
let key1Behavior: "429" | "401" | "403" | "500" | "ok" = "429";
/** key2 对 glm-5.2 返回 404（模拟"该账号端点不可用"） */
let model404Unavailable = false;
/** 所有账号对 glm-5.3-flash 返回 404「Endpoint is unavailable」（模型级不可用） */
let model404All = false;
/** 所有账号对付费模型 kimi-k3 返回 429（额度用尽） */
let paidModel429All = false;
/** key1 对 glm-5.2 返回裸 429（无 limitName / retry-after，模拟瞬时/模型级限流） */
let paidBare429OnA1 = false;
/** key1 对 deepseek 返回上游 context-length 400 */
let contextOverflowOnA1 = false;
/** 免费模型在 key1（a1）上返回 429，key2（a2）正常 */
let freeModel429OnA1 = false;
/** 免费模型只在这几个 key 上可用（其它账号 404） */
let freeOnlyKeys: string[] = [];
/** 免费模型在 key1 上返回 401（key 失效） */
let free401OnA1 = false;
/** 免费模型在 key1 上 2xx 后首字节前断流 */
let freeStreamBreak = false;
/** 所有账号对 kimi-k2.6 返回 404「The model ... does not exist」（模型不可用 → 换号） */
let model404NotFound = false;
/** 所有账号对 kimi-k3 返回 404「Not Found」（与模型无关 → 原样透传） */
let model404Generic = false;
/** 所有账号对 kimi-k3 返回 404「... not found in the routing table」（网关路由错误 → 不换号） */
let model404Route = false;

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";
    const apiKey = req.headers.get("x-api-key") ?? "";
    const googKey = req.headers.get("x-goog-api-key") ?? "";
    const effective = (auth.startsWith("Bearer ") ? auth.slice(7) : "") || apiKey || googKey;
    const bodyText = req.method === "POST" ? await req.text() : "";
    let model: string | undefined;
    try {
      model = (JSON.parse(bodyText) as { model?: string }).model;
    } catch {
      /* get or non-json */
    }
    if (!model) {
      const m = url.pathname.match(/\/models\/([^/?:]+)/);
      if (m) model = decodeURIComponent(m[1]!);
    }
    seen.push({
      path: url.pathname + url.search,
      auth,
      apiKey,
      googKey,
      session: req.headers.get("x-opencode-session") ?? "",
      model,
      bodyLen: bodyText.length,
      body: bodyText,
      anthropicVersion: req.headers.get("anthropic-version") ?? "",
      anthropicBeta: req.headers.get("anthropic-beta") ?? "",
      accept: req.headers.get("accept") ?? "",
      userAgent: req.headers.get("user-agent") ?? "",
    });

    if (url.pathname.includes("gzip-test")) {
      const gz = Bun.gzipSync(Buffer.from("hello-gzip"));
      return new Response(gz, { headers: { "content-type": "text/plain", "content-encoding": "gzip" } });
    }
    if (url.pathname.endsWith(":streamGenerateContent")) {
      return new Response("data: google-chunk\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (effective.endsWith("key1") && key1Behavior === "500") {
      return new Response("internal boom", { status: 500, headers: { "content-type": "text/plain" } });
    }
    if (effective.endsWith("key1") && key1Behavior === "403") {
      return new Response(JSON.stringify({ error: { type: "forbidden", message: "model not allowed in workspace" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    if (effective.endsWith("key1") && key1Behavior === "401") {
      return new Response(JSON.stringify({ error: { type: "unauthorized", message: "invalid api key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    if (effective.endsWith("key1") && key1Behavior === "429") {
      return Response.json(
        { error: { type: "GoUsageLimitError", message: "limit reached", metadata: { limitName: "weekly" } } },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    if (paidBare429OnA1 && effective.endsWith("key1") && model === "glm-5.2") {
      return Response.json(
        { error: { type: "rate_limit_error", message: "too many concurrent requests" } },
        { status: 429 },
      );
    }
    if (contextOverflowOnA1 && effective.endsWith("key1") && model === "deepseek-v4.1-flash") {
      return Response.json(
        {
          error: {
            type: "invalid_request_error",
            message:
              "This model's maximum context length is 1048576 tokens; the prompt has 1050369 tokens (max_model_len)",
          },
        },
        { status: 400 },
      );
    }
    if (free401OnA1 && effective.endsWith("key1") && model === "longcat-2.5-preview-free") {
      return Response.json({ error: { type: "unauthorized", message: "invalid api key" } }, { status: 401 });
    }
    if (freeStreamBreak && effective.endsWith("key1") && model === "longcat-2.5-preview-free") {
      // 2xx 后首字节前断流：声明了长度但提前结束
      return new Response("data: partial\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (freeOnlyKeys.length > 0 && model === "longcat-2.5-preview-free" && !freeOnlyKeys.some((k) => effective.endsWith(k))) {
      return Response.json(
        { error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } },
        { status: 404 },
      );
    }
    if (freeModel429OnA1 && effective.endsWith("key1") && model === "longcat-2.5-preview-free") {
      return Response.json(
        { error: { type: "GoUsageLimitError", message: "limit reached", metadata: { limitName: "weekly" } } },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    if (paidModel429All && model === "kimi-k3") {
      return Response.json(
        { error: { type: "GoUsageLimitError", message: "limit reached", metadata: { limitName: "weekly" } } },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    if (model404All && model === "glm-5.3-flash") {
      return Response.json(
        { error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } },
        { status: 404 },
      );
    }
    if (model404NotFound && model === "kimi-k2.6") {
      return Response.json({ error: { message: "The model kimi-k2.6 does not exist" } }, { status: 404 });
    }
    if (model404Generic && model === "kimi-k3") {
      return Response.json({ error: { message: "Not Found" } }, { status: 404 });
    }
    if (url.pathname.endsWith("/responses") && model === "kimi-k3") {
      return Response.json(
        { error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } },
        { status: 404 },
      );
    }
    if (model404Route && model === "kimi-k3") {
      return Response.json({ error: { message: "The model endpoint was not found in the routing table" } }, { status: 404 });
    }
    if (model404Unavailable && effective.endsWith("key2") && model === "glm-5.2") {
      return Response.json(
        { error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } },
        { status: 404 },
      );
    }
    // 协议翻译测试专用上游：glm-5.1 返回 OpenAI chat 形状（JSON / SSE）；kimi-k2.6 返回 400。
    if (model === "glm-5.1" && url.pathname.endsWith("/openai/v1/chat/completions")) {
      let streamReq = false;
      try {
        streamReq = (JSON.parse(bodyText) as { stream?: boolean }).stream === true;
      } catch {
        /* ignore */
      }
      if (streamReq) {
        const chunk = (delta: unknown, finish: string | null): string =>
          `data: ${JSON.stringify({
            id: "chatcmpl-xlate",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        return new Response(
          [
            chunk({ role: "assistant", content: "翻译" }, null),
            chunk({ content: "成功" }, null),
            chunk({}, "stop"),
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: "chatcmpl-xlate",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "翻译成功" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 5 },
      });
    }
    if (model === "kimi-k2.6" && url.pathname.endsWith("/openai/v1/chat/completions")) {
      return Response.json({ error: { type: "invalid_request_error", message: "bad input" } }, { status: 400 });
    }
    return new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  },
});

const cfg: Config = {
  version: 1,
  upstream: { base: `http://127.0.0.1:${upstream.port}/inference/go` },
  proxy: { host: "127.0.0.1", port: 0 },
  dashboard: { host: "127.0.0.1", port: 0 },
  policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200, alertAt: [] },
  monitor: { pollSec: 300 },
  opencode: { autoActivate: false },
  accounts: [mkAccount("a1", "key1"), mkAccount("a2", "key2")],
};

const { loadCatalog } = await import("../src/catalog");
const rt = new Runtime(cfg, await loadCatalog());
const proxy = startProxy(rt, { port: 0 });
const base = `http://127.0.0.1:${proxy.server.port}`;

const H = (session: string): Record<string, string> => ({
  "content-type": "application/json",
  "x-opencode-session": session,
});

describe("proxy", () => {
  test("healthz", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  test("429 on first account fails over to second before first byte; session binds", async () => {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: H("sess-1"),
      body: JSON.stringify({ model: "glm-5.2", messages: [] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(await r.text()).toBe("data: ok\n\n");

    // two upstream calls: a1 (429) then a2
    const last2 = seen.slice(-2);
    expect(last2[0]!.auth).toBe("Bearer key1");
    expect(last2[0]!.path).toBe("/inference/go/openai/v1/chat/completions");
    expect(last2[0]!.model).toBe("glm-5.2");
    expect(last2[0]!.bodyLen).toBeGreaterThan(0);
    expect(last2[1]!.auth).toBe("Bearer key2");

    // a1 cooling, session bound to a2
    expect(rt.state("a1").cooldownUntil).toBeGreaterThan(Date.now());
    expect(rt.state("a1").lastError).toContain("429");
    expect(rt.getSessionAccount("sess-1")).toBe("a2");

    // switch logged
    const sw = recentSwitches(10);
    expect(sw.some((s) => s.reason === "429:weekly" && s.toAccount === "a2" && s.fromAccount === "a1")).toBe(true);
  });

  test("裸 429（无 limitName/retry-after）只做 3s 短冷却，不写模型负缓存", async () => {
    const saved = key1Behavior;
    const savedCooldown = rt.state("a1").cooldownUntil;
    const savedLastError = rt.state("a1").lastError;
    key1Behavior = "ok";
    paidBare429OnA1 = true;
    rt.state("a1").cooldownUntil = 0;
    rt.state("a1").invalid = false;
    rt.setUsage({
      accountId: "a1",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    rt.setUsage({
      accountId: "a2",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    try {
      const before = seen.length;
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-bare-429"),
        body: JSON.stringify({ model: "glm-5.2", messages: [] }),
      });
      expect(r.status).toBe(200);
      await r.text();
      expect(seen[before]!.auth).toBe("Bearer key1");
      expect(seen[before + 1]!.auth).toBe("Bearer key2");

      // 关键：a1 只有 3s 短冷却，不写 60s 模型负缓存（否则并发 burst 会封死整池）
      expect(rt.state("a1").cooldownUntil).toBeGreaterThan(Date.now());
      expect(rt.state("a1").cooldownUntil).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(rt.modelDenied("a1", "glm-5.2", "chat")).toBeNull();
      expect(rt.getSessionAccount("sess-bare-429")).toBe("a2");
      expect(recentSwitches(50).some((s) => s.reason === "429" && s.fromAccount === "a1" && s.toAccount === "a2")).toBe(true);
    } finally {
      key1Behavior = saved;
      paidBare429OnA1 = false;
      rt.modelDeny.delete("a1:glm-5.2:chat");
      rt.state("a1").cooldownUntil = savedCooldown;
      rt.state("a1").lastError = savedLastError;
    }
  });

  test("Claude Code 上下文后缀 [1m] 转发前剥离", async () => {
    const before = seen.length;
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...H("sess-1m"), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash[1m]",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(r.status).toBe(200);
    await r.text();
    const s = seen[seen.length - 1]!;
    expect(s.path).toBe("/inference/go/openai/v1/chat/completions");
    expect(s.model).toBe("deepseek-v4.1-flash");
    expect(seen.length).toBeGreaterThan(before);
  });

  test("上游 context-length 400 转成 Anthropic prompt is too long", async () => {
    const saved = key1Behavior;
    const savedCooldown = rt.state("a1").cooldownUntil;
    key1Behavior = "ok";
    contextOverflowOnA1 = true;
    rt.state("a1").cooldownUntil = 0;
    rt.state("a1").invalid = false;
    rt.setUsage({
      accountId: "a1",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    try {
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { ...H("sess-overflow"), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(r.status).toBe(400);
      const j = (await r.json()) as { error?: { message?: string } };
      expect(j.error?.message).toContain("prompt is too long");
      expect(j.error?.message).toContain("1048576");
    } finally {
      key1Behavior = saved;
      contextOverflowOnA1 = false;
      rt.state("a1").cooldownUntil = savedCooldown;
    }
  });

  test("超长请求本地预检返回 prompt is too long", async () => {
    const big = "a".repeat(4_200_000);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...H("sess-too-long"), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        max_tokens: 16,
        messages: [{ role: "user", content: big }],
      }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error?: { message?: string } };
    expect(j.error?.message).toContain("prompt is too long");
    expect(j.error?.message).toContain("1048576");
  });

  test("sticky: same session goes straight to a2", async () => {
    const before = seen.length;
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: H("sess-1"),
      body: JSON.stringify({ model: "glm-5.2", messages: [] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.length - before).toBe(1);
    expect(seen[seen.length - 1]!.auth).toBe("Bearer key2");
  });

  test("over-threshold/new session: fallback prefers healthy cooling account over over-threshold", async () => {
    const savedA2 = rt.usages.get("a2");
    try {
      rt.setUsage({ accountId: "a2", ts: Date.now(), rolling: { percent: 0, status: "active", resetsAt: null }, weekly: { percent: 0.98, status: "active", resetsAt: null }, monthly: { percent: 0.5, status: "active", resetsAt: null } });
      const d = pickAccount({ accounts: cfg.accounts, states: rt.states, usages: rt.usages, sessionAccount: null, free: false, now: Date.now(), switchAt: cfg.policy.switchAt });
      expect(d?.accountId).toBe("a1"); // a1 healthy but cooling; a2 over threshold
      expect(d?.reason).toBe("fallback");
    } finally {
      if (savedA2) rt.setUsage(savedA2);
      else rt.usages.delete("a2");
    }
  });

  test("anthropic path → /anthropic/v1 + client key replaced in x-api-key", async () => {
    const r = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { ...H("sess-2"), "x-api-key": "client-original-key" },
      body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    const s = seen[seen.length - 1]!;
    expect(s.path).toBe("/inference/go/anthropic/v1/messages");
    expect(s.apiKey).toBe("key2"); // session sess-2 binds to a2 (a1 cooling); client key replaced
    expect(s.auth).toBe(""); // no authorization header for anthropic family
  });

  test("google path (query preserved, model from path, client key replaced in x-goog-api-key)", async () => {
    const r = await fetch(`${base}/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse`, {
      headers: { ...H("sess-2"), "x-goog-api-key": "client-original-key" },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("data: google-chunk\n\n");
    const s = seen[seen.length - 1]!;
    expect(s.path).toBe("/inference/go/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse");
    expect(s.model).toBe("gemini-4-argon-contributor");
    expect(s.googKey).toBe("key2");
    expect(s.auth).toBe("");
  });

  test("openai responses path routes to /openai/v1/responses", async () => {
    const r = await fetch(`${base}/responses`, {
      method: "POST",
      headers: H("sess-3"),
      body: JSON.stringify({ model: "grok-4.7", input: [] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    const s = seen[seen.length - 1]!;
    expect(s.path).toBe("/inference/go/openai/v1/responses");
    expect(s.model).toBe("grok-4.7");
  });

  test("standard OpenAI path /v1/chat/completions → upstream /openai/v1/chat/completions（客户端 key 被替换）", async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-dummy" },
      body: JSON.stringify({ model: "glm-5.2", messages: [] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    const s = seen[seen.length - 1]!;
    expect(s.path).toBe("/inference/go/openai/v1/chat/completions");
    expect(s.auth.startsWith("Bearer key")).toBe(true);
    expect(s.auth).not.toContain("client-dummy");
  });

  test("standard Anthropic path /v1/messages（+count_tokens）→ /anthropic/v1/…", async () => {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-dummy", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 16, messages: [] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    const s = seen[seen.length - 1]!;
    expect(s.path).toBe("/inference/go/anthropic/v1/messages");
    expect(s.apiKey.startsWith("key")).toBe(true);
    expect(s.apiKey).not.toBe("client-dummy");

    const r2 = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client-dummy" },
      body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
    });
    expect(r2.status).toBe(200);
    await r2.text();
    expect(seen[seen.length - 1]!.path).toBe("/inference/go/anthropic/v1/messages/count_tokens");
  });

  test("GET /v1/models 本地统一清单（含 free 标记，不触发上游）", async () => {
    const before = seen.length;
    const r = await fetch(`${base}/v1/models`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { object: string; data: Array<{ id: string; free: boolean; family: string }> };
    expect(j.object).toBe("list");
    const ids = j.data.map((m) => m.id);
    expect(ids).toContain("beam-free");
    expect(ids).toContain("claude-haiku-5-5");
    expect(j.data.find((m) => m.id === "beam-free")!.free).toBe(true);
    expect(j.data.find((m) => m.id === "beam-free")!.family).toBe("openai");
    expect(j.data.find((m) => m.id === "claude-haiku-5-5")!.family).toBe("anthropic");
    expect(seen.length).toBe(before); // 本地返回，零上游请求

    const r2 = await fetch(`${base}/models`);
    expect(r2.status).toBe(200); // SDK 相对路径同样可用
    const r3 = await fetch(`${base}/v1/models/beam-free`);
    expect(r3.status).toBe(200);
    const r4 = await fetch(`${base}/v1/models/no-such-model`);
    expect(r4.status).toBe(404);

    const r5 = await fetch(`${base}/models/no-such-model-2`);
    expect(r5.status).toBe(200); // 无 /v1 前缀不被本地拦截：保持既有 google 家族路由（走 mock 上游）
    await r5.text();
    expect(seen[seen.length - 1]!.path).toBe("/inference/go/google/v1beta/models/no-such-model-2");
  });

  test("外部客户端缺会话头时代理自动合成 x-opencode-session；显式头原样透传", async () => {
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "dummy-cred" },
      body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    const s1 = seen[seen.length - 1]!;
    expect(s1.session.startsWith("openselect-")).toBe(true);

    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy-cred", "x-opencode-session": "sess-keep" },
      body: JSON.stringify({ model: "glm-5.2", messages: [] }),
    });
    expect(r2.status).toBe(200);
    await r2.text();
    expect(seen[seen.length - 1]!.session).toBe("sess-keep");

    // 判别场景（利用既有不变量）：a1 冷却中、a2 周用量 0.98 ≥ 阈值 → 非 free 的 s1 只能 fallback 到 a2（S_A→a2 绑定）。
    // free 模型跳过配额/冷却检查：此刻 fresh 会选压力更低的 a1（证明“无粘性=另一账号”），粘性则应保持 a2。
    const freshFree = pickAccount({
      accounts: cfg.accounts,
      states: rt.states,
      usages: rt.usages,
      sessionAccount: null,
      free: true,
      now: Date.now(),
      switchAt: cfg.policy.switchAt,
    });
    expect(freshFree?.accountId).toBe("a1");
    expect(s1.apiKey).toBe("key2"); // s1 非 free：a1 冷却 + a2 超阈值 → fallback a2

    // 同凭据 + free 模型 → 稳定合成会话 + 粘性保持 a2（若粘性失效会选 fresh=a1）
    // key1 行为临时置 ok：防止 r3 万一落到 a1 时被 429→故障转移→a2 掩盖（保持断言判别力）
    const savedBehavior = key1Behavior;
    key1Behavior = "ok";
    const seenBefore3 = seen.length;
    const r3 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "dummy-cred" },
      body: JSON.stringify({ model: "beam-free", messages: [] }),
    });
    expect(r3.status).toBe(200);
    await r3.text();
    expect(seen.length - seenBefore3).toBe(1); // 粘性命中 → 仅一次上游调用（无重试掩盖）
    const s3 = seen[seen.length - 1]!;
    expect(s3.session).toBe(s1.session);
    expect(s3.auth).toBe("Bearer key2"); // openai 系走 authorization：粘性 → a2（而非 fresh 的 a1 → key1）

    // 不同凭据 → 不同会话（隔离）；未被粘性绑定 → fresh=a1
    const r4 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "other-cred" },
      body: JSON.stringify({ model: "beam-free", messages: [] }),
    });
    expect(r4.status).toBe(200);
    await r4.text();
    key1Behavior = savedBehavior;
    const s4 = seen[seen.length - 1]!;
    expect(s4.session).not.toBe(s1.session);
    expect(s4.session.startsWith("openselect-")).toBe(true);
    expect(s4.auth).toBe("Bearer key1");
  });

  test("gzip upstream body is transparently decompressed (no stale content-encoding)", async () => {
    const r = await fetch(`${base}/gzip-test`, { headers: H("sess-4") });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(await r.text()).toBe("hello-gzip");
  });

  test("request log rows written", async () => {
    const reqs = recentRequests(50);
    expect(reqs.length).toBeGreaterThanOrEqual(5);
    expect(reqs.some((x) => x.status === 200 && x.attempts === 2)).toBe(true);
  });

  test("all accounts excluded → last upstream error returned", async () => {
    const saved = cfg.policy.maxAttempts;
    const savedBehavior = key1Behavior;
    try {
      cfg.policy.maxAttempts = 2;
      // a1 is cooling; force a2 to 429 too by swapping its key check via behavior flag is complex —
      // instead: make both keys fail by pointing behavior at both keys.
      key1Behavior = "429"; // only key1 fails; a2 still succeeds → expect 200
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-5"),
        body: JSON.stringify({ model: "glm-5.2", messages: [] }),
      });
      expect(r.status).toBe(200);
      await r.text();
    } finally {
      cfg.policy.maxAttempts = saved;
      key1Behavior = savedBehavior;
    }
  });

  test("401 marks account invalid and fails over before first byte (switch logged)", async () => {
    // prep: a1 healthy & low pressure (picked first for a fresh session); a2 stays over-threshold but usable
    const st = rt.state("a1");
    st.invalid = false;
    st.cooldownUntil = 0;
    rt.setUsage({
      accountId: "a1",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    const saved = key1Behavior;
    try {
      key1Behavior = "401";
      const before = seen.length;
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-401"),
        body: JSON.stringify({ model: "glm-5.3-flash", messages: [] }),
      });
      expect(r.status).toBe(200);
      await r.text();
      expect(seen[before]!.auth).toBe("Bearer key1");
      expect(seen[before + 1]!.auth).toBe("Bearer key2");
      expect(rt.state("a1").invalid).toBe(true);
      const sw = recentSwitches(50);
      expect(sw.some((s) => s.reason === "invalid:401" && s.fromAccount === "a1")).toBe(true);
    } finally {
      key1Behavior = saved;
    }
  });

  test("403 does NOT invalidate account; deny-cache skips (account×model) without burning attempts", async () => {
    // prep: a1 healthy & low pressure (picked first), a2 stays over-threshold but usable
    const st = rt.state("a1");
    st.invalid = false;
    st.cooldownUntil = 0;
    rt.setUsage({
      accountId: "a1",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    const saved = key1Behavior;
    try {
      key1Behavior = "403";
      const before1 = seen.length;
      const r1 = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-403-1"),
        body: JSON.stringify({ model: "gpt-6-luna", messages: [] }),
      });
      expect(r1.status).toBe(200);
      await r1.text();
      // a1 got 403 → failover to a2; a1 must NOT be marked invalid
      expect(seen[before1]!.auth).toBe("Bearer key1");
      expect(seen[before1 + 1]!.auth).toBe("Bearer key2");
      expect(rt.state("a1").invalid).toBe(false);
      expect(recentSwitches(50).some((s) => s.reason === "403" && s.fromAccount === "a1")).toBe(true);

      // second request, same model, fresh session: a1 skipped via deny-cache (only one upstream call)
      const before2 = seen.length;
      const r2 = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-403-2"),
        body: JSON.stringify({ model: "gpt-6-luna", messages: [] }),
      });
      expect(r2.status).toBe(200);
      await r2.text();
      expect(seen.length - before2).toBe(1);
      expect(seen[before2]!.auth).toBe("Bearer key2");
    } finally {
      key1Behavior = saved;
    }
  });

  test("403 负缓存的 key 粒度为 (账号×模型)：同账号换模型不跳过（EVT-011 回归）", async () => {
    // prep（自洽，不依赖前序用例）：a1 healthy & 低压力；a2 置为超阈值 → 首选 a1
    const st = rt.state("a1");
    st.invalid = false;
    st.cooldownUntil = 0;
    rt.setUsage({
      accountId: "a1",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    rt.setUsage({
      accountId: "a2",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.98, status: "active", resetsAt: null },
      monthly: { percent: 0.5, status: "active", resetsAt: null },
    });
    const saved = key1Behavior;
    try {
      key1Behavior = "403";
      // 第一次：a1 对 hy3 被拒 → 记 (a1, hy3) 负缓存 → 换 a2
      // （用本文件其它测试未占用的模型，避免负缓存影响后续用例）
      const before1 = seen.length;
      const r1 = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-deny-1"),
        body: JSON.stringify({ model: "hy3", messages: [] }),
      });
      expect(r1.status).toBe(200);
      await r1.text();
      expect(seen[before1]!.auth).toBe("Bearer key1");
      expect(seen[before1 + 1]!.auth).toBe("Bearer key2");

      // 第二次：换模型（hy4-preview）→ a1 不应被 (a1, hy3) 的负缓存跳过
      const before2 = seen.length;
      const r2 = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-deny-2"),
        body: JSON.stringify({ model: "hy4-preview", messages: [] }),
      });
      expect(r2.status).toBe(200);
      await r2.text();
      expect(seen[before2]!.auth).toBe("Bearer key1");
    } finally {
      key1Behavior = saved;
    }
  });

  test("5xx failover is logged with source → target account", async () => {
    // prep: a1 healthy & low pressure (picked first), a2 stays over-threshold but usable
    const st = rt.state("a1");
    st.invalid = false;
    st.cooldownUntil = 0;
    rt.setUsage({
      accountId: "a1",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    const saved = key1Behavior;
    try {
      key1Behavior = "500";
      const before = seen.length;
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-500"),
        body: JSON.stringify({ model: "glm-5.2", messages: [] }),
      });
      expect(r.status).toBe(200);
      await r.text();
      expect(seen[before]!.auth).toBe("Bearer key1");
      expect(seen[before + 1]!.auth).toBe("Bearer key2");
      expect(rt.state("a1").cooldownUntil).toBeGreaterThan(Date.now());
      const sw = recentSwitches(50);
      expect(sw.some((s) => s.fromAccount === "a1" && s.toAccount === "a2" && s.reason === "HTTP 500")).toBe(true);
    } finally {
      key1Behavior = saved;
    }
  });

  test("2xx headers received but body breaks before first byte → failover (first-chunk peek)", async () => {
    const st = rt.state("a1");
    st.invalid = false;
    st.cooldownUntil = 0;
    rt.setUsage({
      accountId: "a1",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    const realFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = ((input: any, init?: any) => {
      upstreamCalls++;
      if (upstreamCalls === 1) {
        const broken = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("connection reset before first byte"));
          },
        });
        return Promise.resolve(new Response(broken, { status: 200, headers: { "content-type": "text/event-stream" } }));
      }
      return realFetch(input, init);
    }) as any;
    try {
      const r = await realFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-stream"),
        body: JSON.stringify({ model: "glm-5.2", messages: [] }),
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("data: ok\n\n");
      expect(upstreamCalls).toBe(2);
      expect(rt.state("a1").cooldownUntil).toBeGreaterThan(Date.now());
      const sw = recentSwitches(50);
      expect(sw.some((s) => s.fromAccount === "a1" && s.toAccount === "a2" && s.reason === "network-error")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("restart restores recent usage from SQLite; stale snapshots are skipped", async () => {
    const { insertUsage } = await import("../src/db");
    insertUsage({
      accountId: "a2",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.99, status: "active", resetsAt: null },
      monthly: { percent: 0.5, status: "active", resetsAt: null },
    });
    const rt2 = new Runtime(cfg, await loadCatalog());
    expect(rt2.usages.get("a2")?.weekly.percent).toBe(0.99);
    expect(rt2.usageSeeded).toBeGreaterThanOrEqual(1);

    // a snapshot older than 24h must not be restored
    const cfg3: Config = { ...cfg, accounts: [...cfg.accounts, mkAccount("a3", "key3")] };
    insertUsage({
      accountId: "a3",
      ts: Date.now() - 25 * 3600 * 1000,
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.9, status: "active", resetsAt: null },
      monthly: { percent: 0, status: "active", resetsAt: null },
    });
    const rt3 = new Runtime(cfg3, await loadCatalog());
    expect(rt3.usages.get("a3")).toBeUndefined();
  });

});

describe("protocol translation (/v1/messages → openai/chat)", () => {
  function prepHealthyA1(): void {
    const st = rt.state("a1");
    st.invalid = false;
    st.cooldownUntil = 0;
    rt.setUsage({
      accountId: "a1",
      ts: Date.now(),
      rolling: { percent: 0, status: "active", resetsAt: null },
      weekly: { percent: 0.1, status: "active", resetsAt: null },
      monthly: { percent: 0.1, status: "active", resetsAt: null },
    });
    rt.setUsage({
      accountId: "a2",
      ts: Date.now(),
      rolling: { percent: 0.05, status: "active", resetsAt: null },
      weekly: { percent: 0.2, status: "active", resetsAt: null },
      monthly: { percent: 0.2, status: "active", resetsAt: null },
    });
  }

  function anthropicHeaders(session: string): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: "Bearer dummy",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
      "x-opencode-session": session,
    };
  }

  function parseSse(text: string): Array<{ event: string; data: any }> {
    return text
      .split("\n\n")
      .filter((b) => b.trim())
      .map((block) => {
        const lines = block.split("\n");
        const event = (lines.find((l) => l.startsWith("event: ")) ?? "event: ?").slice(7);
        const data = (lines.find((l) => l.startsWith("data: ")) ?? "data: {}").slice(6);
        return { event, data: JSON.parse(data) };
      });
  }

  test("非流：请求/响应翻译，丢弃 ?beta=true，剥离 anthropic-*，Bearer 认证", async () => {
    prepHealthyA1();
    const saved = key1Behavior;
    key1Behavior = "ok";
    try {
      const before = seen.length;
      const r = await fetch(`${base}/v1/messages?beta=true`, {
        method: "POST",
        headers: anthropicHeaders("xlate-nonstream"),
        body: JSON.stringify({
          model: "glm-5.1",
          max_tokens: 64,
          system: "SYS",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as any;
      expect(j).toMatchObject({
        type: "message",
        role: "assistant",
        model: "glm-5.1",
        content: [{ type: "text", text: "翻译成功" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 5 },
      });
      const s = seen[before]!;
      expect(s.path).toBe("/inference/go/openai/v1/chat/completions"); // query 丢弃
      expect(s.auth).toBe("Bearer key1");
      expect(s.anthropicVersion).toBe("");
      expect(s.anthropicBeta).toBe("");
      expect(s.accept).toBe("application/json");
      const b = JSON.parse(s.body) as any;
      expect(b).toMatchObject({ model: "glm-5.1", max_tokens: 64, stream: false });
      expect(b.messages).toEqual([
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
      ]);
    } finally {
      key1Behavior = saved;
    }
  });

  test("流式：OpenAI SSE → Anthropic 事件序列", async () => {
    prepHealthyA1();
    const saved = key1Behavior;
    key1Behavior = "ok";
    try {
      const before = seen.length;
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders("xlate-stream"),
        body: JSON.stringify({
          model: "glm-5.1",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/event-stream");
      const text = await r.text();
      const evs = parseSse(text);
      expect(evs[0]!.event).toBe("message_start");
      expect(evs.at(-1)!.event).toBe("message_stop");
      const md = evs.find((e) => e.event === "message_delta")!;
      expect(md.data.delta.stop_reason).toBe("end_turn");
      expect(md.data.usage.output_tokens).toBeGreaterThan(0);
      expect(
        evs
          .filter((e) => e.event === "content_block_delta")
          .map((e) => e.data.delta.text)
          .join(""),
      ).toBe("翻译成功");
      const s = seen[before]!;
      expect(s.path).toBe("/inference/go/openai/v1/chat/completions");
      expect(s.accept).toBe("text/event-stream");
      expect((JSON.parse(s.body) as any).stream).toBe(true);
    } finally {
      key1Behavior = saved;
    }
  });

  test("count_tokens：openai 模型本地近似，零上游请求", async () => {
    const before = seen.length;
    const r = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: anthropicHeaders("xlate-count"),
      body: JSON.stringify({ model: "glm-5.1", messages: [{ role: "user", content: "hello world" }] }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { input_tokens: number };
    expect(j.input_tokens).toBeGreaterThan(0);
    expect(seen.length).toBe(before);
  });

  test("2MB+ /v1/messages 仍解析 model 并翻译（P1 回归）", async () => {
    prepHealthyA1();
    const saved = key1Behavior;
    key1Behavior = "ok";
    try {
      const before = seen.length;
      const big = "x".repeat(2_100_000);
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders("xlate-big"),
        body: JSON.stringify({
          model: "glm-5.1",
          max_tokens: 16,
          system: big,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as any;
      expect(j.content[0].text).toBe("翻译成功");
      const s = seen[before]!;
      expect(s.path).toBe("/inference/go/openai/v1/chat/completions");
      expect((JSON.parse(s.body) as any).model).toBe("glm-5.1");
    } finally {
      key1Behavior = saved;
    }
  });

  test("2MB+ /v1/chat/completions 也解析 body model（P3 回归）", async () => {
    prepHealthyA1();
    const saved = key1Behavior;
    key1Behavior = "ok";
    try {
      const before = seen.length;
      const big = "x".repeat(2_100_000);
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-session": "big-chat" },
        body: JSON.stringify({
          model: "glm-5.1",
          max_tokens: 16,
          messages: [
            { role: "system", content: big },
            { role: "user", content: "hi" },
          ],
        }),
      });
      expect(r.status).toBe(200);
      const s = seen[before]!;
      expect(s.path).toBe("/inference/go/openai/v1/chat/completions");
      expect(s.model).toBe("glm-5.1");
    } finally {
      key1Behavior = saved;
    }
  });

  test("2MB+ /v1/responses 仍解析 body model 并路由到 responses（P3 回归）", async () => {
    prepHealthyA1();
    const saved = key1Behavior;
    key1Behavior = "ok";
    try {
      const before = seen.length;
      const big = "x".repeat(2_100_000);
      const r = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-session": "big-responses" },
        body: JSON.stringify({
          model: "grok-4.7",
          input: [{ role: "user", content: big }],
        }),
      });
      expect(r.status).toBe(200);
      await r.text();
      const s = seen[before]!;
      expect(s.path).toBe("/inference/go/openai/v1/responses");
      expect(s.model).toBe("grok-4.7");
      // 关键断言：请求台账里记录了 model → 证明代理确实解析了 >2MB 的请求体
      // （body 是原样透传，仅断言上游收到的 model 无法区分「解析成功」与「未解析」）
      expect(recentRequests(5).some((x) => x.model === "grok-4.7" && x.path === "/v1/responses")).toBe(true);
    } finally {
      key1Behavior = saved;
    }
  });

  test("2MB+ count_tokens 仍本地近似、零上游（P1 回归）", async () => {
    const before = seen.length;
    const big = "x".repeat(2_100_000);
    const r = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: anthropicHeaders("xlate-big-count"),
      body: JSON.stringify({ model: "glm-5.1", system: big, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { input_tokens: number };
    expect(j.input_tokens).toBeGreaterThan(0);
    expect(seen.length).toBe(before);
  });

  test("responses 模型经 /v1/messages → 本地 400，零上游请求", async () => {
    const before = seen.length;
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders("xlate-responses"),
      body: JSON.stringify({ model: "grok-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("invalid_request_error");
    expect(j.error.message).toContain("Responses");
    expect(seen.length).toBe(before);
  });

  test("google 模型经 /v1/messages → 本地 400，零上游请求", async () => {
    const before = seen.length;
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders("xlate-google"),
      body: JSON.stringify({
        model: "gemini-4-argon-contributor",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.error.message).toContain("Google");
    expect(seen.length).toBe(before);
  });

  test("上游 400 → Anthropic 错误 envelope", async () => {
    prepHealthyA1();
    const saved = key1Behavior;
    key1Behavior = "ok";
    try {
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders("xlate-upstream-400"),
        body: JSON.stringify({ model: "kimi-k2.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({
        type: "error",
        error: { type: "invalid_request_error", message: "bad input" },
      });
    } finally {
      key1Behavior = saved;
    }
  });

  test("429 → 换号成功；翻译后的请求体在重试间复用", async () => {
    prepHealthyA1();
    const saved = key1Behavior;
    key1Behavior = "429";
    try {
      const before = seen.length;
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders("xlate-failover"),
        body: JSON.stringify({ model: "glm-5.1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as any;
      expect(j.content[0].text).toBe("翻译成功");
      const last2 = seen.slice(-2);
      expect(last2[0]!.auth).toBe("Bearer key1");
      expect(last2[1]!.auth).toBe("Bearer key2");
      expect(last2[0]!.path).toBe("/inference/go/openai/v1/chat/completions");
      expect(last2[1]!.path).toBe("/inference/go/openai/v1/chat/completions");
      expect(last2[0]!.body).toBe(last2[1]!.body);
      expect((JSON.parse(last2[1]!.body) as any).messages).toEqual([{ role: "user", content: "hi" }]);
      expect(seen.length).toBe(before + 2);
    } finally {
      key1Behavior = saved;
    }
  });

  test("流式 429 → 换号成功；翻译后 body 复用", async () => {
    prepHealthyA1();
    const saved = key1Behavior;
    key1Behavior = "429";
    try {
      const before = seen.length;
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders("xlate-stream-failover"),
        body: JSON.stringify({
          model: "glm-5.1",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(r.status).toBe(200);
      const evs = parseSse(await r.text());
      expect(
        evs
          .filter((e) => e.event === "content_block_delta")
          .map((e) => e.data.delta.text)
          .join(""),
      ).toBe("翻译成功");
      const last2 = seen.slice(-2);
      expect(last2[0]!.auth).toBe("Bearer key1");
      expect(last2[1]!.auth).toBe("Bearer key2");
      expect(last2[0]!.body).toBe(last2[1]!.body);
      expect(seen.length).toBe(before + 2);
    } finally {
      key1Behavior = saved;
    }
  });
});

describe("上游 404 故障转移", () => {
  test("模型在目录里但该账号端点不可用（404）→ 记负缓存并切到下一个账号", async () => {
    const savedBehavior = key1Behavior;
    key1Behavior = "ok";
    model404Unavailable = true;
    // a2 排在前（lastUsed 更小）、a1 排在后 → 确定性先撞 a2 的 404
    const st1 = rt.state("a1");
    st1.cooldownUntil = 0;
    st1.lastUsed = Date.now();
    const st2 = rt.state("a2");
    st2.cooldownUntil = 0;
    st2.lastUsed = 0;
    rt.modelDeny.clear();
    rt.usages.delete("a1");
    rt.usages.delete("a2"); // 清空用量快照：排序只由 lastUsed 决定，结果确定
    const before = seen.length;
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-404"),
        body: JSON.stringify({ model: "glm-5.2", messages: [] }),
      });
      expect(r.status).toBe(200);
      const hits = seen.slice(before).map((x) => x.auth);
      expect(hits).toContain("Bearer key2"); // 先撞上 404 的账号
      expect(hits).toContain("Bearer key1"); // 再切到可用账号
      // 切换记录里有 404 故障转移
      const sw = recentSwitches(10).find((x) => x.reason === "404");
      expect(sw).toBeDefined();
      expect(String(sw?.detail)).toContain("model-unavailable");
      // 负缓存生效：同账号不再重复撞同一个模型
      expect(rt.modelDenied("a2", "glm-5.2", "chat")).not.toBeNull();
    } finally {
      key1Behavior = savedBehavior;
      model404Unavailable = false;
    }
  });
});

describe("404 的两种语义（AC-CDX P2-4）", () => {
  test("模型级不可用：连续 3 个账号 404 后停止扫描，404 透传给客户端（不多扫池）", async () => {
    const savedBehavior = key1Behavior;
    key1Behavior = "ok";
    model404All = true;
    // 独立池：4 个账号（都指向同一个 mock 上游），验证"最多扫 3 个"
    const poolCfg: Config = {
      ...cfg,
      accounts: [
        mkAccount("b1", "key1"),
        mkAccount("b2", "key2"),
        mkAccount("b3", "key3"),
        mkAccount("b4", "key4"),
      ],
    };
    const poolRt = new Runtime(poolCfg, await loadCatalog());
    const poolProxy = startProxy(poolRt, { port: 0 });
    const poolBase = `http://127.0.0.1:${poolProxy.server.port}`;
    const before = seen.length;
    try {
      const r = await fetch(`${poolBase}/chat/completions`, {
        method: "POST",
        headers: H("sess-404-all"),
        body: JSON.stringify({ model: "glm-5.3-flash", messages: [] }),
      });
      expect(r.status).toBe(404);
      const hits = seen.slice(before).filter((x) => x.model === "glm-5.3-flash");
      expect(hits.length).toBe(3); // 封顶：最多扫 3 个账号，第 4 个不再试
      // 负缓存：被试过的账号都记了 (账号×模型)
      for (const id of ["b1", "b2", "b3"]) {
        expect(poolRt.modelDenied(id, "glm-5.3-flash", "chat")).not.toBeNull();
      }
    } finally {
      poolProxy.server.stop(true);
      key1Behavior = savedBehavior;
      model404All = false;
    }
  });

  test("措辞变体「The model X does not exist」也算模型不可用 → 换号重试，body 仍透传", async () => {
    const savedBehavior = key1Behavior;
    key1Behavior = "ok";
    model404NotFound = true;
    for (const id of ["a1", "a2"]) {
      rt.state(id).cooldownUntil = 0;
      rt.usages.delete(id);
    }
    rt.modelDeny.clear();
    const before = seen.length;
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-404-nf"),
        body: JSON.stringify({ model: "kimi-k2.6", messages: [] }),
      });
      expect(r.status).toBe(404);
      // body 必须透传给客户端（AC-CDX P2：曾经被读空，客户端拿到 content-length: 0）
      const bodyText = await r.text();
      expect(bodyText).toContain("does not exist");
      const hits = seen.slice(before).filter((x) => x.model === "kimi-k2.6");
      expect(hits.length).toBe(2); // 换号重试过（模型不可用 → 账号级）
      expect(rt.modelDenied("a1", "kimi-k2.6", "chat")).not.toBeNull();
    } finally {
      key1Behavior = savedBehavior;
      model404NotFound = false;
    }
  });

  test("与模型无关的 404（原样透传，不换号）", async () => {
    const savedBehavior = key1Behavior;
    key1Behavior = "ok";
    model404Generic = true;
    for (const id of ["a1", "a2"]) {
      rt.state(id).cooldownUntil = 0;
      rt.usages.delete(id);
    }
    rt.modelDeny.clear();
    const before = seen.length;
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-404-nf2"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(404);
      const bodyText = await r.text();
      expect(bodyText).toContain("Not Found");
      const hits = seen.slice(before).filter((x) => x.model === "kimi-k3");
      expect(hits.length).toBe(1); // 没有换号重试
      expect(rt.modelDenied("a1", "kimi-k3", "chat")).toBeNull();
    } finally {
      key1Behavior = savedBehavior;
      model404Generic = false;
    }
  });
});

describe("上游 User-Agent", () => {
  test("客户端 Python-urllib/空 UA 会被替换为稳定 UA，避免 Cloudflare 1010", async () => {
    const savedBehavior = key1Behavior;
    key1Behavior = "ok";
    for (const id of ["a1", "a2"]) {
      rt.state(id).cooldownUntil = 0;
      rt.usages.delete(id);
    }
    rt.modelDeny.clear();
    const before = seen.length;
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { ...H("sess-ua"), "user-agent": "Python-urllib/3.13" },
        body: JSON.stringify({ model: "glm-5.2", messages: [] }),
      });
      expect(r.status).toBe(200);
      await r.text();
      const row = seen.slice(before).find((x) => x.session === "sess-ua");
      expect(row?.userAgent).toBe("opencode/1.0.0");
    } finally {
      key1Behavior = savedBehavior;
    }
  });
});

describe("按接入指定账号（端到端）", () => {
  test("opencode 接入被指定账号 → 该接入的请求走指定账号；其他接入不受影响；台账记录接入", async () => {
    const savedBehavior = key1Behavior;
    const savedPins = rt.config.policy.clientAccounts;
    key1Behavior = "ok"; // a1 正常可用，便于观察"没被指定"时的默认选择
    rt.config.policy.clientAccounts = { opencode: "a2" };
    // 清掉前面用例留下的冷却与模型级拒绝，保证两个账号都可选
    for (const id of ["a1", "a2"]) {
      rt.state(id).cooldownUntil = 0;
      rt.usages.delete(id); // 清空用量快照，避免压力排序影响结果
    }
    rt.modelDeny.clear();
    const before = seen.length;
    try {
      // ① opencode 接入 → a2（key2）
      const r1 = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { ...H("sess-oc"), "user-agent": "opencode/1.2.3" },
        body: JSON.stringify({ model: "glm-5.2", messages: [] }),
      });
      expect(r1.status).toBe(200);
      const ocSeen = seen.slice(before).filter((x) => x.session === "sess-oc");
      expect(ocSeen.length).toBe(1);
      expect(ocSeen[0]!.auth).toBe("Bearer key2");

      // ② Claude Code 接入不受影响 → 默认账号 a1（key1）
      const before2 = seen.length;
      const r2 = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.284 (external, cli)" },
        body: JSON.stringify({ model: "glm-5.1", messages: [] }),
      });
      expect(r2.status).toBe(200);
      const ccSeen = seen.slice(before2).filter((x) => x.session === "sess-cc" || x.auth === "Bearer key1");
      expect(ccSeen.length).toBeGreaterThan(0);
      expect(ccSeen[0]!.auth).toBe("Bearer key1");

      // ③ 台账记录接入归属
      const rows = recentRequests(10);
      const ocRow = rows.find((x) => x.sessionId === "sess-oc");
      expect(ocRow?.client).toBe("opencode");
      const ccRow = rows.find((x) => x.client === "claude-code");
      expect(ccRow).toBeDefined();
    } finally {
      key1Behavior = savedBehavior;
      rt.config.policy.clientAccounts = savedPins;
    }
  });
});

describe("404 判据的误判防护（AC-CDX P3-1）", () => {
  test("网关路由类 404（route/routing）不算「模型不可用」→ 不换号", async () => {
    const savedBehavior = key1Behavior;
    key1Behavior = "ok";
    model404Route = true;
    for (const id of ["a1", "a2"]) {
      rt.state(id).cooldownUntil = 0;
      rt.usages.delete(id);
    }
    rt.modelDeny.clear();
    const before = seen.length;
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-404-route"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(404);
      const bodyText = await r.text();
      expect(bodyText).toContain("routing table");
      const hits = seen.slice(before).filter((x) => x.model === "kimi-k3");
      expect(hits.length).toBe(1); // 没换号（路由错误不是账号级问题）
      expect(rt.modelDenied("a1", "kimi-k3", "chat")).toBeNull(); // 也没写负缓存
    } finally {
      key1Behavior = savedBehavior;
      model404Route = false;
    }
  });
});

describe("兜底模式的失败路径（AC-CDX P1-1 回归）", () => {
  test("免费候选在 a1 失败 → 换账号重试（a2 可用时兜底应成功）", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "fallback";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free"];
    paidModel429All = true; // 付费模型：所有账号额度用尽
    freeModel429OnA1 = true; // 免费模型：a1 被拒，a2 正常
    key1Behavior = "ok";
    for (const id of ["a1", "a2"]) rt.state(id).cooldownUntil = 0;
    rt.modelDeny.clear();
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-fb2"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(200);
      const row = recentRequests(3).find((x) => x.sessionId === "sess-fb2");
      expect(row?.servedModel).toBe("longcat-2.5-preview-free");
      // 确实换过号：a1 试过（429）→ a2 成功
      const hits = seen.filter((x) => x.session === "sess-fb2");
      expect(hits.length).toBeGreaterThanOrEqual(3);
      expect(hits.some((x) => x.model === "longcat-2.5-preview-free" && x.auth === "Bearer key2")).toBe(true);
    } finally {
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      paidModel429All = false;
      freeModel429OnA1 = false;
    }
  });

  test("免费候选在 a1 有负缓存 → 跳过 a1 用 a2（不被负缓存整请求钉死）", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "fallback";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free"];
    paidModel429All = true;
    key1Behavior = "ok";
    for (const id of ["a1", "a2"]) rt.state(id).cooldownUntil = 0;
    rt.modelDeny.clear();
    // 预置：a1 上这个免费模型被拒（负缓存 15 分钟）
    rt.denyModel("a1", "longcat-2.5-preview-free", 403, "model denied", 15 * 60 * 1000, "chat");
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-fb3"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(200);
      const row = recentRequests(3).find((x) => x.sessionId === "sess-fb3");
      expect(row?.servedModel).toBe("longcat-2.5-preview-free");
    } finally {
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      paidModel429All = false;
    }
  });
});

describe("兜底模式的剩余失败路径（AC-CDX P2-1/P2-2/P2-3 回归）", () => {
  test("免费候选在首个账号断流（2xx 后首字节前）→ 换账号重试同一候选 → 200", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "fallback";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free"];
    paidModel429All = true;
    freeStreamBreak = true; // a1 断流
    key1Behavior = "ok";
    for (const id of ["a1", "a2"]) rt.state(id).cooldownUntil = 0;
    rt.modelDeny.clear();
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-stream"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(200);
      const row = recentRequests(3).find((x) => x.sessionId === "sess-stream");
      expect(row?.servedModel).toBe("longcat-2.5-preview-free");
    } finally {
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      paidModel429All = false;
      freeStreamBreak = false;
    }
  });

  test("候选数较多时：第 3 个候选也能轮到（迭代上限要随候选数放大）", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "fallback";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free", "minimax-m3.1-flash-free", "beam-free"];
    paidModel429All = true;
    freeOnlyKeys = ["key5", "key6"]; // 只有第 5/6 个账号能服务任一免费候选
    key1Behavior = "ok";
    const poolCfg: Config = {
      ...cfg,
      accounts: [
        mkAccount("c1", "key1"), mkAccount("c2", "key2"), mkAccount("c3", "key3"),
        mkAccount("c4", "key4"), mkAccount("c5", "key5"), mkAccount("c6", "key6"),
      ],
    };
    const poolRt = new Runtime(poolCfg, await loadCatalog());
    const poolProxy = startProxy(poolRt, { port: 0 });
    const poolBase = `http://127.0.0.1:${poolProxy.server.port}`;
    try {
      const r = await fetch(`${poolBase}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-session": "sess-c3" },
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(200);
    } finally {
      poolProxy.server.stop(true);
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      paidModel429All = false;
      freeOnlyKeys = [];
    }
  });

  test("免费候选返回 401 → 账号按 key 失效移出池（账号级语义）", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "fallback";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free"];
    paidModel429All = true;
    free401OnA1 = true;
    key1Behavior = "ok";
    for (const id of ["a1", "a2"]) rt.state(id).cooldownUntil = 0;
    // 让 a1 先被选（lastUsed 更小 → 排序靠前），确保命中 401
    rt.state("a1").lastUsed = 0;
    rt.state("a2").lastUsed = Date.now();
    rt.modelDeny.clear();
    try {
      await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-401"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(rt.state("a1").invalid).toBe(true); // key 失效 → 移出池
    } finally {
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      paidModel429All = false;
      free401OnA1 = false;
      rt.state("a1").invalid = false;
    }
  });
});

describe("兜底模式的规模与候选推进（AC-CDX P1-A / P1-B 回归）", () => {
  test("池子较大时：免费模型只在最后一个账号可用 → 仍应成功（迭代上限要够）", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "fallback";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free"];
    paidModel429All = true; // 付费模型：所有账号额度用尽
    freeOnlyKeys = ["key4"]; // 免费模型：只有第 4 个账号可用
    key1Behavior = "ok";
    const poolCfg: Config = {
      ...cfg,
      accounts: [mkAccount("b1", "key1"), mkAccount("b2", "key2"), mkAccount("b3", "key3"), mkAccount("b4", "key4")],
    };
    const poolRt = new Runtime(poolCfg, await loadCatalog());
    const poolProxy = startProxy(poolRt, { port: 0 });
    const poolBase = `http://127.0.0.1:${poolProxy.server.port}`;
    try {
      const r = await fetch(`${poolBase}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-session": "sess-pool4" },
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(200);
      const row = recentRequests(3).find((x) => x.sessionId === "sess-pool4");
      expect(row?.servedModel).toBe("longcat-2.5-preview-free");
    } finally {
      poolProxy.server.stop(true);
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      paidModel429All = false;
      freeOnlyKeys = [];
    }
  });

  test("候选 1 只在第二个账号可用 → 不应因为候选 1 在第一个账号失败就放弃它", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "fallback";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free", "minimax-m3.1-flash-free"];
    paidModel429All = true;
    freeOnlyKeys = ["key2"]; // 只有 a2 能服务候选 1
    key1Behavior = "ok";
    for (const id of ["a1", "a2"]) rt.state(id).cooldownUntil = 0;
    rt.modelDeny.clear();
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-fb4"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(200);
      const row = recentRequests(3).find((x) => x.sessionId === "sess-fb4");
      expect(row?.servedModel).toBe("longcat-2.5-preview-free");
    } finally {
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      paidModel429All = false;
      freeOnlyKeys = [];
    }
  });
});

describe("免费模型中转模式（off / first / fallback）", () => {
  /** 让所有账号都无法服务付费模型：所有账号对付费模型 kimi-k3 返回 429（额度用尽） */
  function blockPaidAccounts() {
    paidModel429All = true;
    key1Behavior = "ok"; // 其它用例可能留下 429 行为，这里复位
    for (const id of ["a1", "a2"]) rt.state(id).cooldownUntil = 0;
    rt.modelDeny.clear();
  }
  function restore() {
    paidModel429All = false;
    key1Behavior = "ok";
    rt.usages.delete("a2");
    for (const id of ["a1", "a2"]) rt.state(id).cooldownUntil = 0;
    rt.modelDeny.clear();
  }

  test("fallback：付费模型不可用时才用免费模型接着（会话不断）", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "fallback";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free"];
    blockPaidAccounts();
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-fallback"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(200);
      const row = recentRequests(3).find((x) => x.sessionId === "sess-fallback");
      expect(row?.servedModel).toBe("longcat-2.5-preview-free"); // 付费不可用 → 免费模型承接
      expect(row?.model).toBe("kimi-k3");
    } finally {
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      restore();
    }
  });

  test("first：免费模型优先承接（付费模型根本没被试）", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "first";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free"];
    restore();
    const before = seen.length;
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-first"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBe(200);
      const row = recentRequests(3).find((x) => x.sessionId === "sess-first");
      expect(row?.servedModel).toBe("longcat-2.5-preview-free");
      // 免费候选先行：上游只收到免费模型这一次请求
      const hits = seen.slice(before).filter((x) => x.session === "sess-first");
      expect(hits.length).toBe(1);
      expect(hits[0]!.model).toBe("longcat-2.5-preview-free");
    } finally {
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      restore();
    }
  });

  test("off：完全不替换（付费不可用就是失败，不用免费模型顶替）", async () => {
    const savedMode = rt.config.policy.freeFirstMode;
    const savedList = rt.config.policy.freeFirst;
    rt.config.policy.freeFirstMode = "off";
    rt.config.policy.freeFirst = ["longcat-2.5-preview-free"];
    blockPaidAccounts();
    const before = seen.length;
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-off"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      const hits = seen.slice(before).filter((x) => x.session === "sess-off");
      expect(hits.every((x) => x.model === "kimi-k3")).toBe(true); // 没有换成免费模型
    } finally {
      rt.config.policy.freeFirstMode = savedMode;
      rt.config.policy.freeFirst = savedList;
      restore();
    }
  });
});

describe("负缓存的协议作用域隔离（免费模型只在 chat 端点服务）", () => {
  test("responses 端点上的 404 不影响同模型在 chat 端点上的可用性", async () => {
    const savedBehavior = key1Behavior;
    key1Behavior = "ok";
    for (const id of ["a1", "a2"]) {
      rt.state(id).cooldownUntil = 0;
      rt.usages.delete(id);
    }
    rt.modelDeny.clear();
    try {
      // 1) chat 端点：模型可用 → 200
      const okChat = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-scope-chat"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(okChat.status).toBe(200);
      // 2) responses 端点：同一模型不被该端点服务 → 404
      const r = await fetch(`${base}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "opencode/1.2.3" },
        body: JSON.stringify({ model: "kimi-k3", input: "hi" }),
      });
      expect(r.status).toBe(404);
      // 3) chat 端点的可用性没有被 responses 端点的失败污染
      const still = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-scope-chat2"),
        body: JSON.stringify({ model: "kimi-k3", messages: [] }),
      });
      expect(still.status).toBe(200);
    } finally {
      key1Behavior = savedBehavior;
    }
  });
});

// 放在最后：超大请求体上传余波可能短暂占用服务端，避免拖慢后续用例
describe("payload cap", () => {
  test("Anthropic /v1/messages 超 32MB → Anthropic 413 外形（直调 handler）", async () => {
    const { handleProxyRequest } = await import("../src/proxy");
    const big = "x".repeat(33 * 1024 * 1024);
    const req = new Request(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session": "big-anthropic" },
      body: big,
    });
    const r = await handleProxyRequest(rt, req);
    expect(r.status).toBe(413);
    const j = (await r.json()) as any;
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("request_too_large");
    expect(typeof j.error.message).toBe("string");
  });

  test("request bodies over the 32MB cap are rejected with 413", async () => {
    const big = "x".repeat(33 * 1024 * 1024);
    // 上一个用例的 33MB 上传会短暂占用服务端（Bun 可能直接回 503）→ 最多重试 3 次
    let r: Response | null = null;
    for (let i = 0; i < 3; i++) {
      r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: H("sess-big"),
        body: big,
      });
      if (r.status === 413) break;
      await Bun.sleep(1000);
    }
    expect(r!.status).toBe(413);
    const j = (await r!.json()) as { error: { type: string } };
    expect(j.error.type).toBe("openselect_payload_too_large");
  });
});
