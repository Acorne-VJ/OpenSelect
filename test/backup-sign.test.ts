import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate HOME before importing modules that capture it
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-sign-"));

const { createBackup, fetchBackupsFromRemote, pushBackupToRemote, verifyBackup } = await import("../src/backup");
const { generateSigningKey, PRIVATE_KEY_PATH, PUBLIC_KEY_PATH } = await import("../src/keys");
const { migrateSchema } = await import("../src/db");

function makeEnv(): { paths: { dir: string; plist: string }; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "openselect-sign-env-"));
  const paths = { dir, plist: join(dir, "com.openselect.agent.plist") };
  spawnSync("mkdir", ["-p", join(dir, "backups")]);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });
  writeFileSync(join(dir, "wired.json"), JSON.stringify({ models: {} }), { mode: 0o600 });
  const db = new (require("bun:sqlite").Database)(join(dir, "data.sqlite"), { create: true });
  migrateSchema(db);
  db.close();
  // 密钥对放在本用例目录内（与 paths 覆盖一致）
  generateSigningKey(true, {
    privatePath: join(dir, "keys", "ed25519-private.pem"),
    publicPath: join(dir, "keys", "ed25519-public.pem"),
  });
  return { paths, dir };
}

function makeBareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "openselect-sign-bare-"));
  const r = spawnSync("git", ["init", "--bare", "-q", dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init --bare 失败: ${r.stderr}`);
  return dir;
}

/** 解包 → 改 manifest 的 createdAt（不动成员摘要）→ 重新打包 */
function tamperManifest(archive: string): string {
  const stage = mkdtempSync(join(tmpdir(), "openselect-sign-tamper-"));
  spawnSync("tar", ["-xzf", archive, "-C", stage]);
  const mf = join(stage, "manifest.json");
  const j = JSON.parse(readFileSync(mf, "utf8")) as Record<string, unknown>;
  j.createdAt = "2000-01-01T00:00:00.000Z";
  writeFileSync(mf, `${JSON.stringify(j, null, 2)}\n`);
  const out = join(stage, "..", `tampered-${Date.now()}.tar.gz`);
  spawnSync("tar", ["-czf", out, "-C", stage, "."]);
  return out;
}

describe("备份签名（Ed25519）", () => {
  test("keygen：生成密钥对，私钥 0600，重复执行不覆盖", () => {
    const r1 = generateSigningKey(true);
    expect(r1.created).toBe(true);
    expect(existsSync(PRIVATE_KEY_PATH)).toBe(true);
    expect(existsSync(PUBLIC_KEY_PATH)).toBe(true);
    expect(statSync(PRIVATE_KEY_PATH).mode & 0o777).toBe(0o600);
    const before = readFileSync(PUBLIC_KEY_PATH, "utf8");
    const r2 = generateSigningKey(false);
    expect(r2.created).toBe(false);
    expect(readFileSync(PUBLIC_KEY_PATH, "utf8")).toBe(before); // 未覆盖
  });

  test("backup --sign：生成 .sig，verifyBackup 验签通过", async () => {
    generateSigningKey(true);
    const env = makeEnv();
    const b = await createBackup({ paths: env.paths, sign: true });
    expect(b.signed).toBe(true);
    expect(existsSync(`${b.path}.sig`)).toBe(true);
    const v = await verifyBackup(b.path, env.paths);
    expect(v.ok).toBe(true);
    expect(v.signature?.present).toBe(true);
    expect(v.signature?.verified).toBe(true);
  });

  test("manifest 被改（成员摘要不变）→ 验签失败 → 拒绝恢复", async () => {
    generateSigningKey(true);
    const env = makeEnv();
    const b = await createBackup({ paths: env.paths, sign: true });
    const tampered = tamperManifest(b.path);
    // 复制签名到篡改后的归档旁（模拟攻击者同时替换归档与签名，但签名对不上）
    writeFileSync(`${tampered}.sig`, readFileSync(`${b.path}.sig`));
    const v = await verifyBackup(tampered, env.paths);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("签名校验失败"))).toBe(true);
    expect(v.signature?.verified).toBe(false);
  });

  test("fetch：签名有效的归档被接收", async () => {
    generateSigningKey(true);
    const env = makeEnv();
    const remote = makeBareRepo();
    const good = await createBackup({ paths: env.paths, sign: true });
    const p = pushBackupToRemote({ archive: good.path, remote });
    expect(p.ok).toBe(true);
    // 远端分支应含 .sig
    const list = spawnSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "openselect-backups"], {
      encoding: "utf8",
    });
    expect(list.stdout).toContain(".sig");

    const dest = mkdtempSync(join(tmpdir(), "openselect-sign-fetch-"));
    const fr = await fetchBackupsFromRemote({ remote, dest, paths: env.paths });
    expect(fr.ok).toBe(true);
    expect(fr.fetched).toContain(good.path.split("/").pop()!);
    const landed = join(dest, good.path.split("/").pop()!);
    const v = await verifyBackup(landed, env.paths);
    expect(v.signature?.verified).toBe(true);
  });

  test("有信任锚但归档无签名 → 判为不可恢复（剥离 .sig 不能绕过验签）", async () => {
    generateSigningKey(true);
    const env = makeEnv();
    const b = await createBackup({ paths: env.paths, sign: false });
    const v = await verifyBackup(b.path, env.paths);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("缺少签名"))).toBe(true);
    // 显式放行（--allow-unsigned）则仅做完整性校验
    const v2 = await verifyBackup(b.path, env.paths, { allowUnsigned: true });
    expect(v2.ok).toBe(true);
    expect(v2.signature?.present).toBe(false);
    expect(v2.signature?.reason).toContain("无法证明来源");
  });

  test("无信任锚（无公开钥）→ 完整性校验仍通过，签名无法判定", async () => {
    const env = makeEnv();
    // 用一个不存在的公开钥路径模拟「本机没有信任锚」
    const noAnchor = { ...env.paths, publicKey: join(env.dir, "no-such-public.pem") };
    const b = await createBackup({ paths: env.paths, sign: false });
    const v = await verifyBackup(b.path, noAnchor);
    expect(v.ok).toBe(true);
    expect(v.signature?.present).toBe(false);
  });

  test("归档被追加签名清单之外的成员 → 拒绝（成员集合受签名约束）", async () => {
    generateSigningKey(true);
    const env = makeEnv();
    const b = await createBackup({ paths: env.paths, sign: true });
    // 往归档里追加一个额外成员
    const stage = mkdtempSync(join(tmpdir(), "openselect-sign-extra-"));
    spawnSync("tar", ["-xzf", b.path, "-C", stage]);
    writeFileSync(join(stage, "evil-extra.sh"), "#!/bin/sh\n", { mode: 0o700 });
    const out = join(stage, "..", `extra-${Date.now()}.tar.gz`);
    spawnSync("tar", ["-czf", out, "-C", stage, "."]);
    writeFileSync(`${out}.sig`, readFileSync(`${b.path}.sig`));
    const v = await verifyBackup(out, env.paths);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("签名清单之外的成员"))).toBe(true);
  });
});
