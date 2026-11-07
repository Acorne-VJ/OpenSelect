import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "openselect-token-cache-"));
process.env.OPENSELECT_DB_PATH = join(temp, "data.sqlite");
const { getDb, logRequest, updateRequestTokens, tokenTotals, tokenStatsByModel, tokenStatsByProvider, tokenStatsByAccount, tokenStatsByClient } = await import("../src/db");
const { buildTokenStats } = await import("../src/token_stats");
const rt = { config: { accounts: [] } } as unknown as import("../src/state").Runtime;
const url = new URL("http://localhost/api/tokens?range=24h&bucket=hour");

test("token snapshot cache invalidates for new requests and local and external updates", async () => {
  const id = logRequest({ ts: Date.now(), sessionId: "cache-test", model: "deepseek-v4.1-flash", family: "openai", accountId: "a", provider: "opencode-go", status: 200, attempts: 1, latencyMs: 1, error: null, path: "/v1/messages" })!;
  const first = await buildTokenStats(rt, url);
  const second = await buildTokenStats(rt, url);
  expect(second.speedAnalysis).toBe(first.speedAnalysis);
  expect(second.byTime).toBe(second.rhythm);
  updateRequestTokens(id, { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, total: 13 });
  const local = await buildTokenStats(rt, url);
  expect(local.speedAnalysis).not.toBe(first.speedAnalysis);
  // Other test files may have opened the shared db singleton first. Assert the
  // change to this request rather than assuming that the whole window is empty.
  expect(local.totals.outputTokens).toBe(first.totals.outputTokens + 3);
  const external = new Database(getDb().filename);
  try { external.query("UPDATE requests SET output_tokens=7 WHERE id=?").run(id); }
  finally { external.close(); }
  const updated = await buildTokenStats(rt, url);
  expect(updated.totals.outputTokens).toBe(first.totals.outputTokens + 7);
  logRequest({ ts: Date.now(), sessionId: "cache-test-2", model: "deepseek-v4.1-flash", family: "openai", accountId: "a", provider: "opencode-go", status: 200, attempts: 1, latencyMs: 1, error: null, path: "/v1/messages" });
  const newRow = await buildTokenStats(rt, url);
  expect(newRow.totals.requests).toBe(first.totals.requests + 1);
  const { costUsd: _, ...totals } = newRow.totals;
  expect(totals).toEqual(tokenTotals(newRow.since, newRow.now + 1));
  expect(newRow.byModel.map(({ costUsd: _, ...v }) => v)).toEqual(tokenStatsByModel(newRow.since, newRow.now + 1));
  expect(newRow.byProvider.map(({ costUsd: _, ...v }) => v)).toEqual(tokenStatsByProvider(newRow.since, newRow.now + 1));
  expect(newRow.byAccount).toEqual(tokenStatsByAccount(newRow.since, newRow.now + 1));
  expect(newRow.byClient).toEqual(tokenStatsByClient(newRow.since, newRow.now + 1));
  expect(getDb()).toBeDefined();
});

test("combined grouping preserves legacy SQL semantics for NULLs, renamed models and ties", async () => {
  const db = getDb();
  const ts = Date.now() - 1500;
  const insert = db.query(`INSERT INTO requests
    (ts, model, served_model, provider, account_id, client, status, latency_ms,
     input_tokens, output_tokens, cache_read_tokens, cache_read_known, total_tokens, token_estimated, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
    insert.run(ts, "auto", "B", null, null, null, 200, null, 2, 3, 5, 1, 10, 0, 500);
    insert.run(ts + 1, "auto", "A", "", "", "", 200, 30, 3, 4, 0, 0, 7, 1, 100);
    insert.run(ts + 2, "z", "A", "zai", "a", "cli", 429, 40, null, null, null, null, null, null, null);
    const out = await buildTokenStats(rt, url);
    const { costUsd: _, ...totals } = out.totals;
    expect(totals).toEqual(tokenTotals(out.since, out.now + 1));
    expect(out.byModel.map(({ costUsd: _, ...v }) => v)).toEqual(tokenStatsByModel(out.since, out.now + 1));
    expect(out.byProvider.map(({ costUsd: _, ...v }) => v)).toEqual(tokenStatsByProvider(out.since, out.now + 1));
    expect(out.byAccount).toEqual(tokenStatsByAccount(out.since, out.now + 1));
    expect(out.byClient).toEqual(tokenStatsByClient(out.since, out.now + 1));
  } finally { db.query("DELETE FROM requests WHERE ts>=? AND ts<=? AND session_id IS NULL").run(ts, ts + 2); }
});
