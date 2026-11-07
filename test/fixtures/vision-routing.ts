import { expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENSELECT_DB_PATH = join(mkdtempSync(join(tmpdir(), "openselect-vision-")), "data.sqlite");
const { Runtime } = await import("../../src/state");
const { handleProxyRequest } = await import("../../src/proxy");
const { loadCatalog } = await import("../../src/catalog");

async function verifyVisionRouting() {
  const captured: any[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    captured.push(await req.json());
    return Response.json({ choices: [{ message: { role: "assistant", content: "image received" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  } });
  const rt = new Runtime({
    version: 1, upstream: { base: `http://127.0.0.1:${upstream.port}` },
    proxy: { host: "127.0.0.1", port: 0 }, dashboard: { host: "127.0.0.1", port: 0 },
    policy: { switchAt: 0.99, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200, codingAutoOrder: ["zai", "minimax", "opencode"] },
    monitor: { pollSec: 300 }, opencode: { autoActivate: false },
    accounts: [{ id: "vision-test-account", label: "vision-test-account", integration: "opencode-go", key: "dummy", enabled: true, addedAt: 0 }],
  }, await loadCatalog());
  const base = "http://openselect.test";
  const request = (url: string, init?: RequestInit) => handleProxyRequest(rt, new Request(url, init));
  try {
    // Query known entries directly: the complete list also discovers external
    // Zen models, which is outside this local capability-routing test.
    const autoModel = await (await request(`${base}/v1/models/coding-auto`)).json() as any;
    const proModel = await (await request(`${base}/v1/models/deepseek-v4-pro`)).json() as any;
    expect(autoModel.input_modalities).toEqual(["text", "image"]);
    expect(proModel.input_modalities).toBeUndefined();
    const response = await request(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      model: "coding-auto", max_tokens: 16, messages: [{ role: "user", content: [
        { type: "text", text: "describe" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } },
      ] }],
    }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "image received" }] });
    expect(captured[0].messages[0].content).toEqual([
      { type: "text", text: "describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } },
    ]);
    const offResponse = await request(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-openselect-context-window": "1000000" }, body: JSON.stringify({
      model: "coding-auto", max_tokens: 16, thinking: { type: "disabled" }, messages: [{ role: "user", content: "say OK" }],
    }) });
    expect(offResponse.status).toBe(200);
    expect(JSON.parse(decodeURIComponent(offResponse.headers.get("x-openselect-skipped-routes")!)).map((s: any) => s.route)).toEqual(["zai", "minimax"]);
    await offResponse.text();
    const priorCalls = captured.length;
    const oversized = await request(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-openselect-context-window": "2000000" }, body: JSON.stringify({
      model: "coding-auto", max_tokens: 16, messages: [{ role: "user", content: "say OK" }],
    }) });
    expect(oversized.status).toBe(400);
    expect(await oversized.text()).toContain("上下文容量");
    expect(captured.length).toBe(priorCalls);
  } finally {
    upstream.stop(true);
  }
}
await verifyVisionRouting();
