/**
 * Token usage extraction for OpenAI / Anthropic / Responses / Google / Ollama.
 *
 * 统一口径：
 * - input：未命中缓存的输入 token（OpenAI 的 prompt_tokens 含 cached，需扣掉）
 * - cacheRead：命中缓存的输入 token
 * - cacheWrite：写入缓存的输入 token（Anthropic）
 * - output：输出 token
 * - total = input + cacheRead + cacheWrite + output
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** 流式翻译路径的 usage 是本地估算值，不是上游原始 usage。 */
  estimated?: boolean;
  /** Whether the source actually reported a cache-read count. */
  cacheReadKnown?: boolean;
  inputKnown?: boolean;
  outputKnown?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

function firstNum(...values: unknown[]): number | null {
  for (const v of values) {
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}

function pickUsage(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value);
  if (!root) return null;
  // Anthropic message_start: { type, message: { usage } }
  const message = asRecord(root.message);
  if (message?.usage) return asRecord(message.usage);
  // Responses SSE: { type:"response.completed", response:{ usage } }
  const response = asRecord(root.response);
  if (response?.usage) return asRecord(response.usage);
  if (root.usageMetadata) return asRecord(root.usageMetadata);
  if (root.usage) return asRecord(root.usage);
  // Ollama 原生字段
  if (root.prompt_eval_count != null || root.eval_count != null) return root;
  return null;
}

export function parseTokenUsage(value: unknown): TokenUsage | null {
  const usage = pickUsage(value);
  if (!usage) return null;

  const root = asRecord(value) ?? {};
  const details = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details) ?? {};
  const anthropicStyle =
    usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null;

  const rawInput = firstNum(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.promptTokenCount,
    usage.prompt_eval_count,
    root.prompt_eval_count,
  );
  const rawOutput = firstNum(
    usage.output_tokens,
    usage.completion_tokens,
    usage.candidatesTokenCount,
    usage.eval_count,
    root.eval_count,
  );
  const reportedCacheRead = firstNum(
    usage.cache_read_input_tokens,
    usage.cached_tokens,
    details.cached_tokens,
    usage.cachedContentTokenCount,
  );
  const cacheRead = reportedCacheRead ?? 0;
  const cacheWrite = firstNum(usage.cache_creation_input_tokens, usage.cache_write_tokens) ?? 0;
  const reportedTotal = firstNum(usage.total_tokens, usage.totalTokenCount);

  if (rawInput == null && rawOutput == null && reportedTotal == null) return null;
  const output = rawOutput ?? Math.max(0, (reportedTotal ?? 0) - (rawInput ?? 0) - cacheRead - cacheWrite);
  // OpenAI/Google/Responses 的 input 含 cached；Anthropic 的 input 不含 cached。
  const input = anthropicStyle
    ? (rawInput ?? 0)
    : Math.max(0, (rawInput ?? Math.max(0, (reportedTotal ?? 0) - output)) - cacheRead);
  const total = input + cacheRead + cacheWrite + output;
  if (total <= 0 && rawInput == null && rawOutput == null) return null;
  return { input, output, cacheRead, cacheWrite, total, estimated: false, cacheReadKnown: reportedCacheRead != null,
    inputKnown: rawInput != null || (reportedTotal != null && rawOutput != null),
    outputKnown: rawOutput != null || (reportedTotal != null && rawInput != null) };
}

export function mergeTokenUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  const input = Math.max(a.input, b.input);
  const output = Math.max(a.output, b.output);
  const cacheRead = Math.max(a.cacheRead, b.cacheRead);
  const cacheWrite = Math.max(a.cacheWrite, b.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + cacheRead + cacheWrite + output,
    estimated: Boolean(a.estimated || b.estimated),
    cacheReadKnown: Boolean(a.cacheReadKnown || b.cacheReadKnown),
    inputKnown: Boolean(a.inputKnown || b.inputKnown),
    outputKnown: Boolean(a.outputKnown || b.outputKnown),
  };
}

function parseSseLine(line: string): TokenUsage | null {
  const t = line.trim();
  if (!t.startsWith("data:")) return null;
  const data = t.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return parseTokenUsage(JSON.parse(data));
  } catch {
    return null;
  }
}

/**
 * 透明 tap：原样转发字节，同时解析 SSE usage / 非流式 JSON usage。
 * onDone 在流结束（或取消）时调用一次；没有 usage 时不调用。
 */
export function hasGeneratedContent(event: any): boolean {
  const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;
  const delta = event?.delta;
  if (["text_delta", "thinking_delta", "input_json_delta"].includes(delta?.type)) {
    return nonempty(delta.text) || nonempty(delta.thinking) || nonempty(delta.partial_json);
  }
  if (typeof event?.type === "string" && /(?:output_text|reasoning_summary_text|function_call_arguments)\.delta$/.test(event.type)) return nonempty(delta);
  return Array.isArray(event?.choices) && event.choices.some((c: any) =>
    nonempty(c.delta?.content) || nonempty(c.delta?.reasoning_content) ||
    c.delta?.tool_calls?.some((t: any) => nonempty(t.function?.arguments))) ||
    Array.isArray(event?.candidates) && event.candidates.some((c: any) => c.content?.parts?.some((p: any) => nonempty(p.text) || p.functionCall)) ||
    event?.done === false && (nonempty(event.message?.content) || nonempty(event.message?.thinking) || nonempty(event.response));
}

export function tapUsageStream(
  source: ReadableStream<Uint8Array>,
  onDone: (usage: TokenUsage) => void,
  estimated = false,
  onComplete?: () => void,
  onContentTiming?: (first: number, last: number) => void,
  onStreamError?: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const reader = source.getReader();
  let buffer = "";
  let raw = "";
  let usage: TokenUsage | null = null;
  let finished = false;
  let firstContent: number | null = null;
  let lastContent: number | null = null;

  const feed = (line: string): void => {
    const u = parseSseLine(line);
    if (u) usage = mergeTokenUsage(usage, u);
    if (line.trimStart().startsWith("data:")) {
      try {
        const event = JSON.parse(line.trimStart().slice(5));
        if (event?.type === "error" || event?.error) onStreamError?.();
        if (hasGeneratedContent(event)) {
          const now = Date.now();
          firstContent ??= now;
          lastContent = now;
        }
      } catch { /* metadata, DONE, or malformed event */ }
    }
  };

  const flush = (): void => {
    if (finished) return;
    finished = true;
    if (buffer) feed(buffer);
    if (!usage && raw.trim().startsWith("{")) {
      try {
        usage = parseTokenUsage(JSON.parse(raw));
      } catch {
        /* not JSON */
      }
    }
    if (usage) {
      if (estimated) usage.estimated = true;
      onDone(usage);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          flush();
          if (firstContent != null && lastContent != null) onContentTiming?.(firstContent, lastContent);
          onComplete?.();
          controller.close();
          return;
        }
        if (!value || value.byteLength === 0) return;
        controller.enqueue(value);
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        if (raw.length < 2_000_000) raw += text;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          feed(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      } catch (e) {
        flush();
        controller.error(e);
      }
    },
    cancel(reason) {
      flush();
      void reader.cancel(reason).catch(() => {});
    },
  });
}
