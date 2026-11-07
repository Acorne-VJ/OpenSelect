import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { OPENSELECT_DIR } from "./config";
import { HOME, ensureDir } from "./util";
import { hasTrustAnchor, PRIVATE_KEY_PATH, PUBLIC_KEY_PATH, signBytes, verifyBytes } from "./keys";

/** launchd 任务名（与 cli.ts 的 install/uninstall 保持一致） */
export const LAUNCH_LABEL = "com.openselect.agent";
export const LAUNCH_AGENT = join(HOME, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
/** 定时备份任务（launchd 周期任务） */
export const LAUNCH_BACKUP_LABEL = "com.openselect.backup";
export const LAUNCH_BACKUP_AGENT = join(HOME, "Library", "LaunchAgents", `${LAUNCH_BACKUP_LABEL}.plist`);

/** launchd receives no passphrase in its plist; it inherits the launchd environment. */
export function scheduledBackupPushArgs(remote: string | null, encryptRemote: boolean): string[] {
  return remote ? ["--push", remote, ...(encryptRemote ? ["--encrypt"] : []), "--yes"] : [];
}

const MANIFEST_NAME = "manifest.json";
const TOOL_TAG = "openselect";
/** 允许出现在备份中的文件名（白名单：manifest 里出现其它名字一律拒绝，防路径穿越） */
const ALLOWED_FILES = [
  "config.json",
  "data.sqlite",
  "wired.json",
  `${LAUNCH_LABEL}.plist`,
  `${LAUNCH_BACKUP_LABEL}.plist`,
] as const;
/** 恢复时的目标路径（白名单） */
const RESTORE_TARGETS: Record<string, "config" | "db" | "wired" | "plist" | "backupPlist"> = {
  "config.json": "config",
  "data.sqlite": "db",
  "wired.json": "wired",
  [`${LAUNCH_LABEL}.plist`]: "plist",
  [`${LAUNCH_BACKUP_LABEL}.plist`]: "backupPlist",
};

export interface BackupPaths {
  /** OpenSelect 目录（config / 台账 / wired / backups 所在） */
  dir: string;
  config: string;
  db: string;
  wired: string;
  backups: string;
  /** launchd 常驻服务 plist */
  plist: string;
  /** launchd 定时备份任务 plist */
  backupPlist: string;
  /** 信任锚（公开钥）路径 */
  publicKey: string;
  /** 签名私钥路径 */
  privateKey: string;
}

export interface BackupFileEntry {
  name: string;
  bytes: number;
  sha256: string;
  /** 仅台账：快照方式（vacuum-into = 一致性快照；file-copy = 退化拷贝，可能不一致） */
  snapshotMethod?: "vacuum-into" | "file-copy";
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  tool: string;
  files: BackupFileEntry[];
  /** 归档成员清单（签名覆盖范围：成员集合 + 逐文件摘要） */
  members?: string[];
}

export interface BackupInfo {
  path: string;
  name: string;
  bytes: number;
  createdAt: string;
  fileCount: number;
  /** 是否为「恢复前」安全备份 */
  safety: boolean;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  manifest?: BackupManifest;
  /** 签名状态：present=是否带签名；verified=true/false/null（null=无信任锚无法判定） */
  signature?: { present: boolean; verified: boolean | null; reason?: string };
}

export interface ServiceResult {
  loadedBefore: boolean;
  stopped: boolean;
  restarted: boolean;
  errors: string[];
}

export interface RestoreResult {
  restored: string[];
  safetyBackup?: string;
  problems: string[];
  service: ServiceResult;
}

/**
 * 解析备份相关路径。默认取 ~/.openselect；可用环境变量覆盖（OPENSELECT_DIR /
 * OPENSELECT_DB_PATH / OPENSELECT_LAUNCH_AGENT），便于测试隔离与多实例。
 */
export function resolvePaths(override?: Partial<BackupPaths>): BackupPaths {
  const explicitDir = override?.dir !== undefined;
  const dir = override?.dir ?? process.env.OPENSELECT_DIR ?? OPENSELECT_DIR;
  return {
    dir,
    config: override?.config ?? join(dir, "config.json"),
    // 显式指定目录时，目录内的路径全部由该目录派生（忽略环境变量覆盖，避免串目录）
    db:
      override?.db ??
      (explicitDir ? join(dir, "data.sqlite") : (process.env.OPENSELECT_DB_PATH ?? join(dir, "data.sqlite"))),
    wired: override?.wired ?? join(dir, "wired.json"),
    backups: override?.backups ?? join(dir, "backups"),
    plist:
      override?.plist ??
      (explicitDir
        ? join(dir, `${LAUNCH_LABEL}.plist`)
        : (process.env.OPENSELECT_LAUNCH_AGENT ?? LAUNCH_AGENT)),
    backupPlist:
      override?.backupPlist ??
      (explicitDir
        ? join(dir, `${LAUNCH_BACKUP_LABEL}.plist`)
        : (process.env.OPENSELECT_LAUNCH_BACKUP_AGENT ?? LAUNCH_BACKUP_AGENT)),
    publicKey: override?.publicKey ?? (explicitDir ? join(dir, "keys", "ed25519-public.pem") : PUBLIC_KEY_PATH),
    privateKey: override?.privateKey ?? (explicitDir ? join(dir, "keys", "ed25519-private.pem") : PRIVATE_KEY_PATH),
  };
}

function sha256(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stamp(): string {
  // 2026-10-20T08-15-30.123Z → 20261020T081530123Z（毫秒精度：同一秒内多次备份不会互相覆盖）
  return new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
}

const MAX_MEMBER_BYTES = 512 * 1024 * 1024;

function tarRun(args: string[]): { ok: boolean; stdout: Buffer; err: string } {
  const r = spawnSync("tar", args, { encoding: "buffer", maxBuffer: MAX_MEMBER_BYTES });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? Buffer.alloc(0)) as Buffer,
    err: (r.stderr ? r.stderr.toString() : "").trim(),
  };
}

