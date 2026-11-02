import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate HOME before importing modules that capture it（bun 的测试文件同进程共享模块注册表）
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-backup-"));

const { createBackup, latestBackup, listBackups, pruneBackups, restoreBackup, verifyBackup } = await import(
  "../src/backup"
);

/**
 * 每个用例用独立的目录（resolvePaths 覆盖），避免与其它测试文件共享
 * ~/.openselect / SQLite 台账（bun 的测试文件同进程共享模块注册表）。
 */
function makeEnv(): {
  dir: string;
  paths: { dir: string; plist: string };
  config: string;
  db: string;
  wired: string;
  plist: string;
  backups: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "openselect-backup-test-"));
  const paths = { dir, plist: join(dir, "com.openselect.agent.plist") };
  const env = {
    dir,
    paths,
    config: join(dir, "config.json"),
    db: join(dir, "data.sqlite"),
    wired: join(dir, "wired.json"),
    plist: paths.plist,
    backups: join(dir, "backups"),
  };
  mkdirSync(env.backups, { recursive: true });
  writeFileSync(
    env.config,
    JSON.stringify({
      version: 1,
      accounts: [{ id: "a1", label: "a1", integration: "opencode-go", key: "oc_sk_test", enabled: true, addedAt: 1 }],
    }),
    { mode: 0o600 },
  );
  writeFileSync(env.wired, JSON.stringify({ models: { "glm-5.2": { baseURL: "x" } } }), { mode: 0o600 });
  writeFileSync(env.plist, "<plist/>\n", { mode: 0o600 });
  const d = new Database(env.db);
  d.exec("PRAGMA journal_mode=WAL");
  d.exec("CREATE TABLE IF NOT EXISTS marker(k TEXT PRIMARY KEY, v TEXT)");
  d.exec("INSERT OR REPLACE INTO marker VALUES ('k','v1')");
  d.close();
  return env;
}

