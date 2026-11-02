import { describe, expect, test } from "bun:test";
import { accountPressure, eligibility, isRateLimited, pickAccount, PRESSURE_MAX } from "../src/policy";
import { parseWindow, USAGE_PERCENT_MAX } from "../src/usage";
import type { Account, AccountState, AccountUsage } from "../src/types";

const NOW = 1_000_000;

function mkAccount(id: string, enabled = true): Account {
  return { id, label: id, integration: "opencode-go", key: `key-${id}`, enabled, addedAt: 0 };
}

function mkUsage(rolling: number, weekly: number, monthly: number, status = "active"): AccountUsage {
  const w = (p: number) => ({ percent: p, status, resetsAt: null });
  return { accountId: "x", ts: 0, rolling: w(rolling), weekly: w(weekly), monthly: w(monthly) };
}

function mkState(accountId: string, over: Partial<AccountState> = {}): AccountState {
  return { accountId, cooldownUntil: 0, lastError: null, lastUsed: 0, invalid: false, ...over };
}

describe("accountPressure / isRateLimited", () => {
  test("pressure = max window", () => {
    expect(accountPressure(mkUsage(0.1, 0.5, 0.3))).toBeCloseTo(0.5);
    expect(accountPressure(undefined)).toBe(0);
  });
  test("压力上限 PRESSURE_MAX 与用量展示上限 USAGE_PERCENT_MAX 是两个不同的数（OI-001 锁定）", () => {
    // 压力上限用于排序饱和：>=100% 的压力一律按 PRESSURE_MAX 计
    expect(accountPressure(mkUsage(0, 1.5, 0))).toBeCloseTo(PRESSURE_MAX);
    expect(accountPressure(mkUsage(0, 99, 0))).toBeCloseTo(PRESSURE_MAX);
    // 两个上限语义不同，禁止被"对齐"成同一个值
    expect(PRESSURE_MAX).not.toBe(USAGE_PERCENT_MAX);
    expect(PRESSURE_MAX).toBe(1.2);
    expect(USAGE_PERCENT_MAX).toBe(1.5);
  });
  test("rate-limited by status or 100%", () => {
    expect(isRateLimited(mkUsage(0.1, 0.5, 0.3))).toBe(false);
    expect(isRateLimited(mkUsage(0.1, 1.0, 0.3))).toBe(true);
    expect(isRateLimited(mkUsage(0.1, 0.5, 0.3, "rate-limited"))).toBe(true);
  });
});

describe("eligibility", () => {
  const acc = mkAccount("a1");
  test("disabled / invalid / cooldown / threshold", () => {
    expect(eligibility(mkAccount("a1", false), undefined, undefined, { free: false, now: NOW, switchAt: 0.97 }).eligible).toBe(false);
    expect(eligibility(acc, mkState("a1", { invalid: true }), undefined, { free: false, now: NOW, switchAt: 0.97 }).eligible).toBe(false);
    expect(eligibility(acc, mkState("a1", { cooldownUntil: NOW + 1000 }), undefined, { free: false, now: NOW, switchAt: 0.97 }).eligible).toBe(false);
    expect(eligibility(acc, mkState("a1"), mkUsage(0, 0.98, 0), { free: false, now: NOW, switchAt: 0.97 }).eligible).toBe(false);
  });
  test("free bypasses quota checks", () => {
    expect(eligibility(acc, mkState("a1", { cooldownUntil: NOW + 1000 }), mkUsage(0, 1, 0), { free: true, now: NOW, switchAt: 0.97 }).eligible).toBe(true);
  });
});

describe("parseWindow → policy 接缝（EVT-20261020-001 回归）", () => {
  test("2% 的 weekly 用量不得被判为限流或触发阈值切换", () => {
    const usage: AccountUsage = {
      accountId: "x",
      ts: 0,
      rolling: parseWindow({ percent: 5, status: "ok" }),
      weekly: parseWindow({ percent: 2, status: "ok" }),
      monthly: parseWindow({ percent: 78, status: "ok" }),
    };
    expect(isRateLimited(usage)).toBe(false);
    expect(accountPressure(usage)).toBeCloseTo(0.78);
    expect(eligibility(mkAccount("a1"), mkState("a1"), usage, { free: false, now: NOW, switchAt: 0.97 }).eligible).toBe(true);
  });
});

