import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Account, Config } from "../src/types";

// isolate ~/.openselect before importing modules that capture HOME
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-dash-"));

const { Runtime } = await import("../src/state");
const { startDashboard } = await import("../src/dashboard");
const { insertUsage, usageHistory, logRequest, logSwitch } = await import("../src/db");
const { loadCatalog } = await import("../src/catalog");
const { loadConfig, saveConfig } = await import("../src/config");
const { globalConfigPath } = await import("../src/wire");

type J = Record<string, any>;

async function jpost(base: string, path: string, body?: unknown): Promise<{ status: number; j: J }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, j: (await r.json()) as J };
}

function baseCfg(): Config {
  return {
    version: 1,
    upstream: { base: "http://127.0.0.1:1" },
    proxy: { host: "127.0.0.1", port: 0 },
    dashboard: { host: "127.0.0.1", port: 0 },
    policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
    monitor: { pollSec: 45 },
    opencode: { autoActivate: false },
    accounts: [],
  };
}

function mkAccount(id: string, key: string): Account {
  return { id, label: id, integration: "opencode-go", key, enabled: true, addedAt: 0 };
}

test("dashboard /api/state exposes accounts with usage history; page renders", async () => {
  const cfg: Config = {
    version: 1,
    upstream: { base: "http://127.0.0.1:1" },
    proxy: { host: "127.0.0.1", port: 0 },
    dashboard: { host: "127.0.0.1", port: 0 },
    policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
    monitor: { pollSec: 45 },
    opencode: { autoActivate: false },
    accounts: [mkAccount("d1", "kd1")],
  };
  const rt = new Runtime(cfg, await loadCatalog());

  // seed two snapshots so the history chart has a trend to draw
  const t0 = Date.now() - 90_000;
  insertUsage({
    accountId: "d1",
    ts: t0,
    rolling: { percent: 0.1, status: "active", resetsAt: null },
    weekly: { percent: 0.2, status: "active", resetsAt: null },
    monthly: { percent: 0.3, status: "active", resetsAt: null },
  });
  insertUsage({
    accountId: "d1",
    ts: Date.now(),
    rolling: { percent: 0.4, status: "active", resetsAt: null },
    weekly: { percent: 0.5, status: "active", resetsAt: null },
    monthly: { percent: 0.6, status: "active", resetsAt: null },
  });
  rt.setUsage({
    accountId: "d1",
    ts: Date.now(),
    rolling: { percent: 0.4, status: "active", resetsAt: null },
    weekly: { percent: 0.5, status: "active", resetsAt: null },
    monthly: { percent: 0.6, status: "active", resetsAt: null },
  });
  await saveConfig(cfg);

  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    const r = await fetch(`${base}/api/state`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      policy: { switchAt: number };
      accounts: Array<{ id: string; history: Array<{ rolling: number; weekly: number; monthly: number }> }>;
    };
    expect(j.policy.switchAt).toBe(0.97);
    expect(j.accounts.length).toBe(1);
    const hist = j.accounts[0]!.history;
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist[0]!.rolling).toBe(0.1);
    expect(hist[hist.length - 1]!.monthly).toBe(0.6);

    rt.state("d1").cooldownUntil = Date.now() + 60_000;
    const clr = await jpost(base, "/api/accounts/d1", { clearCooldown: true });
    expect(clr.status).toBe(200);
    expect(rt.state("d1").cooldownUntil).toBe(0);

    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("OpenSelect");
    expect(html).toContain("function spark");
    expect(html).toContain('href="/models"');
    expect(html).toContain('href="/requests"');
    expect(html).toContain('href="/switches"');
    const hz = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; service: string };
    expect(hz).toEqual({ ok: true, service: "openselect-dashboard" });
  } finally {
    dash.stop();
  }
});

