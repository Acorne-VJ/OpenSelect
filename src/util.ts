import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export const HOME = process.env.HOME ?? "/";

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await Bun.file(path).text();
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, content);
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export async function writeJson(path: string, obj: unknown, mode = 0o600): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(obj, null, 2) + "\n", mode);
}

export function nowMs(): number {
  return Date.now();
}

/** XML 文本转义（plist 里插入外部字符串时必须用） */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "acct";
}

export function maskKey(k: string): string {
  if (!k) return "***";
  if (k.length <= 12) return "***";
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}

export function fmtLocal(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export function fmtPct(p: number | null | undefined, digits = 1): string {
  if (p == null) return "-";
  return `${(p * 100).toFixed(digits)}%`;
}

/** Parse RFC 9110 Retry-After (delta-seconds or HTTP-date) into seconds. */
export function parseRetryAfter(v: string | null | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  const d = Date.parse(v);
  if (!Number.isNaN(d)) return Math.max(0, Math.floor((d - Date.now()) / 1000));
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
