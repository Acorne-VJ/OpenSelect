import type { Account, Effort, ModelInfo } from "./types";

export type ProviderId = "zai" | "minimax" | "deepseek" | "commandcode" | "ollama";
/** 账号 integration 值：deepseek 保留给「仅注册凭据」，直连用 deepseek-api。 */
export type ProviderAccountIntegration = "zai" | "minimax" | "deepseek-api" | "commandcode" | "ollama";

export interface ProviderCandidate {
  provider: ProviderId;
  /** 上游模型 ID */
  model: string;
  /** 默认推理强度 */
  effort: Effort;
}

export interface ProviderRoute {
  /** 客户端请求的模型别名 */
  id: string;
  /** true = 只允许该供应商；false = coding-auto 链式降级 */
  strict: boolean;
  candidates: ProviderCandidate[];
}

export const CODING_AUTO_ID = "coding-auto";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  zai: "Z.ai",
  minimax: "MiniMax",
  deepseek: "DeepSeek 官方",
  commandcode: "Command Code",
  ollama: "Ollama Cloud",
};

/** 模型别名 → 供应商/上游模型/默认思考度。 */
export const PROVIDER_MODELS: Record<string, ProviderCandidate & { name: string }> = {
  "zai/glm-5.3-flash": {
    provider: "zai",
    model: "glm-5.3-flash",
    effort: "max",
    name: "GLM-5.3-Flash (Z.ai)",
  },
  "zai/glm-5.3": {
    provider: "zai",
    model: "glm-5.3",
    effort: "max",
    name: "GLM-5.3 (Z.ai)",
  },
  "minimax/MiniMax-M3.1-Flash": {
    provider: "minimax",
    model: "MiniMax-M3.1-Flash",
    effort: "max",
    name: "MiniMax-M3.1-Flash",
  },
  "minimax/MiniMax-M3": {
    provider: "minimax",
    model: "MiniMax-M3",
    effort: "max",
    name: "MiniMax-M3",
  },
  "deepseek/deepseek-flash": {
    provider: "deepseek",
    model: "deepseek-flash",
    effort: "max",
    name: "DeepSeek Flash（官方直连）",
  },
  "deepseek/deepseek-v4-pro": {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    effort: "max",
    name: "DeepSeek V4 Pro（官方直连）",
  },
  // Command Code Provider API 的上游模型 ID 带厂商前缀；这里给常用模型一个短别名。
  "commandcode/deepseek-v4.1-flash": {
    provider: "commandcode",
    model: "deepseek/deepseek-v4.1-flash",
    effort: "max",
    name: "DeepSeek V4.1 Flash (Command Code)",
  },
  "commandcode/glm-5.3-flash": {
    provider: "commandcode",
    model: "z-ai/glm-5.3-flash",
    effort: "max",
    name: "GLM-5.3-Flash (Command Code)",
  },
  "commandcode/minimax-m3.1-flash": {
    provider: "commandcode",
    model: "minimax/minimax-m3.1-flash",
    effort: "max",
    name: "MiniMax M3.1 Flash (Command Code)",
  },
  "commandcode/kimi-k3.1-pro": {
    provider: "commandcode",
    model: "moonshotai/Kimi-K3.1-Pro",
    effort: "max",
    name: "Kimi K3.1 Pro (Command Code)",
  },
};

/** coding-auto：跨供应商降级链；默认都是 Flash + max。 */
export const CODING_AUTO_CHAIN: ProviderCandidate[] = [
  { provider: "zai", model: "glm-5.3-flash", effort: "max" },
  { provider: "minimax", model: "MiniMax-M3.1-Flash", effort: "max" },
];

export function isProviderIntegration(integration: string): integration is ProviderAccountIntegration {
  return (
    integration === "zai" ||
    integration === "minimax" ||
    integration === "deepseek-api" ||
    integration === "commandcode" ||
    integration === "ollama"
  );
}

/** 账号 integration → 路由 provider（deepseek-api 对应用户看到的 deepseek）。 */
export function providerForIntegration(integration: ProviderAccountIntegration): ProviderId {
  return integration === "deepseek-api" ? "deepseek" : integration;
}

/** 路由 provider → 账号 integration。 */
export function providerIntegration(provider: ProviderId): ProviderAccountIntegration {
  return provider === "deepseek" ? "deepseek-api" : provider;
}