test("统计页 /api/stats 汇总模型、账号与时间桶；/stats 可访问", async () => {
  const cfg: Config = {
    version: 1,
    upstream: { base: "http://127.0.0.1:1" },
    proxy: { host: "127.0.0.1", port: 0 },
    dashboard: { host: "127.0.0.1", port: 0 },
    policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
    monitor: { pollSec: 45 },
    opencode: { autoActivate: false },
    accounts: [mkAccount("st1", "kst1")],
  };
  const rt = new Runtime(cfg, await loadCatalog());
  const now = Date.now();
  logRequest({
    ts: now - 3000,
    sessionId: "stats-1",
    model: "stats-model-a",
    servedModel: null,
    family: "openai",
    accountId: "st1",
    status: 200,
    attempts: 1,
    latencyMs: 100,
    error: null,
    path: "/v1/chat/completions",
    client: "stats-test",
  });
  logRequest({
    ts: now - 2000,
    sessionId: "stats-2",
    model: "stats-model-a",
    servedModel: null,
    family: "openai",
    accountId: "st1",
    status: 500,
    attempts: 2,
    latencyMs: 300,
    error: "boom",
    path: "/v1/chat/completions",
    client: "stats-test",
  });
  logRequest({
    ts: now - 1000,
    sessionId: "stats-3",
    model: "stats-model-b",
    servedModel: "free-b",
    family: "openai",
    accountId: "st1",
    status: 200,
    attempts: 1,
    latencyMs: 200,
    error: null,
    path: "/v1/chat/completions",
    client: "stats-test",
  });
  logSwitch({
    ts: now - 500,
    sessionId: "stats-1",
    fromAccount: "st1",
    toAccount: "st2",
    reason: "429",
    detail: "retry-after=60s",
  });
  logSwitch({
    ts: now - 400,
    sessionId: "stats-1",
    fromAccount: "st1",
    toAccount: "st2",
    reason: "policy:least-pressure",
    detail: "pressure=0.1",
  });

  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    const r = await fetch(`${base}/api/stats?range=24h&bucket=hour`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      totals: { requests: number; models: number; accounts: number };
      byModel: Array<{ model: string; requestedModels: string[]; requests: number; ok: number; errors: number; avgLatencyMs: number }>;
      byAccount: Array<{ accountId: string; requests: number }>;
      byModelAccount: Array<{ model: string; accountId: string; requests: number }>;
      byTimeModel: Array<{ bucket: string; key: string; requests: number }>;
      accounts: Array<{ id: string; label: string }>;
      bucket: string;
    };
    const a = j.byModel.find((m) => m.model === "stats-model-a")!;
    expect(a.requests).toBe(2);
    expect(a.ok).toBe(1);
    expect(a.errors).toBe(1);
    expect(a.avgLatencyMs).toBe(200);
    expect(j.byModel.find((m) => m.model === "free-b")!.requestedModels).toContain("stats-model-b");
    expect(j.byAccount.find((x) => x.accountId === "st1")!.requests).toBe(3);
    expect(j.byModelAccount.find((x) => x.model === "stats-model-a" && x.accountId === "st1")!.requests).toBe(2);
    expect(j.byTimeModel.length).toBeGreaterThan(0);
    expect(j.accounts.find((x) => x.id === "st1")!.label).toBe("st1");
    expect(j.bucket).toBe("hour");

    const forced = (await (await fetch(`${base}/api/stats?range=30d&bucket=hour`)).json()) as { bucket: string };
    expect(forced.bucket).toBe("day");

    const html = await (await fetch(`${base}/stats`)).text();
    expect(html).toContain("模型用量");
    expect(html).toContain("账号用量");
    expect(html).toContain("时间 × 模型");

    const modelsHtml = await (await fetch(`${base}/models`)).text();
    expect(modelsHtml).toContain("模型可用性");
    expect(modelsHtml).toContain("只看有差异的模型");

    const reqApi = (await (await fetch(`${base}/api/requests?range=24h&limit=10&model=stats-model-a`)).json()) as {
      total: number;
      rows: Array<{ model: string; status: number }>;
      summary: { requests: number; errors: number };
    };
    expect(reqApi.total).toBe(2);
    expect(reqApi.rows.length).toBe(2);
    expect(reqApi.summary.requests).toBe(2);
    expect(reqApi.summary.errors).toBe(1);

    const swApi = (await (await fetch(`${base}/api/switches?range=24h&from=st1&limit=10&kind=failover`)).json()) as {
      total: number;
      rows: Array<{ reason: string; fromAccount: string }>;
      summary: { total: number; failovers: number; rebinds: number; reasons: Array<{ reason: string; count: number }> };
    };
    expect(swApi.total).toBe(1);
    expect(swApi.rows[0]!.reason).toBe("429");
    expect(swApi.summary.reasons[0]!.reason).toBe("429");
    expect(swApi.summary.failovers).toBe(1);
    expect(swApi.summary.rebinds).toBe(0);

    const swRebind = (await (await fetch(`${base}/api/switches?range=24h&from=st1&limit=10&kind=rebind`)).json()) as {
      total: number;
      rows: Array<{ reason: string }>;
    };
    expect(swRebind.total).toBe(1);
    expect(swRebind.rows[0]!.reason).toBe("policy:least-pressure");

    const reqHtml = await (await fetch(`${base}/requests`)).text();
    expect(reqHtml).toContain("请求流水");
    expect(reqHtml).toContain("上一页");
    const swHtml = await (await fetch(`${base}/switches`)).text();
    expect(swHtml).toContain("切换记录");
    expect(swHtml).toContain("主要原因");
  } finally {
    dash.stop();
  }
});