/** 从归档流式读取单个成员（不落盘） */
function tarMember(path: string, member: string): { ok: boolean; data: Buffer; err: string } {
  const r = tarRun(["-xOzf", path, `./${member}`]);
  return { ok: r.ok, data: r.stdout, err: r.err };
}

/**
 * 创建应用级备份：config.json（账号 Key）、data.sqlite（台账）、wired.json、launchd plist。
 * 归档与 sidecar 均为 0600（归档内含明文 Key）。
 */
export async function createBackup(opts: {
  out?: string;
  label?: string;
  paths?: Partial<BackupPaths>;
  /** 用本机私钥给 manifest 签名（生成 <归档>.sig，供远端校验真实性） */
  sign?: boolean;
} = {}): Promise<{
  path: string;
  manifest: BackupManifest;
  sha256: string;
  signed?: boolean;
}> {
  const p = resolvePaths(opts.paths);
  ensureDir(p.backups);
  try {
    chmodSync(p.backups, 0o700); // 归档含明文 Key → 目录不对同机其他用户开放
  } catch {
    /* best effort */
  }
  const name = `openselect-${opts.label ? `${opts.label}-` : ""}${stamp()}.tar.gz`;
  const out = opts.out ?? join(p.backups, name);

  // staging 放系统临时目录（用户私有 0700），避免明文 config.json 落在 ~/.openselect
  const stage = mkdtempSync(join(tmpdir(), "openselect-backup-"));
  try {
    chmodSync(stage, 0o700);
    const files: BackupFileEntry[] = [];
    const addFile = (src: string, as: string): void => {
      if (!existsSync(src)) return;
      const dest = join(stage, as);
      writeFileSync(dest, readFileSync(src), { mode: 0o600 });
      chmodSync(dest, 0o600);
      files.push({ name: as, bytes: statSync(dest).size, sha256: sha256File(dest) });
    };

    addFile(p.config, "config.json");
    addFile(p.wired, "wired.json");
    addFile(p.plist, `${LAUNCH_LABEL}.plist`);
    addFile(p.backupPlist, `${LAUNCH_BACKUP_LABEL}.plist`);

    // 台账：WAL 模式下用 VACUUM INTO 取一致性快照（只读连接，不干扰运行中的服务）
    if (existsSync(p.db)) {
      const dest = join(stage, "data.sqlite");
      let method: "vacuum-into" | "file-copy" = "file-copy";
      try {
        const src = new Database(p.db, { readonly: true });
        try {
          src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
          method = "vacuum-into";
        } finally {
          src.close();
        }
      } catch {
        // 退化：直接拷贝（可能跨 WAL 边界，manifest 会标记 snapshotMethod=file-copy）
        writeFileSync(dest, readFileSync(p.db), { mode: 0o600 });
      }
      chmodSync(dest, 0o600);
      files.push({
        name: "data.sqlite",
        bytes: statSync(dest).size,
        sha256: sha256File(dest),
        snapshotMethod: method,
      });
    }

    // 成员清单 = 实际放入 staging 的文件（+ manifest 自身）→ 签名同时约束「成员集合」
    const members = [...readdirSync(stage), MANIFEST_NAME].sort();
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      tool: TOOL_TAG,
      files,
      members,
    };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(stage, MANIFEST_NAME), manifestBytes, { mode: 0o600 });

    // 签名：对 manifest 字节做 Ed25519 签名 → 远端可用本机公开钥验证「这份备份确实来自本机」
    let signed = false;
    if (opts.sign) {
      try {
        const sig = signBytes(manifestBytes, p.privateKey);
        writeFileSync(`${out}.sig`, `${sig}\n`, { mode: 0o600 });
        signed = true;
      } catch (e) {
        throw new Error(`签名失败（是否先执行 opensel keygen？或私钥不可读）: ${String(e).slice(0, 120)}`);
      }
    }

    // 先以 0600 建好目标文件：tar 覆写时保留既有权限（否则默认 0644，明文 Key 短暂可读）
    writeFileSync(out, "", { mode: 0o600 });
    const t = tarRun(["-czf", out, "-C", stage, "."]);
    if (!t.ok) throw new Error(`tar 打包失败: ${t.err}`);
    chmodSync(out, 0o600);

    const digest = sha256File(out);
    writeFileSync(`${out}.sha256`, `${digest}  ${basename(out)}\n`, { mode: 0o600 });
    writeFileSync(`${out}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { path: out, manifest, sha256: digest, signed };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** 列出历史备份（按创建时间倒序 = 最新在前） */
export function listBackups(paths?: Partial<BackupPaths>): BackupInfo[] {
  const p = resolvePaths(paths);
  ensureDir(p.backups);
  const out: BackupInfo[] = [];
  for (const name of readdirSync(p.backups)) {
    if (!name.endsWith(".tar.gz")) continue;
    const path = join(p.backups, name);
    let createdAt = "";
    let fileCount = 0;
    const mf = `${path}.manifest.json`;
    if (existsSync(mf)) {
      try {
        const m = JSON.parse(readFileSync(mf, "utf8")) as BackupManifest;
        createdAt = m.createdAt ?? "";
        fileCount = m.files?.length ?? 0;
      } catch {
        /* manifest 损坏：仍列出文件，字段留空 */
      }
    }
    out.push({
      path,
      name,
      bytes: statSync(path).size,
      createdAt,
      fileCount,
      safety: name.includes("pre-restore"),
    });
  }
  // 统一排序键：createdAt 倒序（缺失视为最旧），同值按文件名倒序（文件名内含时间戳）
  out.sort((a, b) => {
    const ca = a.createdAt || "";
    const cb = b.createdAt || "";
    if (ca !== cb) return cb.localeCompare(ca);
    return b.name.localeCompare(a.name);
  });
  return out;
}

/** 最新一份「正式」备份（排除恢复前安全备份） */
export function latestBackup(paths?: Partial<BackupPaths>): string | null {
  const list = listBackups(paths).filter((b) => !b.safety);
  return list.length > 0 ? list[0]!.path : null;
}

/**
 * 保留策略：保留最新 keep 份**正式**归档（最新一份永远不会被删），另保留最新 1 份「恢复前」安全备份
 * （安全备份不占用正式归档的份数），其余连同 sidecar 一并删除。keep <= 0 表示不清理。
 */
export function pruneBackups(keep: number, paths?: Partial<BackupPaths>): string[] {
  if (keep <= 0) return [];
  const list = listBackups(paths);
  const formal = list.filter((b) => !b.safety);
  const safety = list.filter((b) => b.safety);
  const keepPaths = new Set(formal.slice(0, Math.max(1, keep)).map((b) => b.path));
  for (const b of safety.slice(0, 1)) keepPaths.add(b.path);
  const removed: string[] = [];
  for (const b of list) {
    if (keepPaths.has(b.path)) continue;
    for (const f of [b.path, `${b.path}.sha256`, `${b.path}.manifest.json`, `${b.path}.sig`]) {
      if (existsSync(f)) rmSync(f, { force: true });
    }
    removed.push(b.name);
  }
  return removed;
}

/** 校验归档：sidecar sha256 + 逐成员 sha256（流式，不落盘） */
/**
 * 验签结果缓存：面板每 5 秒轮询 /api/state，若每次都解包+验签会阻塞与代理共享的事件循环
 * （实测单份 34–292ms）。按 (归档路径, mtime, .sig mtime) 缓存 60 秒。
 */
const sigCache = new Map<string, { key: string; at: number; verified: boolean | null }>();
const SIG_CACHE_TTL_MS = 60_000;

/** 带缓存的验签（返回 signature 状态，不抛异常） */
export async function verifyBackupCached(
  path: string,
  paths?: Partial<BackupPaths>,
  opts: { allowUnsigned?: boolean } = {},
): Promise<VerifyResult["signature"]> {
  try {
    const st = statSync(path);
    const sigPath = `${path}.sig`;
    const sigMtime = existsSync(sigPath) ? statSync(sigPath).mtimeMs : 0;
    const ck = `${path}:${st.mtimeMs}:${sigMtime}`;
    const hit = sigCache.get(path);
    if (hit && hit.key === ck && Date.now() - hit.at < SIG_CACHE_TTL_MS) {
      return { present: sigMtime > 0, verified: hit.verified };
    }
    const v = await verifyBackup(path, paths, opts);
    sigCache.set(path, { key: ck, at: Date.now(), verified: v.signature?.verified ?? null });
    return v.signature ?? { present: false, verified: null };
  } catch {
    return { present: false, verified: null };
  }
}

export async function verifyBackup(
  path: string,
  paths?: Partial<BackupPaths>,
  opts: { allowUnsigned?: boolean } = {},
): Promise<VerifyResult> {
  const problems: string[] = [];
  const p = resolvePaths(paths);
  if (!existsSync(path)) return { ok: false, problems: [`备份不存在: ${path}`] };

  const sidecar = `${path}.sha256`;
  if (existsSync(sidecar)) {
    const expected = (readFileSync(sidecar, "utf8").trim().split(/\s+/)[0] ?? "").toLowerCase();
    const actual = sha256File(path);
    if (expected && expected !== actual) {
      problems.push(`归档 sha256 不匹配（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
    }
  }

  const mf = tarMember(path, MANIFEST_NAME);
  if (!mf.ok) return { ok: false, problems: [...problems, `归档内缺少 ${MANIFEST_NAME}: ${mf.err}`] };
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(mf.data.toString("utf8")) as BackupManifest;
  } catch {
    return { ok: false, problems: [...problems, "manifest.json 不是合法 JSON"] };
  }

  for (const f of manifest.files ?? []) {
    if (!ALLOWED_FILES.includes(f.name as (typeof ALLOWED_FILES)[number])) {
      problems.push(`manifest 含未知文件（拒绝恢复）: ${f.name}`);
      continue;
    }
    const m = tarMember(path, f.name);
    if (!m.ok) {
      problems.push(`缺少文件: ${f.name}`);
      continue;
    }
    if (sha256(m.data) !== f.sha256) problems.push(`文件校验失败: ${f.name}`);
  }

  // 成员集合必须与签名内的清单一致（防止往已签名归档里追加成员）
  if (Array.isArray(manifest.members) && manifest.members.length > 0) {
    const listed = new Set(
      tarRun(["-tzf", path])
        .stdout.toString("utf8")
        .split("\n")
        .map((l: string) => l.trim().replace(/^\.\//, ""))
        .filter((l: string) => l !== "" && !l.endsWith("/")),
    );
    const expected = new Set(manifest.members);
    for (const m of listed) {
      if (!expected.has(m)) problems.push(`归档含签名清单之外的成员: ${m}`);
    }
    for (const m of expected) {
      if (!listed.has(m)) problems.push(`归档缺少签名清单中的成员: ${m}`);
    }
  }

  // 签名校验：<归档>.sig 存在时，用本机信任锚（公开钥）验证 manifest 的签名
  const sigPath = `${path}.sig`;
  let signature: VerifyResult["signature"];
  if (existsSync(sigPath)) {
    const sigText = readFileSync(sigPath, "utf8").trim();
    const verified = verifyBytes(mf.data, sigText, p.publicKey);
    signature = { present: true, verified };
    if (verified === false) problems.push("签名校验失败（manifest 已被篡改或签名不匹配）");
    else if (verified === null) signature = { present: true, verified: null, reason: "本机未配置信任公钥，仅完成完整性校验" };
  } else {
    signature = { present: false, verified: null, reason: "归档无签名，无法证明来源" };
    // 本机已配置信任锚时，「无签名」= 无法证明来源 → 判为不可恢复（除非显式放行）
    if (!opts.allowUnsigned && hasTrustAnchor(p.publicKey)) {
      problems.push("归档缺少签名，无法验证来源（若确认可信请用 --allow-unsigned 放行）");
    }
  }
  return { ok: problems.length === 0, problems, manifest, signature };
}

function serviceLoaded(): boolean {
  const uid = process.getuid?.() ?? 501;
  return spawnSync("launchctl", ["print", `gui/${uid}/${LAUNCH_LABEL}`], { encoding: "utf8" }).status === 0;
}

function serviceStop(): { ok: boolean; err: string } {
  const uid = process.getuid?.() ?? 501;
  const r = spawnSync("launchctl", ["bootout", `gui/${uid}/${LAUNCH_LABEL}`], { encoding: "utf8" });
  return { ok: r.status === 0, err: (r.stderr || r.stdout || "").trim() };
}

function serviceStart(): { ok: boolean; err: string } {
  const uid = process.getuid?.() ?? 501;
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, LAUNCH_AGENT], { encoding: "utf8" });
  return { ok: r.status === 0, err: (r.stderr || r.stdout || "").trim() };
}

