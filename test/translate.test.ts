import { describe, expect, test } from "bun:test";
import {
  anthropicError,
  approximateInputTokens,
  chatSseToAnthropicStream,
  countTokensResponse,
  mapFinishReason,
  translateAnthropicRequest,
  translateChatCompletion,
  translateOpenAiError,
} from "../src/translate";

type AnyRec = Record<string, any>;

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  return out;
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function parseEvents(text: string): Array<{ event: string; data: AnyRec }> {
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.split("\n");
      const event = (lines.find((l) => l.startsWith("event: ")) ?? "event: ?").slice(7);
      const dataLine = lines.find((l) => l.startsWith("data: ")) ?? "data: {}";
      return { event, data: JSON.parse(dataLine.slice(6)) as AnyRec };
    });
}

function openAiStream(frames: AnyRec[]): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
}

describe("translateAnthropicRequest", () => {
  test("system + 字符串消息 + 参数映射（丢弃 Anthropic 专属字段）", () => {
    const tr = translateAnthropicRequest(
      {
        model: "ignored",
        system: "SYS",
        max_tokens: 128,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 5,
        stop_sequences: ["END"],
        metadata: { user_id: "u" },
        thinking: { type: "enabled" },
        context_management: { edits: [] },
        output_config: { effort: "max" },
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
      "glm-5.1",
    );
    const b = tr.body as AnyRec;
    expect(b.model).toBe("glm-5.1");
    expect(b.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ]);
    expect(b.max_tokens).toBe(128);
    expect(b.temperature).toBe(0.2);
    expect(b.top_p).toBe(0.9);
    expect(b.stop).toEqual(["END"]);
    expect(b.stream).toBe(true);
    expect(b.top_k).toBeUndefined();
    expect(b.metadata).toBeUndefined();
    expect(b.thinking).toBeUndefined();
    expect(b.context_management).toBeUndefined();
    expect(b.output_config).toBeUndefined();
    expect(tr.stream).toBe(true);
    expect(tr.approxInputTokens).toBeGreaterThan(0);
  });

  test("system blocks 拼接；缺省 max_tokens=4096", () => {
    const tr = translateAnthropicRequest(
      {
        system: [{ type: "text", text: "A" }, { type: "image" }, { type: "text", text: "B" }],
        messages: [{ role: "user", content: [] }],
      },
      "m",
    );
    const b = tr.body as AnyRec;
    expect(b.messages[0]).toEqual({ role: "system", content: "A\n\nB" });
    expect(b.max_tokens).toBe(4096);
    expect(b.stream).toBe(false);
  });

  test("messages 内嵌 role:system（mid-conversation system）→ system 消息", () => {
    const tr = translateAnthropicRequest(
      {
        messages: [
          { role: "user", content: "q" },
          { role: "system", content: [{ type: "text", text: "REMIND" }] },
        ],
      },
      "m",
    );
    expect((tr.body as AnyRec).messages).toEqual([
      { role: "user", content: "q" },
      { role: "system", content: "REMIND" },
    ]);
  });

  test("assistant tool_use → tool_calls；user tool_result → tool 消息（先于用户文本）", () => {
    const tr = translateAnthropicRequest(
      {
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "call" },
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "ls" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "ok" }] },
              { type: "text", text: "done" },
            ],
          },
        ],
      },
      "m",
    );
    const msgs = (tr.body as AnyRec).messages;
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: "call",
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Bash", arguments: '{"cmd":"ls"}' } }],
    });
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "ok" });
    expect(msgs[3]).toEqual({ role: "user", content: "done" });
  });

  test("tool_result 内 image 保留为后续 user image_url；null → 空字符串", () => {
    const tr = translateAnthropicRequest(
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  { type: "text", text: "image:" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
                ],
              },
              { type: "text", text: "see above" },
            ],
          },
          { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "F", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: null }] },
        ],
      },
      "m",
    );
    const msgs = (tr.body as AnyRec).messages;
    expect(msgs[0].tool_calls[0].id).toBe("t1");
    expect(msgs[1]).toEqual({ role: "tool", tool_call_id: "t1", content: "image:" });
    expect(msgs[2].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      { type: "text", text: "see above" },
    ]);
    expect(msgs[4]).toEqual({ role: "tool", tool_call_id: "t2", content: "" });
  });

  test("纯 tool_use 的 assistant 消息 content=null", () => {    const tr = translateAnthropicRequest(
      { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "F", input: {} }] }] },
      "m",
    );
    const m = (tr.body as AnyRec).messages[0];
    expect(m.content).toBeNull();
    expect(m.tool_calls[0].function.arguments).toBe("{}");
  });

  test("image base64 / url → image_url parts", () => {
    const tr = translateAnthropicRequest(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } },
              { type: "image", source: { type: "url", url: "https://x/y.png" } },
            ],
          },
        ],
      },
      "m",
    );
    const content = (tr.body as AnyRec).messages[0].content as AnyRec[];
    expect(content[0]).toEqual({ type: "text", text: "look" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } });
    expect(content[2]).toEqual({ type: "image_url", image_url: { url: "https://x/y.png" } });
  });

  test("tools 与 tool_choice 四态", () => {
    const tools = [{ name: "Bash", description: "run", input_schema: { type: "object" } }];
    const base = { messages: [{ role: "user", content: "x" }], tools };
    const expectTc = (choice: unknown, expected: unknown): void => {
      const tr = translateAnthropicRequest({ ...base, tool_choice: choice }, "m");
      expect((tr.body as AnyRec).tool_choice).toEqual(expected);
    };
    expect((translateAnthropicRequest(base, "m").body as AnyRec).tools).toEqual([
      { type: "function", function: { name: "Bash", description: "run", parameters: { type: "object" } } },
    ]);
    expectTc({ type: "auto" }, "auto");
    expectTc({ type: "any" }, "required");
    expectTc({ type: "none" }, "none");
    expectTc({ type: "tool", name: "Bash" }, { type: "function", function: { name: "Bash" } });
  });

  test("缺 input_schema / 服务端工具被丢弃", () => {
    const tr = translateAnthropicRequest(
      { messages: [], tools: [{ name: "NoSchema" }, { type: "web_search_20250305", name: "web_search" }] },
      "m",
    );
    expect((tr.body as AnyRec).tools).toBeUndefined();
  });
});

