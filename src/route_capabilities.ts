import type { CodingAutoStep } from "./coding_auto";

type Support = true | false | "unknown";
export interface RouteCapability {
  imageSources: readonly string[] | "unknown";
  thinking: Support;
  thinkingDisabled: Support;
  contextTokens: number | null;
  source: string;
}

// Evidence describes the served route, not merely what a client config claims.
// OpenCode image + thinking were exercised end-to-end in this project.
export const ROUTE_CAPABILITIES: Record<CodingAutoStep, RouteCapability> = {
  opencode: { imageSources: ["base64", "url"], thinking: true, thinkingDisabled: true, contextTokens: 1_000_000,
    source: "OpenSelect end-to-end OpenCode Go deepseek-v4.1-flash smoke tests" },
  deepseek: { imageSources: ["base64", "url", "file"], thinking: true, thinkingDisabled: true, contextTokens: 1_000_000,
    source: "https://api-docs.deepseek.com/guides/anthropic_api/ ; https://api-docs.deepseek.com/quick_start/pricing/" },
  minimax: { imageSources: ["base64"], thinking: true, thinkingDisabled: false, contextTokens: 1_000_000,
    source: "https://platform.minimax.io/docs/guides/text-generation ; https://platform.minimax.io/docs/m-plan/other-tools" },
  zai: { imageSources: "unknown", thinking: true, thinkingDisabled: false, contextTokens: 1_000_000,
    source: "https://docs.z.ai/guides/vlm/glm-5.3-flash (image support on this API route unverified)" },
};

export interface RequestRequirements {
  imageSources: string[];
  thinking: "on" | "off" | "unspecified" | "unknown";
  /** Exact token count, if established independently; never infer from bytes or max_tokens. */
  exactInputTokens: number | null;
  /** Client-required window capacity; distinct from the actual prompt count. */
  requiredContextTokens?: number;
}

export function requestRequirements(body: Record<string, unknown>, contextHeader?: string | null): RequestRequirements {
  const sources: string[] = [];
  const visit = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      if (block.type === "image") {
        const source = block.source as Record<string, unknown> | undefined;
        sources.push(typeof source?.type === "string" ? source.type : "unknown");
      } else if (block.type === "image_url" || block.type === "input_image") {
        sources.push("unknown");
      } else if (block.type === "tool_result") visit(block.content);
    }
  };
  if (Array.isArray(body.messages)) for (const m of body.messages) {
    if (m && typeof m === "object") visit((m as Record<string, unknown>).content);
  }
  const thinking = body.thinking as { type?: unknown } | undefined;
  const requirements: RequestRequirements = { imageSources: sources, thinking: thinking?.type === "disabled" ? "off" :
    thinking?.type === "enabled" || thinking?.type === "adaptive" ? "on" :
      thinking?.type != null ? "unknown" :
        (body.output_config as { effort?: unknown } | undefined)?.effort != null ? "on" : "unspecified",
    exactInputTokens: null };
  const suffix = typeof body.model === "string" ? body.model.match(/\[(\d+)([km])\]$/i) : null;
  const required = contextHeader != null ? Number(contextHeader) : suffix ? Number(suffix[1]) * (suffix[2]!.toLowerCase() === "m" ? 1_000_000 : 1000) : 0;
  if (contextHeader != null && (!/^\d+$/.test(contextHeader) || !Number.isSafeInteger(required) || required <= 0)) {
    throw new Error("x-openselect-context-window must be a positive integer");
  }
  if (required > 0) requirements.requiredContextTokens = required;
  return requirements;
}

export function supportsRequirements(capability: RouteCapability, req: RequestRequirements): boolean {
  return capabilityRejections(capability, req).length === 0;
}

export function capabilityRejections(capability: RouteCapability, req: RequestRequirements): string[] {
  const reasons: string[] = [];
  if (req.thinking === "unknown") reasons.push("思考模式无法识别");
  if (req.imageSources.length && (capability.imageSources === "unknown" ||
    req.imageSources.some((source) => !capability.imageSources.includes(source)))) reasons.push("图片来源类型未验证或不支持");
  if (req.thinking === "on" && capability.thinking !== true) reasons.push("思考能力未验证或不支持");
  if (req.thinking === "off" && capability.thinkingDisabled !== true) reasons.push("关闭思考未验证或不支持");
  if (req.exactInputTokens != null && (capability.contextTokens == null || req.exactInputTokens > capability.contextTokens)) reasons.push("上下文容量未知或不足");
  if (req.requiredContextTokens != null && (capability.contextTokens == null || req.requiredContextTokens > capability.contextTokens)) reasons.push("不满足客户端要求的上下文容量");
  return reasons;
}
