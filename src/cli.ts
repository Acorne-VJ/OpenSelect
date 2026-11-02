#!/usr/bin/env bun
import { CLIENT_KINDS, CLIENT_LABELS, isClientKind } from "./client";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { MODELS_PATH, isFreeFirstEligible, loadCatalog, resetCatalogCache } from "./catalog";
import {
  BACKUP_KEEP_DEFAULT,
  createBackup,
  fetchBackupsFromRemote,
  latestBackup,
  listBackups,
  manualStartHint,
  pruneBackups,
  pushBackupToRemote,
  validateRemote,
  restoreBackup,
  verifyBackup,
  BACKUP_BRANCH,
  LAUNCH_AGENT,
  LAUNCH_BACKUP_AGENT,
  LAUNCH_BACKUP_LABEL,
} from "./backup";
import {
  BACKUP_DIR,
  CONFIG_PATH,
  DB_PATH,
  LOG_DIR,
  OPENSELECT_DIR,
  addAccount,
  defaultConfig,
  loadConfig,
  saveConfig,
} from "./config";
import {
  getDb,
  getState,
  latestUsage,
  recentAlerts,
  recentRequests,
  recentSwitches,
  repairPollutedUsage,
  setState,
} from "./db";
import { startDashboard } from "./dashboard";
import { generateSigningKey, hasTrustAnchor, PRIVATE_KEY_PATH, publicKeyFingerprint } from "./keys";
import { activateCredential, connectKey, listCredentials, opencodeVersion } from "./opencode";
import { accountPressure, isRateLimited } from "./policy";
import { startProxy } from "./proxy";
import { Runtime } from "./state";
import { buildModelInfo, probeModelProtocol, reconcileCatalog, refreshWire, type ProbeResult } from "./sync";
import type { Account, Config, ModelInfo } from "./types";
import { fetchAccountModels, fetchAccountUsage, pollAll } from "./usage";
import { HOME, ensureDir, fmtLocal, fmtPct, maskKey, sleep, writeFileAtomic, xmlEscape } from "./util";
import { proxyBaseURL, unwireGlobal, wireGlobal, wireStatus } from "./wire";

type Flags = Record<string, string | boolean | undefined>;

/** 不接受值的短横线开关 */
const BOOL_FLAGS = new Set(["h", "help", "v", "version", "y", "yes", "list", "write", "apply", "json"]);

function parseArgs(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const nxt = argv[i + 1];
        if (nxt && !nxt.startsWith("-")) {
          flags[a.slice(2)] = nxt;
          i++;
        } else flags[a.slice(2)] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      // 短横线参数：布尔开关（-h/-v/-y…）不带值；其余（-n 20）把下一个 token 当作值
      const key = a.slice(1);
      const nxt = i + 1 < argv.length ? argv[i + 1]! : "";
      if (!BOOL_FLAGS.has(key) && nxt !== "" && !nxt.startsWith("-") && !Number.isNaN(Number(nxt))) {
        flags[key] = nxt;
        i++;
      } else {
        flags[key] = true;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

/** 布尔 flag：--flag / --flag=true / --flag true 都算真（避免 --flag=true 被当字符串而静默失效） */
function isTrue(v: string | boolean | undefined): boolean {
  return v === true || v === "true" || v === "1" || v === "yes";
}

function pad(s: string, n: number): string {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return s + " ".repeat(Math.max(1, n - w));
}

function accountStatusLine(a: Account, u: ReturnType<typeof latestUsage>, switchAt: number): string {
  if (!a.enabled) return "已禁用";
  if (getState(a.id)?.invalid) return "已失效";
  if (!u) return "无数据";
  if (isRateLimited(u)) return "已限流";
  if (accountPressure(u) >= switchAt) return "接近阈值";
  return "正常";
}

async function checkHealth(host: string, port: number, path: string): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}${path}`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- commands

async function cmdInit(): Promise<void> {
  ensureDir(OPENSELECT_DIR);
  ensureDir(BACKUP_DIR);
  ensureDir(LOG_DIR);
  if (!existsSync(CONFIG_PATH)) await saveConfig(defaultConfig());
  console.log(`✓ 已初始化 ${OPENSELECT_DIR}`);
  console.log(`  配置:   ${CONFIG_PATH}`);
  console.log(`  数据库: ${DB_PATH}`);
  console.log(`  下一步:`);
  console.log(`    opensel add --key oc_sk_... --label go-01`);
  console.log(`    opensel serve            # 代理 :8788 + 面板 :8789`);
  console.log(`    opensel wire             # 把 opencode 的 opencode-go 流量接入代理`);
}

async function cmdAdd(flags: Flags): Promise<void> {
  const key = typeof flags.key === "string" ? flags.key : process.env.OPENSEL_KEY;
  if (!key) {
    console.error("用法: opensel add --key oc_sk_... [--label go-01] [--integration opencode-go] [--no-opencode]");
    process.exit(1);
  }
  const cfg = await loadConfig();
  const { account, added } = await addAccount(cfg, {
    key,
    label: typeof flags.label === "string" ? flags.label : undefined,
    integration: typeof flags.integration === "string" ? flags.integration : undefined,
  });
  if (added) {
    await saveConfig(cfg);
    console.log(`✓ 已添加账号 ${account.id}（${maskKey(account.key)}）`);
  } else {
    console.log(`账号已存在: ${account.id}`);
  }
  const r = await fetchAccountUsage(cfg.upstream.base, account);
  if (r.ok) {
    const u = r.usage;
    console.log(
      `  校验: rolling ${fmtPct(u.rolling.percent)} [${u.rolling.status}] · weekly ${fmtPct(u.weekly.percent)} [${u.weekly.status}] · monthly ${fmtPct(u.monthly.percent)} [${u.monthly.status}]`,
    );
  } else {
    console.log(`  ⚠ 用量校验失败: ${r.error}`);
  }
  if (r.ok) {
    // key 验证通过 → 清除历史失效/冷却标记（修复 key 后重新添加的场景）
    setState({ accountId: account.id, invalid: false, cooldownUntil: 0, lastError: null });
  }
  if (!flags["no-opencode"]) {
    const res = connectKey(account.integration, account.key, account.label);
    console.log(
      res.ok
        ? `  ✓ 已注册到 opencode 凭据（label: ${account.label}）`
        : `  ⚠ opencode 注册失败（可稍后重试）: ${res.detail.slice(0, 160)}`,
    );
  }
}

function extractKey(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  const v = value as Record<string, unknown>;
  if (typeof v.key === "string") return v.key;
  if (typeof v.value === "string") return v.value;
  if (typeof v.apiKey === "string") return v.apiKey;
  return null;
}

async function cmdImport(): Promise<void> {
  const creds = listCredentials();
  if (!creds) {
    console.error("无法读取 opencode 凭据（opencode CLI 不可用？）");
    process.exit(1);
  }
  const cfg = await loadConfig();
  let added = 0;
  let skipped = 0;
  for (const c of creds) {
    if (c.integrationID !== "opencode-go") continue;
    const key = extractKey(c.value);
    if (!key || !key.startsWith("oc_")) continue;
    const label = c.label && c.label !== "API key" ? c.label : undefined;
    const r = await addAccount(cfg, { key, label, integration: "opencode-go" });
    if (r.added) added++;
    else skipped++;
  }
  await saveConfig(cfg);
  console.log(`导入完成: 新增 ${added} 个账号，已存在 ${skipped} 个`);
}