describe("translateChatCompletion", () => {
  test("文本 + usage + finish stop", () => {
    const m = translateChatCompletion(
      {
        id: "chatcmpl-1",
        choices: [{ message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      },
      "glm-5.1",
    );
    expect(m).toMatchObject({
      id: "chatcmpl-1",
      type: "message",
      role: "assistant",
      model: "glm-5.1",
      content: [{ type: "text", text: "你好" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });

  test("tool_calls → tool_use（arguments 解析与容错）", () => {
    const m = translateChatCompletion(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "Bash", arguments: '{"cmd":"ls"}' } },
                { id: "call_2", type: "function", function: { name: "Read", arguments: "{not-json" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
      "m",
    );
    expect(m.stop_reason).toBe("tool_use");
    const content = m.content as AnyRec[];
    expect(content[0]).toEqual({ type: "tool_use", id: "call_1", name: "Bash", input: { cmd: "ls" } });
    expect(content[1]).toEqual({ type: "tool_use", id: "call_2", name: "Read", input: {} });
  });

  test("有 tool_use 时 stop/缺省结束原因修正为 tool_use；length/content_filter 保持语义", () => {
    const message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "A", arguments: "{}" } }],
    };
    for (const fr of ["stop", null, undefined]) {
      expect(translateChatCompletion({ choices: [{ message, finish_reason: fr }] }, "m").stop_reason).toBe("tool_use");
    }
    expect(
      translateChatCompletion({ choices: [{ message, finish_reason: "content_filter" }] }, "m").stop_reason,
    ).toBe("end_turn");
    expect(translateChatCompletion({ choices: [{ message, finish_reason: "length" }] }, "m").stop_reason).toBe(
      "max_tokens",
    );
  });

  test("finish length → max_tokens；空响应兜底", () => {
    expect(translateChatCompletion({ choices: [{ message: {}, finish_reason: "length" }] }, "m").stop_reason).toBe(
      "max_tokens",
    );
    const empty = translateChatCompletion({}, "m");
    expect(empty.content).toEqual([]);
    expect(empty.stop_reason).toBe("end_turn");
    expect(empty.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("mapFinishReason", () => {
  test("映射表与未知兜底", () => {
    expect(mapFinishReason("stop")).toBe("end_turn");
    expect(mapFinishReason("length")).toBe("max_tokens");
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
    expect(mapFinishReason("function_call")).toBe("tool_use");
    expect(mapFinishReason("content_filter")).toBe("end_turn");
    expect(mapFinishReason(null)).toBe("end_turn");
  });
});

describe("错误与本地响应", () => {
  test("translateOpenAiError 状态码映射与 message 提取", () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_request_error"],
      [401, "authentication_error"],
      [403, "permission_error"],
      [404, "not_found_error"],
      [413, "request_too_large"],
      [429, "rate_limit_error"],
      [500, "api_error"],
      [418, "invalid_request_error"],
    ];
    for (const [status, type] of cases) {
      const e = translateOpenAiError(status, JSON.stringify({ error: { message: `boom-${status}` } }));
      expect(e).toEqual({ type: "error", error: { type, message: `boom-${status}` } });
    }
  });

  test("非 JSON 文本保留摘要；空文本兜底", () => {
    const e = translateOpenAiError(502, "bad gateway") as AnyRec;
    expect(e.error.type).toBe("api_error");
    expect(e.error.message).toBe("bad gateway");
    const e2 = translateOpenAiError(500, "") as AnyRec;
    expect(e2.error.message).toBe("upstream HTTP 500");
  });

  test("anthropicError envelope", () => {
    expect(anthropicError("invalid_request_error", "x")).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "x" },
    });
  });

  test("countTokensResponse / approximateInputTokens", () => {
    const r = countTokensResponse({ messages: [{ role: "user", content: "hello" }] }) as AnyRec;
    expect(r.input_tokens).toBeGreaterThan(0);
    expect(approximateInputTokens({})).toBeGreaterThanOrEqual(1);
    expect(approximateInputTokens(undefined)).toBeGreaterThanOrEqual(1);
  });

  test("token estimate excludes encoded image data, not ordinary text", () => {
    const data = "YWJj".repeat(1_000_000);
    const anthropic = { messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ] }] };
    const openai = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
    ] }] };
    expect(approximateInputTokens(anthropic)).toBeLessThan(1000);
    expect(approximateInputTokens(openai)).toBeLessThan(1000);
    expect(approximateInputTokens({ messages: [{ role: "user", content: data }] })).toBeGreaterThan(900_000);
  });

  test("approximateInputTokens 按 UTF-8 字节估算（中文不低估）", () => {
    const body = { x: "中文" };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    expect(approximateInputTokens(body)).toBe(Math.max(1, Math.ceil(bytes / 4)));
    // JSON.stringify("中") = "中"（5 UTF-8 字节；按字符数是 3）
    expect(approximateInputTokens("中")).toBe(2);
  });
});