/** 手动启动命令（引导用户兜底） */
export function manualStartHint(): string {
  const uid = process.getuid?.() ?? 501;
  return `launchctl bootstrap gui/${uid} ${LAUNCH_AGENT}`;
}

/**
 * 从备份恢复。流程：verify（失败即中止，零写入）→ 生成 pre-restore 安全备份 → 停服务 →
 * 逐文件写回（流式，原子替换）→ 重启服务（finally 保证一定尝试重启）。
 * dryRun 只输出计划，不做任何写入（含不解包到磁盘）。
 */
export async function restoreBackup(
  path: string,
  opts: {
    dryRun?: boolean;
    manageService?: boolean;
    restorePlist?: boolean;
    paths?: Partial<BackupPaths>;
    allowUnsigned?: boolean;
  } = {},
): Promise<RestoreResult> {
  const p = resolvePaths(opts.paths);
  const v = await verifyBackup(path, opts.paths);
  const service: ServiceResult = { loadedBefore: false, stopped: false, restarted: false, errors: [] };
  if (!v.ok) {
    return { restored: [], problems: v.problems, service };
  }
  const manifest = v.manifest!;
  const restored: string[] = [];
  const problems: string[] = [];

  const targetOf = (name: string): string | null => {
    switch (RESTORE_TARGETS[name]) {
      case "config":
        return p.config;
      case "db":
        return p.db;
      case "wired":
        return p.wired;
      case "plist":
        return opts.restorePlist === false ? null : p.plist;
      case "backupPlist":
        return opts.restorePlist === false ? null : p.backupPlist;
      default:
        return null;
    }
  };

  if (opts.dryRun) {
    for (const f of manifest.files ?? []) {
      const dest = targetOf(f.name);
      if (!dest) continue;
      restored.push(`${f.name} → ${dest}`);
    }
    return { restored, problems, service };
  }

  // 1) 恢复前安全备份（保证恢复可回退）
  let safetyBackup: string | undefined;
  try {
    const sb = await createBackup({ label: "pre-restore", paths: opts.paths });
    safetyBackup = sb.path;
  } catch (e) {
    problems.push(`生成恢复前安全备份失败: ${String(e)}`);
    return { restored, problems, service };
  }

  // 2) 停服务（避免恢复过程中被写入）
  service.loadedBefore = opts.manageService !== false && serviceLoaded();
  if (service.loadedBefore) {
    const s = serviceStop();
    service.stopped = s.ok;
    if (!s.ok) service.errors.push(`停止 launchd 服务失败: ${s.err}`);
  }

  try {
    // 3) 逐文件写回：流式解出成员 → 临时文件 → 原子替换
    for (const f of manifest.files ?? []) {
      const dest = targetOf(f.name);
      if (!dest) continue;
      try {
        const m = tarMember(path, f.name);
        if (!m.ok) {
          problems.push(`缺少文件: ${f.name}`);
          continue;
        }
        if (sha256(m.data) !== f.sha256) {
          problems.push(`文件校验失败（跳过）: ${f.name}`);
          continue;
        }
        ensureDir(dirname(dest));
        const tmp = `${dest}.restore-tmp`;
        writeFileSync(tmp, m.data, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, dest);
        chmodSync(dest, 0o600);
        if (f.name === "data.sqlite") {
          // 旧库的 WAL/SHM 残留会把旧事务重放到新库上 → "database disk image is malformed"；
          // 恢复的是自包含快照，必须清掉旧 sidecar（SQLite 按需重建）
          for (const side of [`${p.db}-wal`, `${p.db}-shm`]) {
            if (existsSync(side)) rmSync(side, { force: true });
          }
        }
        restored.push(`${f.name} → ${dest}`);
      } catch (e) {
        problems.push(`写入 ${f.name} 失败: ${String(e).slice(0, 160)}`);
      }
    }
  } finally {
    // 4) 无论是否出错都要尝试重启服务（否则代理/面板会一直停摆）
    if (service.loadedBefore) {
      const s = serviceStart();
      service.restarted = s.ok;
      if (!s.ok) service.errors.push(`重启 launchd 服务失败: ${s.err}（手动: ${manualStartHint()}）`);
    }
  }

  return { restored, safetyBackup, problems, service };
}