async function cmdRemove(pos: string[]): Promise<void> {
  const target = pos[1];
  if (!target) {
    console.error("用法: opensel remove <label|account-id>");
    process.exit(1);
  }
  const cfg = await loadConfig();
  const hit = cfg.accounts.find((a) => a.label === target || a.id === target);
  if (!hit) {
    console.error(`未找到账号: ${target}`);
    process.exit(1);
  }
  cfg.accounts = cfg.accounts.filter((a) => a !== hit);
  // 一并清掉指向该账号的指定（手动首选 / 按接入指定），不留幽灵引用
  if (cfg.policy.forcedAccountId === hit.id) cfg.policy.forcedAccountId = null;
  const pins = { ...(cfg.policy.clientAccounts ?? {}) };
  let pinsCleared = 0;
  for (const [kind, accId] of Object.entries(pins)) {
    if (accId === hit.id) {
      delete pins[kind];
      pinsCleared++;
    }
  }
  if (pinsCleared > 0) cfg.policy.clientAccounts = pins;
  await saveConfig(cfg);
  console.log(`✓ 已从账号池移除 ${hit.label}（${maskKey(hit.key)}）`);
  if (pinsCleared > 0) console.log(`  已清除 ${pinsCleared} 个指向该账号的接入指定`);
  console.log("  注: opencode 凭据未删除；如需删除请在 opencode 中手动操作");
}

async function cmdAccounts(flags: Flags): Promise<void> {
  const cfg = await loadConfig();
  if (flags.json) {
    console.log(
      JSON.stringify(
        cfg.accounts.map((a) => ({
          id: a.id,
          label: a.label,
          integration: a.integration,
          key: maskKey(a.key),
          enabled: a.enabled,
          usage: latestUsage(a.id),
        })),
        null,
        2,
      ),
    );
    return;
  }
  console.log(pad("账号", 16) + pad("Key", 20) + pad("状态", 10) + pad("rolling", 12) + pad("weekly", 12) + pad("monthly", 12) + "最后重置");
  for (const a of cfg.accounts) {
    const u = latestUsage(a.id);
    console.log(
      pad(a.label, 16) +
        pad(maskKey(a.key), 20) +
        pad(accountStatusLine(a, u, cfg.policy.switchAt), 10) +
        pad(u ? fmtPct(u.rolling.percent) : "-", 12) +
        pad(u ? fmtPct(u.weekly.percent) : "-", 12) +
        pad(u ? fmtPct(u.monthly.percent) : "-", 12) +
        (u?.monthly.resetsAt ?? "-"),
    );
  }
}

async function cmdUsage(flags: Flags): Promise<void> {
  const cfg = await loadConfig();
  const once = async () => {
    const accounts = cfg.accounts.filter((a) => a.enabled);
    if (accounts.length === 0) {
      console.log("没有账号。先 opensel add / import。");
      return;
    }
    console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] rolling / weekly / monthly`);
    console.log(pad("账号", 16) + pad("rolling", 12) + pad("weekly", 12) + pad("monthly", 12) + "状态");
    for (const a of accounts) {
      const r = await fetchAccountUsage(cfg.upstream.base, a);
      if (r.ok) {
        const u = r.usage;
        const limited = [u.rolling, u.weekly, u.monthly].find((w) => w.status === "rate-limited");
        console.log(
          pad(a.label, 16) +
            pad(fmtPct(u.rolling.percent), 12) +
            pad(fmtPct(u.weekly.percent), 12) +
            pad(fmtPct(u.monthly.percent), 12) +
            (limited ? `限流中(${limited === u.rolling ? "rolling" : limited === u.weekly ? "weekly" : "monthly"})` : "正常"),
        );
      } else {
        console.log(pad(a.label, 16) + `!! ${r.error}`);
      }
    }
  };
  await once();
  if (flags.loop) {
    for (;;) {
      await sleep(Math.max(10, cfg.monitor.pollSec) * 1000);
      await once();
    }
  }
}

async function cmdStatus(flags: Flags): Promise<void> {
  const cfg = await loadConfig();
  const ws = await wireStatus(cfg);
  const proxyUp = await checkHealth(cfg.proxy.host, cfg.proxy.port, "/healthz");
  const dashUp = await checkHealth(cfg.dashboard.host, cfg.dashboard.port, "/healthz");
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          config: CONFIG_PATH,
          accounts: cfg.accounts.map((a) => ({ ...a, key: maskKey(a.key), usage: latestUsage(a.id) })),
          proxy: { port: cfg.proxy.port, running: proxyUp },
          dashboard: { port: cfg.dashboard.port, running: dashUp },
          wire: ws,
          policy: cfg.policy,
          recentSwitches: recentSwitches(10),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("OpenSelect 状态");
  console.log(`  配置    ${CONFIG_PATH}（${cfg.accounts.length} 个账号）`);
  console.log(`  代理    http://${cfg.proxy.host}:${cfg.proxy.port}${proxyUp ? "  运行中" : "  未运行"}`);
  console.log(`  面板    http://${cfg.dashboard.host}:${cfg.dashboard.port}${dashUp ? "  运行中" : "  未运行"}`);
  console.log(
    `  接入    ${ws.wired ? `${ws.written}/${ws.total} 模型 → ${ws.baseURL}` : "未注入（opensel wire）"}  ${ws.path}`,
  );
  console.log(
    `  策略    阈值 ${(cfg.policy.switchAt * 100).toFixed(1)}% · 轮询 ${cfg.monitor.pollSec}s · 单请求最多尝试 ${cfg.policy.maxAttempts} 个账号 · 会话粘性 ${Math.round(cfg.policy.sessionTtlSec / 3600)}h`,
  );
  const ffMode = cfg.policy.freeFirstMode ?? "first";
  const ffModeText = ffMode === "off" ? "关闭" : ffMode === "fallback" ? "兜底（付费不可用时才用）" : "优先";
  console.log(`  免费优先 ${ffModeText} · 候选 ${(cfg.policy.freeFirst ?? []).join(", ") || "（未选）"}`);
  const forced = cfg.policy.forcedAccountId ? cfg.accounts.find((a) => a.id === cfg.policy.forcedAccountId)?.label ?? cfg.policy.forcedAccountId : null;
  console.log(`  手动指定 ${forced ?? "未设置（按自然策略选号）"}`);
  const pins = cfg.policy.clientAccounts ?? {};
  const pinLines = CLIENT_KINDS.filter((k) => pins[k]).map(
    (k) => `${CLIENT_LABELS[k]}→${cfg.accounts.find((a) => a.id === pins[k])?.label ?? pins[k]}`,
  );
  console.log(`  接入指定 ${pinLines.length ? pinLines.join("，") : "未设置（各接入按自然策略）"}`);
  console.log(
    `  告警阈值 ${(cfg.policy.alertAt ?? []).map((n) => `${(n * 100).toFixed(0)}%`).join(", ") || "关闭"}（越线通知，与切换阈值独立）`,
  );
  const byWin = cfg.policy.alertAtByWindow ?? {};
  const winTxt = Object.entries(byWin)
    .map(([w, list]) => `${w} ${(list ?? []).map((n) => `${(n * 100).toFixed(0)}%`).join("/")}`)
    .join(" · ");
  if (winTxt) console.log(`  分窗口阈值 ${winTxt}`);
  if (cfg.policy.alertQuiet) console.log(`  静默时段 ${cfg.policy.alertQuiet.from} → ${cfg.policy.alertQuiet.to}（只记台账，不发通知）`);
  if (cfg.policy.alertEmail) console.log(`  邮件告警 ${cfg.policy.alertEmail.to.join(", ")}（${cfg.policy.alertEmail.host}:${cfg.policy.alertEmail.port}）`);
  const fp = publicKeyFingerprint();
  console.log(`  备份签名 ${fp ? `已配置（信任锚指纹 ${fp}）` : "未配置（opensel keygen 生成密钥对，备份加 --sign）"}`);
  console.log("");
  console.log(pad("账号", 16) + pad("状态", 12) + pad("rolling", 12) + pad("weekly", 12) + pad("monthly", 12) + "最近使用");
  for (const a of cfg.accounts) {
    const u = latestUsage(a.id);
    console.log(
      pad(a.label, 16) +
        pad(accountStatusLine(a, u, cfg.policy.switchAt), 12) +
        pad(u ? fmtPct(u.rolling.percent) : "-", 12) +
        pad(u ? fmtPct(u.weekly.percent) : "-", 12) +
        pad(u ? fmtPct(u.monthly.percent) : "-", 12) +
        (u ? new Date(u.ts).toLocaleTimeString("zh-CN", { hour12: false }) : "-"),
    );
  }
  const sw = recentSwitches(5);
  if (sw.length > 0) {
    console.log("\n最近切换:");
    for (const s of sw) {
      console.log(`  ${fmtLocal(s.ts)}  ${s.fromAccount ?? "-"} → ${s.toAccount ?? "-"}  ${s.reason}${s.detail ? `  ${s.detail}` : ""}`);
    }
  }
}