test("usageHistory clamps to the limit and returns oldest → newest", () => {
  const base = Date.now() - 130_000;
  for (let i = 0; i < 130; i++) {
    insertUsage({
      accountId: "h1",
      ts: base + i * 1000,
      rolling: { percent: i / 130, status: "active", resetsAt: null },
      weekly: { percent: 0, status: "active", resetsAt: null },
      monthly: { percent: 0, status: "active", resetsAt: null },
    });
  }
  const h = usageHistory("h1", 120);
  expect(h.length).toBe(120);
  expect(h[0]!.rolling).toBeCloseTo(10 / 130, 10);
  expect(h[119]!.ts).toBe(base + 129_000);
});

test("console API: add credential-only (non-go) account; toggle/delete go account", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    // google: credential-only — never enters the switch pool
    const g = await jpost(base, "/api/accounts", {
      key: "google-test-key-123456",
      integration: "google",
      label: "google-doc",
      connect: false,
    });
    expect(g.status).toBe(200);
    expect(g.j.added).toBe(true);
    expect(g.j.account.enabled).toBe(false);
    expect(String(g.j.poolHint)).toContain("仅注册");
    const gid = g.j.account.id as string;

    // non-go accounts cannot be toggled
    const tg = await jpost(base, `/api/accounts/${gid}`, { enabled: true });
    expect(tg.status).toBe(400);

    // go account: usage check fails (dead upstream) → added and enabled; runtime handles cooldown/failover
    const go = await jpost(base, "/api/accounts", { key: "go-test-key-123456", label: "go-x", connect: false });
    expect(go.status).toBe(200);
    expect(go.j.added).toBe(true);
    expect(go.j.checkError).toBeTruthy();
    expect(go.j.account.enabled).toBe(true);
    expect(String(go.j.poolHint)).toContain("已启用");
    const planSet = await jpost(base, `/api/accounts/${go.j.account.id}`, { plan: "opencode-plus" });
    expect(planSet.status).toBe(200);
    expect(planSet.j.account.plan).toBe("opencode-plus");
    const goid = go.j.account.id as string;

    // duplicate key: early return, zero side effects — even with default connect=true (AC-CDX r7 #2 / r8 #1 修复)
    const beforeDup = JSON.stringify((await loadConfig()).accounts);
    const dup = await jpost(base, "/api/accounts", { key: "go-test-key-123456", integration: "google" });
    expect(dup.status).toBe(200);
    expect(dup.j.added).toBe(false);
    expect(dup.j.account.integration).toBe("opencode-go");
    expect(dup.j.account.enabled).toBe(true);
    expect(dup.j.usage).toBe(null);
    expect(dup.j.opencode.attempted).toBe(false); // 不触发凭据注册
    const dup2 = await jpost(base, "/api/accounts", { key: "go-test-key-123456" }); // 同类型重复
    expect(dup2.j.added).toBe(false);
    expect(dup2.j.opencode.attempted).toBe(false);
    expect(JSON.stringify((await loadConfig()).accounts)).toBe(beforeDup); // 磁盘零变更

    const on = await jpost(base, `/api/accounts/${goid}`, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.j.account.enabled).toBe(true);
    const off = await jpost(base, `/api/accounts/${goid}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.j.account.enabled).toBe(false);

    const bad = await jpost(base, "/api/accounts", { key: "short" });
    expect(bad.status).toBe(400);

    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    const gAcc = (st.accounts as J[]).find((a) => a.id === gid)!;
    expect(gAcc.status).toBe("仅凭据");
    expect((st.accounts as J[]).some((a) => a.id === goid)).toBe(true);

    const del = await fetch(`${base}/api/accounts/${gid}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const dj = (await del.json()) as J;
    expect(dj.ok).toBe(true);
    expect(dj.removed.id).toBe(gid);
    const st2 = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect((st2.accounts as J[]).some((a) => a.id === gid)).toBe(false);
  } finally {
    dash.stop();
  }
});

