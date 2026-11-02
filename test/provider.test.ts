import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-provider-"));
process.env.OPENSELECT_DB_PATH = join(process.env.HOME, "provider.sqlite");

const { Runtime } = await import("../src/state");
const { startProxy } = await import("../src/proxy");
const { loadCatalog } = await import("../src/catalog");
const { recentRequests } = await import("../src/db");
const { parseZaiUsage, parseMiniMaxUsage, parseDeepSeekUsage } = await import("../src/usage");
const { resolveProviderRoute } = await import("../src/providers");

import type { Account, Config } from "../src/types";

interface Seen {
  path: string;
  auth: string;
  body: string;
}
const seen: Seen[] = [];
let zaiFail = false;
let allFail = false;
let mmRateLimit = false;
let mmQuota = false;
let opencode403 = false;

const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";
    const body = req.method === "POST" ? await req.text() : "";
    seen.push({ path: url.pathname, auth, body });
    if (url.pathname === "/v1/tools/search") {
      return Response.json({ results: [{ title: "mock result", url: "https://example.com" }] });
    }
    if (opencode403 && url.pathname.includes("/inference/go/openai/v1/chat/completions")) {
      return Response.json(
        { title: "Error 1010: Access denied", status: 403, error_code: 1010, zone: "opencode.ai" },
        { status: 403 },
      );
    }
    if (url.pathname.includes("/inference/go/openai/v1/chat/completions")) {
      return Response.json({
        id: "chatcmpl_mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "opencode-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }
    if (mmRateLimit && auth.endsWith("mm-key")) {
      return Response.json({ error: { type: "rate_limit_error", message: "rate limit" } }, { status: 429 });
    }
    if (mmQuota && auth.endsWith("mm-key")) {
      return Response.json(
        { error: { type: "rate_limit_error", message: "quota exceeded" } },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    if (allFail && (auth.endsWith("zai-key") || auth.endsWith("mm-key"))) {
      return Response.json(
        { error: { type: "rate_limit_error", message: "too many requests" } },
        { status: 429, headers: { "retry-after": "1" } },
      );
    }
    if (zaiFail && auth.endsWith("zai-key")) {
      return Response.json(
        { error: { type: "rate_limit_error", message: "too many requests" } },
        { status: 429, headers: { "retry-after": "1" } },
      );
    }
    let model = "mock";
    try {
      model = (JSON.parse(body) as { model?: string }).model ?? model;
    } catch {
      /* ignore */
    }
    return Response.json({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  },
});

function mkAccount(id: string, key: string, integration: string): Account {
  return {
    id,
    label: id,
    integration,
    key,
    enabled: true,
    addedAt: 0,
    baseUrl: `http://127.0.0.1:${provider.port}`,
    region: "cn",
    defaultEffort: "max",
  };
}

async function setup(accounts: Account[], upstreamBase = "http://127.0.0.1:1") {
  const cfg: Config = {
    version: 1,
    upstream: { base: upstreamBase },
    proxy: { host: "127.0.0.1", port: 0 },
    dashboard: { host: "127.0.0.1", port: 0 },
    policy: { switchAt: 0.99, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
    monitor: { pollSec: 300 },
    opencode: { autoActivate: false },
    accounts,
  };
  const rt = new Runtime(cfg, await loadCatalog());
  const proxy = startProxy(rt, { port: 0 });
  return { rt, base: `http://127.0.0.1:${proxy.server.port}` };
}

const H = (session: string): Record<string, string> => ({
  "content-type": "application/json",
  "x-opencode-session": session,
  "anthropic-version": "2023-06-01",
});

describe("provider usage parsers", () => {
  test("Z.ai：unit=3/5 是 5h，unit=6/1 是周；percentage 为已用", () => {
    const u = parseZaiUsage("z1", {
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1793160142192 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 98, nextResetTime: 1793510634999 },
        ],
      },
    });
    expect(u.rolling.percent).toBeCloseTo(0.01);
    expect(u.weekly.percent).toBeCloseTo(0.98);
    expect(u.rolling.status).toBe("active");
    expect(u.weekly.status).toBe("active");
    expect(u.rolling.resetsAt).toContain("2026-");
  });

  test("MiniMax：remaining_percent 换算为已用", () => {
    const u = parseMiniMaxUsage("m1", {
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 99,
          current_interval_status: 1,
          end_time: 1793166500578,
          current_weekly_remaining_percent: 69,
          current_weekly_status: 1,
          weekly_end_time: 1793370694897,
        },
      ],
    });
    expect(u.rolling.percent).toBeCloseTo(0.01);
    expect(u.weekly.percent).toBeCloseTo(0.31);
    expect(u.rolling.status).toBe("active");
  });

  test("DeepSeek 官方：余额映射，无 5h/周窗口", () => {
    const u = parseDeepSeekUsage("d1", {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "69.97", topped_up_balance: "69.97" }],
    });
    expect(u.balance?.currency).toBe("CNY");
    expect(u.balance?.total).toBeCloseTo(69.97);
    expect(u.balance?.available).toBe(true);
    expect(u.rolling.percent).toBe(0);
    expect(u.rolling.status).toBe("active");
  });
});

