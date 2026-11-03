import { join } from "node:path";
import { HOME, clamp, ensureDir, readJson, slugify, writeJson } from "./util";
import { isClientKind } from "./client";
import { isProviderIntegration } from "./providers";
import { codingAutoOrder } from "./coding_auto";
import type { Account, Config } from "./types";

export const OPENSELECT_DIR = join(HOME, ".openselect");
export const CONFIG_PATH = join(OPENSELECT_DIR, "config.json");
/** 台账路径；OPENSELECT_DB_PATH 可覆盖（测试隔离用，避免共享 HOME 捕获导致的跨文件污染） */
export const DB_PATH = process.env.OPENSELECT_DB_PATH ?? join(OPENSELECT_DIR, "data.sqlite");
export const BACKUP_DIR = join(OPENSELECT_DIR, "backups");
export const LOG_DIR = join(OPENSELECT_DIR, "logs");

export const SWITCH_AT_MIN = 0.95;

/** 静默时段时间格式 HH:MM */
export function isHhMm(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim());
}
export const SWITCH_AT_MAX = 0.99;

export function defaultConfig(): Config {
  return {
    version: 1,
    upstream: { base: "https://opencode.ai/inference/go" },
    proxy: { host: "127.0.0.1", port: 8788 },
    dashboard: { host: "127.0.0.1", port: 8789 },
    policy: {
      switchAt: 0.97,
      maxAttempts: 4,
      cooldownFallbackSec: 300,
      sessionTtlSec: 7200,
      freeFirst: [],
      alertAt: [0.9, 0.95, 0.97],
      alertCooldownSec: 21600,
      alertAtByWindow: {},
      alertQuiet: undefined,
      alertEmail: undefined,
    },
    monitor: { pollSec: 45 },
    opencode: { autoActivate: true },
    backup: { remote: null },
    zen: { enabled: true, port: 8790, fallbackModel: "deepseek-v4.1-flash" },
    accounts: [],
  };
}

export function normalizeConfig(raw: Partial<Config>): Config {
  const d = defaultConfig();
  const cfg: Config = {
    ...d,
    ...raw,
    upstream: { ...d.upstream, ...(raw.upstream ?? {}) },
    proxy: { ...d.proxy, ...(raw.proxy ?? {}) },
    dashboard: { ...d.dashboard, ...(raw.dashboard ?? {}) },
    policy: { ...d.policy, ...(raw.policy ?? {}) },
    monitor: { ...d.monitor, ...(raw.monitor ?? {}) },
    opencode: { ...d.opencode, ...(raw.opencode ?? {}) },
    backup: { ...d.backup, ...(raw.backup ?? {}) },
    zen: { ...d.zen, ...(raw.zen ?? {}) },
    accounts: Array.isArray(raw.accounts) ? (raw.accounts as Account[]) : [],
  };
  cfg.policy.switchAt = clamp(Number(cfg.policy.switchAt) || d.policy.switchAt, SWITCH_AT_MIN, SWITCH_AT_MAX);
  if (raw.policy?.codingAutoOrder !== undefined) cfg.policy.codingAutoOrder = codingAutoOrder(raw.policy.codingAutoOrder);
  cfg.policy.freeFirst = Array.isArray(raw.policy?.freeFirst)
    ? [
        ...new Set(
          raw.policy.freeFirst
            .filter((m): m is string => typeof m === "string" && m.trim() !== "")
            .map((m) => m.trim()),
        ),
      ]
    : [];
  cfg.policy.alertAt = Array.isArray(raw.policy?.alertAt)
    ? [
        ...new Set(
          raw.policy.alertAt
            .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1.5)
            .map((n) => Math.round(n * 1000) / 1000),
        ),
      ].sort((a, b) => a - b)
    : d.policy.alertAt;
  cfg.policy.alertCooldownSec = Number.isFinite(raw.policy?.alertCooldownSec)
    ? Math.max(0, Math.floor(raw.policy!.alertCooldownSec!))
    : d.policy.alertCooldownSec;
  // 按窗口分档阈值：逐窗口清洗（与全局同口径：0 < v <= 1.5）
  const byWindow = raw.policy?.alertAtByWindow;
  if (byWindow && typeof byWindow === "object") {
    const out: Partial<Record<"rolling" | "weekly" | "monthly", number[]>> = {};
    for (const w of ["rolling", "weekly", "monthly"] as const) {
      const list = (byWindow as Record<string, unknown>)[w];
      if (Array.isArray(list)) {
        const cleaned = [
          ...new Set(
            list
              .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1.5)
              .map((n) => Math.round(n * 1000) / 1000),
          ),
        ].sort((a, b) => a - b);
        if (cleaned.length > 0) out[w] = cleaned;
      }
    }
    cfg.policy.alertAtByWindow = out;
  } else {
    cfg.policy.alertAtByWindow = d.policy.alertAtByWindow;
  }
  // 静默时段：HH:MM 校验
  const quiet = raw.policy?.alertQuiet;
  if (quiet && typeof quiet === "object" && isHhMm(quiet.from) && isHhMm(quiet.to)) {
    cfg.policy.alertQuiet = { from: quiet.from, to: quiet.to };
  } else {
    cfg.policy.alertQuiet = d.policy.alertQuiet;
  }
  // 手动指定账号（面板「设为首选」）
  cfg.policy.forcedAccountId =
    typeof raw.policy?.forcedAccountId === "string" && raw.policy.forcedAccountId.trim() !== ""
      ? raw.policy.forcedAccountId.trim()
      : null;
  // 免费模型使用模式
  const rawMode = raw.policy?.freeFirstMode;
  cfg.policy.freeFirstMode = rawMode === "off" || rawMode === "fallback" || rawMode === "first" ? rawMode : "first";
  // 异地备份远端
  cfg.backup = {
    remote:
      typeof raw.backup?.remote === "string" && raw.backup.remote.trim() !== "" ? raw.backup.remote.trim() : null,
  };
  // zen 免费层：端口/兜底模型做类型清洗，避免手改配置写坏后运行期崩溃
  cfg.zen = {
    enabled: raw.zen?.enabled !== false,
    port:
      typeof raw.zen?.port === "number" && Number.isFinite(raw.zen.port) && raw.zen.port > 0
        ? Math.floor(raw.zen.port)
        : d.zen!.port!,
    fallbackModel:
      typeof raw.zen?.fallbackModel === "string" && raw.zen.fallbackModel.trim() !== ""
        ? raw.zen.fallbackModel.trim()
        : d.zen!.fallbackModel!,
  };
  // 按接入（客户端）指定账号：{clientKind: accountId}
  cfg.policy.clientAccounts = {};
  const rawClients = (raw.policy?.clientAccounts ?? {}) as Record<string, unknown>;
  if (rawClients && typeof rawClients === "object") {
    for (const [kind, id] of Object.entries(rawClients)) {
      if (!isClientKind(kind)) continue;
      if (typeof id === "string" && id.trim() !== "") cfg.policy.clientAccounts[kind] = id.trim();
    }
  }
  // 邮件通道
  const mail = raw.policy?.alertEmail;
  if (mail && typeof mail === "object") {
    const addrOk = (x: unknown): x is string =>
      typeof x === "string" && /^[^\s<>@]+@[^\s<>@]+$/.test(x) && !/[\r\n\x00-\x1f]/.test(x);
    const to = Array.isArray(mail.to) ? mail.to.filter(addrOk) : [];
    const from = addrOk(mail.from) ? mail.from : "";
    const host = typeof mail.host === "string" ? mail.host : "";
    const port = Number(mail.port);
    if (to.length > 0 && from && host && Number.isInteger(port) && port > 0 && port < 65536) {
      cfg.policy.alertEmail = { to, from, host, port };
    } else {
      cfg.policy.alertEmail = d.policy.alertEmail;
    }
  } else {
    cfg.policy.alertEmail = d.policy.alertEmail;
  }
  return cfg;
}