export function providerBase(account: Account): string {
  if (account.baseUrl?.trim()) return account.baseUrl.trim().replace(/\/+$/, "");
  if (account.integration === "zai") return "https://api.z.ai/api/anthropic";
  if (account.integration === "minimax") {
    return account.region === "global" ? "https://api.minimax.io/anthropic" : "https://api.minimaxi.com/anthropic";
  }
  if (account.integration === "deepseek-api") return "https://api.deepseek.com/anthropic";
  if (account.integration === "commandcode") {
    return (account.baseUrl?.trim() || "https://api.commandcode.ai/provider/v1").replace(/\/+$/, "");
  }
  if (account.integration === "ollama") {
    return (account.baseUrl?.trim() || "https://ollama.com/v1").replace(/\/+$/, "");
  }
  return "";
}

export function providerUsageUrl(account: Account): string {
  if (account.integration === "zai") return "https://api.z.ai/api/monitor/usage/quota/limit";
  if (account.integration === "minimax") {
    return account.region === "global"
      ? "https://api.minimax.io/v1/token_plan/remains"
      : "https://api.minimax.cn/v1/token_plan/remains";
  }
  if (account.integration === "deepseek-api") return "https://api.deepseek.com/user/balance";
  // Command Code Provider 与 Ollama Cloud 没有与 OpenSelect 兼容的 5h/周用量端点。
  return "";
}

/** 该供应商账号在模型可用性页展示的模型别名（Ollama Cloud 动态发现，返回空）。 */
export function providerModelIds(integration: ProviderAccountIntegration): string[] {
  if (integration === "ollama") return [];
  const provider = providerForIntegration(integration);
  return Object.entries(PROVIDER_MODELS)
    .filter(([, m]) => m.provider === provider)
    .map(([id]) => id);
}

/** 直连供应商的公开单价（USD / 1M tokens），仅用于统计页成本估算。 */
const PROVIDER_MODEL_COSTS: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "zai/glm-5.3-flash": { input: 0.15, output: 0.5 },
  "minimax/MiniMax-M3.1-Flash": { input: 0.15, output: 0.6, cacheRead: 0.015 },
  "deepseek/deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
  "deepseek/deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
  "commandcode/deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
  "commandcode/glm-5.3-flash": { input: 0.15, output: 0.5 },
  "commandcode/minimax-m3.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.015 },
};

export function providerCatalogModels(): ModelInfo[] {
  const out: ModelInfo[] = Object.entries(PROVIDER_MODELS).map(([id, m]) => ({
    id,
    name: m.name,
    family: m.provider === "commandcode" ? "openai" : "anthropic",
    ...(m.provider === "commandcode" ? { api: "chat" as const } : {}),
    free: false,
    cost: PROVIDER_MODEL_COSTS[id] ?? { input: 0, output: 0 },
    provider: m.provider,
    upstreamModel: m.model,
    defaultEffort: m.effort,
  }));
  out.push({
    id: CODING_AUTO_ID,
    name: "Coding Auto (Z.ai → MiniMax → OpenCode → DeepSeek 官方兜底)",
    family: "anthropic",
    free: false,
    cost: { input: 0, output: 0 },
    provider: "auto",
    defaultEffort: "max",
  });
  return out;
}

/** opencode 的 deepseek 模型在官方 API 的兜底路由（仅最后一层使用）。 */
export function deepSeekFallbackRoute(model: string | null): ProviderRoute | null {
  if (model === "deepseek-v4.1-flash") return resolveProviderRoute("deepseek/deepseek-flash");
  if (model === "deepseek-v4-pro") return resolveProviderRoute("deepseek/deepseek-v4-pro");
  return null;
}

export function resolveProviderRoute(model: string | null): ProviderRoute | null {
  if (!model) return null;
  if (model === CODING_AUTO_ID) {
    return { id: model, strict: false, candidates: CODING_AUTO_CHAIN };
  }
  const m = PROVIDER_MODELS[model];
  if (m) return { id: model, strict: true, candidates: [{ provider: m.provider, model: m.model, effort: m.effort }] };

  // Command Code：commandcode/<短别名> 与 cc/<短别名> 都映射到同一组上游模型；
  // 也允许 commandcode/<厂商>/<模型> 直接透传。
  if (model.startsWith("commandcode/") || model.startsWith("cc/")) {
    const rest = model.startsWith("cc/") ? model.slice(3) : model.slice("commandcode/".length);
    const friendly = PROVIDER_MODELS[`commandcode/${rest}`];
    return {
      id: model,
      strict: true,
      candidates: [
        {
          provider: "commandcode",
          model: friendly?.model ?? rest,
          effort: friendly?.effort ?? "max",
        },
      ],
    };
  }

  // Ollama Cloud：模型名由 /v1/models 动态发现，别名格式 ollama/<模型名>。
  if (model.startsWith("ollama/")) {
    const upstream = model.slice("ollama/".length);
    if (!upstream) return null;
    return { id: model, strict: true, candidates: [{ provider: "ollama", model: upstream, effort: "max" }] };
  }
  return null;
}
