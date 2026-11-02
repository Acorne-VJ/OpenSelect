import { describe, expect, test } from "bun:test";
import {
  ZEN_MODEL_IDS,
  zenChain,
  zenClassifyFailure,
  zenDeniedUntil,
  zenMarkOutage,
  zenNoteFailure,
  zenOutageRemaining,
} from "../src/zen";

describe("zen 失败分级", () => {
  test("通用 503 / Endpoint is unavailable → transport，不写模型冷却", () => {
    const err = "zen POST /api/session/ses_x/generate → 503: Endpoint is unavailable";
    const f = zenClassifyFailure(err);
    expect(f.scope).toBe("transport");
    expect(f.ms).toBe(0);

    zenNoteFailure("deepseek-v4.1-flash-free", err);
    expect(zenDeniedUntil("deepseek-v4.1-flash-free")).toBe(0);
  });

  test("连接失败 / server 起不来 → transport", () => {
    expect(zenClassifyFailure("zen POST /api/session 连接失败: ECONNREFUSED").scope).toBe("transport");
    expect(zenClassifyFailure("zen server: 启动超时/密码未出现").scope).toBe("transport");
    expect(zenClassifyFailure("zen server: 健康检查失败").scope).toBe("transport");
  });

  test("免费额度耗尽 → 模型冷却 30min", () => {
    const f = zenClassifyFailure("FreeTierError: free tier rate limit exceeded");
    expect(f.scope).toBe("model");
    expect(f.ms).toBe(30 * 60_000);

    zenNoteFailure("mimo-v2.6-flash-free", "HTTP 429: rate limit");
    expect(zenDeniedUntil("mimo-v2.6-flash-free")).toBeGreaterThan(Date.now() + 29 * 60_000);
  });

  test("模型下线 → 24h；未知错误 → 1min", () => {
    expect(zenClassifyFailure("HTTP 410: ModelDeprecated").ms).toBe(24 * 3600_000);
    expect(zenClassifyFailure("something odd happened").ms).toBe(60_000);
  });

  test("连续通用故障触发短时熔断", () => {
    zenMarkOutage(1500, "上游暂不可用");
    expect(zenOutageRemaining()).toBeGreaterThan(0);
  });
});

describe("zen 候选顺序", () => {
  test("点名模型 → 用户配置 → 默认全集，去重", () => {
    const chain = zenChain("glm-5.3-flash-free", ["mimo-v2.6-flash-free", "glm-5.3-flash-free"]);
    expect(chain[0]).toBe("glm-5.3-flash-free");
    expect(chain[1]).toBe("mimo-v2.6-flash-free");
    expect(chain.length).toBe(ZEN_MODEL_IDS.length);
    expect(new Set(chain).size).toBe(chain.length);
  });
});
