import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate ~/.openselect before importing modules that capture HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-freefirst-"));
// 台账路径显式隔离：避免与其他测试文件共享同一 SQLite（config.ts 在 import 时捕获）
process.env.OPENSELECT_DB_PATH = join(process.env.HOME, "free-first.sqlite");

const { Runtime } = await import("../src/state");
const { startProxy } = await import("../src/proxy");
const { recentRequests } = await import("../src/db");
const { loadCatalog } = await import("../src/catalog");

import type { Account, Config } from "../src/types";

const FREE_A = "longcat-2.5-preview-free";
const FREE_B = "minimax-m3.1-flash-free";
const PAID = "deepseek-v4.1-flash";

function mkAccount(id: string, key: string): Account {
  return { id, label: id, integration: "opencode-go", key, enabled: true, addedAt: 0 };
}

interface Seen {
  model?: string;
  auth: string;
  path: string;
}

let seen: Seen[] = [];
/** 模拟“免费模型额度用完”：命中的模型返回 429 */
let free429 = new Set<string>();
/** 模拟免费模型上游故障：命中的模型返回 500 */
let free500 = new Set<string>();
/** 模拟免费模型 2xx 后首字节前断流 */
let freeStreamFail = new Set<string>();

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const bodyText = req.method === "POST" ? await req.text() : "";
    let model: string | undefined;
    try {
      model = (JSON.parse(bodyText) as { model?: string }).model;
    } catch {
      /* non-json */
    }
    seen.push({ model, auth: req.headers.get("authorization") ?? "", path: url.pathname });
    if (model && free429.has(model)) {
      return Response.json(
        { error: { type: "server_error", message: "free model rate limited" } },
        { status: 429, headers: { "retry-after": "30" } },
      );
    }
    if (model && free500.has(model)) {
      return new Response("upstream boom", { status: 500 });
    }
    if (model && freeStreamFail.has(model)) {
      const s = new ReadableStream({
        start(controller) {
          controller.error(new Error("stream boom"));
        },
      });
      return new Response(s, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  },
});

async function setup(freeFirst: string[], accounts?: Account[]) {
  const cfg: Config = {
    version: 1,
    upstream: { base: `http://127.0.0.1:${upstream.port}/inference/go` },
    proxy: { host: "127.0.0.1", port: 0 },
    dashboard: { host: "127.0.0.1", port: 0 },
    policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200, freeFirst },
    monitor: { pollSec: 300 },
    opencode: { autoActivate: false },
    // 独立账号/会话 id：避免与其他测试文件共享 SQLite 台账时互相污染
    accounts: accounts ?? [mkAccount("ff-a1", "ffkey1"), mkAccount("ff-a2", "ffkey2")],
  };
  const rt = new Runtime(cfg, await loadCatalog());
  const proxy = startProxy(rt, { port: 0 });
  return { rt, base: `http://127.0.0.1:${proxy.server.port}` };
}

/** 按 session 精确定位请求台账行（台账可能被其他测试文件共享，不依赖全局 id 游标） */
function requestBySession(sessionId: string) {
  return recentRequests(200).find((r) => r.sessionId === sessionId);
}

const H = (session: string): Record<string, string> => ({
  "content-type": "application/json",
  "x-opencode-session": session,
});

