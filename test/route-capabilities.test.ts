import { expect, test } from "bun:test";
import { capabilityRejections, requestRequirements, ROUTE_CAPABILITIES, supportsRequirements } from "../src/route_capabilities";

test("nested tool-result images and explicit thinking are recognized without counting base64", () => {
  const body = { model: "coding-auto", max_tokens: 1000000, thinking: { type: "adaptive" }, messages: [
    { role: "user", content: [{ type: "tool_result", content: [
      { type: "image", source: { type: "base64", data: "A".repeat(5_000_000) } },
    ] }] },
  ] };
  const req = requestRequirements(body);
  expect(req).toEqual({ imageSources: ["base64"], thinking: "on", exactInputTokens: null });
  expect(supportsRequirements(ROUTE_CAPABILITIES.opencode, req)).toBe(true);
  expect(supportsRequirements(ROUTE_CAPABILITIES.deepseek, req)).toBe(true);
  expect(supportsRequirements(ROUTE_CAPABILITIES.zai, req)).toBe(false);
});

test("unknown input capabilities fail closed; context only uses independently known token counts", () => {
  const fileImage = requestRequirements({ messages: [{ role: "user", content: [{ type: "image", source: { type: "file" } }] }] });
  expect(supportsRequirements(ROUTE_CAPABILITIES.opencode, fileImage)).toBe(false);
  expect(supportsRequirements(ROUTE_CAPABILITIES.deepseek, fileImage)).toBe(true);
  expect(supportsRequirements(ROUTE_CAPABILITIES.minimax, { ...fileImage, imageSources: [], thinking: "off" })).toBe(false);
  expect(capabilityRejections(ROUTE_CAPABILITIES.deepseek, { ...fileImage, exactInputTokens: 1000001 })).toContain("上下文容量未知或不足");
  expect(capabilityRejections({ ...ROUTE_CAPABILITIES.opencode, contextTokens: null }, { ...fileImage, imageSources: [], exactInputTokens: 1 })).toContain("上下文容量未知或不足");
  expect(requestRequirements({ thinking: { type: "unexpected" } }).thinking).toBe("unknown");
});

test("required window is enforced without claiming to count the prompt", () => {
  const req = requestRequirements({ model: "coding-auto[1m]" });
  expect(req.requiredContextTokens).toBe(1000000);
  expect(req.exactInputTokens).toBeNull();
  expect(supportsRequirements(ROUTE_CAPABILITIES.opencode, req)).toBe(true);
  expect(supportsRequirements({ ...ROUTE_CAPABILITIES.opencode, contextTokens: 200000 }, req)).toBe(false);
  expect(supportsRequirements(ROUTE_CAPABILITIES.deepseek, requestRequirements({}, "2000000"))).toBe(false);
  expect(() => requestRequirements({}, "invalid")).toThrow();
  expect(supportsRequirements(ROUTE_CAPABILITIES.zai, requestRequirements({ thinking: { type: "disabled" } }))).toBe(false);
});
