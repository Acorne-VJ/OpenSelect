import { describe, expect, test } from "bun:test";
import { loadTimePricing, nextTransition, ruleById, windowKind } from "../src/time_pricing";

describe("分时窗口", () => {
  test("DeepSeek 周一 UTC 高峰 / 周六非高峰", async () => {
    const data = await loadTimePricing();
    const rule = ruleById(data, "deepseek")!;
    expect(windowKind(rule, new Date("2026-11-02T02:00:00Z"))).toBe("peak");
    expect(windowKind(rule, new Date("2026-11-02T05:00:00Z"))).toBe("off-peak");
    expect(windowKind(rule, new Date("2026-10-31T02:00:00Z"))).toBe("off-peak");
  });

  test("Ollama Cloud 周一 13:00 UTC 高峰 / 19:00 非高峰", async () => {
    const data = await loadTimePricing();
    const rule = ruleById(data, "ollama")!;
    expect(windowKind(rule, new Date("2026-11-02T13:00:00Z"))).toBe("peak");
    expect(windowKind(rule, new Date("2026-11-02T19:00:00Z"))).toBe("off-peak");
  });

  test("Z.ai 14:30 SGT 高峰 / 05:00 UTC 非高峰", async () => {
    const data = await loadTimePricing();
    const rule = ruleById(data, "zai")!;
    expect(windowKind(rule, new Date("2026-11-02T06:30:00Z"))).toBe("peak");
    expect(windowKind(rule, new Date("2026-11-02T05:00:00Z"))).toBe("off-peak");
  });

  test("下一次切换时间可计算", async () => {
    const data = await loadTimePricing();
    const rule = ruleById(data, "deepseek")!;
    const next = nextTransition(rule, new Date("2026-11-02T02:30:00Z"));
    expect(next?.toISOString()).toBe("2026-11-02T04:00:00.000Z");
  });

  test("MiniMax / Command Code 无分时；OpenCode DeepSeek 有分时", async () => {
    const data = await loadTimePricing();
    for (const id of ["minimax", "commandcode"]) {
      expect(windowKind(ruleById(data, id)!, new Date("2026-11-02T02:00:00Z"))).toBe("flat");
    }
    const oc = ruleById(data, "opencode")!;
    expect(windowKind(oc, new Date("2026-11-02T02:00:00Z"))).toBe("peak");
    expect(windowKind(oc, new Date("2026-10-31T02:00:00Z"))).toBe("off-peak");
  });
});