describe("免费优先（free-first）", () => {
  test("付费模型请求先由第一个免费候选承接，台账记录实际服务模型", async () => {
    seen = [];
    free429 = new Set();
    free500 = new Set();
    freeStreamFail = new Set();
    const { base } = await setup([FREE_A, FREE_B]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-1"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.length).toBe(1);
    expect(seen[0]!.model).toBe(FREE_A);
    const log = requestBySession("ff-1")!;
    expect(log.model).toBe(PAID);
    expect(log.servedModel).toBe(FREE_A);
  });

  test("免费候选 429 → 换下一个候选；不冷却账号（付费流量不受影响）", async () => {
    seen = [];
    free429 = new Set([FREE_A]);
    free500 = new Set();
    freeStreamFail = new Set();
    const { rt, base } = await setup([FREE_A, FREE_B]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-2"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.map((s) => s.model)).toEqual([FREE_A, FREE_B]);
    // 同一账号复用（换模型不换号）
    expect(seen[0]!.auth).toBe(seen[1]!.auth);
    // 免费模型限流不冷却账号
    expect(rt.state("ff-a1").cooldownUntil).toBe(0);
    expect(rt.state("ff-a2").cooldownUntil).toBe(0);
    const log = requestBySession("ff-2")!;
    expect(log.servedModel).toBe(FREE_B);
  });

  test("全部免费候选不可用 → 回落到原付费模型", async () => {
    seen = [];
    free429 = new Set([FREE_A, FREE_B]);
    free500 = new Set();
    freeStreamFail = new Set();
    const { rt, base } = await setup([FREE_A, FREE_B]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-3"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.map((s) => s.model)).toEqual([FREE_A, FREE_B, PAID]);
    expect(rt.state("ff-a1").cooldownUntil).toBe(0);
    const log = requestBySession("ff-3")!;
    expect(log.model).toBe(PAID);
    expect(log.servedModel).toBe(null);
  });

  test("freeFirst 为空 → 行为与现状一致（不替换模型）", async () => {
    seen = [];
    free429 = new Set();
    free500 = new Set();
    freeStreamFail = new Set();
    const { base } = await setup([]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-4"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.map((s) => s.model)).toEqual([PAID]);
    expect(requestBySession("ff-4")!.servedModel).toBe(null);
  });

  test("客户端直接请求免费模型 → 不发生替换", async () => {
    seen = [];
    free429 = new Set();
    free500 = new Set();
    freeStreamFail = new Set();
    const { base } = await setup([FREE_A, FREE_B]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-5"),
      body: JSON.stringify({ model: FREE_B, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.map((s) => s.model)).toEqual([FREE_B]);
    expect(requestBySession("ff-5")!.servedModel).toBe(null);
  });

  test("免费候选负缓存生效：被拒后后续请求直接跳到下一个候选（不再打上游）", async () => {
    seen = [];
    free429 = new Set([FREE_A]);
    free500 = new Set();
    freeStreamFail = new Set();
    const { base } = await setup([FREE_A, FREE_B]);
    // 第一次：FREE_A 429 → 记 (账号×FREE_A) 负缓存 → 换 FREE_B
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-8"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r1.status).toBe(200);
    await r1.text();
    expect(seen.map((s) => s.model)).toEqual([FREE_A, FREE_B]);

    // 第二次（同一会话 → 同一账号）：FREE_A 命中负缓存 → 跳过（不打上游），直接 FREE_B
    seen = [];
    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-8"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r2.status).toBe(200);
    await r2.text();
    expect(seen.map((s) => s.model)).toEqual([FREE_B]);
  });

  test("单账号：免费候选全部失败 → 必须回落到付费模型并成功（免费尝试不占用付费选号名额）", async () => {
    seen = [];
    free429 = new Set([FREE_A, FREE_B]);
    free500 = new Set();
    freeStreamFail = new Set();
    const { rt, base } = await setup([FREE_A, FREE_B], [mkAccount("solo", "solokey")]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-11"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.map((s) => s.model)).toEqual([FREE_A, FREE_B, PAID]);
    // 免费模型的失败不冷却账号（付费流量不受影响）
    expect(rt.state("solo").cooldownUntil).toBe(0);
  });

  test("免费候选 5xx → 视为模型级失败：有付费回落且不冷却账号", async () => {
    seen = [];
    free429 = new Set();
    free500 = new Set([FREE_A, FREE_B]);
    const { rt, base } = await setup([FREE_A, FREE_B], [mkAccount("solo2", "solokey2")]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-12"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    // 5xx 不推进账号轮换：换下一个免费候选，再回落付费
    expect(seen.map((s) => s.model)).toEqual([FREE_A, FREE_B, PAID]);
    expect(rt.state("solo2").cooldownUntil).toBe(0);
  });

  test("免费候选 2xx 后首字节前断流 → 有付费回落且不冷却账号", async () => {
    seen = [];
    free429 = new Set();
    free500 = new Set();
    const { rt, base } = await setup([FREE_A, FREE_B], [mkAccount("solo3", "solokey3")]);
    // 拦截代理发往上游的请求：免费候选返回「响应头已到、正文首字节即失败」的响应
    // （Bun.serve 会吞掉流错误，原始 TCP 断流又会触发 fetch 内部重试与连接池停顿 → 不可靠）
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/inference/go/")) {
        const raw = init?.body;
        const text =
          typeof raw === "string"
            ? raw
            : raw instanceof Uint8Array
              ? new TextDecoder().decode(raw)
              : raw instanceof ArrayBuffer
                ? new TextDecoder().decode(new Uint8Array(raw))
                : "";
        let m: string | undefined;
        try {
          m = (JSON.parse(text) as { model?: string }).model;
        } catch {
          /* ignore */
        }
        if (m === FREE_A || m === FREE_B) {
          seen.push({ model: m, auth: "", path: "/inference/go/openai/v1/chat/completions" });
          const body = new ReadableStream({
            start(controller) {
              controller.error(new Error("stream boom"));
            },
          });
          return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
      }
      return realFetch(input as string | URL | Request, init);
    }) as typeof fetch;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: H("ff-13"),
        body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(200);
      await r.text();
      // FREE_A 断流 → 换 FREE_B → 回落付费
      expect(seen.map((s) => s.model)).toEqual([FREE_A, FREE_B, PAID]);
      expect(rt.state("solo3").cooldownUntil).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("回落到付费模型时按付费资格重新选号（不落回冷却中的账号）", async () => {
    seen = [];
    free429 = new Set([FREE_A, FREE_B]);
    free500 = new Set();
    freeStreamFail = new Set();
    const { rt, base } = await setup([FREE_A, FREE_B]);
    // ff-a1 进入冷却；ff-a2 标记为最近使用 → 免费尝试按 least-recently-used 选到 ff-a1
    rt.touch("ff-a2");
    rt.setCooldown("ff-a1", Date.now() + 60_000, "test cooldown");
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: H("ff-10"),
      body: JSON.stringify({ model: PAID, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.map((s) => s.model)).toEqual([FREE_A, FREE_B, PAID]);
    // 免费尝试可用冷却中的账号（免费忽略冷却），但付费回落必须换到健康账号
    expect(seen[0]!.auth).toBe("Bearer ffkey1");
    expect(seen[2]!.auth).toBe("Bearer ffkey2");
  });

  test("anthropic 家族模型不参与免费替换（协议不匹配）", async () => {
    seen = [];
    free429 = new Set();
    free500 = new Set();
    freeStreamFail = new Set();
    const { base } = await setup([FREE_A]);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...H("ff-6"), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen[0]!.path).toContain("/anthropic/v1/messages");
    expect(seen[0]!.model).toBe("claude-haiku-5-5");
  });

  test("Anthropic 客户端 + 付费 openai 模型 → 翻译路径下替换为免费模型，响应 model 为实际服务模型", async () => {
    seen = [];
    free429 = new Set();
    free500 = new Set();
    freeStreamFail = new Set();
    const { base } = await setup([FREE_A]);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...H("ff-7"), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: PAID, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { model?: string };
    expect(seen[0]!.model).toBe(FREE_A);
    expect(j.model).toBe(FREE_A);
    expect(requestBySession("ff-7")!.servedModel).toBe(FREE_A);
  });

  test("tool_result-only /v1/messages + zen 候选 → 不返回 400，继续落账号池付费", async () => {
    seen = [];
    free429 = new Set();
    free500 = new Set();
    freeStreamFail = new Set();
    // freeFirst 放一个 zen 模型，确保先进入 tryZenChain；该请求没有可抽取文本，
    // 免费链必须返回 null 让付费路径接管，而不是把请求判成 400。
    const { base } = await setup(["deepseek-v4.1-flash-free"]);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...H("ff-tool"), "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: PAID,
        max_tokens: 16,
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "probe", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        ],
      }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.length).toBe(1);
    expect(seen[0]!.model).toBe(PAID);
    expect(requestBySession("ff-tool")!.servedModel).toBeNull();
  });
});
