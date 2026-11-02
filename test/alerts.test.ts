import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate HOME before importing modules that capture it
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-alerts-"));

const { migrateSchema, recentAlerts } = await import("../src/db");
const { checkUsageAlerts } = await import("../src/alerts");

import type { AccountUsage } from "../src/types";

/**
 * 告警判定依赖台账（去重/重新武装）→ 测试用独立台账（migrateSchema 建真实 schema），
 * 通过 checkUsageAlerts 的 db 注入参数传入，完全不触碰共享/生产 SQLite。
 */
const TMP = mkdtempSync(join(tmpdir(), "openselect-alerts-db-"));
const alertDb = new Database(join(TMP, "alerts.sqlite"), { create: true });
migrateSchema(alertDb);
const LOG_PATH = join(TMP, "alert.log");

function usage(over: Partial<AccountUsage["rolling"]> = {}): AccountUsage {
  return {
    accountId: "alerts-acct",
    ts: Date.now(),
    rolling: { percent: 0.1, status: "ok", resetsAt: null, ...over },
    weekly: { percent: 0.1, status: "ok", resetsAt: null },
    monthly: { percent: 0.1, status: "ok", resetsAt: null },
  };
}

test("告警：越过阈值触发一次；持续越线不重复；回落后再越线会重新触发（历史行保留）", () => {
  const seen: string[] = [];
  const notify = (title: string, message: string) => seen.push(`${title}|${message}`);
  const thresholds = [0.9, 0.95, 0.97];

  // 未越线 → 不告警
  expect(checkUsageAlerts("alerts-acct", usage({ percent: 0.5 }), thresholds, { notify, db: alertDb, logPath: LOG_PATH })).toEqual([]);
  expect(seen).toEqual([]);

  // 越过 90% → 触发一档（一个轮询周期合并成一条通知）
  const fired = checkUsageAlerts("alerts-acct", usage({ percent: 0.92 }), thresholds, { notify, db: alertDb, logPath: LOG_PATH });
  expect(fired).toHaveLength(1);
  expect(fired[0]!.threshold).toBe(0.9);
  expect(seen).toHaveLength(1);
  const rows1 = recentAlerts(20, alertDb).filter((a) => a.accountId === "alerts-acct");
  expect(rows1).toHaveLength(1);
  expect(rows1[0]!.active).toBe(true);
  expect(existsSync(LOG_PATH)).toBe(true);
  expect(readFileSync(LOG_PATH, "utf8")).toContain("account=alerts-acct");

  // 持续越线 → 不重复告警
  expect(checkUsageAlerts("alerts-acct", usage({ percent: 0.93 }), thresholds, { notify, db: alertDb, logPath: LOG_PATH })).toEqual([]);
  expect(seen).toHaveLength(1);
  expect(recentAlerts(20, alertDb).filter((a) => a.accountId === "alerts-acct")).toHaveLength(1);

  // 回落到阈值以下 → 解除该档（历史行保留，仅 active=0）
  expect(checkUsageAlerts("alerts-acct", usage({ percent: 0.5 }), thresholds, { notify, db: alertDb, logPath: LOG_PATH })).toEqual([]);
  expect(seen).toHaveLength(1);
  const rows2 = recentAlerts(20, alertDb).filter((a) => a.accountId === "alerts-acct");
  expect(rows2).toHaveLength(1); // 历史行未被删除
  expect(rows2[0]!.active).toBe(false);

  // 再次越线 → 重新告警（新增一行）
  const again = checkUsageAlerts("alerts-acct", usage({ percent: 0.95 }), thresholds, { notify, db: alertDb, logPath: LOG_PATH });
  expect(again.map((a) => a.threshold).sort()).toEqual([0.9, 0.95]);
  expect(seen).toHaveLength(2);
  expect(recentAlerts(20, alertDb).filter((a) => a.accountId === "alerts-acct")).toHaveLength(3);
});

test("告警：多档阈值同时越过时逐档各记一条，但只发一条合并通知", () => {
  const seen: string[] = [];
  const notify = (_t: string, m: string) => seen.push(m);
  const fired = checkUsageAlerts("alerts-acct-2", usage({ percent: 0.99 }), [0.9, 0.95, 0.97], {
    notify,
    db: alertDb,
    logPath: LOG_PATH,
  });
  expect(fired.map((a) => a.threshold)).toEqual([0.9, 0.95, 0.97]);
  expect(seen).toHaveLength(1); // 合并成一条
  expect(seen[0]).toContain("alerts-acct-2");
  expect(recentAlerts(20, alertDb).filter((a) => a.accountId === "alerts-acct-2")).toHaveLength(3);
});

test("告警：冷却期内不重复告警（阈值附近抖动）", () => {
  const seen: string[] = [];
  const notify = (_t: string, m: string) => seen.push(m);
  const opts = { notify, db: alertDb, logPath: LOG_PATH, cooldownSec: 3600 };
  expect(checkUsageAlerts("alerts-acct-3", usage({ percent: 0.92 }), [0.9], opts)).toHaveLength(1);
  expect(seen).toHaveLength(1);
  // 回落 → 解除
  expect(checkUsageAlerts("alerts-acct-3", usage({ percent: 0.5 }), [0.9], opts)).toEqual([]);
  // 冷却期内再次越线 → 静默（不新增通知，但历史行仍在）
  expect(checkUsageAlerts("alerts-acct-3", usage({ percent: 0.93 }), [0.9], opts)).toEqual([]);
  expect(seen).toHaveLength(1);
  expect(recentAlerts(20, alertDb).filter((a) => a.accountId === "alerts-acct-3")).toHaveLength(1);
});
