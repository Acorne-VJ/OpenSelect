import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "./catalog";
import { BACKUP_DIR, OPENSELECT_DIR } from "./config";
import type { Config } from "./types";
import { HOME, ensureDir, readJson, writeFileAtomic, writeJson } from "./util";

export const WIRED_STATE_PATH = join(OPENSELECT_DIR, "wired.json");

export function globalConfigPath(): string {
  return join(HOME, ".config", "opencode", "opencode.json");
}

export interface WiredState {
  baseURL: string;
  configPath: string;
  models: string[];
  wiredAt: number;
  /** pre-wire settings.baseURL per model id (null = key absent before wiring); consumed by unwire */
  prev?: Record<string, string | null>;
}

/** Minimal JSONC comment/trailing-comma stripper (string-aware). */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  let pendingComma = false;
  const flushComma = (): void => {
    if (pendingComma) {
      out += ",";
      pendingComma = false;
    }
  };
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === strCh) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      flushComma();
      inStr = true;
      strCh = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ",") {
      flushComma();
      pendingComma = true;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      // drop a trailing comma before a closer
      pendingComma = false;
      out += c;
      i++;
      continue;
    }
    if (pendingComma && (c === " " || c === "\t" || c === "\n" || c === "\r")) {
      i++;
      continue;
    }
    flushComma();
    out += c;
    i++;
  }
  flushComma();
  return out;
}

export function parseConfigText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonComments(text));
  }
}

function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  ensureDir(BACKUP_DIR);
  const dest = join(BACKUP_DIR, `${path.replace(/[^A-Za-z0-9._-]+/g, "_")}.${Date.now()}.bak`);
  copyFileSync(path, dest);
  return dest;
}

export interface WireResult {
  changed: number;
  backup: string | null;
  /** value of settings.baseURL before this wire run, per processed model id (undefined = key absent) */
  before: Record<string, string | undefined>;
}

/** Inject model-level settings.baseURL overrides for opencode-go models. */
export async function wireConfigFile(opts: {
  path: string;
  baseURL: string;
  modelIds: string[];
  dryRun?: boolean;
}): Promise<WireResult> {
  const text = existsSync(opts.path) ? readFileSync(opts.path, "utf8") : "{}";
  const doc = (parseConfigText(text) ?? {}) as Record<string, unknown>;
  const providers = (doc.providers ??= {}) as Record<string, unknown>;
  const og = (providers["opencode-go"] ??= {}) as Record<string, unknown>;
  const models = (og.models ??= {}) as Record<string, Record<string, unknown>>;

  let changed = 0;
  const before: Record<string, string | undefined> = {};
  for (const id of opts.modelIds) {
    const m = (models[id] ??= {});
    const settings = (m.settings ??= {}) as Record<string, unknown>;
    before[id] = typeof settings.baseURL === "string" ? settings.baseURL : undefined;
    if (settings.baseURL !== opts.baseURL) {
      settings.baseURL = opts.baseURL;
      changed++;
    }
  }

  let backup: string | null = null;
  if (changed > 0 && !opts.dryRun) {
    backup = backupFile(opts.path);
    const mode = existsSync(opts.path) ? statSync(opts.path).mode & 0o777 : 0o644;
    await writeFileAtomic(opts.path, JSON.stringify(doc, null, 2) + "\n", mode);
  }
  return { changed, backup, before };
}

/**
 * Build the pre-wire journal for wired.json. A value that was written by a previous wire run
 * (current proxy URL, or the older proxy URL during an A→B migration) is not a user value:
 * keep the original recorded in the prior journal instead. Journals from older versions have
 * no `prev` — their originals are unknown, so they downgrade to null (delete on unwire, i.e.
 * the legacy behavior).
 */
export function buildPrevMap(
  before: Record<string, string | undefined>,
  prior: WiredState | null,
  baseURL: string,
): Record<string, string | null> {
  const prev: Record<string, string | null> = {};
  for (const [id, b] of Object.entries(before)) {
    const injected = b === baseURL || (prior !== null && b === prior.baseURL);
    prev[id] = injected ? (prior?.prev?.[id] ?? null) : (b ?? null);
  }
  return prev;
}

/** True when wired.json lacks original-value entries for the current models (old schema / new model / URL change). */
export function journalStale(prior: WiredState | null, modelIds: string[], baseURL: string): boolean {
  if (!prior || !prior.prev || prior.baseURL !== baseURL) return true;
  const known = new Set(Object.keys(prior.prev));
  return modelIds.some((id) => !known.has(id));
}

export interface UnwireResult {
  removed: number;
  /** subset of removed entries restored to their pre-wire value (instead of deleted) */
  restored: number;
  backup: string | null;
}

