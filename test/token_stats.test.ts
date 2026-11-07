import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-token-stats-"));
process.env.OPENSELECT_DB_PATH = join(process.env.HOME, "token-stats.sqlite");

const {
  getDb,
  logRequest,
  updateRequestTokens,
  updateRequestDuration,
  requestSpeedSamples,
  tokenTotals,
  tokenStatsByProvider,
  tokenStatsByModel,
  tokenStatsByAccount,
  tokenStatsByTime,
} = await import("../src/db");

describe("token 统计 SQL", () => {
  test("输出速度按完整耗时加权，排除历史、估算及失败请求", () => {
    const now = Date.now() + 800 * 24 * 3600_000;
    const add = (outputTokens: number, tokenEstimated: boolean, status = 200) => logRequest({
      ts: now, sessionId: null, model: "speed-model", family: "openai",
      accountId: "speed-account", provider: "opencode-go", status, attempts: 1,
      latencyMs: 100, error: null, path: "/v1/messages", outputTokens,
      inputTokens: 1, totalTokens: outputTokens + 1, tokenEstimated,
    })!;
    try {
      updateRequestDuration(add(100, false), 2000);
      updateRequestDuration(add(100, false), 3000);
      updateRequestDuration(add(900, true), 1000);
      updateRequestDuration(add(900, false, 500), 1000);
      add(900, false); // historical request without completed duration
      const totals = tokenTotals(now, now + 1);
      expect(totals.speedRequests).toBe(2);
      expect(totals.outputTokensPerSecond).toBe(40);
      const samples = requestSpeedSamples(now, now + 1);
      expect(samples.length).toBe(2);
      expect(samples[0]?.waitMs).toBe(100);
      const model = tokenStatsByModel(now, now + 1).find((m) => m.model === "speed-model");
      expect(model?.speedRequests).toBe(2);
      expect(model?.outputTokensPerSecond).toBe(40);
    } finally {
      getDb().query("DELETE FROM requests WHERE ts = ?").run(now);
    }
  });
  test("按供应商/模型/账号/时间聚合，旧行 token 为空不参与", () => {
    // 使用未来时间窗，避免与其它测试文件共享的 SQLite 台账互相污染。
    const now = Date.now() + 400 * 24 * 3600_000;
    try {
    logRequest({
      ts: now - 3000,
      sessionId: "s1",
      model: "deepseek-v4.1-flash",
      servedModel: null,
      family: "openai",
      accountId: "go-1",
      provider: "opencode-go",
      status: 200,
      attempts: 1,
      latencyMs: 100,
      error: null,
      path: "/v1/chat/completions",
      client: "opencode",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      totalTokens: 420,
      tokenEstimated: false,
    });
    const id = logRequest({
      ts: now - 2000,
      sessionId: "s2",
      model: "deepseek-v4.1-flash",
      servedModel: null,
      family: "openai",
      accountId: "cc-1",
      provider: "commandcode",
      status: 200,
      attempts: 1,
      latencyMs: 200,
      error: null,
      path: "/v1/chat/completions",
      client: "opencode",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      tokenEstimated: null,
    });
    expect(id).not.toBeNull();
    updateRequestTokens(id!, {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 60,
      estimated: true,
    });
    // 历史/失败行：无 token
    logRequest({
      ts: now - 1000,
      sessionId: "s3",
      model: "glm-5.3-flash",
      servedModel: null,
      family: "anthropic",
      accountId: "z-1",
      provider: "zai",
      status: 429,
      attempts: 1,
      latencyMs: 50,
      error: "quota",
      path: "/v1/messages",
      client: "claude-code",
    });

    const totals = tokenTotals(now - 5000, now + 1);
    expect(totals.requests).toBe(3);
    expect(totals.tokenRequests).toBe(2);
    expect(totals.estimatedRequests).toBe(1);
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(30);
    expect(totals.cacheReadTokens).toBe(300);
    expect(totals.totalTokens).toBe(480);

    const byProvider = tokenStatsByProvider(now - 5000, now + 1);
    expect(byProvider.find((p) => p.provider === "opencode-go")).toMatchObject({
      requests: 1,
      totalTokens: 420,
    });
    expect(byProvider.find((p) => p.provider === "commandcode")).toMatchObject({
      requests: 1,
      totalTokens: 60,
      estimatedRequests: 1,
    });

    const byModel = tokenStatsByModel(now - 5000, now + 1);
    expect(byModel.find((m) => m.model === "deepseek-v4.1-flash" && m.provider === "opencode-go")).toMatchObject({
      totalTokens: 420,
    });
    const byAccount = tokenStatsByAccount(now - 5000, now + 1);
    expect(byAccount.find((a) => a.accountId === "cc-1")).toMatchObject({ totalTokens: 60 });

    const byTime = tokenStatsByTime(now - 5000, now + 1, "day");
    expect(byTime.reduce((n, x) => n + x.totalTokens, 0)).toBe(480);
    } finally {
      getDb().query("DELETE FROM requests WHERE ts >= ?1").run(now - 5000);
    }
  });
});
