import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freePort(): Promise<number> {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = srv.port;
  srv.stop(true);
  return port;
}

test(
  "opensel serve: boots, hot-reloads config, warns on port changes",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "openselect-home-serve-"));
    const dir = join(home, ".openselect");
    mkdirSync(dir, { recursive: true });

    // mock upstream keeps the poller on localhost
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ usage: { weekly: { percent: 10, status: "active" } } }),
    });

    const proxyPort = await freePort();
    const dashPort = await freePort();
    const cfgPath = join(dir, "config.json");
    const writeCfg = (dPort: number) =>
      writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            version: 1,
            upstream: { base: `http://127.0.0.1:${upstream.port}` },
            proxy: { host: "127.0.0.1", port: proxyPort },
            dashboard: { host: "127.0.0.1", port: dPort },
            policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
            monitor: { pollSec: 10 },
            opencode: { autoActivate: false },
            accounts: [
              { id: "s1", label: "s1", integration: "opencode-go", key: "k-test", enabled: true, addedAt: 0 },
            ],
          },
          null,
          2,
        ),
      );
    writeCfg(dashPort);

    const proc = Bun.spawn([process.execPath, "src/cli.ts", "serve"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    const decoder = new TextDecoder();
    const pump = (async () => {
      const reader = proc.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
    })();
    const errPump = (async () => {
      const reader = proc.stderr.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })();

    async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (cond()) return true;
        await Bun.sleep(200);
      }
      return cond();
    }

    try {
      expect(await waitFor(() => out.includes("✓ 代理"), 15000)).toBe(true);
      const hz = (await fetch(`http://127.0.0.1:${proxyPort}/healthz`)
        .then((r) => r.json())
        .catch(() => null)) as { ok?: boolean } | null;
      expect(hz?.ok).toBe(true);

      // change the dashboard port → reload must log both reload and restart warning
      writeCfg(dashPort + 1);
      expect(await waitFor(() => out.includes("[reload] 配置热加载") && out.includes("端口变更需重启"), 20000)).toBe(
        true,
      );
    } finally {
      proc.kill();
      await proc.exited;
      upstream.stop(true);
      await Promise.allSettled([pump, errPump]);
    }
  },
  45000,
);

test("opensel doctor: 输出全链自检（账号/服务/接入/免费优先/告警/签名/最新备份）", async () => {
  const home = mkdtempSync(join(tmpdir(), "openselect-home-doctor-"));
  mkdirSync(join(home, ".openselect"), { recursive: true });
  writeFileSync(join(home, ".openselect", "config.json"), JSON.stringify({ version: 1, accounts: [] }), { mode: 0o600 });
  const r = spawnSync(process.execPath, [join(process.cwd(), "src", "cli.ts"), "doctor"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 60_000,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  expect(out).toContain("OpenSelect 体检");
  expect(out).toContain("bun ");
  expect(out).toContain("免费优先"); // 全链自检段落
  expect(out).toContain("用量告警");
  expect(out).toContain("备份签名");
  expect(out).toMatch(/最新备份|暂无备份/); // 有备份时报告签名/验签，无备份时明确提示
}, 60_000);

test(
  "opensel force: CLI 写配置 → serve 热加载应用；指向不存在账号时忽略并回退",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "openselect-home-force-"));
    const dir = join(home, ".openselect");
    mkdirSync(dir, { recursive: true });

    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ usage: { weekly: { percent: 10, status: "active" } } }),
    });

    const proxyPort = await freePort();
    const dashPort = await freePort();
    const cfgPath = join(dir, "config.json");
    const writeCfg = (forced?: string) =>
      writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            version: 1,
            upstream: { base: `http://127.0.0.1:${upstream.port}` },
            proxy: { host: "127.0.0.1", port: proxyPort },
            dashboard: { host: "127.0.0.1", port: dashPort },
            policy: {
              switchAt: 0.97,
              maxAttempts: 4,
              cooldownFallbackSec: 300,
              sessionTtlSec: 7200,
              ...(forced ? { forcedAccountId: forced } : {}),
            },
            monitor: { pollSec: 10 },
            opencode: { autoActivate: false },
            accounts: [
              { id: "s1", label: "s1", integration: "opencode-go", key: "k-test", enabled: true, addedAt: 0 },
              { id: "s2", label: "s2", integration: "opencode-go", key: "k-test2", enabled: true, addedAt: 0 },
            ],
          },
          null,
          2,
        ),
      );
    writeCfg();

    const proc = Bun.spawn([process.execPath, "src/cli.ts", "serve"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    const decoder = new TextDecoder();
    const pump = (async () => {
      const reader = proc.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
    })();

    async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (cond()) return true;
        await Bun.sleep(200);
      }
      return cond();
    }

    const cli = (args: string[]) =>
      spawnSync(process.execPath, [join(process.cwd(), "src", "cli.ts"), ...args], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
        timeout: 30_000,
      });

    try {
      expect(await waitFor(() => out.includes("✓ 代理"), 15000)).toBe(true);

      // CLI 指定首选账号 → serve 热加载后应用
      const r1 = cli(["force", "s2"]);
      expect(`${r1.stdout}\n${r1.stderr}`).toContain("已设为首选");
      expect(await waitFor(() => out.includes("手动指定账号 → s2"), 25000)).toBe(true);

      // CLI 解除 → serve 回到自然策略（不再有指定账号）
      const r2 = cli(["force", "off"]);
      expect(`${r2.stdout}\n${r2.stderr}`).toContain("已解除手动指定");

      // 指向不存在的账号 → 忽略，不重绑会话（不产生幽灵绑定）
      writeCfg("typo-id");
      expect(await waitFor(() => out.includes("不存在或已停用 → 已忽略"), 25000)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
      upstream.stop(true);
      await Promise.allSettled([pump]);
    }
  },
  90000,
);