/** Remove all baseURL overrides that point at our proxy (restoring pre-wire values when journaled). */
export async function unwireConfigFile(opts: {
  path: string;
  baseURL: string;
  /** journal from wired.json — models listed here get their pre-wire value restored */
  prev?: Record<string, string | null> | null;
  dryRun?: boolean;
}): Promise<UnwireResult> {
  if (!existsSync(opts.path)) return { removed: 0, restored: 0, backup: null };
  const text = readFileSync(opts.path, "utf8");
  const doc = (parseConfigText(text) ?? {}) as Record<string, unknown>;
  const providers = doc.providers as Record<string, unknown> | undefined;
  const og = providers?.["opencode-go"] as Record<string, unknown> | undefined;
  const models = og?.models as Record<string, Record<string, unknown>> | undefined;
  if (!models) return { removed: 0, restored: 0, backup: null };

  let removed = 0;
  let restored = 0;
  for (const [id, m] of Object.entries(models)) {
    const settings = m?.settings as Record<string, unknown> | undefined;
    if (settings && settings.baseURL === opts.baseURL) {
      const journaled =
        opts.prev && Object.prototype.hasOwnProperty.call(opts.prev, id) ? opts.prev[id] : undefined;
      if (typeof journaled === "string" && journaled.length > 0 && journaled !== opts.baseURL) {
        // reversible: this model had a baseURL before we injected ours → put it back
        settings.baseURL = journaled;
        restored++;
      } else {
        delete settings.baseURL;
      }
      removed++;
      if (Object.keys(settings).length === 0) delete m.settings;
    }
    if (m && typeof m === "object" && Object.keys(m).length === 0) delete models[id];
  }
  if (Object.keys(models).length === 0) delete og!.models;
  if (og && Object.keys(og).length === 0) delete providers!["opencode-go"];
  if (providers && Object.keys(providers).length === 0) delete doc.providers;

  let backup: string | null = null;
  if (removed > 0 && !opts.dryRun) {
    backup = backupFile(opts.path);
    const mode = statSync(opts.path).mode & 0o777;
    await writeFileAtomic(opts.path, JSON.stringify(doc, null, 2) + "\n", mode);
  }
  return { removed, restored, backup };
}

export function proxyBaseURL(cfg: Config): string {
  return `http://${cfg.proxy.host}:${cfg.proxy.port}`;
}

export async function wireGlobal(cfg: Config, dryRun = false): Promise<WireResult & { path: string; models: number }> {
  const catalog = await loadCatalog();
  const path = globalConfigPath();
  const baseURL = proxyBaseURL(cfg);
  const modelIds = Object.keys(catalog.models);
  const prior = await readJson<WiredState | null>(WIRED_STATE_PATH, null);
  const res = await wireConfigFile({ path, baseURL, modelIds, dryRun });
  // refresh the journal even when the config needed no changes: an upgraded install may still
  // carry a pre-`prev` journal (or a journal written for an older proxy URL / model set)
  if (!dryRun && (res.changed > 0 || journalStale(prior, modelIds, baseURL))) {
    const state: WiredState = {
      baseURL,
      configPath: path,
      models: modelIds,
      wiredAt: Date.now(),
      prev: buildPrevMap(res.before, prior, baseURL),
    };
    await writeJson(WIRED_STATE_PATH, state, 0o600);
  }
  return { ...res, path, models: modelIds.length };
}

export async function unwireGlobal(cfg: Config): Promise<UnwireResult & { path: string }> {
  const state = await readJson<WiredState | null>(WIRED_STATE_PATH, null);
  const baseURL = state?.baseURL ?? proxyBaseURL(cfg);
  const path = state?.configPath ?? globalConfigPath();
  const res = await unwireConfigFile({ path, baseURL, prev: state?.prev ?? null });
  return { ...res, path };
}

export interface WireStatus {
  path: string;
  baseURL: string;
  wired: boolean;
  written: number;
  /** 指向本代理但已不在当前目录中的残留条目数 */
  stale: number;
  total: number;
  configExists: boolean;
}

export async function wireStatus(cfg: Config): Promise<WireStatus> {
  const catalog = await loadCatalog();
  const path = globalConfigPath();
  const baseURL = proxyBaseURL(cfg);
  const total = Object.keys(catalog.models).length;
  if (!existsSync(path)) return { path, baseURL, wired: false, written: 0, stale: 0, total, configExists: false };
  try {
    const doc = parseConfigText(readFileSync(path, "utf8")) as Record<string, unknown>;
    const models = (doc.providers as Record<string, unknown> | undefined)?.["opencode-go"] as
      | Record<string, unknown>
      | undefined;
    const mm = (models?.models ?? {}) as Record<string, { settings?: { baseURL?: string } }>;
    const current = new Set(Object.keys(catalog.models));
    let written = 0;
    let stale = 0;
    for (const [id, m] of Object.entries(mm)) {
      if (m?.settings?.baseURL !== baseURL) continue;
      if (current.has(id)) written++;
      else stale++;
    }
    return { path, baseURL, wired: written > 0 || stale > 0, written, stale, total, configExists: true };
  } catch {
    return { path, baseURL, wired: false, written: 0, stale: 0, total, configExists: true };
  }
}
