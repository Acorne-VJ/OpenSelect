/** Anthropic ⇄ OpenAI Chat 协议翻译层（EVT-20261019-010）
 *
 * 目标：Claude Code / 任意 Anthropic 客户端 `/v1/messages` 调用 openai/chat 系模型。
 *
 * ## proxy.ts 集成点
 * - `/v1/messages/count_tokens`：openai/google 系模型本地近似（不触发推理）；anthropic 系模型透传上游。
 * - `/v1/messages`：catalog 中 `family==="openai"` 且 `api!=="responses"` 的模型 →
 *   `translateAnthropicRequest` 一次性翻译，上游 `/openai/v1/chat/completions`；
 *   `api==="responses"` 与 google 系模型 → 本地 400（v1 不支持）。
 * - 翻译模式：丢弃 query（如 `?beta=true`）、剥离 `anthropic-*` 请求头、认证用 `authorization: Bearer`；
 *   请求体在重试间复用同一份。
 * - 上游错误 → `translateOpenAiError`；成功非流 → `translateChatCompletion`；
 *   成功流式 → 保留首块预读后包装 `chatSseToAnthropicStream`。
 *
 * ## 映射备忘
 * 请求：system(string|blocks)→system message；messages 内嵌 role:"system"（mid-conversation system beta）→ system message；
 *   content blocks→chat messages（user: text/image/tool_result 拆分 tool 消息；
 *   assistant: text + tool_use→tool_calls）；stop_sequences→stop；tools→functions；
 *   tool_choice: auto/any/none/tool→"auto"/"required"/"none"/named；丢 top_k/metadata/thinking。
 * 响应：finish_reason stop|length|tool_calls|function_call|content_filter→end_turn|max_tokens|tool_use|tool_use|end_turn；
 *   usage prompt/completion→input/output；tool_calls→tool_use blocks（arguments JSON.parse，容错 {}）。
 * SSE：message_start→content_block_start(text/tool_use)→content_block_delta(text_delta/input_json_delta)→
 *   content_block_stop→message_delta(stop_reason+usage)→message_stop；工具调用参数先缓冲、finish 时整块下发
 *   （index 交错/缺失不丢参数）；流内 error 帧→event:error；data:[DONE] 与无尾换行 flush 兜底。
 * 错误：400/401/403/404/413/429/5xx→invalid_request_error/authentication_error/permission_error/not_found_error/
 *   request_too_large/rate_limit_error/api_error，envelope {type:"error",error:{type,message}}。
 * count_tokens（openai 模型本地）：{input_tokens: ceil(JSON bytes / 4)}。
 */

export interface TranslatedAnthropicRequest {
  body: Record<string, unknown>;
  stream: boolean;
  approxInputTokens: number;
}

function normalizeParts(parts: Array<Record<string, unknown>>): unknown {
  if (parts.every((p) => p.type === "text")) return parts.map((p) => String(p.text ?? "")).join("");
  return parts;
}

function imageUrlFromSource(source: Record<string, unknown>): string {
  return source.type === "url"
    ? String(source.url ?? "")
    : `data:${String(source.media_type ?? "image/png")};base64,${String(source.data ?? "")}`;
}

/** 拆分 tool_result：文本进 tool 消息；图片转 image_url 附到随后的 user 消息（v1 不丢图）。 */
function splitToolResult(content: unknown): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (content == null) return { text: "", images: [] };
  if (Array.isArray(content)) {
    const texts: string[] = [];
    const images: string[] = [];
    for (const raw of content) {
      const b = (raw ?? {}) as Record<string, unknown>;
      if (b.type === "text") texts.push(String(b.text ?? ""));
      else if (b.type === "image") {
        const url = imageUrlFromSource((b.source ?? {}) as Record<string, unknown>);
        if (url) images.push(url);
      }
    }
    return { text: texts.join(""), images };
  }
  return { text: JSON.stringify(content), images: [] };
}

export function mapFinishReason(fr: unknown): string {
  switch (fr) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "end_turn"; // stop / content_filter / null / 未知
  }
}

/**
 * 结合是否存在 tool_use 修正结束原因：上游可能以 stop/null/[DONE]/EOF 结束，
 * 但 Anthropic 协议要求有工具调用时 stop_reason=tool_use；length/content_filter 保持原语义。
 */