test("opensel remove: 删除账号时一并清掉指向它的手动首选与接入指定", async () => {
  const home = mkdtempSync(join(tmpdir(), "openselect-home-remove-"));
  const dir = join(home, ".openselect");
  mkdirSync(dir, { recursive: true });
  const cfgPath = join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      version: 1,
      upstream: { base: "http://127.0.0.1:1" },
      proxy: { host: "127.0.0.1", port: 0 },
      dashboard: { host: "127.0.0.1", port: 0 },
      policy: {
        switchAt: 0.97,
        maxAttempts: 4,
        cooldownFallbackSec: 300,
        sessionTtlSec: 7200,
        forcedAccountId: "acc-A",
        clientAccounts: { opencode: "acc-A", "claude-code": "acc-B" },
      },
      monitor: { pollSec: 45 },
      opencode: { autoActivate: false },
      accounts: [
        { id: "acc-A", label: "acc-A", integration: "opencode-go", key: "k-a", enabled: true, addedAt: 0 },
        { id: "acc-B", label: "acc-B", integration: "opencode-go", key: "k-b", enabled: true, addedAt: 0 },
      ],
    }),
  );

  const r = spawnSync(process.execPath, [join(process.cwd(), "src", "cli.ts"), "remove", "acc-A"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 30_000,
  });
  expect(r.status).toBe(0);
  const after = JSON.parse(readFileSync(cfgPath, "utf8")) as {
    accounts: Array<{ id: string }>;
    policy: { forcedAccountId: string | null; clientAccounts: Record<string, string> };
  };
  expect(after.accounts.map((a) => a.id)).toEqual(["acc-B"]);
  // 指向被删账号的指定都被清掉；指向其它账号的保留
  expect(after.policy.forcedAccountId).toBe(null);
  expect(after.policy.clientAccounts.opencode).toBeUndefined();
  expect(after.policy.clientAccounts["claude-code"]).toBe("acc-B");
}, 60_000);

test("opensel backup --remote: 设置/清除异地备份远端（写配置，不推送）", async () => {
  const home = mkdtempSync(join(tmpdir(), "openselect-home-remote-"));
  const dir = join(home, ".openselect");
  mkdirSync(dir, { recursive: true });
  const cfgPath = join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      version: 1,
      upstream: { base: "http://127.0.0.1:1" },
      proxy: { host: "127.0.0.1", port: 0 },
      dashboard: { host: "127.0.0.1", port: 0 },
      policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
      monitor: { pollSec: 45 },
      opencode: { autoActivate: false },
      accounts: [],
    }),
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(process.cwd(), "src", "cli.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 30_000,
    });
  const readCfg = () => JSON.parse(readFileSync(cfgPath, "utf8")) as { backup?: { remote?: string | null } };

  // 未配置时为空
  expect(readCfg().backup?.remote ?? null).toBe(null);

  // 设置
  const r1 = run(["backup", "--remote", "git@github.com:example/backup.git"]);
  expect(r1.status).toBe(0);
  expect(readCfg().backup?.remote).toBe("git@github.com:example/backup.git");

  // 非法格式 → 拒绝且不改配置
  const r2 = run(["backup", "--remote", "not a url"]);
  expect(r2.status).toBe(1);
  expect(readCfg().backup?.remote).toBe("git@github.com:example/backup.git");

  // 清除
  const r3 = run(["backup", "--remote", "off"]);
  expect(r3.status).toBe(0);
  expect(readCfg().backup?.remote ?? null).toBe(null);
}, 60_000);

test("opensel backup --push --sign-if-possible: 私钥存在时产出**签名**归档（异地归档必须可验签）", async () => {
  const home = mkdtempSync(join(tmpdir(), "openselect-home-pushsign-"));
  const dir = join(home, ".openselect");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      version: 1,
      upstream: { base: "http://127.0.0.1:1" },
      proxy: { host: "127.0.0.1", port: 0 },
      dashboard: { host: "127.0.0.1", port: 0 },
      policy: { switchAt: 0.97, maxAttempts: 4, cooldownFallbackSec: 300, sessionTtlSec: 7200 },
      monitor: { pollSec: 45 },
      opencode: { autoActivate: false },
      accounts: [],
    }),
    { mode: 0o600 },
  );
  const bare = mkdtempSync(join(tmpdir(), "openselect-bare-sign-"));
  expect(spawnSync("git", ["init", "--bare", "-q", bare], { encoding: "utf8" }).status).toBe(0);

  const run = (args: string[]) =>
    spawnSync(process.execPath, [join(process.cwd(), "src", "cli.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 60_000,
    });

  // 生成密钥对（信任锚 + 私钥）
  const kg = run(["keygen"]);
  expect(kg.status).toBe(0);

  // 推送（定时任务用的就是这个组合）
  const push = run(["backup", "--push", bare, "--sign-if-possible", "--yes"]);
  expect(push.status).toBe(0);
  expect(`${push.stdout}\n${push.stderr}`).toContain("已推送到");

  // 本机归档旁有 .sig，且远端分支里也有 .sig
  const backups = join(dir, "backups");
  const files = readdirSync(backups);
  const archive = files.find((f) => f.endsWith(".tar.gz"));
  expect(archive).toBeTruthy();
  expect(files).toContain(`${archive}.sig`);
  const ls = spawnSync("git", ["--git-dir", bare, "ls-tree", "--name-only", "openselect-backups"], {
    encoding: "utf8",
  });
  expect(ls.stdout).toContain(`${archive}.sig`);
}, 120_000);