describe("provider routing", () => {
  test("zai 模型别名走 Anthropic 透传，注入 thinking/reasoning_effort", async () => {
    seen.length = 0;
    zaiFail = false;
    const { base } = await setup([mkAccount("zai-1", "zai-key", "zai")]);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: H("sess-zai"),
      body: JSON.stringify({ model: "zai/glm-5.3-flash", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("ok");
    expect(seen.length).toBe(1);
    expect(seen[0]!.path).toBe("/v1/messages");
    expect(seen[0]!.auth).toBe("Bearer zai-key");
    const body = JSON.parse(seen[0]!.body) as Record<string, any>;
    expect(body.model).toBe("glm-5.3-flash");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
  });

  test("coding-auto：Z.ai 429 后切 MiniMax，台账记录实际服务模型", async () => {
    seen.length = 0;
    zaiFail = true;
    try {
      const { rt, base } = await setup([
        mkAccount("zai-1", "zai-key", "zai"),
        mkAccount("mm-1", "mm-key", "minimax"),
      ]);
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: H("sess-auto"),
        body: JSON.stringify({ model: "coding-auto", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(200);
      await r.text();
      expect(seen.map((s) => s.auth)).toEqual(["Bearer zai-key", "Bearer mm-key"]);
      expect(rt.state("zai-1").cooldownUntil).toBeGreaterThan(Date.now());
      const body = JSON.parse(seen[1]!.body) as Record<string, any>;
      expect(body.model).toBe("MiniMax-M3.1-Flash");
      expect(body.output_config.effort).toBe("max");
      const log = recentRequests(50).find((x) => x.sessionId === "sess-auto")!;
      expect(log.model).toBe("coding-auto");
      expect(log.servedModel).toBe("MiniMax-M3.1-Flash");
      expect(log.accountId).toBe("mm-1");
      expect(log.status).toBe(200);
    } finally {
      zaiFail = false;
    }
  });

  test("coding-auto：两家都失败后落 opencode-go", async () => {
    seen.length = 0;
    allFail = true;
    try {
      const { base } = await setup(
        [
          mkAccount("zai-go", "zai-key", "zai"),
          mkAccount("mm-go", "mm-key", "minimax"),
          mkAccount("go-go", "go-key", "opencode-go"),
        ],
        `http://127.0.0.1:${provider.port}/inference/go`,
      );
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: H("sess-auto-go"),
        body: JSON.stringify({ model: "coding-auto", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      expect(j.content?.find((c) => c.type === "text")?.text).toContain("opencode-ok");
      expect(seen.map((s) => s.auth)).toEqual(["Bearer zai-key", "Bearer mm-key", "Bearer go-key"]);
      expect(seen.at(-1)!.path).toBe("/inference/go/openai/v1/chat/completions");
    } finally {
      allFail = false;
    }
  });

  test("MiniMax 裸 429 只做 3s 冷却，不按 5h 窗口冷却", async () => {
    seen.length = 0;
    mmRateLimit = true;
    try {
      const { rt, base } = await setup([mkAccount("mm-1", "mm-key", "minimax")]);
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: H("sess-mm-transient"),
        body: JSON.stringify({ model: "minimax/MiniMax-M3.1-Flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(429);
      const cd = rt.state("mm-1").cooldownUntil - Date.now();
      expect(cd).toBeGreaterThan(0);
      expect(cd).toBeLessThan(10_000);
      expect(rt.state("mm-1").lastError).toContain("transient");
    } finally {
      mmRateLimit = false;
    }
  });

  test("MiniMax 带 retry-after 的 quota 429 按上游时间冷却", async () => {
    seen.length = 0;
    mmQuota = true;
    try {
      const { rt, base } = await setup([mkAccount("mm-2", "mm-key", "minimax")]);
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: H("sess-mm-quota"),
        body: JSON.stringify({ model: "minimax/MiniMax-M3.1-Flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(429);
      const cd = rt.state("mm-2").cooldownUntil - Date.now();
      expect(cd).toBeGreaterThan(50_000);
      expect(rt.state("mm-2").lastError).toContain("quota");
    } finally {
      mmQuota = false;
    }
  });

  test("DeepSeek 官方直连模型走 Anthropic，注入 max 思考度", async () => {
    seen.length = 0;
    const ds = mkAccount("ds-api", "ds-key", "deepseek-api");
    ds.fallbackOnly = true;
    const { base } = await setup([ds]);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: H("sess-ds-api"),
      body: JSON.stringify({ model: "deepseek/deepseek-flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.at(-1)!.auth).toBe("Bearer ds-key");
    const body = JSON.parse(seen.at(-1)!.body) as Record<string, any>;
    expect(body.model).toBe("deepseek-flash");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
  });

  test("coding-auto：Z.ai/MiniMax/opencode 都不可用时才落 DeepSeek 官方", async () => {
    seen.length = 0;
    const ds = mkAccount("ds-fallback", "ds-key", "deepseek-api");
    ds.fallbackOnly = true;
    const { rt, base } = await setup([ds]);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: H("sess-ds-last"),
      body: JSON.stringify({ model: "coding-auto", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    await r.text();
    expect(seen.at(-1)!.auth).toBe("Bearer ds-key");
    const log = recentRequests(50).find((x) => x.sessionId === "sess-ds-last")!;
    expect(log.model).toBe("coding-auto");
    expect(log.servedModel).toBe("deepseek-flash");
    expect(log.accountId).toBe("ds-fallback");
  });

  test("coding-auto：opencode 403 Cloudflare 后仍落 DeepSeek 官方", async () => {
    seen.length = 0;
    opencode403 = true;
    try {
      const ds = mkAccount("ds-cf", "ds-key", "deepseek-api");
      ds.fallbackOnly = true;
      const go = mkAccount("go-cf", "go-key", "opencode-go");
      const { base } = await setup([ds, go], `http://127.0.0.1:${provider.port}/inference/go`);
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: H("sess-cf-fallback"),
        body: JSON.stringify({ model: "coding-auto", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(200);
      await r.text();
      expect(seen.at(-1)!.auth).toBe("Bearer ds-key");
      const log = recentRequests(50).find((x) => x.sessionId === "sess-cf-fallback")!;
      expect(log.model).toBe("coding-auto");
      expect(log.servedModel).toBe("deepseek-flash");
    } finally {
      opencode403 = false;
    }
  });

  test("DeepSeek Search 代理使用 deepseek 账号 key 转发", async () => {
    const prev = process.env.DEEPSEEK_BASE_URL;
    const prevKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${provider.port}`;
    try {
      seen.length = 0;
      const { base } = await setup([mkAccount("ds-1", "ds-key", "deepseek")]);
      const r = await fetch(`${base}/v1/tools/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "test", count: 1 }),
      });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { results: Array<{ title: string }> };
      expect(j.results[0]!.title).toBe("mock result");
      expect(seen.at(-1)!.path).toBe("/v1/tools/search");
      expect(seen.at(-1)!.auth).toBe("Bearer ds-key");
      expect(JSON.parse(seen.at(-1)!.body).query).toBe("test");
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_BASE_URL;
      else process.env.DEEPSEEK_BASE_URL = prev;
      if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevKey;
    }
  });

  test("模型目录包含供应商别名与 coding-auto", async () => {
    const catalog = await loadCatalog();
    expect(catalog.models["zai/glm-5.3-flash"]?.provider).toBe("zai");
    expect(catalog.models["minimax/MiniMax-M3.1-Flash"]?.provider).toBe("minimax");
    expect(catalog.models["coding-auto"]?.provider).toBe("auto");
    expect(resolveProviderRoute("coding-auto")?.candidates.length).toBe(2);
    expect(resolveProviderRoute("zai/glm-5.3-flash")?.strict).toBe(true);
  });
});