describe("chatSseToAnthropicStream", () => {
  test("文本流：任意切块（含半行/半 JSON）→ 完整事件序列", async () => {
    const frames = [
      { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
      { id: "c1", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
      { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const raw = openAiStream(frames) + "data: [DONE]\n\n";
    const chunks = [raw.slice(0, 17), raw.slice(17, 43), raw.slice(43, 101), raw.slice(101)];
    const out = await collect(
      chatSseToAnthropicStream(streamOf(chunks), { model: "glm-5.1", inputTokens: 9 }),
    );
    const evs = parseEvents(out);
    expect(evs[0]!.event).toBe("message_start");
    expect(evs[0]!.data.message.usage).toEqual({ input_tokens: 9, output_tokens: 0 });
    expect(
      evs
        .filter((e) => e.event === "content_block_delta")
        .map((e) => e.data.delta.text)
        .join(""),
    ).toBe("Hello world");
    expect(evs.at(-1)!.event).toBe("message_stop");
    const md = evs.find((e) => e.event === "message_delta")!;
    expect(md.data.delta.stop_reason).toBe("end_turn");
    expect(md.data.usage.output_tokens).toBeGreaterThan(0);
  });

  test("工具调用流：tool_use + input_json_delta 分片", async () => {
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: '{"cmd":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const out = await collect(
      chatSseToAnthropicStream(streamOf([openAiStream(frames) + "data: [DONE]\n\n"]), { model: "m" }),
    );
    const evs = parseEvents(out);
    const start = evs.find(
      (e) => e.event === "content_block_start" && e.data.content_block.type === "tool_use",
    )!;
    expect(start.data.content_block).toMatchObject({
      type: "tool_use",
      id: "call_1",
      name: "Bash",
      input: {},
    });
    const partials = evs
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(partials).toBe('{"cmd":"ls"}');
    expect(evs.find((e) => e.event === "message_delta")!.data.delta.stop_reason).toBe("tool_use");
    expect(evs.filter((e) => e.event === "content_block_stop").length).toBe(1);
  });

  test("usage-only 尾块被忽略；无 finish_reason 时 flush 兜底 end_turn", async () => {
    const frames = [
      { choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    const out = await collect(chatSseToAnthropicStream(streamOf([openAiStream(frames)]), { model: "m" }));
    const evs = parseEvents(out);
    expect(
      evs
        .filter((e) => e.event === "content_block_delta")
        .map((e) => e.data.delta.text)
        .join(""),
    ).toBe("x");
    expect(evs.at(-1)!.event).toBe("message_stop");
    expect(evs.find((e) => e.event === "message_delta")!.data.delta.stop_reason).toBe("end_turn");
  });

  test("空流：仍产出 message_start/delta/stop", async () => {
    const out = await collect(chatSseToAnthropicStream(streamOf([]), { model: "m" }));
    const evs = parseEvents(out);
    expect(evs.map((e) => e.event)).toEqual(["message_start", "message_delta", "message_stop"]);
  });

  test("EOF 无尾换行：最后一帧（含 finish_reason）不丢", async () => {
    const raw = openAiStream([
      { choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "B" }, finish_reason: "length" }] },
    ]).replace(/\n\n$/, ""); // 去掉最后一帧尾换行
    const evs = parseEvents(await collect(chatSseToAnthropicStream(streamOf([raw]), { model: "m" })));
    expect(
      evs
        .filter((e) => e.event === "content_block_delta")
        .map((e) => e.data.delta.text)
        .join(""),
    ).toBe("AB");
    expect(evs.find((e) => e.event === "message_delta")!.data.delta.stop_reason).toBe("max_tokens");
  });

  test("EOF 无尾换行的 [DONE] 也能收尾", async () => {
    const raw =
      openAiStream([{ choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }]) + "data: [DONE]";
    const evs = parseEvents(await collect(chatSseToAnthropicStream(streamOf([raw]), { model: "m" })));
    expect(
      evs
        .filter((e) => e.event === "content_block_delta")
        .map((e) => e.data.delta.text)
        .join(""),
    ).toBe("x");
    expect(evs.at(-1)!.event).toBe("message_stop");
  });

  test("流内 error 帧 → Anthropic error 事件，不伪装成功结束", async () => {
    const frames = [
      { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
      { error: { type: "rate_limit_error", message: "quota exceeded" } },
    ];
    const evs = parseEvents(
      await collect(
        chatSseToAnthropicStream(streamOf([openAiStream(frames) + "data: [DONE]\n\n"]), { model: "m" }),
      ),
    );
    const err = evs.find((e) => e.event === "error")!;
    expect(err.data).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "quota exceeded" },
    });
    expect(evs.some((e) => e.event === "message_delta")).toBe(false);
    expect(evs.some((e) => e.event === "message_stop")).toBe(false);
    expect(
      evs
        .filter((e) => e.event === "content_block_delta")
        .map((e) => e.data.delta.text)
        .join(""),
    ).toBe("partial");
  });

  test("工具调用 index 交错：参数不丢、按各 index 完整下发", async () => {
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "A", arguments: '{"x":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "B", arguments: '{"y":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: null },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "2}" } }] }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const evs = parseEvents(
      await collect(chatSseToAnthropicStream(streamOf([openAiStream(frames) + "data: [DONE]\n\n"]), { model: "m" })),
    );
    const starts = evs.filter((e) => e.event === "content_block_start");
    expect(starts.map((e) => e.data.content_block.name)).toEqual(["A", "B"]);
    const argsByIdx = new Map<number, string>();
    for (const e of evs) {
      if (e.event === "content_block_delta" && e.data.delta.type === "input_json_delta") {
        argsByIdx.set(e.data.index, (argsByIdx.get(e.data.index) ?? "") + e.data.delta.partial_json);
      }
    }
    expect(argsByIdx.get(starts[0]!.data.index)).toBe('{"x":1}');
    expect(argsByIdx.get(starts[1]!.data.index)).toBe('{"y":2}');
  });

  test("缺少 index 的多个工具调用按 id/name 分块，不合并参数", async () => {
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: "c1", type: "function", function: { name: "A", arguments: '{"x":1}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: "c2", type: "function", function: { name: "B", arguments: '{"y":2}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const evs = parseEvents(
      await collect(chatSseToAnthropicStream(streamOf([openAiStream(frames) + "data: [DONE]\n\n"]), { model: "m" })),
    );
    const starts = evs.filter((e) => e.event === "content_block_start");
    expect(starts.map((e) => e.data.content_block.id)).toEqual(["c1", "c2"]);
    const argsByIdx = new Map<number, string>();
    for (const e of evs) {
      if (e.event === "content_block_delta" && e.data.delta.type === "input_json_delta") {
        argsByIdx.set(e.data.index, (argsByIdx.get(e.data.index) ?? "") + e.data.delta.partial_json);
      }
    }
    expect(argsByIdx.get(starts[0]!.data.index)).toBe('{"x":1}');
    expect(argsByIdx.get(starts[1]!.data.index)).toBe('{"y":2}');
  });

  test("工具调用但上游以 stop/缺省/[DONE]/EOF 结束 → tool_use，且只收尾一次", async () => {
    const toolFrame = (finish: string | null): AnyRec => ({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "A", arguments: "{}" } }],
          },
          finish_reason: finish,
        },
      ],
    });
    const cases: string[] = [
      openAiStream([toolFrame("stop")]),
      openAiStream([toolFrame(null)]) + "data: [DONE]\n\n",
      openAiStream([toolFrame(null)]), // EOF 无 finish_reason
    ];
    for (const raw of cases) {
      const evs = parseEvents(await collect(chatSseToAnthropicStream(streamOf([raw]), { model: "m" })));
      const md = evs.filter((e) => e.event === "message_delta");
      expect(md).toHaveLength(1);
      expect(md[0]!.data.delta.stop_reason).toBe("tool_use");
      expect(evs.filter((e) => e.event === "message_stop")).toHaveLength(1);
      expect(
        evs.filter((e) => e.event === "content_block_start" && e.data.content_block.type === "tool_use"),
      ).toHaveLength(1);
    }
  });

  test("工具调用 index 1 先于 0 到达：按 numeric index 排序下发", async () => {
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "B", arguments: "{}" } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "A", arguments: "{}" } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const evs = parseEvents(
      await collect(chatSseToAnthropicStream(streamOf([openAiStream(frames)]), { model: "m" })),
    );
    const names = evs
      .filter((e) => e.event === "content_block_start")
      .map((e) => e.data.content_block.name);
    expect(names).toEqual(["A", "B"]);
  });

  test("混合 index/id 流合并为单个 tool_use 块（1→0 交错参数完整）", async () => {
    // 同一 id 的调用在后续帧把 index 从 1 改成 0：必须合并为一块，参数完整拼接
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, id: "call_x", type: "function", function: { name: "X", arguments: '{"a":' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { arguments: "1}" } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const evs = parseEvents(
      await collect(chatSseToAnthropicStream(streamOf([openAiStream(frames) + "data: [DONE]\n\n"]), { model: "m" })),
    );
    const starts = evs.filter((e) => e.event === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.data.content_block).toMatchObject({ type: "tool_use", id: "call_x", name: "X" });
    const args = evs
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(args).toBe('{"a":1}');
  });

  test("混合 index/id 流：首帧只有 id、次帧只有 index → 仍合并为一块", async () => {
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: "call_y", type: "function", function: { name: "Y", arguments: '{"b":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, type: "function", function: { arguments: "2}" } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const evs = parseEvents(
      await collect(chatSseToAnthropicStream(streamOf([openAiStream(frames)]), { model: "m" })),
    );
    const starts = evs.filter((e) => e.event === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.data.content_block.id).toBe("call_y");
    const args = evs
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(args).toBe('{"b":2}');
  });

  test("id-only 调用与 index-only 调用并存 → 不合并（函数名冲突时不并入）", async () => {
    // 调用 A 只有 id，调用 B 只有 index 且函数名不同 → 必须保持两块，不能把 A 的 id 配 B 的 name
    const frames = [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: "callA", type: "function", function: { name: "A", arguments: '{"a":1}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, type: "function", function: { name: "B", arguments: '{"b":2}' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const evs = parseEvents(
      await collect(chatSseToAnthropicStream(streamOf([openAiStream(frames)]), { model: "m" })),
    );
    const starts = evs.filter((e) => e.event === "content_block_start");
    expect(starts).toHaveLength(2);
    expect(starts.map((e) => e.data.content_block.name).sort()).toEqual(["A", "B"]);
    const argsByIdx = new Map<number, string>();
    for (const e of evs) {
      if (e.event === "content_block_delta" && e.data.delta.type === "input_json_delta") {
        argsByIdx.set(e.data.index, (argsByIdx.get(e.data.index) ?? "") + e.data.delta.partial_json);
      }
    }
    expect(argsByIdx.get(starts.find((e) => e.data.content_block.name === "A")!.data.index)).toBe('{"a":1}');
    expect(argsByIdx.get(starts.find((e) => e.data.content_block.name === "B")!.data.index)).toBe('{"b":2}');
  });

  test("流式 stop_reason：content_filter → end_turn；length → max_tokens（工具调用时也不改写）", async () => {
    const textFrames = (fr: string): AnyRec[] => [
      { choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: fr }] },
    ];
    for (const [fr, expected] of [
      ["content_filter", "end_turn"],
      ["length", "max_tokens"],
      ["stop", "end_turn"],
    ] as Array<[string, string]>) {
      const evs = parseEvents(
        await collect(chatSseToAnthropicStream(streamOf([openAiStream(textFrames(fr))]), { model: "m" })),
      );
      const md = evs.find((e) => e.event === "message_delta")!;
      expect(md.data.delta.stop_reason).toBe(expected);
    }
    // 有工具调用时：length 仍为 max_tokens，content_filter 仍为 end_turn（不被改写成 tool_use）
    const toolFrames = (fr: string): AnyRec[] => [
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "A", arguments: "{}" } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: fr }] },
    ];
    for (const [fr, expected] of [
      ["length", "max_tokens"],
      ["content_filter", "end_turn"],
    ] as Array<[string, string]>) {
      const evs = parseEvents(
        await collect(chatSseToAnthropicStream(streamOf([openAiStream(toolFrames(fr))]), { model: "m" })),
      );
      const md = evs.find((e) => e.event === "message_delta")!;
      expect(md.data.delta.stop_reason).toBe(expected);
    }
  });
});