test("console API: settings validated, persisted and hot-applied", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    const r1 = await jpost(base, "/api/settings", { switchAt: 0.96, pollSec: 30, autoActivate: true });
    expect(r1.status).toBe(200);
    expect(r1.j.config.switchAt).toBe(0.96);
    expect(r1.j.config.pollSec).toBe(30);
    expect(rt.config.policy.switchAt).toBe(0.96); // hot-applied in memory

    const disk = await loadConfig();
    expect(disk.policy.switchAt).toBe(0.96);
    expect(disk.monitor.pollSec).toBe(30);
    expect(disk.opencode.autoActivate).toBe(true);

    // out of range → rejected
    const r2 = await jpost(base, "/api/settings", { switchAt: 0.9 });
    expect(r2.status).toBe(400);
    const r3 = await jpost(base, "/api/settings", { pollSec: 5 });
    expect(r3.status).toBe(400);
    expect((await loadConfig()).policy.switchAt).toBe(0.96);

    // CSRF guards: reject cross-origin and non-JSON writes (AC-CDX r7 #3 / r8 #2 修复)
    const cfgBefore = JSON.stringify(await loadConfig());
    const csrf = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ switchAt: 0.95, pollSec: 10, autoActivate: false }),
    });
    expect(csrf.status).toBe(403);
    const ct = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ switchAt: 0.95 }),
    });
    expect(ct.status).toBe(415);
    const jsonp = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/jsonp" },
      body: JSON.stringify({ switchAt: 0.95 }),
    });
    expect(jsonp.status).toBe(415); // application/jsonp 不再误通过
    const del403 = await fetch(`${base}/api/accounts/none`, {
      method: "DELETE",
      headers: { origin: "https://attacker.example" },
    });
    expect(del403.status).toBe(403); // DELETE 写端点同样受 Origin 防护
    expect(JSON.stringify(await loadConfig())).toBe(cfgBefore); // 拒绝后完整配置零变更
    const okCase = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=UTF-8", origin: "http://127.0.0.1:8789" },
      body: JSON.stringify({ switchAt: 0.96, pollSec: 30, autoActivate: true }),
    });
    expect(okCase.status).toBe(200); // 大小写 + charset 参数 + 本机 Origin 应被接受

    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st.config.switchAt).toBe(0.96);
  } finally {
    dash.stop();
  }
});

test("console API: freeFirst 写入/校验/去重/回显（EVT-20261020-002 验收 #7）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    // 合法免费模型列表 → 200 + 落盘 + 内存热生效 + /api/state 回显
    const ok = await jpost(base, "/api/settings", {
      freeFirst: ["longcat-2.5-preview-free", "minimax-m3.1-flash-free"],
    });
    expect(ok.status).toBe(200);
    expect(ok.j.config.freeFirst).toEqual(["longcat-2.5-preview-free", "minimax-m3.1-flash-free"]);
    expect(rt.config.policy.freeFirst).toEqual(["longcat-2.5-preview-free", "minimax-m3.1-flash-free"]); // 内存热生效
    expect((await loadConfig()).policy.freeFirst).toEqual([
      "longcat-2.5-preview-free",
      "minimax-m3.1-flash-free",
    ]); // 已落盘
    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st.config.freeFirst).toEqual(["longcat-2.5-preview-free", "minimax-m3.1-flash-free"]);

    // 重复项自动去重
    const dup = await jpost(base, "/api/settings", {
      freeFirst: ["longcat-2.5-preview-free", "longcat-2.5-preview-free"],
    });
    expect(dup.status).toBe(200);
    expect(dup.j.config.freeFirst).toEqual(["longcat-2.5-preview-free"]);

    // 未知模型 → 拒绝（不落盘、不改内存）
    const unknown = await jpost(base, "/api/settings", { freeFirst: ["no-such-model"] });
    expect(unknown.status).toBe(400);
    expect(String(unknown.j.error)).toContain("不在目录中");

    // 付费模型 → 拒绝（防止把付费模型塞进免费列表绕过额度阈值）
    const paid = await jpost(base, "/api/settings", { freeFirst: ["deepseek-v4.1-flash"] });
    expect(paid.status).toBe(400);
    expect(String(paid.j.error)).toContain("不是可替换的免费模型");

    // 非数组 / 含空串 → 拒绝
    const notArray = await jpost(base, "/api/settings", { freeFirst: "longcat-2.5-preview-free" });
    expect(notArray.status).toBe(400);
    expect(String(notArray.j.error)).toContain("模型 ID 数组");
    const withEmpty = await jpost(base, "/api/settings", { freeFirst: ["longcat-2.5-preview-free", "  "] });
    expect(withEmpty.status).toBe(400);
    expect(String(withEmpty.j.error)).toContain("模型 ID 数组");

    // 拒绝后配置零变更
    expect((await loadConfig()).policy.freeFirst).toEqual(["longcat-2.5-preview-free"]);

    // 清空（关闭免费优先）→ 200
    const clear = await jpost(base, "/api/settings", { freeFirst: [] });
    expect(clear.status).toBe(200);
    expect(clear.j.config.freeFirst).toEqual([]);
    expect(rt.config.policy.freeFirst).toEqual([]);
  } finally {
    dash.stop();
  }
});