let lastActivated: string | null = null;

async function maybeSyncActive(rt: Runtime, force = false): Promise<void> {
  if (!rt.config.opencode.autoActivate) return;
  const target = rt.preferredAccountId;
  if (!target || (!force && target === lastActivated)) return;
  const acct = rt.account(target);
  if (!acct) return;
  const creds = listCredentials();
  if (!creds) return;
  const ours = creds.filter((c) => c.integrationID === acct.integration);
  const current = ours.find((c) => c.active);
  if (current && extractKey(current.value) === acct.key) {
    lastActivated = target;
    return;
  }
  const targetCred = ours.find((c) => extractKey(c.value) === acct.key);
  if (!targetCred) return;
  const r = activateCredential(targetCred.id);
  if (r.ok) {
    lastActivated = target;
    console.log(`[auto] opencode 活跃凭据 → ${acct.label}`);
  }
}

async function cmdServe(flags: Flags): Promise<void> {
  const cfg = await loadConfig();
  const catalog = await loadCatalog();
  if (cfg.accounts.length === 0) {
    console.error("没有账号，先 opensel add 或 opensel import");
    process.exit(1);
  }
  const rt = new Runtime(cfg, catalog);
  if (rt.usageSeeded > 0) console.log(`✓ 已恢复 ${rt.usageSeeded} 个账号最近用量（重启窗口保护）`);
  const stops: Array<() => void> = [];
  const shutdown = () => {
    for (const s of stops) {
      try {
        s();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!flags["dashboard-only"]) {
    const px = startProxy(rt);
    stops.push(px.stop);
    console.log(`✓ 代理      http://${cfg.proxy.host}:${cfg.proxy.port}  →  ${cfg.upstream.base}`);
  }
  if (!flags["proxy-only"]) {
    const db = startDashboard(rt);
    stops.push(db.stop);
    console.log(`✓ 控制面板  http://${cfg.dashboard.host}:${cfg.dashboard.port}`);
  }
  console.log(`✓ 用量监控  每 ${cfg.monitor.pollSec}s 轮询 ${cfg.accounts.filter((a) => a.enabled).length} 个账号`);

  let stopped = false;
  stops.push(() => {
    stopped = true;
  });
  let cfgMtime = 0;
  try {
    cfgMtime = statSync(CONFIG_PATH).mtimeMs;
  } catch {
    /* missing file — keep 0 */
  }
  void (async () => {
    while (!stopped) {
      try {
        const m = (() => {
          try {
            return statSync(CONFIG_PATH).mtimeMs;
          } catch {
            return 0;
          }
        })();
        if (m !== 0 && m !== cfgMtime) {
          cfgMtime = m;
          const prevProxyPort = rt.config.proxy.port;
          const prevDashPort = rt.config.dashboard.port;
          rt.config = await loadConfig();
          const prevForced = rt.forcedAccountId;
          const wantForced = rt.config.policy.forcedAccountId ?? null;
          if (wantForced) {
            const target = rt.config.accounts.find((a) => a.id === wantForced);
            if (!target || !target.enabled) {
              // 目标账号不存在或已停用 → 忽略强制，不重绑会话（避免绑定到幽灵账号）
              rt.forcedAccountId = null;
              console.log(`[reload] ⚠ 手动指定账号 ${wantForced} 不存在或已停用 → 已忽略`);
            } else if (wantForced !== prevForced) {
              const n = rt.forceAccount(wantForced);
              console.log(`[reload] 手动指定账号 → ${rt.forcedAccountId}（重绑 ${n} 个会话）`);
            }
          } else {
            rt.forcedAccountId = null;
          }
          console.log(`[reload] 配置热加载: ${rt.config.accounts.length} 个账号`);
          if (rt.config.proxy.port !== prevProxyPort || rt.config.dashboard.port !== prevDashPort) {
            console.log(`[reload] ⚠ 端口变更需重启服务生效（当前监听 :${prevProxyPort} / :${prevDashPort}）`);
          }
        }
        await pollAll(rt);
      } catch (e) {
        console.error("poller error:", e);
      }
      await maybeSyncActive(rt);
      await sleep(Math.max(10, rt.config.monitor.pollSec) * 1000);
    }
  })();

  await new Promise<void>(() => {});
}

async function cmdWire(flags: Flags): Promise<void> {
  const cfg = await loadConfig();
  const dry = flags["dry-run"] === true;
  const res = await wireGlobal(cfg, dry);
  if (res.changed === 0) {
    console.log(`已是最新: ${res.path}（目标 ${proxyBaseURL(cfg)}）`);
    return;
  }
  console.log(`${dry ? "[dry-run] 将为" : "✓ 已为"} ${res.changed} 个模型注入 baseURL → ${proxyBaseURL(cfg)}`);
  if (res.backup) console.log(`  备份: ${res.backup}`);
  console.log(`  文件: ${res.path}`);
  if (!dry) console.log("  提示: 重启 opencode 后生效；撤销用 opensel unwire");
}

async function cmdUnwire(): Promise<void> {
  const cfg = await loadConfig();
  const res = await unwireGlobal(cfg);
  if (res.removed === 0) console.log(`没有发现注入项（${res.path}）`);
  else {
    const restoredNote = res.restored > 0 ? `（其中 ${res.restored} 个恢复为注入前原值）` : "";
    console.log(`✓ 已移除 ${res.removed} 个模型的 baseURL 注入${restoredNote}`);
    if (res.backup) console.log(`  备份: ${res.backup}`);
    console.log(`  文件: ${res.path}`);
  }
}

async function cmdDoctor(): Promise<void> {
  console.log("OpenSelect 体检");
  console.log(`  ✓ bun ${Bun.version}`);
  const ov = opencodeVersion();
  console.log(ov ? `  ✓ opencode ${ov}` : "  ✗ opencode 不可用（不在 PATH？）");
  const cfg = await loadConfig();
  if (cfg.accounts.length > 0) {
    console.log(`  ✓ 账号 ${cfg.accounts.length} 个（${cfg.accounts.filter((a) => a.enabled).length} 启用）`);
  } else {
    console.log("  ✗ 未配置账号（opensel add / import）");
  }
  for (const a of cfg.accounts) {
    const r = await fetchAccountUsage(cfg.upstream.base, a);
    if (r.ok) {
      const u = r.usage;
      const limited = [u.rolling, u.weekly, u.monthly].some((w) => w.status === "rate-limited");
      console.log(
        `  ${limited ? "!" : "✓"} ${a.label} key 有效 · rolling ${fmtPct(u.rolling.percent)} / weekly ${fmtPct(u.weekly.percent)} / monthly ${fmtPct(u.monthly.percent)}${limited ? "（有限流窗口）" : ""}`,
      );
    } else {
      console.log(`  ✗ ${a.label} 校验失败: ${r.error}`);
    }
  }
  const proxyUp = await checkHealth(cfg.proxy.host, cfg.proxy.port, "/healthz");
  if (proxyUp) console.log(`  ✓ 代理 :${cfg.proxy.port} 运行中`);
  else {
    try {
      const t = Bun.serve({ hostname: cfg.proxy.host, port: cfg.proxy.port, fetch: () => new Response("x") });
      t.stop(true);
      console.log(`  ✓ 代理端口 :${cfg.proxy.port} 空闲`);
    } catch {
      console.log(`  ✗ 代理端口 :${cfg.proxy.port} 被其他程序占用`);
    }
  }
  const dashUp = await checkHealth(cfg.dashboard.host, cfg.dashboard.port, "/healthz");
  console.log(dashUp ? `  ✓ 面板运行中` : `  · 面板未运行（可选）`);
  const ws = await wireStatus(cfg);
  console.log(ws.wired ? `  ✓ 已接入 opencode（${ws.written}/${ws.total} 模型）` : `  ✗ 未接入 opencode（opensel wire）`);
  const creds = listCredentials();
  console.log(creds ? `  ✓ opencode 凭据服务正常（${creds.length} 条）` : `  ✗ opencode 凭据服务不可达`);

  // 功能链自检：免费优先 / 告警 / 备份 / 签名
  const freeFirst = cfg.policy.freeFirst ?? [];
  console.log(
    freeFirst.length > 0
      ? `  ✓ 免费优先已启用（${freeFirst.join(", ")}）`
      : "  · 免费优先未启用（付费模型直接使用）",
  );
  const alertAt = cfg.policy.alertAt ?? [];
  console.log(
    alertAt.length > 0
      ? `  ✓ 用量告警已启用（${alertAt.map((n) => `${(n * 100).toFixed(0)}%`).join(", ")}）`
      : "  · 用量告警未启用",
  );
  if (cfg.policy.alertQuiet) console.log(`  ✓ 告警静默时段 ${cfg.policy.alertQuiet.from} → ${cfg.policy.alertQuiet.to}`);
  if (cfg.policy.alertEmail) {
    console.log(`  ✓ 邮件告警已配置（${cfg.policy.alertEmail.to.join(", ")} ← ${cfg.policy.alertEmail.host}:${cfg.policy.alertEmail.port}）`);
  }
  const fp = publicKeyFingerprint();
  console.log(fp ? `  ✓ 备份签名信任锚已配置（指纹 ${fp}）` : "  · 备份签名未配置信任锚（opensel keygen）");
  const byWin = cfg.policy.alertAtByWindow ?? {};
  const winTxt = Object.entries(byWin)
    .map(([w, list]) => `${w} ${(list ?? []).map((n) => `${(n * 100).toFixed(0)}%`).join("/")}`)
    .join(" · ");
  if (winTxt) console.log(`  ✓ 分窗口告警阈值 ${winTxt}`);
  const latestPath = latestBackup();
  if (!latestPath) {
    console.log("  · 暂无备份（opensel backup）");
  } else {
    const name = latestPath.split("/").pop()!;
    const signed = existsSync(`${latestPath}.sig`);
    let verified: boolean | null = null;
    if (signed && fp) {
      try {
        verified = (await verifyBackup(latestPath)).signature?.verified ?? null;
      } catch {
        verified = null;
      }
    }
    if (!signed) {
      console.log(`  ! 最新备份 ${name} 未签名：无法证明来源（opensel backup --sign；已配信任锚时恢复会被拒）`);
    } else if (verified === false) {
      console.log(`  ✗ 最新备份 ${name} 验签失败：可能换过密钥或归档被篡改，请核对信任锚指纹 ${fp}`);
    } else if (verified === null) {
      console.log(`  ! 最新备份 ${name} 有签名但本机无信任公钥 → 仅完成完整性校验（opensel keygen）`);
    } else {
      console.log(`  ✓ 最新备份 ${name} 已签名且验签通过`);
    }
  }
}


async function cmdInstall(): Promise<void> {
  ensureDir(join(HOME, "Library", "LaunchAgents"));
  ensureDir(LOG_DIR);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.openselect.agent</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${join(import.meta.dir, "cli.ts")}</string><string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"}</string>
  </dict>
  <key>StandardOutPath</key><string>${join(LOG_DIR, "agent.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, "agent.err.log")}</string>
</dict></plist>
`;
  await Bun.write(LAUNCH_AGENT, plist);
  const uid = process.getuid?.() ?? 501;
  // 已在运行 → 只重启（kickstart），避免 bootout+bootstrap 的空窗与竞态
  const already = spawnSync("launchctl", ["print", `gui/${uid}/com.openselect.agent`], { encoding: "utf8" }).status === 0;
  if (already) {
    const k = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/com.openselect.agent`], { encoding: "utf8" });
    if (k.status === 0) console.log("✓ launchd 服务已重启（登录自启 + 崩溃自动重启）");
    else console.log(`⚠ launchctl kickstart 失败: ${(k.stderr || k.stdout || "").trim()}\n  可手动执行: launchctl kickstart -k gui/${uid}/com.openselect.agent`);
  } else {
    spawnSync("launchctl", ["bootout", `gui/${uid}/com.openselect.agent`], { encoding: "utf8" });
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, LAUNCH_AGENT], { encoding: "utf8" });
    if (r.status === 0) console.log("✓ launchd 已加载（登录自启 + 崩溃自动重启）");
    else {
      // 回退：legacy load（bootstrap 偶发 Input/output error）
      const l = spawnSync("launchctl", ["load", "-w", LAUNCH_AGENT], { encoding: "utf8" });
      console.log(
        l.status === 0
          ? "✓ launchd 已加载（经 launchctl load 回退）"
          : `⚠ launchctl bootstrap 失败: ${(r.stderr || r.stdout || "").trim()}\n  可手动执行: launchctl load -w ${LAUNCH_AGENT}`,
      );
    }
  }
  console.log(`  plist: ${LAUNCH_AGENT}`);

  // 定时备份任务：每日 03:30 执行 opensel backup --keep 14（配置了异地远端则一并推送）
  const rawBackupRemote = (await loadConfig()).backup?.remote ?? null;
  let backupRemote: string | null = null;
  if (rawBackupRemote) {
    const bad = validateRemote(rawBackupRemote);
    if (bad) {
      console.log(`⚠ 配置里的异地备份远端非法（${bad}）→ 定时备份只做本地备份；请用 opensel backup --remote <url> 修正`);
    } else {
      backupRemote = rawBackupRemote;
    }
  }
  // plist 是 XML：远端必须转义（否则含 & 会让 plist 非法，含 < 可注入任意键）
  const backupPushArgs = backupRemote
    ? `<string>--push</string><string>${xmlEscape(backupRemote)}</string><string>--yes</string>`
    : "";
  const backupPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_BACKUP_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${join(import.meta.dir, "cli.ts")}</string><string>backup</string><string>--keep</string><string>14</string><string>--sign-if-possible</string>${backupPushArgs}
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"}</string>
  </dict>
  <key>StandardOutPath</key><string>${join(LOG_DIR, "backup.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, "backup.err.log")}</string>
</dict></plist>
`;
  await Bun.write(LAUNCH_BACKUP_AGENT, backupPlist);
  // 总是重新装载定时备份任务：plist 变更（例如新增 --push 参数）必须生效，
  // 否则 launchd 仍跑旧参数（已加载时不会自动重读 plist）
  // 装载前先校验 plist 合法性：非法 plist 会让 launchctl bootstrap 失败，
  // 若此时已把旧任务 bootout，每日备份就会静默消失 → 先校验再卸载
  const lint = spawnSync("plutil", ["-lint", LAUNCH_BACKUP_AGENT], { encoding: "utf8" });
  if (lint.status !== 0) {
    console.log(`⚠ 定时备份任务的 plist 非法（${(lint.stderr || lint.stdout || "").trim()}）→ 保留原任务，未重新装载`);
    console.log(`  plist: ${LAUNCH_BACKUP_AGENT}`);
    return;
  }
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LAUNCH_BACKUP_LABEL}`], { encoding: "utf8" });
  const rb = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, LAUNCH_BACKUP_AGENT], { encoding: "utf8" });
  if (rb.status !== 0) {
    const l = spawnSync("launchctl", ["load", "-w", LAUNCH_BACKUP_AGENT], { encoding: "utf8" });
    if (l.status !== 0) {
      console.log(`⚠ 定时备份任务加载失败: ${(rb.stderr || rb.stdout || "").trim()}\n  可手动执行: launchctl load -w ${LAUNCH_BACKUP_AGENT}`);
    }
  }
  console.log(`✓ 定时备份任务已加载（每日 03:30，保留最新 14 份${backupRemote ? `，并推送到 ${backupRemote}` : ""}）`);
  console.log(`  plist: ${LAUNCH_BACKUP_AGENT}`);
}

