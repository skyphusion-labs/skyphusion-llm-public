// Tests for the image-prep container call guard (callImagePrep). The bundle
// assembler routes cast portraits through the IMAGE_PREP Cloudflare Container;
// a fully-cold container can 503 a heavy /portrait/prep request while it's still
// binding the port (seen in live testing), so the call warms with /health and
// retries on 503. These cover that guard with a mocked DO stub. backoffMs=0 so
// the retries don't actually wait. See docs / project memory for the live
// verification.

import { describe, it, expect } from "vitest";
import { callImagePrep } from "../src/bundle-assembler";
import type { Env } from "../src/env";

const PAYLOAD = {
  inputUrl: "https://r2/in?sig=x",
  outputUrl: "https://r2/out?sig=y",
  outputKey: "cast-clean/abc.png",
  background: "alpha" as const,
};

// Minimal env with an IMAGE_PREP DO whose stub.fetch is the supplied impl.
function mockEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): Env {
  const stub = { fetch: (url: string, init?: RequestInit) => fetchImpl(url, init) };
  return {
    IMAGE_PREP: {
      idFromName: (_: string) => "singleton-id",
      get: (_: unknown) => stub,
    },
  } as unknown as Env;
}

describe("callImagePrep cold-start guard", () => {
  it("warms /health before posting /portrait/prep", async () => {
    const urls: string[] = [];
    const env = mockEnv(async (url) => {
      urls.push(url);
      return new Response("{}", { status: 200 });
    });
    const r = await callImagePrep(env, PAYLOAD, { backoffMs: 0 });
    expect(r?.status).toBe(200);
    expect(urls[0]).toContain("/health");
    expect(urls.some((u) => u.includes("/portrait/prep"))).toBe(true);
  });

  it("retries /portrait/prep on 503 and returns the eventual success", async () => {
    let prepCalls = 0;
    const env = mockEnv(async (url) => {
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      prepCalls++;
      return new Response("{}", { status: prepCalls < 2 ? 503 : 200 });
    });
    const r = await callImagePrep(env, PAYLOAD, { retries: 3, backoffMs: 0 });
    expect(r?.status).toBe(200);
    expect(prepCalls).toBe(2); // 503 once, then success
  });

  it("gives up after `retries` 503s and returns the last 503", async () => {
    let prepCalls = 0;
    const env = mockEnv(async (url) => {
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      prepCalls++;
      return new Response("{}", { status: 503 });
    });
    const r = await callImagePrep(env, PAYLOAD, { retries: 3, backoffMs: 0 });
    expect(r?.status).toBe(503);
    expect(prepCalls).toBe(3);
  });

  it("returns null when /portrait/prep throws (network error)", async () => {
    const env = mockEnv(async (url) => {
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      throw new Error("boom");
    });
    const r = await callImagePrep(env, PAYLOAD, { retries: 2, backoffMs: 0 });
    expect(r).toBeNull();
  });

  it("tolerates a throwing /health warm and still attempts prep", async () => {
    let prepCalled = false;
    const env = mockEnv(async (url) => {
      if (url.endsWith("/health")) throw new Error("cold");
      prepCalled = true;
      return new Response("{}", { status: 200 });
    });
    const r = await callImagePrep(env, PAYLOAD, { backoffMs: 0 });
    expect(prepCalled).toBe(true);
    expect(r?.status).toBe(200);
  });
});
