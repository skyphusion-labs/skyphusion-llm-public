// Tests for the SttSession Durable Object's pure helpers. The DO itself bridges
// a hibernatable browser socket to an upstream @cf/deepgram/flux socket and
// persists the final transcript to /history on close; the socket lifecycle is
// exercised live, not unit-tested. buildTranscript (turn join) and
// sanitizeCloseCode (WebSocket close-code legality) are the testable pure bits.

import { describe, it, expect } from "vitest";
import { buildTranscript, sanitizeCloseCode } from "../src/stt-util";

describe("buildTranscript", () => {
  it("joins non-empty, trimmed turns with single spaces", () => {
    expect(
      buildTranscript([{ text: "hello" }, { text: " world " }, { text: "" }, { text: "  " }, { text: "again" }]),
    ).toBe("hello world again");
  });

  it("returns an empty string when there are no usable turns", () => {
    expect(buildTranscript([])).toBe("");
    expect(buildTranscript([{ text: "" }, { text: "   " }])).toBe("");
  });
});

describe("sanitizeCloseCode", () => {
  it("passes legal codes through (1000 and 3000-4999)", () => {
    expect(sanitizeCloseCode(1000)).toBe(1000);
    expect(sanitizeCloseCode(3000)).toBe(3000);
    expect(sanitizeCloseCode(4999)).toBe(4999);
  });

  it("maps illegal/reserved codes to 1011", () => {
    for (const code of [0, 1001, 1005, 1006, 1011, 2999, 5000]) {
      expect(sanitizeCloseCode(code)).toBe(1011);
    }
  });
});
