import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate HOME before importing modules that capture it
process.env.HOME = mkdtempSync(join(tmpdir(), "openselect-home-alerts2-"));

const { migrateSchema, recentAlerts } = await import("../src/db");
const { checkUsageAlerts, inQuietHours, sendSmtpMail, thresholdsForWindow } = await import("../src/alerts");

import type { AccountUsage } from "../src/types";

const TMP = mkdtempSync(join(tmpdir(), "openselect-alerts2-db-"));
const alertDb = new Database(join(TMP, "alerts.sqlite"), { create: true });
migrateSchema(alertDb);
const LOG_PATH = join(TMP, "alert.log");

function usage(over: Partial<AccountUsage["rolling"]> = {}): AccountUsage {
  return {
    accountId: "a2-acct",
    ts: Date.now(),
    rolling: { percent: 0.1, status: "ok", resetsAt: null, ...over },
    weekly: { percent: 0.1, status: "ok", resetsAt: null },
    monthly: { percent: 0.1, status: "ok", resetsAt: null },
  };
}

describe("告警增强：按窗口阈值 / 静默时段 / 邮件通道", () => {
  test("按窗口分档阈值：weekly 用自己的档位，rolling 仍用全局", () => {
    expect(thresholdsForWindow("weekly", [0.9], { weekly: [0.5, 0.6] })).toEqual([0.5, 0.6]);
    expect(thresholdsForWindow("rolling", [0.9], { weekly: [0.5, 0.6] })).toEqual([0.9]);
    expect(thresholdsForWindow("monthly", [0.9], {})).toEqual([0.9]);
  });

  test("按窗口阈值实际生效：只给 weekly 设低档时，仅 weekly 触发", () => {
    const seen: string[] = [];
    const notify = (_t: string, m: string) => seen.push(m);
    const fired = checkUsageAlerts("a2-acct", usage({ percent: 0.55 }), [0.9], {
      notify,
      db: alertDb,
      logPath: LOG_PATH,
      byWindow: { weekly: [0.5] },
    });
    // weekly=0.1 未越 0.5；rolling=0.55 越过全局 0.9？不 → 无触发
    expect(fired).toEqual([]);
    expect(seen).toEqual([]);

    const fired2 = checkUsageAlerts("a2-acct", usage({ percent: 0.55 }), [0.9], {
      notify,
      db: alertDb,
      logPath: LOG_PATH,
      byWindow: { rolling: [0.5] },
    });
    expect(fired2).toHaveLength(1);
    expect(fired2[0]!.window).toBe("rolling");
    expect(fired2[0]!.threshold).toBe(0.5);
  });

  test("静默时段：不发通知，但台账与日志仍记录", () => {
    const seen: string[] = [];
    const notify = (_t: string, m: string) => seen.push(m);
    // 23:00–07:00 覆盖 03:30
    expect(inQuietHours({ from: "23:00", to: "07:00" }, new Date(2026, 0, 1, 3, 30))).toBe(true);
    expect(inQuietHours({ from: "23:00", to: "07:00" }, new Date(2026, 0, 1, 12, 0))).toBe(false);
    expect(inQuietHours(undefined, new Date())).toBe(false);

    const fired = checkUsageAlerts("a2-acct", usage({ percent: 0.96 }), [0.9], {
      notify,
      db: alertDb,
      logPath: LOG_PATH,
      quiet: { from: "00:00", to: "23:59" },
      now: new Date(2026, 0, 1, 12, 0),
    });
    expect(fired).toHaveLength(1); // 仍记录
    expect(seen).toEqual([]); // 但不发通知
    expect(recentAlerts(20, alertDb).some((a) => a.accountId === "a2-acct" && a.threshold === 0.9)).toBe(true);
    expect(existsSync(LOG_PATH)).toBe(true);
  });

  test("邮件通道：越线时通过 SMTP 发出邮件", async () => {
    // 极简 mock SMTP 服务端
    const received: string[] = [];
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write("220 mock ESMTP ready\r\n");
        },
        data(socket, data) {
          const text = data.toString();
          if (/^DATA/i.test(text)) {
            socket.write("354 go ahead\r\n");
            return;
          }
          if (text.trim() === ".") {
            socket.write("250 ok\r\n");
            return;
          }
          received.push(text);
          socket.write("250 ok\r\n");
        },
      },
    });
    try {
      const seen: string[] = [];
      const notify = (_t: string, m: string) => seen.push(m);
      checkUsageAlerts("a2-mail", usage({ percent: 0.98 }), [0.9], {
        notify,
        db: alertDb,
        logPath: LOG_PATH,
        email: { to: ["ops@example.com"], from: "openselect@example.com", host: "127.0.0.1", port: server.port },
      });
      // 邮件是异步发送，等一小会儿
      for (let i = 0; i < 50 && !received.join("").includes("Subject:"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const all = received.join("");
      expect(all).toContain("Subject:");
      expect(all).toContain("ops@example.com");
      expect(all).toContain("a2-mail");
    } finally {
      server.stop(true);
    }
  });
});

