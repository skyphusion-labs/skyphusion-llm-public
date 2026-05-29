// Tests for interpretOpenAISSEFrame (v0.21.0).
//
// The interpreter must handle both shapes env.AI.run can emit for a streamed
// proxied OpenAI model: the OpenAI-native delta shape and the CF-normalized
// flat `response` shape. Whichever the proxy actually uses, streaming should
// produce the same normalized text/usage events. `data: [DONE]` is stripped
// by the SSE framer upstream, so it never reaches the interpreter.

import { describe, it, expect } from "vitest";
import { interpretOpenAISSEFrame } from "../src/parsers/openai-sse";

describe("interpretOpenAISSEFrame", () => {
  // --- Shape 1: OpenAI-native delta ---

  it("extracts a content delta from the OpenAI-native shape", () => {
    const frame = {
      id: "chatcmpl-x",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "Hello" } }],
    };
    expect(interpretOpenAISSEFrame(frame)).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("drops an empty-string delta (normal on role/usage frames)", () => {
    expect(interpretOpenAISSEFrame({ choices: [{ delta: { content: "" } }] })).toEqual([]);
    expect(interpretOpenAISSEFrame({ choices: [{ delta: {} }] })).toEqual([]);
  });

  it("reads the usage frame from the OpenAI-native shape", () => {
    const frame = { choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: 22 } };
    expect(interpretOpenAISSEFrame(frame)).toEqual([{ type: "usage", in_: 11, out_: 22 }]);
  });

  // --- Shape 2: CF-normalized flat `response` ---

  it("extracts text from the flat response shape", () => {
    expect(interpretOpenAISSEFrame({ response: "world" })).toEqual([{ type: "text", text: "world" }]);
  });

  it("drops an empty flat response", () => {
    expect(interpretOpenAISSEFrame({ response: "" })).toEqual([]);
  });

  it("reads usage from the flat shape, accepting OpenAI or Anthropic naming", () => {
    expect(interpretOpenAISSEFrame({ response: "", usage: { prompt_tokens: 3, completion_tokens: 4 } }))
      .toEqual([{ type: "usage", in_: 3, out_: 4 }]);
    expect(interpretOpenAISSEFrame({ response: "", usage: { input_tokens: 5, output_tokens: 6 } }))
      .toEqual([{ type: "usage", in_: 5, out_: 6 }]);
  });

  // --- Robustness ---

  it("yields text then usage when a single frame carries both", () => {
    const frame = { choices: [{ delta: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } };
    expect(interpretOpenAISSEFrame(frame)).toEqual([
      { type: "text", text: "done" },
      { type: "usage", in_: 1, out_: 2 },
    ]);
  });

  it("returns no events for an unrelated frame", () => {
    expect(interpretOpenAISSEFrame({ id: "x", object: "chat.completion.chunk", choices: [{}] })).toEqual([]);
  });

  it("does not throw on null / undefined / string", () => {
    expect(() => interpretOpenAISSEFrame(null)).not.toThrow();
    expect(() => interpretOpenAISSEFrame(undefined)).not.toThrow();
    expect(() => interpretOpenAISSEFrame("[DONE]")).not.toThrow();
    expect(interpretOpenAISSEFrame(null)).toEqual([]);
  });
});