/* ── 私有 remote（git）──────────────────────────────────────── */

export const BACKUP_BRANCH = "openselect-backups";

/** 默认保留的备份份数（CLI、面板、定时任务共用） */
export const BACKUP_KEEP_DEFAULT = 14;

export interface PushResult {
  ok: boolean;
  remote: string;
  branch: string;
  file: string;
  encrypted: boolean;
  commit?: string;
  error?: string;
}

export interface FetchResult {
  ok: boolean;
  remote: string;
  branch: string;
  fetched: string[];
  rejected: string[];
  error?: string;
}

function git(args: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  // 禁止 git 交互式提示（ssh 口令/凭据）导致长时间挂起
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL:"C" };
  env.GIT_SSH_COMMAND = `${process.env.GIT_SSH_COMMAND || "ssh"} -o BatchMode=yes -o ConnectTimeout=15`;
  const r = spawnSync("git", args, { encoding: "utf8", cwd, timeout: 120_000, env });
  return {
    ok: r.status === 0,
    out: (r.stdout || "").trim(),
    err: (r.stderr || r.stdout || r.error?.message || "").trim(),
  };
}

/** 远端地址不得以 - 开头（否则会被 git 当成选项解析） */
/**
 * 远端地址白名单校验（所有入口共用：--push / --fetch / --remote / 写配置 / 渲染 plist）。
 * 拒绝：空值、空白字符、shell/XML 元字符、以 - 开头（被当作 git 参数）、ext:: 传输协议
 * （git 的 ext:: 可执行任意命令）、以及不支持的协议前缀。
 */
