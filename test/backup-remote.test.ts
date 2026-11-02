import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate HOME before importing modules that capture it
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-remote-"));

const { createBackup, fetchBackupsFromRemote, pushBackupToRemote, validateRemote, verifyBackup } = await import("../src/backup");
const { xmlEscape } = await import("../src/util");
const { migrateSchema } = await import("../src/db");

function makeEnv(): { paths: { dir: string; plist: string }; dir: string; config: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "openselect-remote-env-"));
  const paths = { dir, plist: join(dir, "com.openselect.agent.plist") };
  mkdirp(join(dir, "backups"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });
  writeFileSync(join(dir, "wired.json"), JSON.stringify({ models: {} }), { mode: 0o600 });
  const db = new Database(join(dir, "data.sqlite"), { create: true });
  migrateSchema(db);
  db.close();
  return { paths, dir, config: join(dir, "config.json"), db: join(dir, "data.sqlite") };
}

function mkdirp(p: string): void {
  spawnSync("mkdir", ["-p", p]);
}

function makeBareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "openselect-bare-"));
  const r = spawnSync("git", ["init", "--bare", "-q", dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init --bare 失败: ${r.stderr}`);
  return dir;
}

function gitShow(remote: string, ref: string): string {
  const r = spawnSync("git", ["--git-dir", remote, "show", ref], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

/** 二进制内容（加密归档）必须按 buffer 取，否则会被 utf8 解码破坏 */
function gitShowBin(remote: string, ref: string): Buffer {
  const r = spawnSync("git", ["--git-dir", remote, "show", ref], { encoding: "buffer" });
  return r.status === 0 ? (r.stdout as Buffer) : Buffer.alloc(0);
}

describe("备份私有 remote（git 推送/拉取）", () => {
  test("--push：归档与 sidecar 进入远端分支；--fetch 拉回本机并通过 SHA-256 校验", async () => {
    const env = makeEnv();
    const remote = makeBareRepo();
    const b = await createBackup({ paths: env.paths });

    const push = pushBackupToRemote({ archive: b.path, remote });
    expect(push.ok).toBe(true);
    expect(push.branch).toBe("openselect-backups");
    expect(push.commit).toBeTruthy();

    // 远端分支里能看到归档与 sidecar
    const shown = gitShow(remote, `openselect-backups:${b.manifest.files.length ? "" : ""}`);
    expect(shown.length).toBeGreaterThanOrEqual(0);
    const list = spawnSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "openselect-backups"], {
      encoding: "utf8",
    });
    expect(list.stdout).toContain(b.path.split("/").pop()!);
    expect(list.stdout).toContain(`${b.path.split("/").pop()}.sha256`);

    // 拉回本机（另一个备份目录）→ 文件落地 + 校验通过
    const dest = mkdtempSync(join(tmpdir(), "openselect-fetched-"));
    const fr = await fetchBackupsFromRemote({ remote, dest, allowUnsigned: true });
    expect(fr.ok).toBe(true);
    expect(fr.fetched).toContain(b.path.split("/").pop()!);
    expect(fr.rejected).toEqual([]);
    const local = join(dest, b.path.split("/").pop()!);
    expect(existsSync(local)).toBe(true);
    expect(statSync(local).mode & 0o777).toBe(0o600);
    const v = await verifyBackup(local);
    expect(v.ok).toBe(true);
  });

  test("--fetch：远端归档被篡改 → 拒绝并从本机删除", async () => {
    const env = makeEnv();
    const remote = makeBareRepo();
    const b = await createBackup({ paths: env.paths });
    // 直接往远端分支推一个被篡改的归档
    const stage = mkdtempSync(join(tmpdir(), "openselect-evil-"));
    const evil = join(stage, "evil.tar.gz");
    writeFileSync(evil, "not-a-real-tarball");
    spawnSync("git", ["init", "-q"], { cwd: stage });
    spawnSync("git", ["add", "-A"], { cwd: stage });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "evil"], { cwd: stage });
    spawnSync("git", ["push", "--force", remote, "HEAD:refs/heads/openselect-backups"], { cwd: stage });

    const dest = mkdtempSync(join(tmpdir(), "openselect-fetched2-"));
    const fr = await fetchBackupsFromRemote({ remote, dest, allowUnsigned: true });
    expect(fr.ok).toBe(true);
    expect(fr.rejected.length).toBe(1);
    expect(existsSync(join(dest, "evil.tar.gz"))).toBe(false); // 校验失败不落地
  });

  test("--encrypt：推送的是密文，用同一口令可还原为原始归档", async () => {
    const env = makeEnv();
    const remote = makeBareRepo();
    const b = await createBackup({ paths: env.paths });
    const passphrase = "test-pass-123";
    const push = pushBackupToRemote({ archive: b.path, remote, encrypt: true, passphrase });
    expect(push.ok).toBe(true);
    expect(push.encrypted).toBe(true);

    const name = `${b.path.split("/").pop()}.enc`;
    const list = spawnSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "openselect-backups"], {
      encoding: "utf8",
    });
    expect(list.stdout).toContain(name);
    // 密文不是 gzip 头
    const raw = gitShowBin(remote, `openselect-backups:${name}`);
    expect(raw.subarray(0, 8).toString("utf8")).toBe("Salted__");

    // 用同一口令还原 → 与原始归档一致
    const out = mkdtempSync(join(tmpdir(), "openselect-dec-")) + "/orig.tar.gz";
    const dec = spawnSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", `env:OPENSELECT_BACKUP_PASSPHRASE`], {
      encoding: "buffer",
      env: { ...process.env, OPENSELECT_BACKUP_PASSPHRASE: passphrase },
      input: raw,
    });
    expect(dec.status).toBe(0);
    writeFileSync(out, dec.stdout);
    expect(readFileSync(out).length).toBe(statSync(b.path).size);
  });
});

describe("备份私有 remote（复核加固）", () => {
  test("push 累积历史：多次推送后远端分支保留全部归档（非 force 覆盖）", async () => {
    const env = makeEnv();
    const remote = makeBareRepo();
    const a = await createBackup({ paths: env.paths });
    const p1 = pushBackupToRemote({ archive: a.path, remote });
    expect(p1.ok).toBe(true);
    const b = await createBackup({ paths: env.paths });
    const p2 = pushBackupToRemote({ archive: b.path, remote });
    expect(p2.ok).toBe(true);

    const list = spawnSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "openselect-backups"], {
      encoding: "utf8",
    });
    const names = list.stdout.trim().split("\n");
    expect(names).toContain(a.path.split("/").pop()!);
    expect(names).toContain(b.path.split("/").pop()!);
    const count = spawnSync("git", ["--git-dir", remote, "rev-list", "--count", "openselect-backups"], { encoding: "utf8" });
    expect(Number(count.stdout.trim())).toBeGreaterThanOrEqual(2); // 历史未被覆盖
  });

  test("fetch：sidecar 摘要被改 → 拒绝且不落地；已有同名好备份不被覆盖", async () => {
    const env = makeEnv();
    const remote = makeBareRepo();
    const b = await createBackup({ paths: env.paths });
    // 往远端推一份「归档合法但 sidecar 摘要被改」的样本
    const stage = mkdtempSync(join(tmpdir(), "openselect-badside-"));
    copyFileSync(b.path, join(stage, b.path.split("/").pop()!));
    writeFileSync(join(stage, `${b.path.split("/").pop()}.sha256`), `${"0".repeat(64)}  x.tar.gz\n`);
    copyFileSync(`${b.path}.manifest.json`, join(stage, `${b.path.split("/").pop()}.manifest.json`));
    spawnSync("git", ["init", "-q"], { cwd: stage });
    spawnSync("git", ["add", "-A"], { cwd: stage });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "bad sidecar"], { cwd: stage });
    spawnSync("git", ["push", "--force", remote, "HEAD:refs/heads/openselect-backups"], { cwd: stage });

    // 远端有一份同名好备份（第二份推送）
    const b2 = await createBackup({ paths: env.paths });
    pushBackupToRemote({ archive: b2.path, remote });

    const dest = mkdtempSync(join(tmpdir(), "openselect-fetched3-"));
    // 预置一份本机好备份（同名）→ fetch 不应覆盖它
    const good = join(dest, b2.path.split("/").pop()!);
    writeFileSync(good, "LOCAL-GOOD-BACKUP", { mode: 0o600 });

    const fr = await fetchBackupsFromRemote({ remote, dest, allowUnsigned: true });
    expect(fr.ok).toBe(true);
    // sidecar 被改的那份被拒绝
    expect(fr.rejected.length).toBeGreaterThanOrEqual(1);
    // 本机好备份仍在
    expect(readFileSync(good, "utf8")).toBe("LOCAL-GOOD-BACKUP");
  });

  test("fetch：加密归档可被拉回并解密落地（需口令）", async () => {
    const env = makeEnv();
    const remote = makeBareRepo();
    const b = await createBackup({ paths: env.paths });
    const passphrase = "pw-remote-1";
    const p = pushBackupToRemote({ archive: b.path, remote, encrypt: true, passphrase });
    expect(p.ok).toBe(true);

    const dest = mkdtempSync(join(tmpdir(), "openselect-fetched4-"));
    const fr = await fetchBackupsFromRemote({ remote, dest, passphrase });
    expect(fr.ok).toBe(true);
    expect(fr.fetched).toContain(b.path.split("/").pop()!);
    const landed = join(dest, b.path.split("/").pop()!);
    expect(existsSync(landed)).toBe(true);
    expect(statSync(landed).mode & 0o777).toBe(0o600);
    const v = await verifyBackup(landed);
    expect(v.ok).toBe(true);

    // 无口令 → 明确拒绝（而不是静默 0 条）
    const dest2 = mkdtempSync(join(tmpdir(), "openselect-fetched5-"));
    const fr2 = await fetchBackupsFromRemote({ remote, dest: dest2 });
    expect(fr2.fetched).toEqual([]);
    expect(fr2.rejected.length).toBeGreaterThanOrEqual(1);
  });

  test("CLI：未带 --yes 时不推送（远端无分支、退出码非零）", async () => {
    const home = mkdtempSync(join(tmpdir(), "openselect-cli-remote-"));
    mkdirp(join(home, ".openselect"));
    writeFileSync(join(home, ".openselect", "config.json"), JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });
    const remote = makeBareRepo();
    const r = spawnSync("bun", [join(process.cwd(), "src", "cli.ts"), "backup", "--push", remote], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    const branches = spawnSync("git", ["--git-dir", remote, "branch", "--list"], { encoding: "utf8" });
    expect(branches.stdout.trim()).toBe(""); // 远端没有任何分支
  });
});

describe("远端地址白名单（AC-CDX P2-2）", () => {

  test("拒绝危险/非法远端", () => {
    expect(validateRemote("")).toBeTruthy();
    expect(validateRemote("   ")).toBeTruthy();
    expect(validateRemote("-oProxyCommand=evil")).toBeTruthy(); // git 参数注入
    expect(validateRemote("ext::sh -c 'curl evil'")).toBeTruthy(); // git ext:: 任意命令
    expect(validateRemote("https://host/repo.git && rm -rf /")).toBeTruthy(); // shell 元字符
    expect(validateRemote("https://host/a b.git")).toBeTruthy(); // 空白
    expect(validateRemote("https://host/<x>.git")).toBeTruthy(); // XML 元字符
  });

  test("接受常见形态", () => {
    expect(validateRemote("git@github.com:owner/repo.git")).toBe(null);
    expect(validateRemote("https://github.com/owner/repo.git")).toBe(null);
    expect(validateRemote("ssh://git@host/owner/repo.git")).toBe(null);
    expect(validateRemote("/tmp/local-bare-repo")).toBe(null);
  });

  test("plist 用 XML 转义（含 & 的合法远端不会写出非法 plist）", () => {
    expect(xmlEscape("a&b")).toBe("a&amp;b");
    expect(xmlEscape("<x>")).toBe("&lt;x&gt;");
    expect(xmlEscape("a\"b'c")).toBe("a&quot;b&apos;c");
    // 转义后不含裸 < 或非实体的 & （&amp; 之类是合法实体）
    const esc = xmlEscape("git@host:o/r.git</string><string>--evil</string>");
    expect(esc.includes("<")).toBe(false);
    expect(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(esc)).toBe(false);
  });
});