test("console API: 告警阈值 alertAt 校验/落盘/回显（EVT-20261020-007）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    // 合法值 → 200 + 落盘 + 内存热生效 + /api/state 回显
    const ok = await jpost(base, "/api/settings", { alertAt: [90, 97.5] });
    expect(ok.status).toBe(200);
    expect(ok.j.config.alertAt).toEqual([0.9, 0.975]);
    expect(rt.config.policy.alertAt).toEqual([0.9, 0.975]);
    expect((await loadConfig()).policy.alertAt).toEqual([0.9, 0.975]);
    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st.config.alertAt).toEqual([0.9, 0.975]);

    // 非法值 → 400 且配置零变更
    const before = JSON.stringify(await loadConfig());
    for (const bad of [[0], [151], [-5], [Number.NaN], ["90" as unknown as number]]) {
      const r = await jpost(base, "/api/settings", { alertAt: bad });
      expect(r.status).toBe(400);
      expect(String(r.j.error)).toContain("告警阈值");
    }
    expect(JSON.stringify(await loadConfig())).toBe(before);

    // 非数组 → 400
    const notArray = await jpost(base, "/api/settings", { alertAt: "90" });
    expect(notArray.status).toBe(400);
    expect(JSON.stringify(await loadConfig())).toBe(before);
  } finally {
    dash.stop();
  }
});

test("console API: 分窗口阈值 + 静默时段（EVT-20261020-009）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    // 分窗口阈值 → 落盘 + 回显
    const ok = await jpost(base, "/api/settings", {
      alertAt: [90],
      alertAtByWindow: { weekly: [60, 80], rolling: [], monthly: [95] },
      alertQuiet: { from: "23:00", to: "07:00" },
    });
    expect(ok.status).toBe(200);
    expect(ok.j.config.alertAtByWindow).toEqual({ weekly: [0.6, 0.8], monthly: [0.95] });
    expect(ok.j.config.alertQuiet).toEqual({ from: "23:00", to: "07:00" });
    const disk = await loadConfig();
    expect(disk.policy.alertAtByWindow).toEqual({ weekly: [0.6, 0.8], monthly: [0.95] });
    expect(disk.policy.alertQuiet).toEqual({ from: "23:00", to: "07:00" });

    // 非法值 → 400 且配置零变更
    const before = JSON.stringify(await loadConfig());
    const badWindow = await jpost(base, "/api/settings", { alertAtByWindow: { weekly: [0] } });
    expect(badWindow.status).toBe(400);
    const badWindow2 = await jpost(base, "/api/settings", { alertAtByWindow: { weekly: [151] } });
    expect(badWindow2.status).toBe(400);
    const badQuiet = await jpost(base, "/api/settings", { alertQuiet: { from: "25:00", to: "07:00" } });
    expect(badQuiet.status).toBe(400);
    const badQuiet2 = await jpost(base, "/api/settings", { alertQuiet: { from: "23:00", to: "abc" } });
    expect(badQuiet2.status).toBe(400);
    expect(JSON.stringify(await loadConfig())).toBe(before);

    // 关闭静默（null）→ 200
    const clear = await jpost(base, "/api/settings", { alertQuiet: null });
    expect(clear.status).toBe(200);
    expect(clear.j.config.alertQuiet).toBe(null);
  } finally {
    dash.stop();
  }
});

test("console API: per-account model refresh + wire roundtrip", async () => {
  const up = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "longcat-2.5-preview-free" }, { id: "deepseek-v4-pro" }],
        });
      }
      return new Response("nope", { status: 404 });
    },
  });
  try {
    const cfg = await loadConfig();
    cfg.upstream.base = `http://127.0.0.1:${up.port}`;
    cfg.proxy.port = 8788;
    cfg.accounts = [];
    await saveConfig(cfg);

    // derive the opencode config path from the wire module itself: when the full suite
    // runs in one process, modules can be cached from an earlier file with a different HOME
    const ocPath = globalConfigPath();
    mkdirSync(dirname(ocPath), { recursive: true });
    writeFileSync(
      ocPath,
      JSON.stringify({
        providers: { "opencode-go": { models: { m1: { settings: { baseURL: "https://opencode.ai/inference/go" } } } } },
      }),
    );

    const rt = new Runtime(await loadConfig(), await loadCatalog());
    const dash = startDashboard(rt, { port: 0 });
    const base = `http://127.0.0.1:${dash.server.port}`;
    try {
      const a = await jpost(base, "/api/accounts", { key: "go-models-key-123456", label: "go-m", connect: false });
      expect(a.status).toBe(200);
      expect(a.j.account.enabled).toBe(true); // 用量校验失败也接入即启用，运行期冷却/故障转移
      const aid = a.j.account.id as string;
      const on = await jpost(base, `/api/accounts/${aid}`, { enabled: true });
      expect(on.j.account.enabled).toBe(true);

      const mr = await jpost(base, "/api/models/refresh", {});
      expect(mr.status).toBe(200);
      expect(mr.j.results[aid].ok).toBe(true);
      expect(mr.j.results[aid].count).toBe(2);

      const st = (await (await fetch(`${base}/api/state`)).json()) as J;
      expect(st.models[aid].ids as string[]).toContain("longcat-2.5-preview-free");
      expect((st.catalog as J[]).length).toBeGreaterThan(5);
      expect((st.integrationOptions as J[]).length).toBeGreaterThanOrEqual(8);

      const w = await jpost(base, "/api/wire", {});
      expect(w.status).toBe(200);
      expect(w.j.ok).toBe(true);
      expect(w.j.changed).toBeGreaterThanOrEqual(1);
      expect(readFileSync(ocPath, "utf8")).toContain(":8788");

      const uw = await jpost(base, "/api/unwire", {});
      expect(uw.status).toBe(200);
      expect(uw.j.removed + uw.j.restored).toBeGreaterThanOrEqual(1);
      expect(readFileSync(ocPath, "utf8")).not.toContain(":8788");
    } finally {
      dash.stop();
    }
  } finally {
    up.stop(true);
  }
});