describe("pickAccount", () => {
  const accounts = [mkAccount("a1"), mkAccount("a2"), mkAccount("a3")];
  const states = new Map<string, AccountState>([
    ["a1", mkState("a1", { lastUsed: 300 })],
    ["a2", mkState("a2", { lastUsed: 200 })],
    ["a3", mkState("a3", { lastUsed: 100 })],
  ]);
  const usages = new Map<string, AccountUsage>([
    ["a1", mkUsage(0, 0.1, 0)],
    ["a2", mkUsage(0, 0.2, 0)],
    ["a3", mkUsage(0, 0.3, 0)],
  ]);

  test("sticky session wins when eligible", () => {
    const d = pickAccount({ accounts, states, usages, sessionAccount: "a3", free: false, now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a3");
    expect(d?.reason).toBe("sticky");
  });

  test("sticky over-threshold falls back to least pressure", () => {
    const u2 = new Map(usages);
    u2.set("a3", mkUsage(0, 0.98, 0));
    const d = pickAccount({ accounts, states, usages: u2, sessionAccount: "a3", free: false, now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a1");
    expect(d?.reason).toBe("least-pressure");
  });

  test("least-pressure then least-recently-used", () => {
    const u2 = new Map(usages);
    u2.set("a1", mkUsage(0, 0.2, 0));
    u2.set("a2", mkUsage(0, 0.2, 0));
    u2.set("a3", mkUsage(0, 0.05, 0));
    const d = pickAccount({ accounts, states, usages: u2, free: false, now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a3"); // lowest pressure despite most recent use
    const u3 = new Map(usages);
    u3.set("a1", mkUsage(0, 0.5, 0));
    u3.set("a2", mkUsage(0, 0.5, 0));
    u3.set("a3", mkUsage(0, 0.5, 0));
    const d2 = pickAccount({ accounts, states, usages: u3, free: false, now: NOW, switchAt: 0.97 });
    expect(d2?.accountId).toBe("a3"); // tie → least recently used (100)
  });

  test("exclude respected", () => {
    const d = pickAccount({ accounts, states, usages, free: false, exclude: new Set(["a1"]), now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a2");
  });

  test("fallback when everything drained: prefers lowest cooldown", () => {
    const u2 = new Map(usages);
    for (const id of ["a1", "a2", "a3"]) u2.set(id, mkUsage(0, 1, 0, "rate-limited"));
    const s2 = new Map(states);
    s2.set("a1", mkState("a1", { cooldownUntil: NOW + 50_000 }));
    s2.set("a2", mkState("a2", { cooldownUntil: NOW + 5_000 }));
    s2.set("a3", mkState("a3", { cooldownUntil: NOW + 9_000 }));
    const d = pickAccount({ accounts, states: s2, usages: u2, free: false, now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a2");
    expect(d?.reason).toBe("fallback");
  });

  test("fallback：健康账号的 3s 冷却优先于已限流但 cooldown=0 的账号", () => {
    const accounts2 = [mkAccount("a1"), mkAccount("a2")];
    const states2 = new Map<string, AccountState>([
      ["a1", mkState("a1", { cooldownUntil: NOW + 3_000 })],
      ["a2", mkState("a2", { cooldownUntil: 0 })],
    ]);
    const usages2 = new Map<string, AccountUsage>([
      ["a1", mkUsage(0.1, 0.8, 0.5)],
      ["a2", mkUsage(0, 1, 0, "rate-limited")],
    ]);
    const d = pickAccount({ accounts: accounts2, states: states2, usages: usages2, free: false, now: NOW, switchAt: 0.99 });
    expect(d?.accountId).toBe("a1");
    expect(d?.reason).toBe("fallback");
  });

  test("free request can use cooling account", () => {
    const s2 = new Map(states);
    s2.set("a1", mkState("a1", { cooldownUntil: NOW + 50_000 }));
    const d = pickAccount({ accounts, states: s2, usages, sessionAccount: "a1", free: true, now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a1");
    expect(d?.reason).toBe("sticky");
  });

  test("disabled and invalid are never picked", () => {
    const accs = [mkAccount("a1", false), mkAccount("a2")];
    const s2 = new Map<string, AccountState>([["a2", mkState("a2", { invalid: true })]]);
    const d = pickAccount({ accounts: accs, states: s2, usages: new Map(), free: false, now: NOW, switchAt: 0.97 });
    expect(d).toBeNull();
  });
});

describe("手动指定账号（forced）", () => {
  test("forced 账号优先于 sticky 与 least-pressure", () => {
    const accounts = [mkAccount("a1"), mkAccount("a2")];
    const states = new Map<string, AccountState>([
      ["a1", mkState("a1", { lastUsed: 300 })],
      ["a2", mkState("a2", { lastUsed: 100 })],
    ]);
    const usages = new Map<string, AccountUsage>([
      ["a1", mkUsage(0, 0.1, 0)],
      ["a2", mkUsage(0, 0.2, 0)],
    ]);
    // 强制 a1（压力更低），但 sticky 指向 a2 → 强制应优先
    const d = pickAccount({
      accounts,
      states,
      usages,
      sessionAccount: "a2",
      forcedAccountId: "a1",
      free: false,
      now: NOW,
      switchAt: 0.97,
    });
    expect(d?.accountId).toBe("a1");
    expect(d?.reason).toBe("forced");
  });

  test("forced 账号被停用/失效 → 忽略强制，回退自然策略", () => {
    const accounts = [mkAccount("a1"), mkAccount("a2")];
    const states = new Map<string, AccountState>([
      ["a1", mkState("a1", { invalid: true })],
      ["a2", mkState("a2", { lastUsed: 100 })],
    ]);
    const usages = new Map<string, AccountUsage>([
      ["a1", mkUsage(0, 0.1, 0)],
      ["a2", mkUsage(0, 0.2, 0)],
    ]);
    const d = pickAccount({
      accounts,
      states,
      usages,
      forcedAccountId: "a1", // Key 失效 → 不可选
      free: false,
      now: NOW,
      switchAt: 0.97,
    });
    expect(d?.accountId).toBe("a2");
    expect(d?.reason).not.toBe("forced");
  });
});

describe("手动指定账号的失效回退（AC-CDX P2-3 补测）", () => {
  const accounts = [mkAccount("a1"), mkAccount("a2")];
  const usages = new Map<string, AccountUsage>([
    ["a1", mkUsage(0, 0.1, 0)],
    ["a2", mkUsage(0, 0.2, 0)],
  ]);

  test("forced 账号处于冷却中 → 忽略强制，回退到其他可用账号", () => {
    const states = new Map<string, AccountState>([
      ["a1", mkState("a1", { cooldownUntil: NOW + 60_000 })],
      ["a2", mkState("a2")],
    ]);
    const d = pickAccount({ accounts, states, usages, forcedAccountId: "a1", free: false, now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a2");
    expect(d?.reason).not.toBe("forced");
  });

  test("forced 账号已限流（用量 100%）→ 忽略强制，回退到其他可用账号", () => {
    const u = new Map<string, AccountUsage>([
      ["a1", mkUsage(0, 1, 0)],
      ["a2", mkUsage(0, 0.2, 0)],
    ]);
    const states = new Map<string, AccountState>([["a1", mkState("a1")], ["a2", mkState("a2")]]);
    const d = pickAccount({ accounts, states, usages: u, forcedAccountId: "a1", free: false, now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a2");
    expect(d?.reason).not.toBe("forced");
  });

  test("forced 账号超阈值（98% ≥ switchAt 97%）→ 忽略强制，回退到其他可用账号", () => {
    const u = new Map<string, AccountUsage>([
      ["a1", mkUsage(0, 0.98, 0)],
      ["a2", mkUsage(0, 0.2, 0)],
    ]);
    const states = new Map<string, AccountState>([["a1", mkState("a1")], ["a2", mkState("a2")]]);
    const d = pickAccount({ accounts, states, usages: u, forcedAccountId: "a1", free: false, now: NOW, switchAt: 0.97 });
    expect(d?.accountId).toBe("a2");
    expect(d?.reason).not.toBe("forced");
  });
});

describe("按接入指定账号（client-pinned）", () => {
  test("接入指定优先于全局指定与会话粘性", () => {
    const accounts = [mkAccount("a1"), mkAccount("a2")];
    const states = new Map<string, AccountState>([
      ["a1", mkState("a1", { lastUsed: 300 })],
      ["a2", mkState("a2", { lastUsed: 100 })],
    ]);
    const usages = new Map<string, AccountUsage>([
      ["a1", mkUsage(0, 0.1, 0)],
      ["a2", mkUsage(0, 0.2, 0)],
    ]);
    const d = pickAccount({
      accounts,
      states,
      usages,
      sessionAccount: "a1", // 会话粘性指向 a1
      forcedAccountId: "a1", // 全局指定也指向 a1
      clientAccountId: "a2", // 接入指定指向 a2 → 最具体，胜出
      free: false,
      now: NOW,
      switchAt: 0.97,
    });
    expect(d?.accountId).toBe("a2");
    expect(d?.reason).toBe("client-pinned");
  });

  test("接入指定的账号不可用 → 回退到全局指定 / 自然策略", () => {
    const accounts = [mkAccount("a1"), mkAccount("a2")];
    const states = new Map<string, AccountState>([
      ["a1", mkState("a1", { invalid: true })],
      ["a2", mkState("a2")],
    ]);
    const usages = new Map<string, AccountUsage>([
      ["a1", mkUsage(0, 0.1, 0)],
      ["a2", mkUsage(0, 0.2, 0)],
    ]);
    const d = pickAccount({
      accounts,
      states,
      usages,
      clientAccountId: "a1", // Key 失效 → 忽略
      forcedAccountId: "a2",
      free: false,
      now: NOW,
      switchAt: 0.97,
    });
    expect(d?.accountId).toBe("a2");
    expect(d?.reason).toBe("forced");
  });
});
