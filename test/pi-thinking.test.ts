import { expect, test } from "bun:test";
import { chatSseToAnthropicStream, translateAnthropicRequest, translateChatCompletion } from "../src/translate";

test("DeepSeek translation carries thinking selection and replays reasoning", () => {
  const base = { model: "coding-auto", messages: [{ role: "assistant", content: [
    { type: "thinking", thinking: "prior reasoning", signature: "" },
    { type: "tool_use", id: "call_1", name: "read", input: {} },
  ] }] };
  for (const [input, expected] of [
    [{ thinking: { type: "disabled" } }, { thinking: { type: "disabled" }, reasoning_effort: "none" }],
    [{ thinking: { type: "adaptive" }, output_config: { effort: "low" } }, { thinking: { type: "enabled" }, reasoning_effort: "low" }],
    [{ thinking: { type: "adaptive" }, output_config: { effort: "medium" } }, { thinking: { type: "enabled" }, reasoning_effort: "high" }],
    [{ thinking: { type: "adaptive" }, output_config: { effort: "max" } }, { thinking: { type: "enabled" }, reasoning_effort: "max" }],
  ] as const) {
    const result = translateAnthropicRequest({ ...base, ...input }, "deepseek-v4.1-flash").body;
    expect(result).toMatchObject(expected);
    expect(result.messages).toMatchObject([{ role: "assistant", reasoning_content: "prior reasoning" }]);
  }
  const response = translateChatCompletion({ choices: [{ message: { reasoning_content: "reason", content: "answer" }, finish_reason: "stop" }] }, "deepseek");
  expect(response.content).toEqual([{ type: "thinking", thinking: "reason", signature: "" }, { type: "text", text: "answer" }]);
});

test("streamed reasoning is returned as thinking blocks", async () => {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"reason"},"finish_reason":null}]}\n\n'));
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n'));
    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    controller.close();
  } });
  const result = await new Response(chatSseToAnthropicStream(source, { model: "deepseek" })).text();
  expect(result).toContain('"type":"thinking_delta","thinking":"reason"');
  expect(result).toContain('"type":"text_delta","text":"answer"');
});