async function cmdUninstall(): Promise<void> {
  const uid = process.getuid?.() ?? 501;
  spawnSync("launchctl", ["bootout", `gui/${uid}/com.openselect.agent`], { encoding: "utf8" });
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LAUNCH_BACKUP_LABEL}`], { encoding: "utf8" });
  const { rmSync } = await import("node:fs");
  let removed = 0;
  for (const p of [LAUNCH_AGENT, LAUNCH_BACKUP_AGENT]) {
    if (existsSync(p)) {
      rmSync(p);
      removed++;
    }
  }
  console.log(
    removed > 0 ? `✓ 已卸载 launchd 任务并删除 ${removed} 个 plist` : "未发现 launchd 任务",
  );
}

async function cmdLogs(flags: Flags): Promise<void> {
  const n = typeof flags.n === "string" ? Number(flags.n) || 20 : 20;
  console.log("最近请求:");
  const reqs = recentRequests(n);
  for (const r of reqs) {
    console.log(
      `  ${fmtLocal(r.ts)}  ${(r.model ?? "-").padEnd(28).slice(0, 28)}  → ${r.accountId}  ${r.status}  ${r.attempts}x  ${r.latencyMs}ms${r.error ? `  ${r.error.slice(0, 60)}` : ""}`,
    );
  }
  if (reqs.length === 0) console.log("  （无）");
  console.log("\n最近切换:");
  const sw = recentSwitches(n);
  for (const s of sw) {
    console.log(`  ${fmtLocal(s.ts)}  ${s.fromAccount ?? "-"} → ${s.toAccount ?? "-"}  ${s.reason}${s.detail ? `  ${s.detail}` : ""}`);
  }
  if (sw.length === 0) console.log("  （无）");
}

async function cmdSyncCatalog(flags: Flags): Promise<void> {
  const cfg = await loadConfig();
  const write = flags.write === true;
  const asJson = flags.json === true;
  const doProbe = flags["no-probe"] !== true;
  const base = cfg.upstream.base;
  const accounts = cfg.accounts.filter((a) => a.enabled);
  if (accounts.length === 0) {
    console.error("没有启用的账号，无法获取账号实际模型清单。");
    process.exit(1);
  }

  const perAccount: Array<{ id: string; count: number; ids: string[] }> = [];
  for (const a of accounts) {
    const r = await fetchAccountModels(base, a);
    if (!r.ok) {
      console.error(`✗ ${a.id} 模型清单获取失败: HTTP ${r.status} ${r.error}`);
      console.error("未做任何修改。");
      process.exit(1);
    }
    perAccount.push({ id: a.id, count: r.ids.length, ids: r.ids });
  }
  const liveIds = [...new Set(perAccount.flatMap((p) => p.ids))].sort();
  const catalog = await loadCatalog();
  const currentIds = Object.keys(catalog.models);
  const liveSet = new Set(liveIds);
  const addedIds = liveIds.filter((id) => !catalog.models[id]);
  const removedIds = currentIds.filter((id) => !liveSet.has(id)).sort();

  // 探测使用"实际声明该模型"的账号（同一模型多账号声明时取首个启用账号）——
  // 避免与模型无关账号的鉴权/权限错误被误当作协议证据
  const ownerByModel = new Map<string, { key: string; label: string }>();
  for (const p of perAccount) {
    const acct = accounts.find((a) => a.id === p.id);
    if (!acct) continue;
    for (const id of p.ids) {
      if (!ownerByModel.has(id)) ownerByModel.set(id, { key: acct.key, label: acct.label ?? acct.id });
    }
  }

  const probes: Record<string, ProbeResult> = {};
  if (doProbe) {
    for (const id of addedIds) {
      const owner = ownerByModel.get(id) ?? { key: accounts[0]!.key, label: accounts[0]!.label ?? accounts[0]!.id };
      probes[id] = await probeModelProtocol({ base, key: owner.key, modelId: id });
      if (!asJson) {
        const steps = probes[id]!.steps.map((s) => `${s.probe}=${s.verdict}`).join(", ");
        console.log(`  探测 ${id}（${owner.label}）: ${probes[id]!.protocol}（${steps}）`);
      }
    }
  }

  const metaFor = (id: string): ModelInfo =>
    buildModelInfo(id, doProbe ? (probes[id]?.protocol ?? "unknown") : "unknown");
  const rec = reconcileCatalog(catalog.models, liveIds, metaFor);
  const changed = rec.added.length > 0 || rec.removed.length > 0;

  let applied = false;
  let rewire: { removed: number; restored: number; injected: number } | null = null;
  let wireWarning: string | null = null;
  if (write && changed) {
    await writeFileAtomic(MODELS_PATH, JSON.stringify(rec.next, null, 1) + "\n", 0o644);
    resetCatalogCache();
    applied = true;
    const ws = await wireStatus(cfg);
    if (ws.wired) {
      const counts = { removed: 0, restored: 0, injected: 0 };
      const rr = await refreshWire({
        unwire: async () => {
          const u = await unwireGlobal(cfg);
          counts.removed += u.removed;
          counts.restored += u.restored;
        },
        wire: async () => {
          counts.injected = (await wireGlobal(cfg)).changed;
        },
      });
      if (rr.refreshed) {
        rewire = { ...counts };
      } else {
        const after = await wireStatus(cfg);
        wireWarning = `${rr.warning ?? "wire 注入刷新失败"}（当前注入 ${after.written}/${after.total}${after.stale > 0 ? `，残留 ${after.stale} 项` : ""}）`;
      }
    }
  }
  if (wireWarning) process.exitCode = 1;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          accounts: perAccount.map((p) => ({ id: p.id, models: p.count })),
          union: liveIds.length,
          catalog: currentIds.length,
          added: addedIds.map((id) => ({ id, probe: probes[id]?.protocol ?? null, steps: probes[id]?.steps ?? [] })),
          removed: removedIds,
          write,
          applied,
          rewire,
          wireWarning,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`账号实际: ${perAccount.map((p) => `${p.id} ${p.count}`).join(" / ")}（并集 ${liveIds.length}）`);
  console.log(`目录现状: ${currentIds.length} 个模型`);
  if (!changed) {
    console.log("✓ 已与账号实际一致，无需更新。");
    return;
  }
  if (rec.added.length > 0) console.log(`新增 ${rec.added.length} 个: ${rec.added.join(", ")}`);
  if (rec.removed.length > 0) console.log(`移除 ${rec.removed.length} 个: ${rec.removed.join(", ")}`);
  if (rec.added.some((id) => (probes[id]?.protocol ?? "unknown") === "unknown")) {
    console.log("提示: 存在未能判定协议的模型（默认 openai/chat），建议人工复核。");
  }
  if (applied) {
    console.log(`✓ 已写入 ${MODELS_PATH}（${Object.keys(rec.next).length} 个模型）`);
    if (rewire) {
      console.log(`✓ wire 注入已刷新: 撤销 ${rewire.removed} 项，注入 ${rewire.injected} 项（opencode 重启后生效）`);
    }
    if (wireWarning) {
      console.log(`⚠ ${wireWarning}`);
    }
    console.log("提示: 重启本机服务载入新目录: launchctl kickstart -k gui/$(id -u)/com.openselect.agent");
  } else {
    console.log("dry-run：未写入。加 --write 应用（自动刷新 wire 注入）。");
  }
}

async function cmdBackup(flags: Flags): Promise<void> {
  try {
    if (isTrue(flags.list)) {
      const list = listBackups();
      if (list.length === 0) {
        console.log("暂无备份");
        return;
      }
      console.log("备份列表（新 → 旧）:");
      for (const b of list) {
        console.log(
          `  ${b.name}  ${(b.bytes / 1024).toFixed(1)}KB  ${b.fileCount} 个文件  ${b.createdAt || "-"}${b.safety ? "  [恢复前安全备份]" : ""}`,
        );
      }
      return;
    }

    // 1) 拉取远端备份（只读远端 + 写本机；不新建本地备份、不触发保留清理）
    if (flags.fetch !== undefined) {
      const remote = typeof flags.fetch === "string" ? flags.fetch : "";
      if (!remote) {
        console.error("✗ --fetch 需要远端地址（git 仓库路径或 URL）");
        process.exit(1);
      }
      const fr = await fetchBackupsFromRemote({ remote, allowUnsigned: isTrue(flags["allow-unsigned"]) });
      if (!fr.ok) {
        console.error(`✗ 拉取失败: ${fr.error}`);
        process.exit(1);
      }
      console.log(`✓ 已从 ${fr.remote} 拉取 ${fr.fetched.length} 份备份（分支 ${fr.branch}）`);
      for (const f of fr.fetched) console.log(`  ✓ ${f}`);
      for (const r of fr.rejected) console.error(`  ✗ 已拒绝: ${r}`);
      if (hasTrustAnchor()) {
        const signed = fr.fetched.filter((f) => existsSync(join(BACKUP_DIR, `${f}.sig`))).length;
        console.log(
          signed === fr.fetched.length
            ? `  签名:   ${signed}/${fr.fetched.length} 份已用本机公钥验签通过（来源可信）`
            : `  签名:   ${signed}/${fr.fetched.length} 份带签名并已验签；其余**未验签**（仅完整性校验）`,
        );
      } else {
        console.log("  签名:   本机未配置信任公钥 → 仅完成完整性校验（**未验证来源**）");
      }
      if (fr.fetched.length === 0) {
        console.error("✗ 未取回任何备份（远端分支为空，或全部未通过校验/缺少口令）");
        process.exit(1);
      }
      console.log(
        hasTrustAnchor()
          ? "  提示: 已用本机公钥验签的备份来源可信；未签名的备份只做完整性校验（不防恶意远端）"
          : "  提示: SHA-256 校验只防损坏/传输错误，不防恶意远端（本机未配置信任公钥 → 无签名校验）",
      );
      if (fr.rejected.length > 0) process.exit(1);
      return;
    }

    // 2) 推送到远端（写远端 → 必须显式 --yes）
    if (flags.push !== undefined) {
      const remote = typeof flags.push === "string" ? flags.push : "";
      const remoteErr = validateRemote(remote);
      if (remoteErr) {
        console.error(`✗ --push 远端地址无效: ${remoteErr}`);
        process.exit(1);
      }
      const encrypt = isTrue(flags.encrypt);
      const passphrase = process.env.OPENSELECT_BACKUP_PASSPHRASE ?? "";
      if (encrypt && !passphrase) {
        console.error("✗ 加密推送需要环境变量 OPENSELECT_BACKUP_PASSPHRASE（不要写在命令行里）");
        process.exit(1);
      }
      const quoted = JSON.stringify(remote);
      if (!isTrue(flags.yes)) {
        console.log("将要推送备份到远端:");
        console.log(`  远端:   ${remote}`);
        console.log(`  分支:   ${BACKUP_BRANCH}`);
        console.log(`  文件:   openselect-<时间戳>.tar.gz${encrypt ? "（加密推送）" : "（**明文，含账号 Key**）"}`);
        console.log(`\n确认无误后执行: opensel backup --push ${quoted}${encrypt ? " --encrypt" : ""} --yes`);
        process.exit(1);
      }
      if (!encrypt) {
        console.error("⚠ 明文推送：远端仓库里将存在**明文账号 Key**（建议 --encrypt，或确保远端为私有仓库）");
      }
      // 签名：--sign 强制；--sign-if-possible 在私钥存在时签名（定时任务用它 → 异地归档必须可验签）
      const signIfPossible = isTrue(flags["sign-if-possible"]);
      const sign = isTrue(flags.sign) || (signIfPossible && existsSync(PRIVATE_KEY_PATH));
      if (signIfPossible && !sign) console.log("  提示:   未找到私钥，跳过签名（opensel keygen 生成密钥对）");
      const local = await createBackup({ sign });
      const pr = pushBackupToRemote({ archive: local.path, remote, encrypt, passphrase });
      if (!pr.ok) {
        console.error(`✗ 推送失败: ${pr.error}`);
        process.exit(1);
      }
      console.log(`✓ 已推送到 ${pr.remote}（分支 ${pr.branch}，commit ${(pr.commit ?? "").slice(0, 8)}）`);
      console.log(`  文件: ${pr.file}${pr.encrypted ? "（已加密）" : "（**明文，含账号 Key**）"}`);
      // 推送路径也要执行本地保留策略（否则每日推送会让本地归档无限增长）
      const keepPush = flags.keep !== undefined ? Number(flags.keep) : BACKUP_KEEP_DEFAULT;
      if (Number.isInteger(keepPush) && keepPush >= 0) {
        const removedPush = pruneBackups(keepPush);
        if (removedPush.length > 0) console.log(`  保留策略: 保留最新 ${keepPush} 份，已清理 ${removedPush.length} 份旧归档`);
      }
      // 记住远端：定时备份任务会推送到同一个远端（异地备份生效）
      const cfgPush = await loadConfig();
      if (cfgPush.backup?.remote !== remote) {
        cfgPush.backup = { ...(cfgPush.backup ?? {}), remote };
        await saveConfig(cfgPush);
        console.log(`  已记住远端: ${remote}`);
        console.log("  执行 opensel install 可让每日 03:30 的定时备份也推送到该远端");
      }
      return;
    }

    // 2.5) 只设置/清除远端（不推送、不新建本地备份）
    if (flags.remote !== undefined) {
      if (flags.remote === true) {
        console.error("✗ --remote 需要一个地址（或 off 清除）");
        process.exit(1);
      }
      const target = typeof flags.remote === "string" ? flags.remote.trim() : "";
      const cfgRemote = await loadConfig();
      if (!target || target === "off" || target === "none") {
        cfgRemote.backup = { ...(cfgRemote.backup ?? {}), remote: null };
        await saveConfig(cfgRemote);
        console.log("✓ 已清除异地备份远端（定时备份只做本地备份；执行 opensel install 让定时任务生效）");
        return;
      }
      const remoteErr = validateRemote(target);
      if (remoteErr) {
        console.error(`✗ 远端地址无效: ${remoteErr}`);
        process.exit(1);
      }
      cfgRemote.backup = { ...(cfgRemote.backup ?? {}), remote: target };
      await saveConfig(cfgRemote);
      console.log(`✓ 已设置异地备份远端: ${target}`);
      console.log("  ⚠ 每日 03:30 的定时备份会把**明文归档（含账号 Key）**推送到该远端：远端必须是私有仓库；定时任务暂不支持加密（需要加密请手动 opensel backup --push <remote> --encrypt）");
      console.log("  执行 opensel install 让每日 03:30 的定时备份推送到该远端");
      return;
    }

    // 3) 本地备份
    const out = typeof flags.out === "string" ? flags.out : undefined;
    // --sign-if-possible：仅在私钥存在时签名（定时任务用，避免产出无法验签的归档）
    const signIfPossible = isTrue(flags["sign-if-possible"]);
    const sign = isTrue(flags.sign) || (signIfPossible && existsSync(PRIVATE_KEY_PATH));
    if (signIfPossible && !sign) console.log("  提示:   未找到私钥，跳过签名（opensel keygen 生成密钥对）");
    const r = await createBackup({ out, sign });
    console.log(`✓ 备份已创建: ${r.path}`);
    console.log(`  大小:   ${(statSync(r.path).size / 1024).toFixed(1)}KB`);
    console.log(`  sha256: ${r.sha256}`);
    console.log(`  内容:   ${r.manifest.files.map((f) => f.name).join(", ") || "（空）"}`);
    const dbFile = r.manifest.files.find((f) => f.name === "data.sqlite");
    if (dbFile?.snapshotMethod === "file-copy") {
      console.warn("  ⚠ 台账快照退化为文件拷贝（未用 VACUUM INTO），可能跨 WAL 边界不完全一致");
    }
    let keep = BACKUP_KEEP_DEFAULT;
    if (flags.keep !== undefined) {
      const n = Number(flags.keep);
      if (!Number.isInteger(n) || n < 0) {
        console.error(`✗ --keep 须为非负整数（0 = 不清理），收到: ${String(flags.keep)}`);
        process.exit(1);
      }
      keep = n;
    }
    if (r.signed) console.log(`  签名:   已生成 ${r.path}.sig（Ed25519，可用本机公开钥验证真实性）`);
    const removed = pruneBackups(keep);
    if (removed.length > 0) console.log(`  保留策略: 保留最新 ${keep} 份，已清理 ${removed.length} 份旧归档`);
    console.log(`  提示:   归档含账号明文 Key（权限 0600），请存放在加密卷或私有 remote`);
  } catch (e) {
    console.error(`✗ 备份失败: ${String(e).slice(0, 200)}`);
    process.exit(1);
  }
}

async function cmdRestore(pos: string[], flags: Flags): Promise<void> {
  // pos[0] 是命令本身，备份路径是 pos[1]
  const target = pos[1] ?? "latest";
  const path = target === "latest" ? latestBackup() : target;
  if (!path) {
    console.error("没有可用备份（先执行 opensel backup）");
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`备份不存在: ${path}`);
    process.exit(1);
  }
  const dryRun = isTrue(flags["dry-run"]);
  try {
    if (!dryRun && !isTrue(flags.yes)) {
      const preview = await restoreBackup(path, { dryRun: true });
      console.log("将要执行恢复（覆盖下列文件）:");
      for (const l of preview.restored) console.log(`  ${l}`);
      console.log(`\n确认无误后执行: opensel restore ${path} --yes`);
      process.exit(1);
    }
    const r = await restoreBackup(path, {
    dryRun,
    manageService: flags["no-service"] !== true,
    allowUnsigned: isTrue(flags["allow-unsigned"]),
  });
    if (dryRun) {
      console.log("dry-run：将恢复下列文件（不写盘）");
      for (const l of r.restored) console.log(`  ${l}`);
      return;
    }
    if (r.restored.length > 0) {
      console.log(`✓ 已从 ${path} 恢复:`);
      for (const l of r.restored) console.log(`  ${l}`);
    }
    if (r.safetyBackup) console.log(`  恢复前安全备份: ${r.safetyBackup}`);
    if (r.service.stopped) {
      console.log(
        r.service.restarted ? "  launchd 服务已重启" : `  ⚠ launchd 服务未重启，请手动执行: ${manualStartHint()}`,
      );
    } else if (r.service.loadedBefore) {
      console.log("  launchd 服务未停止（恢复期间可能仍在写入）");
    }
    for (const e of r.service.errors) console.error(`  ⚠ ${e}`);
    if (r.problems.length > 0) {
      console.error(`✗ 恢复存在问题: ${r.problems.join("；")}`);
      if (r.safetyBackup) console.error(`  可用安全备份回退: opensel restore ${r.safetyBackup} --yes`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`✗ 恢复失败: ${String(e).slice(0, 300)}`);
    process.exit(1);
  }
}

async function cmdRepairUsage(flags: Flags): Promise<void> {
  const apply = isTrue(flags.apply);
  const beforeTs =
    typeof flags.before === "string" ? (Number(flags.before) || Date.parse(flags.before) || undefined) : undefined;
  const r = repairPollutedUsage({ apply, db: getDb(), beforeTs });
  if (r.scanned === 0) {
    console.log("✓ 未发现被旧解析器放大的用量快照（无需清理）");
    return;
  }
  const windows = Object.entries(r.byWindow)
    .map(([w, n]) => `${w} ${n}`)
    .join(" · ");
  console.log(`${apply ? "✓ 已修正" : "○ 将修正"} ${r.scanned} 个用量快照窗口（${windows}）`);
  console.log(`  涉及账号: ${r.accounts.join(", ")}`);
  console.log(`  修正方式: 存值/100（旧解析器把 0..2 的原始百分比当成 0..1 比例）——近似值，非精确还原`);
  if (!apply) {
    console.log("  这是 dry-run：数据库未改动。执行修复: opensel repair-usage --apply");
  }
}

/** 手动指定账号（首选）：新流量优先走它，已有会话立即重绑；off 解除 */
async function cmdForce(pos: string[]): Promise<void> {
  const target = pos[1] ?? "";
  const cfg = await loadConfig();
  if (!target || target === "off" || target === "none") {
    cfg.policy.forcedAccountId = null;
    await saveConfig(cfg);
    console.log("✓ 已解除手动指定（回到自然选号策略）");
    return;
  }
  const acc = cfg.accounts.find((a) => a.id === target || a.label === target);
  if (!acc) {
    console.error(`✗ 找不到账号: ${target}（opensel accounts 查看）`);
    process.exit(1);
  }
  if (!acc.enabled) {
    console.error(`✗ 账号已停用: ${acc.label}`);
    process.exit(1);
  }
  cfg.policy.forcedAccountId = acc.id;
  await saveConfig(cfg);
  console.log(`✓ 已设为首选: ${acc.label}（服务下个轮询周期生效，并重绑已有会话）`);
}

/** 按接入（客户端）指定账号：opensel pin <client> <account|off> */
async function cmdPin(pos: string[]): Promise<void> {
  const kind = pos[1] ?? "";
  const target = pos[2] ?? "";
  const cfg = await loadConfig();
  if (!kind || kind === "list" || kind === "--list") {
    const pins = cfg.policy.clientAccounts ?? {};
    const rows = CLIENT_KINDS.map((k) => {
      const id = pins[k];
      const acc = id ? cfg.accounts.find((a) => a.id === id) : null;
      const desc = !id ? "未指定" : acc ? acc.label : `${id}（账号已不存在）`;
      return `  ${pad(CLIENT_LABELS[k], 24)} ${desc}`;
    });
    console.log("按接入指定的账号：");
    for (const r of rows) console.log(r);
    return;
  }
  if (!isClientKind(kind)) {
    console.error(`✗ 接入类型无效: ${kind}（可用：${CLIENT_KINDS.join(", ")}）`);
    process.exit(1);
  }
  if (!target || target === "off" || target === "none") {
    const pins = { ...(cfg.policy.clientAccounts ?? {}) };
    delete pins[kind];
    cfg.policy.clientAccounts = pins;
    await saveConfig(cfg);
    console.log(`✓ 已解除 ${CLIENT_LABELS[kind]} 的账号指定（回到自然选号策略）`);
    return;
  }
  const acc = cfg.accounts.find((a) => a.id === target || a.label === target);
  if (!acc) {
    console.error(`✗ 找不到账号: ${target}（opensel accounts 查看）`);
    process.exit(1);
  }
  if (!acc.enabled) {
    console.error(`✗ 账号已停用: ${acc.label}`);
    process.exit(1);
  }
  cfg.policy.clientAccounts = { ...(cfg.policy.clientAccounts ?? {}), [kind]: acc.id };
  await saveConfig(cfg);
  console.log(`✓ ${CLIENT_LABELS[kind]} 的流量优先走: ${acc.label}（服务下个轮询周期生效）`);
}

/** 免费模型候选与中转模式：opensel free [--mode off|first|fallback] [--use id1,id2] */
async function cmdFree(flags: Flags): Promise<void> {
  const cfg = await loadConfig();
  const mode = cfg.policy.freeFirstMode ?? "first";
  if (flags.mode === undefined && flags.use === undefined) {
    console.log(`免费模型中转模式: ${mode}`);
    console.log(`  ${mode === "off" ? "关闭（不替换，质量完全由你决定）" : mode === "fallback" ? "兜底（付费不可用时才用免费模型）" : "优先（先用免费模型承接）"}`);
    console.log(`  候选（按优先级）: ${(cfg.policy.freeFirst ?? []).join(", ") || "（未选）"}`);
    console.log("  用法: opensel free --mode off|first|fallback   opensel free --use id1,id2   opensel free --use off");
    return;
  }
  if (flags.mode !== undefined) {
    const m = typeof flags.mode === "string" ? flags.mode : "";
    if (m !== "off" && m !== "first" && m !== "fallback") {
      console.error("✗ --mode 须为 off / first / fallback");
      process.exit(1);
    }
    cfg.policy.freeFirstMode = m;
  }
  if (flags.use !== undefined) {
    if (flags.use === true) {
      console.error("✗ --use 需要模型 id 列表（或 off 清空）");
      process.exit(1);
    }
    const raw = typeof flags.use === "string" ? flags.use : "";
    if (!raw || raw === "off" || raw === "none") {
      cfg.policy.freeFirst = [];
    } else {
      const catalog = await loadCatalog();
      const ids = raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      const valid: string[] = [];
      for (const id of ids) {
        if (!catalog.models[id]) {
          console.error(`✗ 模型 ${id} 不在目录中`);
          process.exit(1);
        }
        if (!isFreeFirstEligible(catalog, id)) {
          console.error(`✗ 模型 ${id} 不是可替换的免费模型（须在目录中、标记为免费，且属于 openai/chat 家族）`);
          process.exit(1);
        }
        if (!valid.includes(id)) valid.push(id);
      }
      cfg.policy.freeFirst = valid;
    }
  }
  await saveConfig(cfg);
  console.log(`✓ 免费模型中转模式: ${cfg.policy.freeFirstMode ?? "first"}`);
  console.log(`  候选（按优先级）: ${(cfg.policy.freeFirst ?? []).join(", ") || "（未选）"}`);
}

async function cmdAlerts(flags: Flags): Promise<void> {
  const n = typeof flags.n === "string" ? Math.max(1, Number(flags.n) || 20) : 20;
  const rows = recentAlerts(n);
  if (rows.length === 0) {
    console.log("暂无用量告警");
    return;
  }
  console.log("最近告警（新 → 旧）:");
  for (const a of rows) {
    console.log(
      `  ${fmtLocal(a.ts)}  ${a.accountId}  ${a.window.padEnd(8)} 阈值 ${(a.threshold * 100).toFixed(0)}%  用量 ${(a.percent * 100).toFixed(1)}%`,
    );
  }
}

async function cmdKeygen(flags: Flags): Promise<void> {
  const force = isTrue(flags.force);
  const r = generateSigningKey(force);
  if (r.created) {
    console.log("✓ 已生成 Ed25519 签名密钥对");
    console.log(`  私钥: ${r.info.privatePath}（0600，**不要外传**）`);
    console.log(`  公钥: ${r.info.publicPath}（信任锚，可分发给其它机器核对）`);
    console.log(`  指纹: ${r.info.fingerprint}`);
    console.log("  用法: opensel backup --sign（生成 <归档>.sig）；远端 fetch 时用本机公钥自动验签");
  } else {
    console.log("已存在签名密钥（未覆盖；如需重建请加 --force）");
    console.log(`  私钥: ${r.info.privatePath}`);
    console.log(`  指纹: ${r.info.fingerprint}`);
  }
}

function usage(): void {
  console.log(`opensel — OpenSelect 多账号池（OpenCode Go）