test("console API: 面板默认 payload（空分档 + 空静默）可保存且不清掉已有配置（EVT-20261020-009 回归）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    // 先配置分档与静默
    const setup = await jpost(base, "/api/settings", {
      alertAt: [90],
      alertAtByWindow: { weekly: [60] },
      alertQuiet: { from: "23:00", to: "07:00" },
    });
    expect(setup.status).toBe(200);

    // 面板「默认 payload」：分档三栏为空 + 静默为空 → 语义 = 跟随全局 / 关闭静默
    const payload = {
      switchAt: 0.96,
      pollSec: 30,
      autoActivate: true,
      freeFirst: [],
      alertAt: [90],
      alertAtByWindow: { rolling: [], weekly: [], monthly: [] },
      alertQuiet: null,
    };
    const r = await jpost(base, "/api/settings", payload);
    expect(r.status).toBe(200); // 不得因空静默而整体 400
    const disk = await loadConfig();
    expect(disk.policy.switchAt).toBe(0.96);
    expect(disk.monitor.pollSec).toBe(30);
    expect(disk.policy.alertAtByWindow).toEqual({}); // 空分档 = 跟随全局
    expect(disk.policy.alertQuiet).toBeUndefined(); // 空静默 = 关闭
  } finally {
    dash.stop();
  }
});

test("console API: 备份与签名状态（/api/state.backups + POST /api/backup）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    // /api/state?view=settings 暴露 backups 段（列表 + 信任锚）
    const st = (await (await fetch(`${base}/api/state?view=settings`)).json()) as J;
    expect(st.backups).toBeDefined();
    expect(Array.isArray(st.backups.list)).toBe(true);
    expect(typeof st.backups.hasKey).toBe("boolean");

    // 面板可触发备份（未签名）
    const r = await jpost(base, "/api/backup", { sign: false });
    expect(r.status).toBe(200);
    expect(r.j.ok).toBe(true);
    expect(r.j.signed).toBe(false);
    expect(Array.isArray(r.j.files)).toBe(true);

    // 备份后状态里能看到它
    const st2 = (await (await fetch(`${base}/api/state?view=settings`)).json()) as J;
    expect(st2.backups.list.length).toBeGreaterThan(0);
    expect(st2.backups.list[0].name).toContain(".tar.gz");

    // 非法 JSON → 400（与其它写端点一致，不静默降级）
    const bad = await fetch(`${base}/api/backup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);

    // 跨站写 → 403（CSRF 防护）
    const csrf = await fetch(`${base}/api/backup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ sign: false }),
    });
    expect(csrf.status).toBe(403);

    // 非 JSON Content-Type → 415
    const ct = await fetch(`${base}/api/backup`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(ct.status).toBe(415);
  } finally {
    dash.stop();
  }
});

test("console API: 当前连接可见 + 手动切换账号（forcedAccountId + 会话重绑）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    // /api/state 暴露 current 段（正在服务 / 手动指定 / 活跃会话）
    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st.current).toBeDefined();
    expect(st.current).toHaveProperty("forcedAccountId");
    expect(st.current).toHaveProperty("lastAccountId");
    expect(st.current).toHaveProperty("sessionCount");

    // 手动指定 → 落盘 + 内存生效
    const acc = mkAccount("acc-1", "k1");
    const cfg = await loadConfig();
    cfg.accounts = [acc];
    await saveConfig(cfg);
    rt.config = cfg;
    const ok = await jpost(base, "/api/accounts/force", { accountId: acc.id });
    expect(ok.status).toBe(200);
    expect(ok.j.ok).toBe(true);
    expect(ok.j.forcedAccountId).toBe(acc.id);
    expect(rt.forcedAccountId).toBe(acc.id);
    expect((await loadConfig()).policy.forcedAccountId).toBe(acc.id);

    // 状态回显
    const st2 = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st2.current.forcedAccountId).toBe(acc.id);

    // 解除 → 回到自然策略
    const off = await jpost(base, "/api/accounts/force", { accountId: null });
    expect(off.status).toBe(200);
    expect(rt.forcedAccountId).toBe(null);
    expect((await loadConfig()).policy.forcedAccountId).toBe(null);

    // 非法账号 → 400 且不改动
    const bad = await jpost(base, "/api/accounts/force", { accountId: "nope" });
    expect(bad.status).toBe(400);
    expect((await loadConfig()).policy.forcedAccountId).toBe(null);
  } finally {
    dash.stop();
  }
});

