import type { Account, ModelInfo } from "./types";

/** Ollama Cloud 的 OpenAI 兼容端点；Anthropic 兼容端点为 https://ollama.com。 */
export const OLLAMA_DEFAULT_BASE = "https://ollama.com/v1";

/** 把账号 baseUrl 统一成 Ollama 根地址（不带 /v1）。 */
export function ollamaRoot(base?: string): string {
  const raw = (base?.trim() || OLLAMA_DEFAULT_BASE).replace(/\/+$/, "");
  return raw.endsWith("/v1") ? raw.slice(0, -3) : raw;
}

/** Ollama Cloud 公开单价（USD / 1M tokens，标准价；off-peak 更低）。 */
const OLLAMA_COSTS: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044 },
  "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03 },
  "minimax-m3.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.015 },
  "kimi-k3": { input: 3.0, output: 15.0, cacheRead: 0.3 },
  "gpt-oss:120b": { input: 0.15, output: 0.6, cacheRead: 0.014 },
  "gpt-oss:20b": { input: 0.07, output: 0.3, cacheRead: 0.035 },
  "mimo-v2.6-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  "mimo-v2.6-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036 },
  gemma4: { input: 0.14, output: 0.4, cacheRead: 0.05 },
};

function uniqueNames(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const name = v.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function authHeaders(key?: string): Record<string, string> {
  return key?.trim() ? { authorization: `Bearer ${key.trim()}` } : {};
}

/**
 * 读取 Ollama Cloud 模型列表。
 * 优先 /api/tags（Ollama 原生），失败再试 /v1/models（OpenAI 兼容）。
 * 未配置 Key 或服务不可达时返回空数组，不抛错。
 */
export async function fetchOllamaModelNames(base?: string, key?: string, timeoutMs = 3000): Promise<string[]> {
  const root = ollamaRoot(base);
  try {
    const res = await fetch(`${root}/api/tags`, {
      headers: authHeaders(key),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const j = (await res.json()) as {
        models?: Array<{
          name?: unknown;
          model?: unknown;
          details?: { family?: unknown; families?: unknown };
        }>;
      };
      const names = uniqueNames(
        (j.models ?? [])
          .filter((m) => {
            const name = String(m.name ?? m.model ?? "").toLowerCase();
            const family = String(m.details?.family ?? "").toLowerCase();
            // 嵌入模型不能走聊天端点，不放进聊天模型目录。
            return !family.includes("bert") && !/embed/i.test(name);
          })
          .map((m) => m.name ?? m.model),
      );
      if (names.length > 0) return names;
    }
  } catch {
    /* fall through to /v1/models */
  }
  try {
    const res = await fetch(`${root}/v1/models`, {
      headers: authHeaders(key),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const j = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return uniqueNames(
        (j.data ?? [])
          .filter((m) => !/embed/i.test(String(m.id ?? "")))
          .map((m) => m.id),
      );
    }
  } catch {
    /* cloud unavailable */
  }
  return [];
}

export function ollamaCatalogModels(names: string[]): ModelInfo[] {
  return names.map((name) => ({
    id: `ollama/${name}`,
    name: `${name} (Ollama Cloud)`,
    family: "anthropic",
    api: "chat",
    free: false,
    cost: OLLAMA_COSTS[name] ?? { input: 0, output: 0 },
    provider: "ollama",
    upstreamModel: name,
  }));
}

export async function fetchOllamaCatalogModels(base?: string, key?: string): Promise<ModelInfo[]> {
  return ollamaCatalogModels(await fetchOllamaModelNames(base, key));
}

export async function fetchOllamaAccountModels(
  account: Account,
): Promise<{ ok: true; ids: string[] } | { ok: false; status: number; error: string }> {
  if (!account.key.trim()) return { ok: false, status: 401, error: "Ollama Cloud 需要 API Key" };
  const names = await fetchOllamaModelNames(account.baseUrl, account.key);
  if (names.length === 0) {
    return { ok: false, status: 0, error: "Ollama Cloud 不可达、Key 无效或没有可用模型" };
  }
  return { ok: true, ids: names.map((n) => `ollama/${n}`) };
}
