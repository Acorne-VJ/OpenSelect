import type { Runtime } from "./state";

/**
 * DeepSeek Search / Fetch 代理。
 *
 * 客户端直接 POST /v1/tools/search 或 /v1/tools/fetch，OpenSelect 用本机配置的
 * DeepSeek key 转发到 api.deepseek.com；key 来源：
 *   1. DEEPSEEK_API_KEY
 *   2. accounts 中 integration=deepseek 的账号 key
 * 不在 OpenSelect 里做搜索语法/结果改写，保持 DeepSeek 原始 JSON。
 */
export async function handleDeepSeekTool(rt: Runtime, req: Request, path: "/tools/search" | "/tools/fetch"): Promise<Response> {
  const key =
    (process.env.DEEPSEEK_API_KEY ?? "").trim() ||
    rt.config.accounts.find((a) => a.integration === "deepseek")?.key ||
    "";
  if (!key) {
    return Response.json(
      {
        error: {
          type: "openselect_tool_key_missing",
          message: "未配置 DeepSeek Key：设置 DEEPSEEK_API_KEY，或在面板添加 integration=deepseek 的账号。",
        },
      },
      { status: 400 },
    );
  }
  const base = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const body = await req.text();
  let res: Response;
  try {
    res = await fetch(`${base}${path === "/tools/search" ? "/v1/tools/search" : "/v1/tools/fetch"}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
    });
  } catch (e) {
    return Response.json({ error: { type: "openselect_tool_network", message: String(e) } }, { status: 502 });
  }
  const text = await res.text().catch(() => "");
  if (res.status === 402) {
    return Response.json(
      {
        error: {
          type: "openselect_tool_balance",
          message: "DeepSeek Search/Fetch 余额不足（402）；请充值或换用有 Search 余额的 Key。",
          detail: text.slice(0, 300),
        },
      },
      { status: 402 },
    );
  }
  return new Response(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