test("console API: 手动切换的边界（已停用账号 400 零变更 / 会话重绑 / 删除账号解除指定）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    const acc = mkAccount("acc-live", "k1");
    const off = mkAccount("acc-off", "k2");
    off.enabled = false;
    const cfg = await loadConfig();
    cfg.accounts = [acc, off];
    await saveConfig(cfg);
    rt.config = cfg;

    // ① 已停用账号 → 400，且配置零变更
    const bad = await jpost(base, "/api/accounts/force", { accountId: off.id });
    expect(bad.status).toBe(400);
    expect((await loadConfig()).policy.forcedAccountId ?? null).toBe(null);
    expect(rt.forcedAccountId).toBe(null);

    // ② 预置两个会话绑定 → 指定账号后立即重绑
    rt.bindSession("sess-a", acc.id);
    rt.bindSession("sess-b", acc.id);
    const ok = await jpost(base, "/api/accounts/force", { accountId: acc.id });
    expect(ok.status).toBe(200);
    expect(rt.getSessionAccount("sess-a")).toBe(acc.id);
    expect(rt.getSessionAccount("sess-b")).toBe(acc.id);
    // 面板统计到的活跃会话数随之更新
    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st.current.sessionCount).toBeGreaterThanOrEqual(2);

    // ③ 删除被指定的账号 → 自动解除指定（不留幽灵账号）
    const del = await fetch(`${base}/api/accounts/${encodeURIComponent(acc.id)}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await loadConfig()).policy.forcedAccountId ?? null).toBe(null);
    expect(rt.forcedAccountId).toBe(null);
  } finally {
    dash.stop();
  }
});

test("console API: 按接入（客户端）指定账号 + 接入流量可见", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    const acc = mkAccount("acc-1", "k1");
    const cfg = await loadConfig();
    cfg.accounts = [acc];
    await saveConfig(cfg);
    rt.config = cfg;

    // /api/state 暴露接入维度（含 6 种已知接入）
    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(Array.isArray(st.clients)).toBe(true);
    expect(st.clients.length).toBeGreaterThanOrEqual(6);
    const oc = st.clients.find((c: J) => c.kind === "opencode");
    expect(oc).toBeDefined();
    expect(oc.label).toBe("opencode");
    expect(oc.pinnedAccountId).toBe(null);

    // 指定 opencode 接入 → 落盘 + 回显
    const ok = await jpost(base, "/api/clients/pin", { client: "opencode", accountId: acc.id });
    expect(ok.status).toBe(200);
    expect(ok.j.ok).toBe(true);
    expect(ok.j.pinnedAccountId).toBe(acc.id);
    expect((await loadConfig()).policy.clientAccounts?.opencode).toBe(acc.id);
    const st2 = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st2.clients.find((c: J) => c.kind === "opencode").pinnedAccountId).toBe(acc.id);

    // 解除 → 回到未指定
    const off = await jpost(base, "/api/clients/pin", { client: "opencode", accountId: null });
    expect(off.status).toBe(200);
    expect((await loadConfig()).policy.clientAccounts?.opencode).toBeUndefined();

    // 非法接入类型 / 不存在的账号 → 400 且配置零变更
    const badKind = await jpost(base, "/api/clients/pin", { client: "bogus", accountId: acc.id });
    expect(badKind.status).toBe(400);
    const badAcc = await jpost(base, "/api/clients/pin", { client: "opencode", accountId: "nope" });
    expect(badAcc.status).toBe(400);
    expect((await loadConfig()).policy.clientAccounts?.opencode).toBeUndefined();

    // 删除被指定的账号 → 一并清掉接入指定（不留幽灵引用，AC-CDX P2-1）
    await jpost(base, "/api/clients/pin", { client: "opencode", accountId: acc.id });
    expect((await loadConfig()).policy.clientAccounts?.opencode).toBe(acc.id);
    const del = await fetch(`${base}/api/accounts/${encodeURIComponent(acc.id)}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await loadConfig()).policy.clientAccounts?.opencode).toBeUndefined();
    const st3 = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st3.clients.find((c: J) => c.kind === "opencode").pinnedAccountId).toBe(null);
  } finally {
    dash.stop();
  }
});


