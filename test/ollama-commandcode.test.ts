import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-cc-ollama-"));
process.env.OPENSELECT_DB_PATH = join(process.env.HOME, "cc-ollama.sqlite");

const { Runtime } = await import("../src/state");
const { startProxy } = await import("../src/proxy");
const { loadCatalog } = await import("../src/catalog");
const { resolveProviderRoute, providerBase } = await import("../src/providers");
const { fetchOllamaModelNames } = await import("../src/ollama");
const { pricingTablesHtml } = await import("../src/pricing");
const { addAccount } = await import("../src/config");
const { recentRequests } = await import("../src/db");
const { tokenStatsPage } = await import("../src/token_stats");

import type { Account, Config } from "../src/types";

interface Seen {
  path: string;
  auth: string;
  body: string;
}
const seen: Seen[] = [];

const mock = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : "";
    seen.push({ path: url.pathname, auth: req.headers.get("authorization") ?? "", body });

    if (url.pathname === "/api/tags") {
      if (req.headers.get("authorization") !== "Bearer ollama-key") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({ models: [{ name: "qwen2.5:0.5b" }, { name: "llama3.2:3b" }] });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "qwen2.5:0.5b" }] });
    }
    if (url.pathname === "/provider/v1/messages" || url.pathname === "/v1/messages") {
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
        content: [{ type: "text", text: "anthropic-ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    if (url.pathname === "/provider/v1/chat/completions" || url.pathname === "/v1/chat/completions") {
      return Response.json({
        id: "chatcmpl_mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "chat-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    }
    if (url.pathname === "/provider/v1/responses") {
      return Response.json({ id: "resp_mock", object: "response", output: [] });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

function mkAccount(id: string, integration: string, baseUrl: string, key = ""): Account {
  return {
    id,
    label: id,
    integration,
    key,
    enabled: true,
    addedAt: 0,
    baseUrl,
    defaultEffort: "max",
  };
}

async function setup(accounts: Account[]) {
  const cfg: Config = {
    version: 1,
    upstream: { base: "http://127.0.0.1:1" },
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

const ccBase = `http://127.0.0.1:${mock.port}/provider/v1`;
const ollamaBase = `http://127.0.0.1:${mock.port}/v1`;

describe("Command Code / Ollama 路由", () => {
  test("Command Code 短别名与 cc/ 别名映射到上游厂商模型", () => {
    expect(resolveProviderRoute("commandcode/deepseek-v4.1-flash")).toMatchObject({
      strict: true,
      candidates: [{ provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" }],
    });
    expect(resolveProviderRoute("cc/glm-5.3-flash")).toMatchObject({
      strict: true,
      candidates: [{ provider: "commandcode", model: "z-ai/glm-5.3-flash" }],
    });
    expect(resolveProviderRoute("commandcode/z-ai/glm-5.3-flash")).toMatchObject({
      candidates: [{ provider: "commandcode", model: "z-ai/glm-5.3-flash" }],
    });
  });

  test("Ollama Cloud 别名保留模型名（含冒号）", () => {
    expect(resolveProviderRoute("ollama/qwen2.5:0.5b")).toMatchObject({
      strict: true,
      candidates: [{ provider: "ollama", model: "qwen2.5:0.5b" }],
    });
    expect(providerBase(mkAccount("ollama-default", "ollama", ""))).toBe("https://ollama.com/v1");
  });

  test("Command Code Anthropic /messages → OpenAI chat 翻译：Bearer + 上游模型", async () => {
    seen.length = 0;
    const { base } = await setup([mkAccount("cc-1", "commandcode", ccBase, "cc-key")]);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: H("sess-cc-anth"),
      body: JSON.stringify({
        model: "commandcode/deepseek-v4.1-flash",
        max_tokens: 32,
        output_config: { effort: "max" },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, any>;
    expect(j.content[0].text).toBe("chat-ok");
    expect(seen.length).toBe(1);
    expect(seen[0]!.path).toBe("/provider/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer cc-key");
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(body.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(Array.isArray(body.messages)).toBe(true);
    const row = recentRequests(1)[0]!;
    expect(row.provider).toBe("commandcode");
    expect(row.inputTokens).toBe(1);
    expect(row.outputTokens).toBe(1);
    expect(row.totalTokens).toBe(2);
  });

  test("Command Code OpenAI /chat/completions 透传", async () => {
    seen.length = 0;
    const { base } = await setup([mkAccount("cc-1", "commandcode", ccBase, "cc-key")]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session": "sess-cc-chat" },
      body: JSON.stringify({ model: "cc/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("chat-ok");
    expect(seen[0]!.path).toBe("/provider/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer cc-key");
    expect((JSON.parse(seen[0]!.body) as Record<string, unknown>).model).toBe("z-ai/glm-5.3-flash");
  });

  test("Ollama Cloud Anthropic /messages 原生透传，并发送 Bearer", async () => {
    seen.length = 0;
    const { base } = await setup([mkAccount("ollama-1", "ollama", ollamaBase, "ollama-key")]);
    const r = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: H("sess-ollama-anth"),
      body: JSON.stringify({
        model: "ollama/qwen2.5:0.5b",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, any>;
    expect(j.type).toBe("message");
    expect(j.content[0].text).toBe("anthropic-ok");
    expect(seen.length).toBe(1);
    expect(seen[0]!.path).toBe("/v1/messages");
    expect(seen[0]!.auth).toBe("Bearer ollama-key");
    const body = JSON.parse(seen[0]!.body) as Record<string, any>;
    expect(body.model).toBe("qwen2.5:0.5b");
    expect(body.messages[0]).toMatchObject({ role: "user", content: "hi" });
    const row = recentRequests(1)[0]!;
    expect(row.provider).toBe("ollama");
    expect(row.totalTokens).toBe(2);
  });

  test("Ollama OpenAI /chat/completions 原样转发", async () => {
    seen.length = 0;
    const { base } = await setup([mkAccount("ollama-1", "ollama", ollamaBase, "ollama-key")]);
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session": "sess-ollama-chat" },
      body: JSON.stringify({ model: "ollama/qwen2.5:0.5b", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("chat-ok");
    expect(seen[0]!.path).toBe("/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer ollama-key");
    expect((JSON.parse(seen[0]!.body) as Record<string, unknown>).model).toBe("qwen2.5:0.5b");
  });

  test("Ollama 模型发现读取 /api/tags", async () => {
    expect(await fetchOllamaModelNames(`http://127.0.0.1:${mock.port}`, "ollama-key")).toEqual([
      "qwen2.5:0.5b",
      "llama3.2:3b",
    ]);
  });

  test("Ollama Cloud 必须提供 Key", async () => {
    const cfg: Config = {
      version: 1,
      upstream: { base: "http://127.0.0.1:1" },
      proxy: { host: "127.0.0.1", port: 0 },
      dashboard: { host: "127.0.0.1", port: 0 },
      policy: { switchAt: 0.99, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
      monitor: { pollSec: 300 },
      opencode: { autoActivate: false },
      accounts: [],
    };
    await expect(addAccount(cfg, { key: "", integration: "ollama" })).rejects.toThrow("Key 不能为空");
  });

  test("首页价格表：套餐/API 分区、DeepSeek=100%、不编造 MiniMax 比例", () => {
    const html = pricingTablesHtml();
    expect(html).toContain("套餐（订阅制）");
    expect(html).toContain("API（按量计费）");
    expect(html).toContain("DeepSeek 官方 API = 100%");
    expect(html).toContain("OpenCode");
    expect(html).toContain("Command Code");
    expect(html).toContain("Ollama Cloud");
    expect(html).toContain("off-peak");
    expect(html).toContain("MiniMax");
    expect(html).not.toContain("PerchAI");
    expect(html).toContain("DeepSeek 订阅额度倍数");
    expect(html).toContain("10×");
    expect(html).toContain("15×");
    expect(html).toContain("Pay as you go");
    expect(html).toContain("—");
    expect(html).toContain("2026-10-31");
  });

  test("Token 统计页包含供应商/账号/模型/趋势区块", () => {
    const html = tokenStatsPage();
    expect(html).toContain("Token 消费统计");
    expect(html).toContain("供应商消费");
    expect(html).toContain("账号消费排行");
    expect(html).toContain("模型消费排行");
    expect(html).toContain("Token 趋势");
    expect(html).toContain("/api/tokens");
  });
});