describe("SMTP 客户端健壮性", () => {
  /** 极简 mock SMTP：可自定义每条命令的应答 */
  function mockSmtp(reply: (cmd: string) => string | null): { port: number; received: string[]; stop: () => void } {
    const received: string[] = [];
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write("220 mock ESMTP ready\r\n");
        },
        data(socket, data) {
          const text = data.toString();
          received.push(text);
          const cmd = text.split("\r\n")[0] ?? "";
          const r = reply(cmd);
          if (r !== null) socket.write(`${r}\r\n`);
        },
      },
    });
    return { port: server.port, received, stop: () => server.stop(true) };
  }

  const cfg = (port: number) => ({ to: ["ops@example.com"], from: "openselect@example.com", host: "127.0.0.1", port });

  test("服务端 550 拒收 → ok=false（不是假成功）", async () => {
    const m = mockSmtp((cmd) => {
      if (/^MAIL FROM/i.test(cmd)) return "550 Authentication required";
      return "250 ok";
    });
    try {
      const r = await sendSmtpMail(cfg(m.port), "s", "b");
      expect(r.ok).toBe(false);
      expect(r.err).toContain("550");
    } finally {
      m.stop();
    }
  });

  test("部分收件人被拒 → ok=true 且 err 说明被拒者", async () => {
    const m = mockSmtp((cmd) => {
      if (/^RCPT TO:<bad@/i.test(cmd)) return "550 mailbox unavailable";
      return "250 ok";
    });
    try {
      const r = await sendSmtpMail(
        { ...cfg(m.port), to: ["ops@example.com", "bad@example.com"] },
        "s",
        "b",
      );
      expect(r.ok).toBe(true);
      expect(r.err).toContain("bad@example.com");
    } finally {
      m.stop();
    }
  });

  test("全部收件人被拒 → ok=false", async () => {
    const m = mockSmtp((cmd) => (cmd.startsWith("RCPT") ? "550 mailbox unavailable" : "250 ok"));
    try {
      const r = await sendSmtpMail(cfg(m.port), "s", "b");
      expect(r.ok).toBe(false);
    } finally {
      m.stop();
    }
  });

  test("服务端不回话 → 超时后返回失败（不永久挂起）", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          /* 故意不回话 */
        },
        data() {
          /* 吞掉请求，不回任何应答 */
        },
      },
    });
    try {
      const r = await sendSmtpMail(cfg(server.port), "s", "b", 300);
      expect(r.ok).toBe(false);
      expect(r.err).toContain("超时");
    } finally {
      server.stop(true);
    }
  });

  test("多行应答（250- 续行）不造成错位", async () => {
    const m = mockSmtp((cmd) => {
      if (/^HELO/i.test(cmd)) return "250-mock.local\r\n250 HELP";
      return "250 ok";
    });
    try {
      const r = await sendSmtpMail(cfg(m.port), "s", "b");
      expect(r.ok).toBe(true);
    } finally {
      m.stop();
    }
  });

  test("正文行首 '.' 被点填充，且主题里的 CR/LF 被剥离（防头注入）", async () => {
    const m = mockSmtp(() => "250 ok");
    try {
      const r = await sendSmtpMail(cfg(m.port), "bad\r\nBcc: attacker@evil.com", "line1\n.dotted\nline3");
      expect(r.ok).toBe(true);
      const all = m.received.join("");
      // CR/LF 被剥离 → 无法伪造新头（主题仍是同一行）
      expect(all).toContain("Subject: badBcc: attacker@evil.com\r\n");
      expect(all).not.toContain("\r\nBcc:");
      expect(all).toContain("..dotted"); // 行首 . → ..
    } finally {
      m.stop();
    }
  });
});
