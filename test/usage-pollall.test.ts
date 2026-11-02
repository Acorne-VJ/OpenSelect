import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, Config } from "../src/types";

// isolate ~/.openselect before importing modules that capture HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-pollall-"));

const { Runtime } = await import("../src/state");
const { pollAll } = await import("../src/usage");
const { loadCatalog } = await import("../src/catalog");

function mkAccount(id: string, key: string): Account {
  return { id, label: id, integration: "opencode-go", key, enabled: true, addedAt: 0 };
}

test("pollAll polls all enabled accounts in parallel", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer k")) return new Response("bad key", { status: 401 });
      await Bun.sleep(300);
      return Response.json({ usage: { weekly: { percent: 50, status: "ok" } } });
    },
  });
  // 热身：mock 可能刚好绑定到一个刚被回收的端口，而 Bun 的 fetch 连接池里还留着
  // 上一个 server 的失效连接 → 请求会写进死 socket 并挂到超时。
  // 先发一次必定失败的请求把失效连接挤出连接池（失败即忽略）。
  await fetch(`http://127.0.0.1:${upstream.port}/warmup`, { signal: AbortSignal.timeout(1000) }).catch(() => {});
  const cfg: Config = {
    version: 1,
    upstream: { base: `http://127.0.0.1:${upstream.port}` },
    proxy: { host: "127.0.0.1", port: 0 },
    dashboard: { host: "127.0.0.1", port: 0 },
    policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
    monitor: { pollSec: 45 },
    opencode: { autoActivate: false },
    accounts: [mkAccount("u1", "k1"), mkAccount("u2", "k2"), mkAccount("u3", "k3")],
  };
  const rt = new Runtime(cfg, await loadCatalog());

  const started = Date.now();
  const results = await pollAll(rt);
  const elapsed = Date.now() - started;
  upstream.stop(true);

  expect(results.size).toBe(3);
  expect([...results.values()].every((r) => r.ok)).toBe(true);
  // serial would need 3 × 300ms; parallel must queue all three before the first delay finishes
  expect(elapsed).toBeLessThan(600);
  expect(rt.usages.get("u1")?.weekly.percent).toBe(0.5);
  expect(rt.usages.get("u3")?.weekly.percent).toBe(0.5);
});