export function validateRemote(remote: string): string | null {
  if (!remote || remote.trim() === "") return "远端地址不能为空";
  const r = remote.trim();
  if (r !== remote) return "远端地址首尾不能有空白字符";
  if (/\s/.test(r)) return "远端地址不能包含空白字符";
  if (r.startsWith("-")) return "远端地址不能以 - 开头";
  if (r.includes("::")) return "远端地址不能使用 ext:: 传输协议（可执行任意命令）";
  if (/[<>&"'`;$(){}|\\]/.test(r)) return "远端地址不能包含 shell 或 XML 元字符";
  // 允许的形态：URL、scp 风格（git@host:path）、本地绝对/相对路径
  const isUrl = /^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/)/.test(r);
  const isScp = /^git@[^:\s]+:[^\s]+$/.test(r);
  const isPath = /^(\/|~\/|\.\/|\w)/.test(r);
  if (!isUrl && !isScp && !isPath) {
    return "远端地址格式无效（应为 https://…、git@host:path 或本地路径）";
  }
  return null;
}

function checkRemote(remote: string): string | null {
  return validateRemote(remote);
}

/** 解密归档（口令只从环境变量读取，不进命令行） */
function decryptArchive(src: string, dest: string, passphrase: string): { ok: boolean; err: string } {
  const r = spawnSync(
    "openssl",
    ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", `env:OPENSELECT_BACKUP_PASSPHRASE`, "-in", src, "-out", dest],
    { encoding: "utf8", env: { ...process.env, OPENSELECT_BACKUP_PASSPHRASE: passphrase }, timeout: 60_000 },
  );
  return { ok: r.status === 0, err: (r.stderr || r.stdout || "").trim() };
}

/** 用口令加密归档（openssl AES-256-CBC + PBKDF2）；口令只从环境变量读取，不进命令行 */
function encryptArchive(src: string, dest: string, passphrase: string): { ok: boolean; err: string } {
  const r = spawnSync(
    "openssl",
    ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", `env:OPENSELECT_BACKUP_PASSPHRASE`, "-in", src, "-out", dest],
    { encoding: "utf8", env: { ...process.env, OPENSELECT_BACKUP_PASSPHRASE: passphrase }, timeout: 60_000 },
  );
  return { ok: r.status === 0, err: (r.stderr || r.stdout || "").trim() };
}

/** Decrypt to an isolated temporary file and verify its manifest/signature.
 * No service stop, config restore, or overwrite of the live SQLite database. */
export async function verifyEncryptedBackupRoundTrip(archive: string, passphrase: string): Promise<boolean> {
  if (!passphrase) return false;
  const stage = mkdtempSync(join(tmpdir(),"openselect-encrypted-verify-"));
  try {
    chmodSync(stage,0o700);
    const encrypted = join(stage,"backup.enc"), plain = join(stage,"backup.tar.gz");
    if (!encryptArchive(archive,encrypted,passphrase).ok || !decryptArchive(encrypted,plain,passphrase).ok || sha256File(archive)!==sha256File(plain)) return false;
    if (existsSync(archive+".sig")) copyFileSync(archive+".sig",plain+".sig");
    const verified = await verifyBackup(plain);
    if (!verified.ok) return false;
    if (verified.manifest?.files.some((f) => f.name === "data.sqlite")) {
      const unpack = spawnSync("tar",["-xzf",plain,"-C",stage,"data.sqlite"],{encoding:"utf8",timeout:60000});
      if (unpack.status !== 0) return false;
      const copy = new Database(join(stage,"data.sqlite"),{readonly:true});
      try { if ((copy.query("PRAGMA quick_check").get() as {quick_check:string}).quick_check !== "ok") return false; }
      finally { copy.close(); }
    }
    return true;
  } catch { return false; }
  finally { rmSync(stage,{recursive:true,force:true}); }
}

/**
 * 把备份归档推到 git 远端的专用分支（默认 openselect-backups）。
 * encrypt=true 时先加密再推（口令来自调用方，不落盘）。
 */
export function pushBackupToRemote(opts: {
  archive: string;
  remote: string;
  branch?: string;
  encrypt?: boolean;
  passphrase?: string;
}): PushResult {
  const branch = opts.branch ?? BACKUP_BRANCH;
  const base: PushResult = {
    ok: false,
    remote: opts.remote,
    branch,
    file: basename(opts.archive),
    encrypted: !!opts.encrypt,
  };
  const bad = checkRemote(opts.remote);
  if (bad) return { ...base, error: bad };
  if (!existsSync(opts.archive)) return { ...base, error: `归档不存在: ${opts.archive}` };
  if (opts.encrypt && !opts.passphrase) return { ...base, error: "加密推送需要口令（OPENSELECT_BACKUP_PASSPHRASE）" };

  const stage = mkdtempSync(join(tmpdir(), "openselect-push-"));
  try {
    // 1) 组装要推送的文件（加密路径不推明文 sidecar，避免泄露明文派生信息）
    let payloadName = basename(opts.archive);
    let payloadSrc = opts.archive;
    if (opts.encrypt) {
      const enc = join(stage, `${payloadName}.enc`);
      const e = encryptArchive(opts.archive, enc, opts.passphrase!);
      if (!e.ok) return { ...base, error: `加密失败: ${e.err}` };
      payloadSrc = enc;
      payloadName = `${payloadName}.enc`;
    }
    const dest = join(stage, payloadName);
    if (payloadSrc !== dest) {
      copyFileSync(payloadSrc, dest);
      chmodSync(dest, 0o600);
    }
    if (opts.encrypt) {
      // 密文摘要（不推明文 manifest）；签名覆盖的是**明文** manifest → 明文归档的 .sig 一并带上
      writeFileSync(join(stage, `${payloadName}.sha256`), `${sha256File(dest)}  ${payloadName}\n`, { mode: 0o600 });
      const plainSig = `${opts.archive}.sig`;
      if (existsSync(plainSig)) {
        copyFileSync(plainSig, join(stage, `${payloadName}.sig`));
        chmodSync(join(stage, `${payloadName}.sig`), 0o600);
      }
      writeFileSync(
        join(stage, `${payloadName}.manifest.json`),
        `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), tool: "openselect", encrypted: true, files: [] }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } else {
      for (const side of [".sha256", ".manifest.json", ".sig"]) {
        const s = `${opts.archive}${side}`;
        if (existsSync(s)) {
          copyFileSync(s, join(stage, `${payloadName}${side}`));
          chmodSync(join(stage, `${payloadName}${side}`), 0o600);
        }
      }
    }

    // 2) 基于远端分支累积提交（不快进覆盖 → 远端保留历史备份）
    const init = git(["init", "-q"], stage);
    if (!init.ok) return { ...base, error: `git init 失败: ${init.err}` };
    const addRemote = git(["remote", "add", "origin", opts.remote], stage);
    if (!addRemote.ok) return { ...base, error: `git remote add 失败: ${addRemote.err}` };
    // Fetch complete ancestry, but do not download/check out every historical
    // archive. The index can retain existing blob IDs without reading secrets.
    git(["config","remote.origin.promisor","true"],stage);
    git(["config","remote.origin.partialclonefilter","blob:none"],stage);
    const fetched = git(["fetch", "--filter=blob:none", "origin", `refs/heads/${branch}`], stage);
    if (fetched.ok) {
      for (const args of [["update-ref",`refs/heads/${branch}`,"FETCH_HEAD"],["symbolic-ref","HEAD",`refs/heads/${branch}`],["read-tree","FETCH_HEAD"]]) {
        const result=git(args,stage);
        if (!result.ok) return {...base,error:`git index 失败: ${result.err}`};
      }
    } else {
      if (!/couldn't find remote ref|could not find remote branch/i.test(fetched.err)) return {...base,error:`git fetch 失败: ${fetched.err}`};
      // 远端还没有该分支（首次推送）
      const co = git(["checkout", "-B", branch], stage);
      if (!co.ok) return { ...base, error: `git checkout 失败: ${co.err}` };
    }
    // Stage only this backup; git add -A would delete old entries whose blobs
    // deliberately have not been materialized in this temporary worktree.
    const payloadFiles=[payloadName,...[".sha256",".manifest.json",".sig"].filter((side)=>existsSync(join(stage,payloadName+side))).map((side)=>payloadName+side)];
    const added=git(["add","--",...payloadFiles],stage);
    if (!added.ok) return {...base,error:`git add 失败: ${added.err}`};
    const tree=git(["write-tree","--missing-ok"],stage);
    if (!tree.ok) return {...base,error:`git write-tree 失败: ${tree.err}`};
    // Commit the index directly: porcelain commit refreshes the worktree and
    // may lazily fetch old archives merely to summarize their missing files.
    const commit = git(
      [
        "-c",
        "user.name=openselect-backup",
        "-c",
        "user.email=backup@openselect.local",
        "commit-tree",
        tree.out,
        ...(fetched.ok ? ["-p","FETCH_HEAD"] : []),
        "-m",
        `openselect backup ${new Date().toISOString()}`,
      ],
      stage,
    );
    if (!commit.ok) {
      return { ...base, error: `git commit 失败: ${commit.err}` };
    }
    const moved=git(["update-ref",`refs/heads/${branch}`,commit.out],stage);
    if (!moved.ok) return {...base,error:`git update-ref 失败: ${moved.err}`};
    const rev = git(["rev-parse", "HEAD"], stage);
    const push = git(["push", "origin", `HEAD:refs/heads/${branch}`], stage);
    if (!push.ok) return { ...base, commit: rev.out, error: `git push 失败: ${push.err}` };
    return { ...base, ok: true, file:payloadName, commit: rev.out };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * 从 git 远端拉取备份到本机备份目录，并逐个校验 SHA-256。
 * 被篡改/损坏的归档会被拒绝（不写入本机）。
 */
export async function fetchBackupsFromRemote(opts: {
  remote: string;
  branch?: string;
  dest?: string;
  paths?: Partial<BackupPaths>;
  passphrase?: string;
  /** 允许无签名归档（本机已配置信任锚时默认拒绝，因为「无签名」= 无法证明来源） */
  allowUnsigned?: boolean;
}): Promise<FetchResult> {
  const branch = opts.branch ?? BACKUP_BRANCH;
  const p = resolvePaths(opts.paths);
  const dest = opts.dest ?? p.backups;
  const out: FetchResult = { ok: false, remote: opts.remote, branch, fetched: [], rejected: [] };
  const bad = checkRemote(opts.remote);
  if (bad) return { ...out, error: bad };
  const stage = mkdtempSync(join(tmpdir(), "openselect-fetch-"));
  try {
    ensureDir(dest);
    try {
      chmodSync(dest, 0o700); // 内含明文 Key 的备份目录不对同机其他用户开放
    } catch {
      /* best effort */
    }
    const clone = git(["clone", "--depth", "1", "--branch", branch, "--", opts.remote, stage]);
    if (!clone.ok) return { ...out, error: `git clone 失败: ${clone.err}` };

    /** 校验通过后原子落地（不覆盖已有归档，避免坏档毁掉本机好备份） */
    const land = (src: string, name: string): void => {
      const target = join(dest, name);
      if (existsSync(target)) return; // 已存在同名归档 → 保留本机版本
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, readFileSync(src), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    };

    for (const name of readdirSync(stage)) {
      if (name.endsWith(".tar.gz")) {
        // 明文归档：先在 staging 校验（归档摘要 + 内嵌 manifest），通过后再落地
        const v = await verifyBackup(join(stage, name), opts.paths, { allowUnsigned: opts.allowUnsigned });
        if (!v.ok) {
          out.rejected.push(`${name}（${v.problems.join("；")}）`);
          continue;
        }
        land(join(stage, name), name);
        for (const side of [".sha256", ".manifest.json", ".sig"]) {
          const s = join(stage, `${name}${side}`);
          if (existsSync(s)) land(s, `${name}${side}`);
        }
        out.fetched.push(name);
      } else if (name.endsWith(".tar.gz.enc")) {
        // 加密归档：先校验密文摘要 → 解密 → 校验内嵌 manifest → 落地解密件
        const encPath = join(stage, name);
        const sidecar = join(stage, `${name}.sha256`);
        if (existsSync(sidecar)) {
          const expected = (readFileSync(sidecar, "utf8").trim().split(/\s+/)[0] ?? "").toLowerCase();
          const actual = sha256File(encPath);
          if (expected && expected !== actual) {
            out.rejected.push(`${name}（密文 sha256 不匹配）`);
            continue;
          }
        }
        const pass = opts.passphrase ?? process.env.OPENSELECT_BACKUP_PASSPHRASE ?? "";
        if (!pass) {
          out.rejected.push(`${name}（需要 OPENSELECT_BACKUP_PASSPHRASE 解密）`);
          continue;
        }
        const dec = join(stage, `${name}.dec`);
        const d = decryptArchive(encPath, dec, pass);
        if (!d.ok) {
          out.rejected.push(`${name}（解密失败: ${d.err}）`);
          continue;
        }
        const plain = name.replace(/\.enc$/, "");
        // 明文归档的签名（覆盖明文 manifest）→ 解密后先落地再验签
        const encSig = join(stage, `${name}.sig`);
        if (existsSync(encSig)) {
          const tmpSig = join(stage, `${plain}.sig`);
          copyFileSync(encSig, tmpSig);
          chmodSync(tmpSig, 0o600);
        }
        const v = await verifyBackup(dec, opts.paths, { allowUnsigned: opts.allowUnsigned });
        if (!v.ok) {
          out.rejected.push(`${plain}（解密后校验失败: ${v.problems.join("；")}）`);
          rmSync(dec, { force: true });
          continue;
        }
        land(dec, plain);
        rmSync(dec, { force: true });
        if (existsSync(join(stage, `${plain}.sig`))) land(join(stage, `${plain}.sig`), `${plain}.sig`);
        out.fetched.push(plain);
      }
    }
    out.ok = true;
    return out;
  } catch (e) {
    return { ...out, error: String(e).slice(0, 200) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
