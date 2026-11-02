import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate HOME before importing modules that capture it
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-repair-"));

const { migrateSchema, pollutedUsageRows, repairPollutedUsage } = await import("../src/db");
const { USAGE_SCALE_FIXED_AT } = await import("../src/usage");
const { DB_PATH } = await import("../src/config");

test("测试隔离：台账路径必须落在临时目录（不得指向生产 ~/.openselect）", () => {
  expect(DB_PATH).toContain("openselect-");
  expect(DB_PATH.startsWith(tmpdir())).toBe(true);
});

/**
 * 独立台账：用 migrateSchema 建真实 schema，避免触碰共享/生产 SQLite
 * （bun 的测试文件同进程共享模块注册表，config.ts 在 import 时捕获 HOME）。
 */
function makeDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "openselect-repair-db-"));
  const db = new Database(join(dir, "data.sqlite"), { create: true });
  migrateSchema(db);
  return db;
}

const ACCT = "repair-test-acct";

function addRow(
  db: Database,
  weeklyPct: number,
  weeklyStatus: string,
  ts = USAGE_SCALE_FIXED_AT - 60_000, // 默认落在旧解析器生效期内
): void {
  db.query(
    `INSERT INTO usage_snapshots (account_id, ts, rolling_pct, rolling_status, rolling_reset, weekly_pct, weekly_status, weekly_reset, monthly_pct, monthly_status, monthly_reset)
     VALUES (?, ?, 0.1, 'ok', NULL, ?, ?, NULL, 0.2, 'ok', NULL)`,
  ).run(ACCT, ts, weeklyPct, weeklyStatus);
}

function weeklyValues(db: Database): number[] {
  const rows = db
    .query(`SELECT weekly_pct AS p FROM usage_snapshots WHERE account_id = ? ORDER BY id`)
    .all(ACCT) as Array<{ p: number }>;
  return rows.map((r) => r.p).sort((a, b) => a - b);
}

test("repair-usage：只修「值>=1 且 status=ok」的污染行，歧义区间与真实限流行不动", () => {
  const db = makeDb();
  try {
    addRow(db, 1.5, "ok"); // 污染：旧解析器把 2% 放大成 150%
    addRow(db, 1.0, "ok"); // 污染：旧解析器把 1% 放大成 100%
    addRow(db, 1.5, "rate-limited"); // 真实 150%：不得改动
    addRow(db, 0.87, "ok"); // 歧义区间（可能是 0.87% 也可能是 87%）：不得改动

    // dry-run：报告命中，但零写入
    const dry = repairPollutedUsage({ apply: false, db });
    expect(dry.fixed).toBe(0);
    expect(dry.scanned).toBe(2);
    expect(dry.byWindow.weekly).toBe(2);
    expect(dry.accounts).toEqual([ACCT]);
    const mine = pollutedUsageRows(db).filter((r) => r.accountId === ACCT);
    expect(mine).toHaveLength(2); // rate-limited 与 0.87 都不该命中
    expect(mine.every((r) => r.window === "weekly")).toBe(true);
    expect(weeklyValues(db)).toEqual([0.87, 1, 1.5, 1.5]);

    // --apply：污染行按「存值/100」近似还原，其余不动
    const applied = repairPollutedUsage({ apply: true, db });
    expect(applied.fixed).toBe(2);
    const vals = weeklyValues(db);
    expect(vals[0]).toBeCloseTo(0.01); // 1.0 → 0.01
    expect(vals[1]).toBeCloseTo(0.015); // 1.5 → 0.015
    expect(vals[2]).toBeCloseTo(0.87); // 歧义区间不动
    expect(vals[3]).toBeCloseTo(1.5); // 真实限流行不动

    // 修完再扫：没有残留
    expect(repairPollutedUsage({ apply: false, db }).scanned).toBe(0);
  } finally {
    db.close();
  }
});

test("repair-usage：只处理旧解析器生效期内的行（beforeTs 边界）", () => {
  const db = makeDb();
  try {
    // 旧行（修复时刻之前）→ 可修
    addRow(db, 1.0, "ok", USAGE_SCALE_FIXED_AT - 60_000);
    // 新行（修复时刻之后）：即使是「值>=1 且 ok」也不动（可能是上游未来的合法 100%+ok）
    addRow(db, 1.0, "ok", USAGE_SCALE_FIXED_AT + 60_000);
    const r = repairPollutedUsage({ apply: true, db });
    expect(r.scanned).toBe(1);
    expect(r.fixed).toBe(1);
    const vals = weeklyValues(db);
    expect(vals[0]).toBeCloseTo(0.01); // 旧行被修正
    expect(vals[1]).toBeCloseTo(1.0); // 新行不动
  } finally {
    db.close();
  }
});