export async function loadConfig(): Promise<Config> {
  const raw = await readJson<Partial<Config>>(CONFIG_PATH, {});
  return normalizeConfig(raw);
}

export async function saveConfig(cfg: Config): Promise<void> {
  ensureDir(OPENSELECT_DIR);
  await writeJson(CONFIG_PATH, cfg, 0o600);
}

export function findAccount(cfg: Config, idOrLabel: string): Account | undefined {
  return cfg.accounts.find((a) => a.id === idOrLabel || a.label === idOrLabel);
}

export function uniqueId(cfg: Config, base: string): string {
  const taken = new Set(cfg.accounts.map((a) => a.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!taken.has(cand)) return cand;
  }
}

export async function addAccount(
  cfg: Config,
  input: {
    key: string;
    label?: string;
    integration?: string;
    note?: string;
    region?: "cn" | "global";
    baseUrl?: string;
    defaultEffort?: Account["defaultEffort"];
    models?: string[];
    plan?: string;
    fallbackOnly?: boolean;
  },
): Promise<{ account: Account; added: boolean }> {
  const integration = input.integration || "opencode-go";
  const key = input.key.trim();
  if (!key) throw new Error("Key 不能为空");
  // 同一把 Key 只允许在 deepseek（仅凭据）与 deepseek-api（直连兜底）之间复用；
  // 其他跨 integration 的重复 Key 仍然按原逻辑拒绝，避免误加同一把 key。
  const deepseekPair = (x: string, y: string): boolean =>
    (x === "deepseek" && y === "deepseek-api") || (x === "deepseek-api" && y === "deepseek");
  const existing = cfg.accounts.find(
    (a) => a.key === key && (a.integration === integration || !deepseekPair(a.integration, integration)),
  );
  if (existing) return { account: existing, added: false };
  const isProvider = isProviderIntegration(integration);
  const fallbackOnly = input.fallbackOnly ?? integration === "deepseek-api";
  const defaultSlug = integration === "ollama" ? "ollama" : integration === "commandcode" ? "cc" : "go";
  const base = slugify(input.label || `${defaultSlug}-${cfg.accounts.length + 1}`);
  const id = uniqueId(cfg, base);
  const account: Account = {
    id,
    label: input.label?.trim() || id,
    integration: (input.integration as Account["integration"]) || "opencode-go",
    key,
    enabled: true,
    note: input.note,
    addedAt: Date.now(),
    ...(input.region ? { region: input.region } : isProvider && integration === "minimax" ? { region: "cn" as const } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.defaultEffort ? { defaultEffort: input.defaultEffort } : isProvider ? { defaultEffort: "max" as const } : {}),
    ...(input.models?.length ? { models: input.models } : {}),
    ...(input.plan?.trim() ? { plan: input.plan.trim() } : {}),
    ...(fallbackOnly ? { fallbackOnly: true } : {}),
  };
  cfg.accounts.push(account);
  return { account, added: true };
}
