// Tests for the Gemini message transform (v0.21.3).
//
// The load-bearing bits: assistant -> model role mapping (Gemini has no
// "assistant"), system turns dropped (hoisted to systemInstruction), and
// defensive text coercion so a stray array/multimodal turn degrades to text
// rather than throwing.

import { describe, it, expect } from "vitest";
import { geminiContentsFromMessages, prepareGeminiRequest } from "../src/providers/google";

describe("geminiContentsFromMessages", () => {
  it("maps user -> user and assistant -> model", () => {
    const out = geminiContentsFromMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);
    expect(out).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: "bye" }] },
    ]);
  });

  it("drops system-role turns (hoisted to systemInstruction)", () => {
    const out = geminiContentsFromMessages([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    expect(out).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("coerces array content to joined text parts", () => {
    const out = geminiContentsFromMessages([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ]);
    expect(out).toEqual([{ role: "user", parts: [{ text: "ab" }] }]);
  });

  it("treats an unknown role as user", () => {
    expect(geminiContentsFromMessages([{ role: "tool", content: "x" }]))
      .toEqual([{ role: "user", parts: [{ text: "x" }] }]);
  });
});

describe("prepareGeminiRequest", () => {
  it("includes systemInstruction when a system prompt is given", () => {
    const body = prepareGeminiRequest("you are terse", [{ role: "user", content: "hi" }]);
    expect(body).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { parts: [{ text: "you are terse" }] },
    });
  });

  it("omits systemInstruction when no system prompt", () => {
    const body = prepareGeminiRequest(undefined, [{ role: "user", content: "hi" }]);
    expect(body).toEqual({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect("systemInstruction" in body).toBe(false);
  });

  it("omits systemInstruction for a blank system prompt", () => {
    const body = prepareGeminiRequest("   ", [{ role: "user", content: "hi" }]);
    expect("systemInstruction" in body).toBe(false);
  });
});
