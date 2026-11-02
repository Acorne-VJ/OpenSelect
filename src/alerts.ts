import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { isHhMm, LOG_DIR } from "./config";
import { disarmAlert, getDb, insertAlert, lastAlert } from "./db";
import { ensureDir } from "./util";
import type { AccountUsage, UsageWindow } from "./types";

export type AlertWindow = "rolling" | "weekly" | "monthly";

export interface AlertRecord {
  ts: number;
  accountId: string;
  window: AlertWindow;
  threshold: number;
  percent: number;
  status: string | null;
}

const WINDOWS: AlertWindow[] = ["rolling", "weekly", "monthly"];

/** 通知通道（测试可注入替换） */
export type NotifyFn = (title: string, message: string) => void;

/**
 * macOS 桌面通知；无 GUI 会话时静默失败（台账与日志仍会记录）。
 * 用 Bun.spawn 异步启动、不等待 → 避免阻塞代理/轮询的事件循环。
 */
export const notifyDesktop: NotifyFn = (title, message) => {
  try {
    Bun.spawn(["osascript", "-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
  } catch {
    /* 忽略：通知失败不影响判定与台账 */
  }
};

function writeAlertLog(
  accountId: string,
  window: AlertWindow,
  threshold: number,
  percent: number,
  status: string | null,
  logPath: string,
): void {
  try {
    ensureDir(dirname(logPath));
    const line = `${new Date().toISOString()} account=${accountId} window=${window} threshold=${(threshold * 100).toFixed(1)}% percent=${(percent * 100).toFixed(1)}% status=${status ?? "-"}\n`;
    appendFileSync(logPath, line);
  } catch {
    /* 日志失败不阻断 */
  }
}

/** 按窗口取阈值：分档覆盖优先，否则用全局列表 */
export function thresholdsForWindow(
  window: AlertWindow,
  global: number[],
  byWindow?: Partial<Record<AlertWindow, number[]>>,
): number[] {
  const override = byWindow?.[window];
  return Array.isArray(override) && override.length > 0 ? override : global;
}

/** 静默时段判定（本地时间 HH:MM；from > to 视为跨零点） */
export function inQuietHours(quiet: { from: string; to: string } | undefined, now = new Date()): boolean {
  if (!quiet || !isHhMm(quiet.from) || !isHhMm(quiet.to)) return false;
  const hm = (s: string): number => {
    const [h, m] = s.split(":");
    return Number(h) * 60 + Number(m);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = hm(quiet.from);
  const to = hm(quiet.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** 去掉控制字符/CR/LF（防 SMTP 头注入与命令注入） */
function sanitizeHeaderValue(v: string): string {
  return v.replace(/[^\x20-\x7E]/g, "");
}

const SMTP_TIMEOUT_MS = 10_000;

/**
 * 极简 SMTP 发送（明文；正文点填充 + 头部净化）。
 * 校验应答码（4xx/5xx 视为失败），带 10s 超时，失败只返回错误、不抛出。
 */
export async function sendSmtpMail(
  cfg: { to: string[]; from: string; host: string; port: number },
  subject: string,
  body: string,
  timeoutMs: number = SMTP_TIMEOUT_MS,
): Promise<{ ok: boolean; err?: string }> {
  const dotStuff = (s: string): string => s.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  const from = sanitizeHeaderValue(cfg.from);
  const to = cfg.to.map(sanitizeHeaderValue).filter((x) => x.includes("@"));
  if (!from || to.length === 0) return { ok: false, err: "收件人/发件人地址无效" };
  const subj = sanitizeHeaderValue(subject);

  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  try {
    const waiters: Array<(r: { code: number; text: string }) => void> = [];
    let buffer = "";
    let pending = "";
    const sock = await Bun.connect({
      hostname: cfg.host,
      port: cfg.port,
      socket: {
        data(_s, data) {
          buffer += data.toString();
          let idx = buffer.indexOf("\r\n");
          while (idx >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const m = /^(\d{3})([ -])?(.*)$/.exec(line);
            if (m) {
              const code = Number(m[1]);
              if (m[2] === "-") {
                pending += `${line}\n`; // RFC 5321 续行
              } else {
                const text = pending + line;
                pending = "";
                const w = waiters.shift();
                if (w) w({ code, text });
              }
            }
            idx = buffer.indexOf("\r\n");
          }
        },
        close() {
          while (waiters.length) waiters.shift()!({ code: 0, text: "closed" });
        },
        error() {
          while (waiters.length) waiters.shift()!({ code: 0, text: "error" });
        },
      },
    });
    socket = sock;

    const expect = async (): Promise<{ code: number; text: string }> => {
      const waiter = new Promise<{ code: number; text: string }>((res) => waiters.push(res));
      const timer = new Promise<{ code: number; text: string }>((_, rej) =>
        setTimeout(() => rej(new Error("SMTP 应答超时")), timeoutMs),
      );
      return await Promise.race([waiter, timer]);
    };
    const cmd = async (c: string): Promise<{ code: number; text: string }> => {
      sock.write(`${c}\r\n`);
      const r = await expect();
      if (r.code >= 400) {
        const last = r.text.split("\n").filter(Boolean).pop() ?? r.text;
        throw new Error(`${c.split(" ")[0]} 被拒: ${r.code} ${last}`);
      }
      return r;
    };

    const greet = await expect();
    if (greet.code !== 220) throw new Error(`SMTP 问候异常: ${greet.code}`);
    await cmd("HELO openselect");
    await cmd(`MAIL FROM:<${from}>`);
    const rejected: string[] = [];
    for (const rcpt of to) {
      try {
        await cmd(`RCPT TO:<${rcpt}>`);
      } catch (e) {
        rejected.push(`${rcpt}（${String(e).slice(0, 80)}）`);
      }
    }
    if (rejected.length === to.length) throw new Error(`全部收件人被拒: ${rejected.join("；")}`);
    await cmd("DATA");
    const payload = `Subject: ${subj}\r\nFrom: ${from}\r\nTo: ${to.join(", ")}\r\n\r\n${dotStuff(body)}\r\n.`;
    sock.write(`${payload}\r\n`);
    const done = await expect();
    if (done.code >= 400) throw new Error(`投递被拒: ${done.code} ${done.text}`);
    try {
      await cmd("QUIT");
    } catch {
      /* QUIT 失败不影响投递结果 */
    }
    return rejected.length > 0 ? { ok: true, err: `部分收件人被拒: ${rejected.join("；")}` } : { ok: true };
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 160) };
  } finally {
    try {
      socket?.end();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 阈值告警判定：对每个窗口逐档阈值检查。
 *
 * 语义：
 * - 越过阈值且该档未告警过 → 触发（台账 + 日志 + 通知）
 * - 持续越线期间同档只告警一次（台账行 active=1 表示仍处于越线中）
 * - 用量回落到阈值以下 → 解除该档（active=0，**历史行保留**），下次再越线可重新触发
 * - 冷却：同一档两次告警的最小间隔（cooldownSec），避免阈值附近抖动反复弹窗
 */
export function checkUsageAlerts(
  accountId: string,
  usage: AccountUsage,
  thresholds: number[],
  opts: {
    notify?: NotifyFn;
    db?: Database;
    cooldownSec?: number;
    logPath?: string;
    byWindow?: Partial<Record<AlertWindow, number[]>>;
    quiet?: { from: string; to: string };
    email?: { to: string[]; from: string; host: string; port: number };
    now?: Date;
  } = {},
): AlertRecord[] {
  const notify = opts.notify ?? notifyDesktop;
  const db = opts.db ?? getDb();
  const cooldownMs = Math.max(0, opts.cooldownSec ?? 0) * 1000;
  const logPath = opts.logPath ?? `${LOG_DIR}/alert.log`;
  const now = Date.now();
  const fired: AlertRecord[] = [];

  for (const window of WINDOWS) {
    const w = usage[window] as UsageWindow | undefined;
    if (!w) continue;
    const windowThresholds = thresholdsForWindow(window, thresholds, opts.byWindow);
    for (const threshold of windowThresholds) {
      const last = lastAlert(accountId, window, threshold, db);
      if (w.percent < threshold) {
        // 回落到阈值以下 → 解除该档（历史行保留，可再次触发）
        if (last?.active) disarmAlert(accountId, window, threshold, db);
        continue;
      }
      if (last?.active) continue; // 本次越线期间已告警过
      if (last && now - last.ts < cooldownMs) continue; // 冷却期内不重复告警
      const rec: AlertRecord = {
        ts: now,
        accountId,
        window,
        threshold,
        percent: w.percent,
        status: w.status ?? null,
      };
      insertAlert(rec, db);
      writeAlertLog(accountId, window, threshold, w.percent, rec.status, logPath);
      fired.push(rec);
    }
  }

  // 一个轮询周期合并成一条通知（避免同一窗口多档阈值弹多次）
  if (fired.length > 0) {
    const items = fired
      .slice(0, 6)
      .map(
        (f) =>
          `${f.accountId} ${f.window} ${(f.percent * 100).toFixed(1)}%（阈值 ${(f.threshold * 100).toFixed(0)}%${f.status === "rate-limited" ? "，已限流" : ""}）`,
      )
      .join("；");
    const more = fired.length > 6 ? ` 等 ${fired.length} 项` : "";
    const message = `${items}${more}`;
    // 静默时段：只记台账/日志，不发通知
    if (!inQuietHours(opts.quiet, opts.now ?? new Date())) {
      notify("OpenSelect 用量告警", message);
      if (opts.email) {
        void sendSmtpMail(opts.email, "OpenSelect 用量告警", message)
          .then((r) => {
            if (!r.ok || r.err) {
              try {
                ensureDir(dirname(logPath));
                appendFileSync(logPath, `${new Date().toISOString()} email-${r.ok ? "partial" : "failed"}: ${r.err ?? ""}\n`);
              } catch {
                /* ignore */
              }
            }
          })
          .catch(() => {
            /* 邮件通道异常不影响告警主流程 */
          });
      }
    }
  }
  return fired;
}
