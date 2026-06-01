// Tests for the storyboard / chat bucket routing helper (v0.39.1).
// The prefix matcher is pure; the bucket-selecting wrapper is exercised
// indirectly via the route handlers (which need env bindings the unit
// tests do not stand up).

import { describe, it, expect } from "vitest";
import { isRendersKey } from "../src/r2-routing";

describe("isRendersKey", () => {
  it("routes storyboard-side prefixes to R2_RENDERS", () => {
    expect(isRendersKey("renders/cherry/silent_full.mp4")).toBe(true);
    expect(isRendersKey("renders/cherry/job-1/keyframes/shot_01.png")).toBe(true);
    expect(isRendersKey("bundles/cherry.tar.gz")).toBe(true);
    expect(isRendersKey("projects/cherry/state.tar.gz")).toBe(true);
    expect(isRendersKey("character-refs/abc-123.png")).toBe(true);
  });

  it("leaves chat-side prefixes on R2", () => {
    expect(isRendersKey("in/abc-123.png")).toBe(false);
    expect(isRendersKey("out/abc-123.mp3")).toBe(false);
    expect(isRendersKey("zip/abc-123.zip")).toBe(false);
  });

  it("treats a partial match as not a renders key (no substring matches)", () => {
    // A key whose name happens to contain `renders/` mid-path but does
    // not start with it stays on R2. The matcher is anchored at start.
    expect(isRendersKey("in/renders-bundle.png")).toBe(false);
    expect(isRendersKey("rendersapp/file.png")).toBe(false);
  });

  it("rejects empty string and root-only paths", () => {
    expect(isRendersKey("")).toBe(false);
    expect(isRendersKey("/")).toBe(false);
    expect(isRendersKey("renders")).toBe(false); // no trailing slash
    expect(isRendersKey("bundles")).toBe(false);
  });
});
