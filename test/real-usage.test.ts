import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENSELECT_DB_PATH = join(mkdtempSync(join(tmpdir(), "openselect-real-usage-")), "data.sqlite");
const { Runtime } = await import("../src/state");
const { startProxy } = await import("../src/proxy");
const { loadCatalog } = await import("../src/catalog");
const { getDb, recentRequests, tokenTotals } = await import("../src/db");

test("translated streams prefer upstream usage and leave unavailable cache unknown", async () => {
  const seen: any[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as any;
    await Bun.sleep(10);
    seen.push(body);
    const finalUsage = body.messages?.[0]?.content === "reported" ?
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":123,"prompt_tokens_details":{"cached_tokens":700}}}\n\n' : body.messages?.[0]?.content === "partial" ? 'data: {"choices":[],"usage":{"prompt_tokens":1000}}\n\n' : "";
    const text = 'data: {"choices":[{"delta":{"content":"O"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"K"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' + finalUsage + 'data: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const split = text.indexOf("\n\n") + 2;
        controller.enqueue(new TextEncoder().encode(text.slice(0, split)));
        await Bun.sleep(30);
        controller.enqueue(new TextEncoder().encode(text.slice(split)));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } });
  const rt = new Runtime({
    version: 1, upstream: { base: `http://127.0.0.1:${upstream.port}` },
    proxy: { host: "127.0.0.1", port: 0 }, dashboard: { host: "127.0.0.1", port: 0 },
    policy: { switchAt: 0.99, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200, codingAutoOrder: ["opencode"] },
    monitor: { pollSec: 300 }, opencode: { autoActivate: false },
    accounts: [{ id: "a", label: "a", integration: "opencode-go", key: "dummy", enabled: true, addedAt: 0 }],
  }, await loadCatalog());
  const proxy = startProxy(rt, { port: 0 });
  try {
    for (const content of ["reported", "unreported", "partial"]) {
      const response = await fetch(`http://127.0.0.1:${proxy.server.port}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": content },
        body: JSON.stringify({ model: "coding-auto", stream: true, max_tokens: 100, messages: [{ role: "user", content }] }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      if (content === "reported") expect(text).toContain('"input_tokens":300,"output_tokens":123,"cache_read_input_tokens":700');
    }
    expect(seen[0].stream_options).toEqual({ include_usage: true });
    const reported = recentRequests(10).find((r) => r.sessionId === "reported")!;
    const unreported = recentRequests(10).find((r) => r.sessionId === "unreported")!;
    expect(reported).toMatchObject({ inputTokens: 300, outputTokens: 123, cacheReadTokens: 700, totalTokens: 1123, tokenEstimated: false });
    expect(unreported.tokenEstimated).toBe(true);
    expect(recentRequests(10).find((r) => r.sessionId === "partial")!.tokenEstimated).toBe(true);
    const totals = tokenTotals(0, Date.now() + 1000);
    expect(totals).toMatchObject({ cacheKnownRequests: 1, cacheKnownInputTokens: 300, cacheKnownReadTokens: 700 });
    const timing = getDb().query("SELECT duration_ms, latency_ms, first_content_ms, generation_ms FROM requests WHERE session_id = ? ORDER BY id DESC LIMIT 1").get("reported") as { duration_ms: number; latency_ms: number; first_content_ms: number; generation_ms: number };
    expect(timing.duration_ms).toBeGreaterThanOrEqual(timing.latency_ms + 10);
    expect(timing.first_content_ms).toBeGreaterThanOrEqual(0);
    expect(timing.generation_ms).toBeGreaterThanOrEqual(10);
  } finally {
    proxy.server.stop(true);
    upstream.stop(true);
  }
});
