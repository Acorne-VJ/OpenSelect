import { describe, expect, test } from "bun:test";
import { CLIENT_KINDS, CLIENT_LABELS, detectClient, isClientKind } from "../src/client";

function req(headers: Record<string, string>, url = "http://127.0.0.1:8788/v1/messages"): Request {
  return new Request(url, { headers });
}

describe("detectClient（接入识别）", () => {
  test("显式头 x-openselect-client 优先（仅接受已知种类）", () => {
    expect(detectClient(req({ "x-openselect-client": "opencode" }), "/v1/messages")).toBe("opencode");
    expect(detectClient(req({ "x-openselect-client": "claude-code" }), "/v1/messages")).toBe("claude-code");
    // 未知取值 → 忽略，按 UA/路径判断
    expect(detectClient(req({ "x-openselect-client": "bogus", "user-agent": "opencode/1.2" }), "/v1/messages")).toBe(
      "opencode",
    );
  });

  test("User-Agent 识别 opencode 与 Claude Code", () => {
    expect(detectClient(req({ "user-agent": "opencode/1.2.3" }), "/responses")).toBe("opencode");
    expect(detectClient(req({ "user-agent": "claude-cli/2.1.284 (external, cli)" }), "/v1/messages")).toBe("claude-code");
    expect(detectClient(req({ "user-agent": "claude-code/1.0" }), "/v1/messages")).toBe("claude-code");
  });

  test("会话头 x-opencode-session 不作为 opencode 判据（AC-CDX P2-3：会误伤普通客户端）", () => {
    // 带该头的普通 OpenAI SDK 客户端 → 按路径判为 openai-compat，不能被当成 opencode
    expect(detectClient(req({ "x-opencode-session": "abc" }), "/v1/chat/completions")).toBe("openai-compat");
    expect(detectClient(req({ "x-opencode-session": "abc" }), "/responses")).toBe("openai-responses");
    // 带该头但 UA 是 opencode → 仍然是 opencode（UA 优先）
    expect(detectClient(req({ "x-opencode-session": "abc", "user-agent": "opencode/1" }), "/responses")).toBe("opencode");
  });

  test("无特征时按路径判定协议族", () => {
    expect(detectClient(req({}), "/v1/messages")).toBe("anthropic-compat");
    expect(detectClient(req({}), "/v1/responses")).toBe("openai-responses");
    expect(detectClient(req({}), "/responses")).toBe("openai-responses");
    expect(detectClient(req({}), "/v1/chat/completions")).toBe("openai-compat");
    expect(detectClient(req({}), "/v1/models")).toBe("other");
  });

  test("UA 判定优先于路径（opencode 走 /responses、Claude Code 走 /v1/messages）", () => {
    expect(detectClient(req({ "user-agent": "opencode/1" }), "/v1/chat/completions")).toBe("opencode");
    expect(detectClient(req({ "user-agent": "claude-cli/2" }), "/v1/chat/completions")).toBe("claude-code");
  });

  test("种类集合与标签齐全", () => {
    for (const k of CLIENT_KINDS) {
      expect(isClientKind(k)).toBe(true);
      expect(CLIENT_LABELS[k]).toBeTruthy();
    }
    expect(isClientKind("not-a-kind")).toBe(false);
  });
});