export function effectiveStopReason(fr: unknown, hasTools: boolean): string {
  if (!hasTools) return mapFinishReason(fr);
  if (fr === "length") return "max_tokens";
  if (fr === "content_filter") return "end_turn";
  return "tool_use";
}

/** Anthropic /v1/messages 请求体 → OpenAI /chat/completions 请求体。仅处理已知块类型，未知块丢弃。 */
export function translateAnthropicRequest(
  input: Record<string, unknown>,
  model: string,
): TranslatedAnthropicRequest {
  const out: Record<string, unknown> = { model };
  const msgs: Array<Record<string, unknown>> = [];

  const system = input.system;
  if (typeof system === "string" && system.trim()) {
    msgs.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const txt = system
      .filter((b) => (b as { type?: string } | null)?.type === "text")
      .map((b) => String((b as { text?: unknown }).text ?? ""))
      .join("\n\n");
    if (txt.trim()) msgs.push({ role: "system", content: txt });
  }

  const conv = Array.isArray(input.messages) ? (input.messages as Array<Record<string, unknown>>) : [];
  for (const m of conv) {
    const rawRole = m?.role;
    const role = rawRole === "assistant" ? "assistant" : rawRole === "system" ? "system" : "user";
    const content = m?.content;
    if (role === "system") {
      // Claude Code（mid-conversation system beta）会在 messages 内嵌 role:"system"
      const txt =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content as Array<Record<string, unknown>>)
                .filter((b) => b?.type === "text")
                .map((b) => String(b.text ?? ""))
                .join("\n\n")
            : "";
      if (txt.trim()) msgs.push({ role: "system", content: txt });
      continue;
    }
    if (typeof content === "string") {
      msgs.push({ role, content });
      continue;
    }
    const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
    const parts: Array<Record<string, unknown>> = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const toolMsgs: Array<Record<string, unknown>> = [];
    const toolImages: Array<Record<string, unknown>> = [];
    let text = "";
    const flushText = (): void => {
      if (text) {
        parts.push({ type: "text", text });
        text = "";
      }
    };
    for (const b of blocks) {
      const t = b?.type;
      if (t === "text") {
        if (typeof b.text === "string") text += b.text;
      } else if (t === "image") {
        flushText();
        const src = (b.source ?? {}) as Record<string, unknown>;
        const url = imageUrlFromSource(src);
        if (url) parts.push({ type: "image_url", image_url: { url } });
      } else if (t === "tool_use" && role === "assistant") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (t === "tool_result" && role === "user") {
        const r = splitToolResult(b.content);
        toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: r.text });
        for (const url of r.images) toolImages.push({ type: "image_url", image_url: { url } });
      }
      // thinking / redacted_thinking / document / search_result → 丢弃（v1）
    }
    flushText();
    msgs.push(...toolMsgs);
    if (role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant" };
      if (parts.length) msg.content = normalizeParts(parts);
      if (toolCalls.length) {
        msg.tool_calls = toolCalls;
        if (!parts.length) msg.content = null;
      }
      if (msg.content !== undefined || toolCalls.length) msgs.push(msg);
    } else {
      const userParts = [...toolImages, ...parts];
      if (userParts.length) {
        const allText = userParts.every((p) => p.type === "text");
        msgs.push({
          role: "user",
          content: allText ? userParts.map((p) => String(p.text ?? "")).join("") : userParts,
        });
      }
    }
  }
  out.messages = msgs;
  const maxTokens = Number(input.max_tokens);
  out.max_tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096;
  if (typeof input.temperature === "number") out.temperature = input.temperature;
  if (typeof input.top_p === "number") out.top_p = input.top_p;
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length) out.stop = input.stop_sequences;

  if (Array.isArray(input.tools) && input.tools.length) {
    const tools = (input.tools as Array<Record<string, unknown>>)
      .filter((t) => t?.name && t?.input_schema)
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    if (tools.length) out.tools = tools;
  }
  const tc = input.tool_choice as Record<string, unknown> | undefined;
  if (tc?.type === "auto") out.tool_choice = "auto";
  else if (tc?.type === "any") out.tool_choice = "required";
  else if (tc?.type === "none") out.tool_choice = "none";
  else if (tc?.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };

  const stream = input.stream === true;
  out.stream = stream;
  // 丢弃: metadata / top_k / thinking / context_management / output_config / container / service_tier 等 Anthropic 专属字段

  return { body: out, stream, approxInputTokens: approximateInputTokens(out) };
}

