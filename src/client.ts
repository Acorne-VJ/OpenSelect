/**
 * 接入（客户端）识别。
 *
 * 目的：面板要回答两件事——
 *  1. 现在是哪个客户端（接入）在用本代理（opencode / Claude Code / 其他兼容客户端）；
 *  2. 能不能按「接入」分别指定账号（比全局「设为首选」更细粒度）。
 *
 * 识别依据（优先级从高到低）：
 *  1. 显式头 `x-openselect-client`（客户端自报，取值限已知种类；代理侧不转发该头到上游）；
 *  2. User-Agent 含 opencode → opencode；含 claude-cli/claude-code → Claude Code；
 *  3. 请求路径（/v1/messages、/responses、/v1/chat/completions）→ 对应协议族。
 *
 * 注意：会话头 `x-opencode-session` **不**作为 opencode 的判据 —— 本代理把它当作通用会话粘性头
 * （任何客户端都可以带），用它判定会把普通 OpenAI SDK 误判成 opencode（AC-CDX P2-3）。
 * 真实 opencode 客户端的 UA 即含 "opencode"，无需依赖该头。
 *
 * 注意：这里的「接入」指**客户端**（谁在用代理），与账号卡片上的 integration
 * （账号属于哪种集成，如 opencode-go）是两个不同维度，不要混淆。
 */

export const CLIENT_KINDS = [
  "opencode",
  "claude-code",
  "anthropic-compat",
  "openai-responses",
  "openai-compat",
  "other",
] as const;

export type ClientKind = (typeof CLIENT_KINDS)[number];

export const CLIENT_LABELS: Record<ClientKind, string> = {
  opencode: "opencode",
  "claude-code": "Claude Code",
  "anthropic-compat": "Anthropic 协议客户端",
  "openai-responses": "OpenAI Responses 客户端",
  "openai-compat": "OpenAI Chat 兼容客户端",
  other: "其他客户端",
};

export function isClientKind(s: string): s is ClientKind {
  return (CLIENT_KINDS as readonly string[]).includes(s);
}

/** 归一化请求路径（去掉 /v1 前缀与查询串），便于按协议族判断。 */
function normalizedPath(path: string): string {
  let p = path.split("?")[0] ?? "";
  if (p.startsWith("/v1/")) p = p.slice(3);
  else if (p === "/v1") p = "/";
  return p;
}

/** 识别请求来自哪个接入（客户端）。 */
export function detectClient(req: Request, path: string): ClientKind {
  const explicit = (req.headers.get("x-openselect-client") ?? "").trim().toLowerCase();
  if (explicit && isClientKind(explicit)) return explicit;

  const ua = (req.headers.get("user-agent") ?? "").toLowerCase();
  if (ua.includes("opencode")) return "opencode";
  if (ua.includes("claude-cli") || ua.includes("claude-code")) return "claude-code";

  const p = normalizedPath(path);
  if (p === "/messages") return "anthropic-compat";
  if (p === "/responses") return "openai-responses";
  if (p === "/chat/completions") return "openai-compat";
  return "other";
}
