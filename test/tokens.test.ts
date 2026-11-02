import { describe, expect, test } from "bun:test";
import { mergeTokenUsage, parseTokenUsage, tapUsageStream } from "../src/tokens";

describe("token usage parsing", () => {
  test("OpenAI：prompt 含 cached，input 扣掉 cached", () => {
    const u = parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    });
    expect(u).toMatchObject({ input: 20, output: 10, cacheRead: 80, cacheWrite: 0, total: 110 });
  });

  test("Anthropic：input 不含 cached，total 加上 cache", () => {
    const u = parseTokenUsage({
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 5,
      },
    });
    expect(u).toMatchObject({ input: 20, output: 10, cacheRead: 80, cacheWrite: 5, total: 115 });
  });

  test("Responses：input_tokens_details.cached_tokens", () => {
    const u = parseTokenUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 80 },
      },
    });
    expect(u).toMatchObject({ input: 20, output: 10, cacheRead: 80, total: 110 });
  });

  test("Google usageMetadata", () => {
    const u = parseTokenUsage({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        cachedContentTokenCount: 80,
      },
    });
    expect(u).toMatchObject({ input: 20, output: 10, cacheRead: 80, total: 110 });
  });

  test("Ollama 原生字段", () => {
    const u = parseTokenUsage({ prompt_eval_count: 12, eval_count: 3 });
    expect(u).toMatchObject({ input: 12, output: 3, total: 15 });
  });

  test("没有 usage 返回 null，不伪造", () => {
    expect(parseTokenUsage({ choices: [] })).toBeNull();
    expect(parseTokenUsage(null)).toBeNull();
  });

  test("merge 取各字段最大值并重算 total", () => {
    const a = parseTokenUsage({ usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 80 } });
    const b = parseTokenUsage({ usage: { output_tokens: 10 } });
    expect(mergeTokenUsage(a, b)).toMatchObject({ input: 20, output: 10, cacheRead: 80, total: 110 });
  });

  test("SSE tap 原样转发并解析 Anthropic message_start/message_delta", async () => {
    const input = new TextEncoder().encode(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":0,"cache_read_input_tokens":80}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":10}}\n\n',
    );
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      },
    });
    let got: unknown = null;
    const tapped = tapUsageStream(source, (u) => {
      got = u;
    });
    const text = await new Response(tapped).text();
    expect(text).toBe(new TextDecoder().decode(input));
    expect(got).toMatchObject({ input: 20, output: 10, cacheRead: 80, total: 110 });
  });
});