describe("backup / restore", () => {
  test("createBackup：产出 0600 归档 + manifest + sha256 sidecar", async () => {
    const env = makeEnv();
    const r = await createBackup({ paths: env.paths });
    expect(existsSync(r.path)).toBe(true);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${r.path}.sha256`)).toBe(true);
    expect(existsSync(`${r.path}.manifest.json`)).toBe(true);
    const names = r.manifest.files.map((f) => f.name);
    expect(names).toContain("config.json");
    expect(names).toContain("data.sqlite");
    expect(names).toContain("wired.json");
    expect(names).toContain("com.openselect.agent.plist");
    // 台账必须用一致性快照（VACUUM INTO），退化拷贝要在 manifest 里标出来
    expect(r.manifest.files.find((f) => f.name === "data.sqlite")?.snapshotMethod).toBe("vacuum-into");
    const sidecar = readFileSync(`${r.path}.sha256`, "utf8").trim().split(/\s+/)[0];
    expect(sidecar).toBe(r.sha256);
  });

  test("listBackups / latestBackup：按时间倒序，latest 排除「恢复前」安全备份", async () => {
    const env = makeEnv();
    const a = await createBackup({ paths: env.paths, label: "t1" });
    const b = await createBackup({ paths: env.paths, label: "pre-restore" });
    const list = listBackups(env.paths);
    expect(list.length).toBe(2);
    // pre-restore 不得成为 latest
    expect(latestBackup(env.paths)).toBe(a.path);
    expect(list.find((x) => x.path === b.path)?.safety).toBe(true);
  });

  test("verifyBackup：完好的归档通过校验（流式，不落盘）", async () => {
    const env = makeEnv();
    const r = await createBackup({ paths: env.paths });
    const v = await verifyBackup(r.path, env.paths);
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.manifest?.files.length).toBeGreaterThan(0);
    // 校验不得在 OpenSelect 目录留下解包临时目录
    expect(readdirSync(env.dir).filter((n) => n.startsWith("verify-"))).toEqual([]);
  });

  test("verifyBackup：归档被篡改 → 校验失败", async () => {
    const env = makeEnv();
    const r = await createBackup({ paths: env.paths });
    const buf = readFileSync(r.path);
    buf[Math.floor(buf.length / 2)] = (buf[Math.floor(buf.length / 2)]! + 1) % 256;
    writeFileSync(r.path, buf);
    const v = await verifyBackup(r.path, env.paths);
    expect(v.ok).toBe(false);
    expect(v.problems.length).toBeGreaterThan(0);
  });

  test("verifyBackup：manifest 含未知文件 → 拒绝（防路径穿越）", async () => {
    const env = makeEnv();
    // 手工构造一个 manifest 里带越界文件名的归档
    const stage = mkdtempSync(join(tmpdir(), "openselect-evil-"));
    writeFileSync(
      join(stage, "manifest.json"),
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        tool: "openselect",
        files: [{ name: "../../../.ssh/authorized_keys", bytes: 1, sha256: "x".repeat(64) }],
      }),
    );
    const evil = join(env.backups, "evil.tar.gz");
    const t = spawnSync("tar", ["-czf", evil, "-C", stage, "."], { encoding: "utf8" });
    expect(t.status).toBe(0);
    const v = await verifyBackup(evil, env.paths);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("未知文件"))).toBe(true);
  });

  test("restoreBackup：恢复 config/台账/wired，且恢复前生成安全备份", async () => {
    const env = makeEnv();
    const r = await createBackup({ paths: env.paths });
    // 破坏现状
    writeFileSync(env.config, JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });
    writeFileSync(env.wired, JSON.stringify({ models: {} }), { mode: 0o600 });
    const d = new Database(env.db);
    d.exec("DELETE FROM marker");
    d.close();

    const res = await restoreBackup(r.path, { manageService: false, paths: env.paths });
    expect(res.problems).toEqual([]);
    expect(res.safetyBackup).toBeTruthy();
    expect(existsSync(res.safetyBackup!)).toBe(true);
    const cfg = JSON.parse(readFileSync(env.config, "utf8")) as { accounts: Array<{ key: string }> };
    expect(cfg.accounts[0]!.key).toBe("oc_sk_test");
    expect(readFileSync(env.wired, "utf8")).toContain("glm-5.2");
    // 台账内容必须与备份一致（标记行回来）
    const after = new Database(env.db, { readonly: true });
    try {
      const row = after.query("SELECT v FROM marker WHERE k='k'").get() as { v: string } | null;
      expect(row?.v).toBe("v1");
    } finally {
      after.close();
    }
    expect(statSync(env.config).mode & 0o777).toBe(0o600);
  });

  test("restoreBackup：dry-run 不写盘", async () => {
    const env = makeEnv();
    const r = await createBackup({ paths: env.paths });
    writeFileSync(env.config, JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });
    const res = await restoreBackup(r.path, { dryRun: true, manageService: false, paths: env.paths });
    expect(res.restored.length).toBeGreaterThan(0);
    expect(res.safetyBackup).toBeUndefined();
    const cfg = JSON.parse(readFileSync(env.config, "utf8")) as { accounts: unknown[] };
    expect(cfg.accounts).toEqual([]); // 未被恢复
    // 不得留下解包/临时目录
    expect(readdirSync(env.dir).filter((n) => n.startsWith("verify-") || n.startsWith("restore-"))).toEqual([]);
  });

  test("restoreBackup：归档损坏 → 中止且不写回", async () => {
    const env = makeEnv();
    const r = await createBackup({ paths: env.paths });
    const buf = readFileSync(r.path);
    buf[Math.floor(buf.length / 2)] = (buf[Math.floor(buf.length / 2)]! + 1) % 256;
    writeFileSync(r.path, buf);
    writeFileSync(env.config, JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });
    const res = await restoreBackup(r.path, { manageService: false, paths: env.paths });
    expect(res.problems.length).toBeGreaterThan(0);
    expect(res.restored).toEqual([]);
    const cfg = JSON.parse(readFileSync(env.config, "utf8")) as { accounts: unknown[] };
    expect(cfg.accounts).toEqual([]); // 未被覆盖
  });

  test("pruneBackups：保留最新 N 份正式归档（最新一份永不被删）+ 安全备份不占份数", async () => {
    const env = makeEnv();
    const a = await createBackup({ paths: env.paths });
    const b = await createBackup({ paths: env.paths });
    const c = await createBackup({ paths: env.paths });
    const safety = await createBackup({ paths: env.paths, label: "pre-restore" });
    expect(new Set([a.path, b.path, c.path, safety.path]).size).toBe(4); // 毫秒级时间戳：不会互相覆盖
    const removed = pruneBackups(2, env.paths);
    expect(removed.length).toBe(1); // 3 份正式留最新 2 份 + 1 份安全备份留 1 份 → 删 1 份最旧的正式备份
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(`${a.path}.sha256`)).toBe(false);
    expect(existsSync(`${a.path}.manifest.json`)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(c.path)).toBe(true);
    expect(existsSync(safety.path)).toBe(true); // 最新一份安全备份保留
    // 关键契约：最新一份「正式」备份永不被删 → restore latest 始终可用
    expect(existsSync(latestBackup(env.paths)!)).toBe(true);
    // keep=1 时也必须保留最新一份正式备份
    const removed2 = pruneBackups(1, env.paths);
    expect(removed2.length).toBe(1);
    expect(existsSync(c.path)).toBe(true);
    expect(existsSync(latestBackup(env.paths)!)).toBe(true);
    // keep=0 → 不清理
    expect(pruneBackups(0, env.paths)).toEqual([]);
    expect(existsSync(c.path)).toBe(true);
  });

  test("restoreBackup：清除旧 WAL/SHM 残留（否则恢复后的台账损坏）", async () => {
    const env = makeEnv();
    const r = await createBackup({ paths: env.paths });
    writeFileSync(`${env.db}-wal`, "stale-wal-bytes");
    writeFileSync(`${env.db}-shm`, "stale-shm-bytes");
    const res = await restoreBackup(r.path, { manageService: false, paths: env.paths });
    expect(res.problems).toEqual([]);
    expect(existsSync(`${env.db}-wal`)).toBe(false);
    expect(existsSync(`${env.db}-shm`)).toBe(false);
    // 恢复后的台账必须可正常查询（否则报 "database disk image is malformed"）
    const fresh = new Database(env.db, { readonly: true });
    try {
      const rows = fresh.query("SELECT count(*) AS c FROM marker").all() as Array<{ c: number }>;
      expect(rows[0]!.c).toBe(1);
    } finally {
      fresh.close();
    }
  });
});
