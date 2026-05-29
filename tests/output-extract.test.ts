// Tests for extractOutput / extractUsage (v0.21.0).
//
// These two functions normalize every response shape that reaches the
// non-streaming chat path. The OpenAI proxied chat models added in v0.21.0
// rest entirely on extractOutput parsing the OpenAI shapes correctly, so the
// chat-completions and Responses API cases are the load-bearing ones here;
// the rest are regression coverage for the shapes that already shipped.

import { describe, it, expect } from "vitest";
import { extractOutput, extractUsage, detectProviderFailure, extractProxiedImageUrl } from "../src/output-extract";

describe("extractOutput", () => {
  it("returns a bare string unchanged", () => {
    expect(extractOutput("hello")).toBe("hello");
  });

  it("reads Workers AI { response }", () => {
    expect(extractOutput({ response: "from workers ai" })).toBe("from workers ai");
  });

  it("reads a top-level string { result }", () => {
    expect(extractOutput({ result: "from result" })).toBe("from result");
  });

  // --- OpenAI proxied: the v0.21.0 load-bearing cases ---

  it("reads the OpenAI chat-completions shape { choices[0].message.content }", () => {
    const r = {
      choices: [{ index: 0, message: { role: "assistant", content: "openai chat reply" } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    };
    expect(extractOutput(r)).toBe("openai chat reply");
  });

  it("reads the OpenAI Responses API shape { output[].content[] } (output_text)", () => {
    const r = {
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "first" },
            { type: "output_text", text: " second" },
          ],
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    };
    expect(extractOutput(r)).toBe("first second");
  });

  it("reads Responses API blocks typed plain 'text' as well as 'output_text'", () => {
    const r = { output: [{ content: [{ type: "text", text: "plain text block" }] }] };
    expect(extractOutput(r)).toBe("plain text block");
  });

  it("does not confuse the Responses API { output: [] } with the Bedrock { output: {} } shape", () => {
    // Bedrock's output is an object with .message; the Responses API output is
    // an array. Both branches must coexist without crossfire.
    const bedrock = { output: { message: { content: [{ text: "bedrock nova" }] } } };
    expect(extractOutput(bedrock)).toBe("bedrock nova");
  });

  // --- Existing-shape regression coverage ---

  it("reads the Anthropic Messages content array, text blocks only", () => {
    const r = {
      content: [
        { type: "thinking", text: "ignored" },
        { type: "text", text: "anthropic " },
        { type: "text", text: "answer" },
      ],
    };
    expect(extractOutput(r)).toBe("anthropic answer");
  });

  it("reads Bedrock Pegasus { message }", () => {
    expect(extractOutput({ message: "pegasus says", finishReason: "stop" })).toBe("pegasus says");
  });

  it("reads Bedrock { generations[0].text }", () => {
    expect(extractOutput({ generations: [{ text: "gen text" }] })).toBe("gen text");
  });

  it("falls back to JSON.stringify on an unrecognized shape", () => {
    const weird = { nope: true };
    expect(extractOutput(weird)).toBe(JSON.stringify(weird));
  });

  it("does not throw on null / undefined", () => {
    expect(() => extractOutput(null)).not.toThrow();
    expect(() => extractOutput(undefined)).not.toThrow();
  });
});

describe("extractUsage", () => {
  it("reads OpenAI prompt_tokens / completion_tokens", () => {
    expect(extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 50 } }))
      .toEqual({ in_: 100, out_: 50 });
  });

  it("reads Anthropic input_tokens / output_tokens", () => {
    expect(extractUsage({ usage: { input_tokens: 8, output_tokens: 4 } }))
      .toEqual({ in_: 8, out_: 4 });
  });

  it("reads Bedrock camelCase inputTokens / outputTokens", () => {
    expect(extractUsage({ usage: { inputTokens: 3, outputTokens: 9 } }))
      .toEqual({ in_: 3, out_: 9 });
  });

  it("returns nulls when there is no usage object", () => {
    expect(extractUsage({ response: "no usage here" })).toEqual({ in_: null, out_: null });
  });

  it("does not throw on null / undefined", () => {
    expect(() => extractUsage(null)).not.toThrow();
    expect(() => extractUsage(undefined)).not.toThrow();
  });
});

describe("detectProviderFailure", () => {
  it("returns the upstream error from a { state: 'Failed', error } envelope", () => {
    const r = { state: "Failed", error: "Model execution failed (Upstream provider is unavailable)" };
    expect(detectProviderFailure(r)).toBe("Model execution failed (Upstream provider is unavailable)");
  });

  it("falls back to the state when a Failed envelope has no error string", () => {
    expect(detectProviderFailure({ state: "Failed" })).toBe('provider returned state "Failed"');
  });

  it("treats any non-Completed state as a failure", () => {
    expect(detectProviderFailure({ state: "Cancelled" })).toBe('provider returned state "Cancelled"');
  });

  it("returns null for a Completed envelope (the async success shape)", () => {
    expect(detectProviderFailure({ state: "Completed", result: { video: "https://..." } })).toBeNull();
  });

  it("returns null for normal sync chat responses (no state field)", () => {
    expect(detectProviderFailure({ choices: [{ message: { content: "hi" } }] })).toBeNull();
    expect(detectProviderFailure({ content: [{ type: "text", text: "hi" }] })).toBeNull();
    expect(detectProviderFailure({ response: "hi" })).toBeNull();
  });

  it("does not throw on null / undefined / string", () => {
    expect(detectProviderFailure(null)).toBeNull();
    expect(detectProviderFailure(undefined)).toBeNull();
    expect(detectProviderFailure("plain string")).toBeNull();
  });
});

describe("extractProxiedImageUrl", () => {
  it("reads the wrapped { state, result: { image } } envelope", () => {
    const r = { state: "Completed", result: { image: "https://r2.dev/cat/img.png" }, gatewayMetadata: { keySource: "Unified" } };
    expect(extractProxiedImageUrl(r)).toBe("https://r2.dev/cat/img.png");
  });

  it("reads the bare { image } shape (no binding wrapper)", () => {
    expect(extractProxiedImageUrl({ image: "https://r2.dev/x.jpg" })).toBe("https://r2.dev/x.jpg");
  });

  it("prefers the wrapped result.image over a top-level image", () => {
    const r = { result: { image: "https://r2.dev/wrapped.png" }, image: "https://r2.dev/bare.png" };
    expect(extractProxiedImageUrl(r)).toBe("https://r2.dev/wrapped.png");
  });

  it("returns null when no image url is present", () => {
    expect(extractProxiedImageUrl({ state: "Completed", result: {} })).toBeNull();
    expect(extractProxiedImageUrl({ choices: [] })).toBeNull();
  });

  it("does not throw on null / undefined / string", () => {
    expect(extractProxiedImageUrl(null)).toBeNull();
    expect(extractProxiedImageUrl(undefined)).toBeNull();
    expect(extractProxiedImageUrl("nope")).toBeNull();
  });
});
