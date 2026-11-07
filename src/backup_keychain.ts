import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Config } from "./types";

const SERVICE = "ai.openselect.backup.encryption";
const ACCOUNT = "OpenSelect";
export type SecurityRunner = (args: string[], input?: string) => { status: number | null; stdout: string };
const systemSecurity: SecurityRunner = (args, input) => {
  if (process.platform !== "darwin") throw new Error("Backup Keychain requires macOS");
  const result = spawnSync("/usr/bin/security", args, { input, encoding: "utf8", timeout: 10000 });
  return { status: result.status, stdout: result.stdout ?? "" };
};

export function readBackupKeychain(run: SecurityRunner = systemSecurity): string {
  const result = run(["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("Backup Keychain item unavailable or locked; encrypted upload refused");
  return result.stdout.trim();
}

/** Create once; never rotate or replace an existing recovery key implicitly. */
export function ensureBackupKeychain(run: SecurityRunner = systemSecurity): { created: boolean } {
  const existing = run(["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]);
  if (existing.status === 0 && existing.stdout.trim()) return { created: false };
  if (existing.status !== 44) throw new Error("Cannot inspect backup Keychain; existing key will not be replaced");
  const secret = randomBytes(32).toString("hex");
  // Interactive security reads commands from stdin. The secret never appears
  // in process arguments, shell history, config, plist, or logs. No -A ACL.
  const created = run(["-i", "-q"], `add-generic-password -a ${ACCOUNT} -s ${SERVICE} -w ${secret}\n`);
  if (created.status !== 0 || readBackupKeychain(run) !== secret) throw new Error("Backup Keychain creation/read-back failed");
  return { created: true };
}

export function backupPassphrase(config: Config): string {
  const supplied = process.env.OPENSELECT_BACKUP_PASSPHRASE;
  if (supplied) return supplied;
  return config.backup?.keychain === true ? readBackupKeychain() : "";
}