test("接入统计：只认成功请求的服务账号（失败请求的 account_id 是尝试链，不是账号）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    const acc = mkAccount("acc-ok", "k1");
    const cfg = await loadConfig();
    cfg.accounts = [acc];
    await saveConfig(cfg);
    rt.config = cfg;

    const now = Date.now();
    // 成功请求：真实账号 id
    logRequest({
      ts: now - 1000, sessionId: "s1", model: "glm-5.2", servedModel: null, family: "openai",
      accountId: acc.id, status: 200, attempts: 1, latencyMs: 10, error: null, path: "/v1/chat/completions",
      client: "opencode",
    });
    // 失败请求：account_id 记的是尝试链 "a → b"（历史格式）
    logRequest({
      ts: now, sessionId: "s2", model: "glm-5.2", servedModel: null, family: "openai",
      accountId: "acc-x → acc-y", status: 404, attempts: 2, latencyMs: 20, error: "Endpoint is unavailable",
      path: "/v1/chat/completions", client: "opencode",
    });

    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    const oc = st.clients.find((c: J) => c.kind === "opencode");
    expect(oc.requests).toBe(2);
    // 服务账号取**成功**请求里的真实账号 id，不接受尝试链
    expect(oc.lastAccountId).toBe(acc.id);
    expect(oc.lastAccountLabel).toBe(acc.id);
  } finally {
    dash.stop();
  }
});

test("console API: 免费模型的可选/优先级/模式（面板「免费模型」区块的写入面）", async () => {
  const rt = new Runtime(baseCfg(), await loadCatalog());
  const dash = startDashboard(rt, { port: 0 });
  const base = `http://127.0.0.1:${dash.server.port}`;
  try {
    // 页面含编辑器容器
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('id="freeRows"');
    expect(html).toContain('id="freeMode"');
    expect(html).toContain('id="freeSave"');
    expect(html).toContain('id="showAllAccounts" checked');
    expect(html).toContain('id="credRows"');
    const connectHtml = await (await fetch(`${base}/connect`)).text();
    expect(connectHtml).toContain("接入控制");
    const settingsHtml = await (await fetch(`${base}/settings`)).text();
    expect(settingsHtml).toContain("参数设置");
    const routesHtml = await (await fetch(`${base}/routes`)).text();
    expect(routesHtml).toContain("线路优化");
    const routesApi = (await (await fetch(`${base}/api/routes`)).json()) as J;
    expect(routesApi.providers.length).toBe(6);
    expect(routesApi.plans.length).toBeGreaterThan(5);
    expect(routesApi.scoring.qualityWeight).toBe(0.2);
    expect(routesApi.candidates[0]).toHaveProperty("latencyScore");

    // 状态里有模式与候选（面板下拉框的回显来源）
    const st = (await (await fetch(`${base}/api/state`)).json()) as J;
    expect(st.config).toHaveProperty("freeFirstMode");
    expect(st.config).toHaveProperty("freeFirst");
    // 目录里的免费模型带端点类型（chat / responses）
    const freeCat = (st.catalog as J[]).filter((m) => m.free);
    expect(freeCat.length).toBeGreaterThan(0);
    for (const m of freeCat) expect(["chat", "responses"]).toContain(m.api);

    // 保存：选定候选 + 顺序 + 模式
    const ok = await jpost(base, "/api/settings", {
      freeFirst: ["minimax-m3.1-flash-free", "longcat-2.5-preview-free"],
      freeFirstMode: "fallback",
    });
    expect(ok.status).toBe(200);
    expect(ok.j.ok).toBe(true);
    const cfg = await loadConfig();
    expect(cfg.policy.freeFirst).toEqual(["minimax-m3.1-flash-free", "longcat-2.5-preview-free"]);
    expect(cfg.policy.freeFirstMode).toBe("fallback");

    // 模式非法 → 400 且配置零变更
    const bad = await jpost(base, "/api/settings", { freeFirstMode: "bogus" });
    expect(bad.status).toBe(400);
    expect((await loadConfig()).policy.freeFirstMode).toBe("fallback");

    // 不可中转的模型 → 400（目录里没有 / 非 openai-chat 家族）
    const badModel = await jpost(base, "/api/settings", { freeFirst: ["no-such-model-xyz"] });
    expect(badModel.status).toBe(400);
    expect((await loadConfig()).policy.freeFirst).toEqual(["minimax-m3.1-flash-free", "longcat-2.5-preview-free"]);

    // 关闭模式（清空候选）
    const off = await jpost(base, "/api/settings", { freeFirst: [], freeFirstMode: "off" });
    expect(off.status).toBe(200);
    expect((await loadConfig()).policy.freeFirst).toEqual([]);
    expect((await loadConfig()).policy.freeFirstMode).toBe("off");
  } finally {
    dash.stop();
  }
}, 15000);
