import { join } from "node:path";
import { readJson } from "./util";
import { loadConfig } from "./config";
import { fetchOllamaCatalogModels } from "./ollama";
import { providerCatalogModels } from "./providers";
import type { Family, ModelInfo, PlanLimit } from "./types";

const DATA_DIR = join(import.meta.dir, "..", "data");

/** 模型目录文件路径（sync-catalog 写盘目标）。 */
export const MODELS_PATH = join(DATA_DIR, "models.json");

export interface Catalog {
  models: Record<string, ModelInfo>;
  limits: Record<string, PlanLimit>;
}

let cache: Catalog | null = null;

export async function loadCatalog(): Promise<Catalog> {
  if (cache) return cache;
  const models = await readJson<Record<string, ModelInfo>>(MODELS_PATH, {});
  // OpenCode Go lists this model as vision-capable; leave unknown models unspecified.
  if (models["deepseek-v4.1-flash"]) models["deepseek-v4.1-flash"].inputModalities = ["text", "image"];
  // 直连供应商的模型别名（zai/...、minimax/...、coding-auto、commandcode/...）动态并入目录，
  // 不写入 data/models.json，避免 sync-catalog 覆盖。
  for (const m of providerCatalogModels()) if (!models[m.id]) models[m.id] = m;
  // Ollama Cloud 模型名来自 ollama.com，只有配置了 Ollama 账号才探测，避免未使用时的启动延迟。
  const cfg = await loadConfig();
  const ollamaAccount = cfg.accounts.find((a) => a.integration === "ollama" && a.enabled) ??
    cfg.accounts.find((a) => a.integration === "ollama");
  if (ollamaAccount?.key.trim()) {
    for (const m of await fetchOllamaCatalogModels(ollamaAccount.baseUrl, ollamaAccount.key)) {
      if (!models[m.id]) models[m.id] = m;
    }
  }
  const limits = await readJson<Record<string, PlanLimit>>(join(DATA_DIR, "plan-limits.json"), {});
  cache = { models, limits };
  return cache;
}

/** 清空模块级缓存（同进程内改写 models.json 后必须调用）。 */
export function resetCatalogCache(): void {
  cache = null;
}

/** Strip a leading version segment (/v1, /v1beta) so standard client paths ("/v1/messages")
 *  and base-URL-relative SDK paths ("/messages") normalize to the same family route. */
export function stripVersionPrefix(pathname: string): string {
  if (pathname === "/v1" || pathname === "/v1beta") return "/";
  if (pathname.startsWith("/v1/")) return pathname.slice(3);
  if (pathname.startsWith("/v1beta/")) return pathname.slice(7);
  return pathname;
}

export function familyFromPath(pathname: string): Family {
  const p = stripVersionPrefix(pathname);
  if (p.startsWith("/messages")) return "anthropic";
  if (p.startsWith("/responses")) return "openai";
  if (p.startsWith("/models/") || p.includes(":generateContent") || p.includes(":streamGenerateContent")) {
    return "google";
  }
  return "openai";
}

export function familyFromModel(catalog: Catalog, modelId: string | null): Family {
  if (!modelId) return "openai";
  const m = catalog.models[modelId];
  return m?.family ?? "openai";
}

export function isFreeModel(catalog: Catalog, modelId: string | null): boolean {
  if (!modelId) return false;
  return catalog.models[modelId]?.free ?? false;
}

/**
 * 免费优先候选资格：目录内标记 free，且属于 openai/chat 家族（协议可被代理替换）。
 * 代理与控制台校验共用此判定，避免两端口径不一致导致「静默无效」的配置。
 */
export function isFreeFirstEligible(catalog: Catalog, modelId: string): boolean {
  const info = catalog.models[modelId];
  if (!info || !info.free) return false;
  return info.family === "openai" && (info.api ?? "chat") === "chat";
}

export function modelName(catalog: Catalog, modelId: string | null): string {
  if (!modelId) return "-";
  return catalog.models[modelId]?.name ?? modelId;
}