用法:
  opensel init                             初始化 ~/.openselect
  opensel add --key K [--label L]          添加账号（校验用量并注册到 opencode）
  opensel import                           从 opencode 凭据导入 opencode-go 账号
  opensel remove <label|id>                从账号池移除账号
  opensel accounts [--json]                账号列表
  opensel usage [--loop]                   查询官方用量
  opensel status [--json]                  总览状态
  opensel serve [--proxy-only|--dashboard-only]
                                           启动代理(:8788)+面板(:8789)+用量监控
  opensel wire [--dry-run]                 注入 opencode 配置（模型级 baseURL → 本地代理）
  opensel unwire                           撤销注入
  opensel sync-catalog [--write] [--json] [--no-probe]
                                           模型目录同步：以账号实际 /v1/models 为准
  opensel doctor                           环境体检
  opensel logs [-n 20]                     查看请求/切换日志
  opensel backup [--out <path>] [--list] [--keep N] [--sign|--sign-if-possible]
                                           应用级备份（config+台账+wired+plist，SHA-256 校验；默认保留最新 14 份）
  opensel backup --push <remote> [--encrypt] [--yes]   推送备份到 git 远端（--encrypt 用 OPENSELECT_BACKUP_PASSPHRASE 加密）
  opensel backup --remote <url|off>                    只设置/清除异地备份远端（不改本地备份）
  opensel backup --fetch <remote> [--allow-unsigned]
                                           从 git 远端拉取备份并逐个校验 SHA-256（+验签）
  opensel restore <path|latest> [--dry-run] [--no-service] [--allow-unsigned] [--yes]
                                           从备份恢复（恢复前自动生成安全备份）
  opensel repair-usage [--apply]           清理旧解析器放大的历史用量快照（默认 dry-run）
  opensel alerts [-n 20]                    查看用量阈值告警记录
  opensel force <account|off>               手动指定首选账号（off 解除；已有会话立即重绑）
  opensel pin <client> <account|off>        按接入指定账号（client 见 opensel pin list）
  opensel free [--mode off|first|fallback] [--use id1,id2]
                                           免费模型中转：模式（关闭/优先/兜底）与候选（按优先级）
  opensel keygen [--force --yes]            生成备份签名密钥对（Ed25519，~/.openselect/keys/）
  opensel install | uninstall              launchd 开机自启 + 每日自动备份 安装/卸载
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { pos, flags } = parseArgs(argv);
  const cmd = pos[0] ?? "help";
  switch (cmd) {
    case "init":
      await cmdInit();
      break;
    case "add":
      await cmdAdd(flags);
      break;
    case "import":
      await cmdImport();
      break;
    case "remove":
    case "rm":
      await cmdRemove(pos);
      break;
    case "accounts":
    case "ls":
      await cmdAccounts(flags);
      break;
    case "usage":
      await cmdUsage(flags);
      break;
    case "status":
      await cmdStatus(flags);
      break;
    case "serve":
    case "run":
      await cmdServe(flags);
      break;
    case "wire":
      await cmdWire(flags);
      break;
    case "unwire":
      await cmdUnwire();
      break;
    case "sync-catalog":
    case "sync":
      await cmdSyncCatalog(flags);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "logs":
      await cmdLogs(flags);
      break;
    case "backup":
      await cmdBackup(flags);
      break;
    case "restore":
      await cmdRestore(pos, flags);
      break;
    case "repair-usage":
      await cmdRepairUsage(flags);
      break;
    case "alerts":
      await cmdAlerts(flags);
      break;
    case "force":
      await cmdForce(pos);
      break;
    case "pin":
      await cmdPin(pos);
      break;
    case "free":
      await cmdFree(flags);
      break;
    case "keygen":
      await cmdKeygen(flags);
      break;
    case "install":
      await cmdInstall();
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`未知命令: ${cmd}`);
      usage();
      process.exit(1);
  }
}

await main();