/** 粗略 token 估计（无依赖近似：UTF-8 字节数 / 4，下限 1）。 */
export function approximateInputTokens(body: unknown): number {
  let s = "";
  try {
    s = JSON.stringify(body ?? null) ?? "";
  } catch {
    s = "";
  }
  return Math.max(1, Math.ceil(new TextEncoder().encode(s).length / 4));
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** OpenAI /chat/completions 非流式响应 → Anthropic message。 */
export function translateChatCompletion(j: unknown, model: string): Record<string, unknown> {
  const root = (j ?? {}) as Record<string, unknown>;
  const choice = ((root.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {}) as Record<string, unknown>;
  const msg = (choice.message ?? {}) as Record<string, unknown>;
  const blocks: Array<Record<string, unknown>> = [];
  if (typeof msg.content === "string" && msg.content.length > 0) blocks.push({ type: "text", text: msg.content });
  const tcs = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Array<Record<string, unknown>>) : [];
  for (const tc of tcs) {
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    let input: unknown = {};
    try {
      input = typeof fn.arguments === "string" && fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      input = {};
    }
    blocks.push({
      type: "tool_use",
      id: typeof tc.id === "string" ? tc.id : `toolu_${Math.random().toString(36).slice(2, 10)}`,
      name: typeof fn.name === "string" ? fn.name : "",
      input,
    });
  }
  const usage = (root.usage ?? {}) as Record<string, unknown>;
  const hasTools = blocks.some((b) => b.type === "tool_use");
  return {
    id: typeof root.id === "string" ? root.id : `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: effectiveStopReason(choice.finish_reason, hasTools),
    stop_sequence: null,
    usage: { input_tokens: num(usage.prompt_tokens), output_tokens: num(usage.completion_tokens) },
  };
}

/** OpenAI 错误体/状态码 → Anthropic 错误 envelope。 */
export function translateOpenAiError(status: number, text: string): Record<string, unknown> {
  let message = text ? text.slice(0, 500) : `upstream HTTP ${status}`;
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    message = String(j.error?.message ?? j.message ?? message);
  } catch {
    /* 非 JSON：保留原始文本摘要 */
  }
  const byStatus: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
  };
  const type = byStatus[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
  return { type: "error", error: { type, message } };
}

/** 本地构造的 Anthropic 错误（如 responses 模型不支持的清晰 400）。 */
export function anthropicError(type: string, message: string): Record<string, unknown> {
  return { type: "error", error: { type, message } };
}

/** 本地 count_tokens 近似响应（openai/google 家族模型经 /v1/messages/count_tokens）。 */
export function countTokensResponse(body: unknown): Record<string, unknown> {
  return { input_tokens: approximateInputTokens(body) };
}

/* ------------------------------------------------------------------ */
/* SSE 翻译：OpenAI chat 流 → Anthropic 事件流                          */
/* ------------------------------------------------------------------ */

interface StreamingToolCall {
  key: string;
  id: string;
  name: string;
  args: string;
  /** OpenAI 流式 tool_calls[].index；缺失为 null */
  idx: number | null;
  /** 首次出现序号，用于缺 index 时的稳定排序 */
  seq: number;
}

class SseTranslator {
  private buffer = "";
  private pending: string | null = null;
  private started = false;
  private finished = false;
  private openIndex = -1;
  private openKind: "text" | null = null;
  private nextBlock = 0;
  /** 工具调用先缓冲、finish 时按顺序整块下发：任意交错 index 均不丢参数。 */
  private readonly toolCalls: StreamingToolCall[] = [];
  private readonly toolCallByKey = new Map<string, StreamingToolCall>();
  private toolSeq = 0;
  private outChars = 0;
  private readonly dec = new TextDecoder();
  private readonly enc = new TextEncoder();

  constructor(
    private readonly model: string,
    private readonly inputTokens: number,
  ) {}

  private ev(type: string, data: unknown): Uint8Array {
    return this.enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private ensureStart(): Uint8Array[] {
    if (this.started) return [];
    this.started = true;
    return [
      this.ev("message_start", {
        type: "message_start",
        message: {
          id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      }),
    ];
  }

  private closeOpen(): Uint8Array[] {
    if (this.openIndex < 0) return [];
    const out = [this.ev("content_block_stop", { type: "content_block_stop", index: this.openIndex })];
    this.openIndex = -1;
    this.openKind = null;
    return out;
  }

  private finish(rawFinishReason: unknown): Uint8Array[] {
    if (this.finished) return [];
    this.finished = true;
    const out = [...this.ensureStart(), ...this.closeOpen()];
    const ordered = [...this.toolCalls].sort((a, b) => {
      if (a.idx !== null && b.idx !== null) return a.idx - b.idx;
      if (a.idx !== null) return -1;
      if (b.idx !== null) return 1;
      return a.seq - b.seq;
    });
    for (const call of ordered) {
      const index = this.nextBlock++;
      out.push(
        this.ev("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        }),
      );
      if (call.args) {
        out.push(
          this.ev("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: call.args },
          }),
        );
      }
      out.push(this.ev("content_block_stop", { type: "content_block_stop", index }));
    }
    out.push(
      this.ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: effectiveStopReason(rawFinishReason, ordered.length > 0), stop_sequence: null },
        usage: { output_tokens: Math.max(1, Math.round(this.outChars / 4)) },
      }),
    );
    out.push(this.ev("message_stop", { type: "message_stop" }));
    return out;
  }

  private handleJson(j: unknown): Uint8Array[] {
    if (this.finished) return [];
    const out = this.ensureStart();
    const root = (j ?? {}) as Record<string, unknown>;

    // 上游在 HTTP 200 流中发送 error 帧：转 Anthropic error 事件，不再补成功 stop
    if (root.error) {
      const err = (root.error ?? {}) as Record<string, unknown>;
      const rawType = String(err.type ?? "api_error");
      const type = rawType.includes("rate_limit")
        ? "rate_limit_error"
        : rawType.includes("invalid_request")
          ? "invalid_request_error"
          : "api_error";
      this.finished = true;
      out.push(...this.closeOpen());
      out.push(
        this.ev("error", {
          type: "error",
          error: { type, message: String(err.message ?? "upstream stream error") },
        }),
      );
      return out;
    }

    const choice = (root.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) return out; // usage-only 尾块等
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (this.openKind !== "text") {
        out.push(...this.closeOpen());
        this.openIndex = this.nextBlock++;
        this.openKind = "text";
        out.push(
          this.ev("content_block_start", {
            type: "content_block_start",
            index: this.openIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      this.outChars += delta.content.length;
      out.push(
        this.ev("content_block_delta", {
          type: "content_block_delta",
          index: this.openIndex,
          delta: { type: "text_delta", text: delta.content },
        }),
      );
    }

    // 工具调用参数先缓冲（允许任意 index 交错/缺失），finish 时整块顺序下发
    const tcs = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
    for (const tc of tcs) {
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      const rawIdx = tc.index;
      const id = typeof tc.id === "string" ? tc.id : "";
      let key: string;
      if (rawIdx !== undefined && rawIdx !== null) key = `i:${Number(rawIdx)}`;
      else if (id) key = `id:${id}`;
      else if (typeof fn.name === "string" && fn.name) key = `n:${this.toolCalls.length}`;
      else key = this.toolCalls.length === 0 ? "single" : this.toolCalls[this.toolCalls.length - 1]!.key;

      // 别名合并：同一调用在部分帧缺 index（或缺 id）时，用另一侧别名命中同一条记录，
      // 避免同一个 tool call 被拆成两个 tool_use 块、参数被割裂。
      // 前提：上游 tool_call id 全局唯一（OpenAI 协议如此）；若上游对不同调用复用同一 id，
      // 会被合并为一块且参数串接——这是协议层的歧义，翻译层无法区分。
      let call = this.toolCallByKey.get(key);
      if (!call && id) call = this.toolCallByKey.get(`id:${id}`);
      if (!call && id === "" && rawIdx !== undefined && rawIdx !== null) {
        // 只有 index 的帧：若当前仅存在一个「缺 index」的调用，且函数名不冲突，则并入它
        // （多候选或名字不一致时不合并，避免把不同调用错并到一起）
        const cands = this.toolCalls.filter((c) => c.idx === null);
        const fname = typeof fn.name === "string" ? fn.name : "";
        if (cands.length === 1) {
          const c0 = cands[0]!;
          if (fname === "" || c0.name === "" || c0.name === fname) call = c0;
        }
      }

      if (!call) {
        call = {
          key,
          id: id || `toolu_${Math.random().toString(36).slice(2, 10)}`,
          name: typeof fn.name === "string" ? fn.name : "",
          args: "",
          idx: rawIdx !== undefined && rawIdx !== null ? Number(rawIdx) : null,
          seq: this.toolSeq++,
        };
        this.toolCalls.push(call);
      }
      // 登记全部别名：后续帧无论带 index 还是带 id，都能命中同一条记录
      this.toolCallByKey.set(key, call);
      if (id) this.toolCallByKey.set(`id:${id}`, call);
      if (rawIdx !== undefined && rawIdx !== null) this.toolCallByKey.set(`i:${Number(rawIdx)}`, call);

      if (id && call.id.startsWith("toolu_")) call.id = id;
      if (typeof fn.name === "string" && fn.name) call.name = fn.name;
      if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
        call.args += fn.arguments;
        this.outChars += fn.arguments.length;
      }
    }

    if (choice.finish_reason) out.push(...this.finish(choice.finish_reason));
    return out;
  }

  /** 增量喂入上游字节，返回需要下发给客户端的事件字节序列。 */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer += this.dec.decode(chunk, { stream: true });
    const out: Uint8Array[] = [];
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (line.startsWith("data:")) {
        const v = line.slice(5).trimStart();
        if (v === "[DONE]") {
          out.push(...this.finish(undefined));
          this.pending = null;
        } else {
          let parsed: unknown;
          let ok = false;
          try {
            parsed = JSON.parse(v);
            ok = true;
          } catch {
            ok = false;
          }
          if (ok) {
            this.pending = null;
            out.push(...this.handleJson(parsed));
          } else {
            this.pending = this.pending ? `${this.pending}\n${v}` : v; // 多行 data 兜底
          }
        }
      } else if (line === "" && this.pending !== null) {
        const joined = this.pending;
        this.pending = null;
        try {
          out.push(...this.handleJson(JSON.parse(joined)));
        } catch {
          /* 无法解析的尾部数据：丢弃 */
        }
      }
      // event: / id: / retry: / 注释行忽略
    }
    return out;
  }

  /** 上游流结束（或异常）时的兜底：处理无尾换行的残留帧、补齐 message_stop。 */
  flush(): Uint8Array[] {
    const out: Uint8Array[] = [];
    this.buffer += this.dec.decode(); // 冲刷解码器，避免多字节字符尾部丢失
    if (this.pending !== null) {
      const joined = this.pending;
      this.pending = null;
      if (joined === "[DONE]") {
        out.push(...this.finish(undefined));
        return out;
      }
      try {
        out.push(...this.handleJson(JSON.parse(joined)));
      } catch {
        /* 丢弃 */
      }
    }
    if (this.buffer.length > 0) {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      if (line.startsWith("data:")) {
        const v = line.slice(5).trimStart();
        if (v === "[DONE]") {
          out.push(...this.finish(undefined));
          return out;
        }
        try {
          out.push(...this.handleJson(JSON.parse(v)));
        } catch {
          /* 丢弃 */
        }
      }
    }
    out.push(...this.finish(undefined));
    return out;
  }
}

/** 把 OpenAI chat SSE 流转成 Anthropic SSE 流（供 proxy 首块预读后包装使用）。 */
export function chatSseToAnthropicStream(
  source: ReadableStream<Uint8Array>,
  opts: { model: string; inputTokens?: number },
): ReadableStream<Uint8Array> {
  const tr = new SseTranslator(opts.model, opts.inputTokens ?? 0);
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            for (const b of tr.flush()) controller.enqueue(b);
            controller.close();
            return;
          }
          if (!value || value.byteLength === 0) continue;
          const out = tr.push(value);
          if (out.length === 0) continue; // 半行/半 JSON：继续读，保证每次 pull 都有产出或关闭
          for (const b of out) controller.enqueue(b);
          return;
        }
      } catch (e) {
        try {
          for (const b of tr.flush()) controller.enqueue(b);
        } catch {
          /* ignore */
        }
        controller.error(e);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}
