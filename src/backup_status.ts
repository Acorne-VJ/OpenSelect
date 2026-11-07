import { join } from "node:path";
import { readFileSync } from "node:fs";
import { OPENSELECT_DIR } from "./config";
import { writeFileAtomic } from "./util";

export interface BackupRunStatus { at: number; ok: boolean; operation: "push" | "verify"; encrypted: boolean; verified?: boolean; file?: string; reason?: string }
const pathFor = (operation: "push"|"verify") => join(OPENSELECT_DIR, `backup-${operation}-status.json`);
export function lastBackupRun(operation: "push"|"verify" = "push"): BackupRunStatus | null {
  try { return JSON.parse(readFileSync(pathFor(operation), "utf8")); } catch { return null; }
}
export async function recordBackupRun(status: Omit<BackupRunStatus,"at">): Promise<void> {
  await writeFileAtomic(pathFor(status.operation),JSON.stringify({ ...status, at:Date.now() })+"\n",0o600);
}
