import { describe, expect, it } from "vitest";
import {
  gatewaySource,
  maskSecret,
  resolveGatewayFromParts,
} from "../src/gateway-credentials";
import type { Env } from "../src/env";

function env(partial: Partial<Env> = {}): Env {
  return partial as Env;
}

describe("resolveGatewayFromParts", () => {
  it("returns null when no gateway id is available", () => {
    expect(resolveGatewayFromParts(null, env())).toBeNull();
    expect(resolveGatewayFromParts({ gateway_id: "  " }, env())).toBeNull();
  });

  it("merges user prefs over worker secrets field-by-field", () => {
    const resolved = resolveGatewayFromParts(
      { gateway_id: "user-gw", cf_aig_token: "user-token" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    );
    expect(resolved).toEqual({ gatewayId: "user-gw", cfAigToken: "user-token" });
  });

  it("falls back to worker secrets for unset user fields", () => {
    const resolved = resolveGatewayFromParts(
      { gateway_id: "user-gw" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    );
    expect(resolved).toEqual({ gatewayId: "user-gw", cfAigToken: "worker-token" });
  });
});

describe("gatewaySource", () => {
  it("labels pure user credentials", () => {
    expect(gatewaySource(
      { gateway_id: "gw", cf_aig_token: "tok" },
      env(),
    )).toBe("user");
  });

  it("labels worker-only credentials", () => {
    expect(gatewaySource(null, env({ GATEWAY_ID: "gw" }))).toBe("worker");
  });

  it("labels mixed overrides", () => {
    expect(gatewaySource(
      { gateway_id: "user-gw" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    )).toBe("mixed");
  });
});

describe("maskSecret", () => {
  it("masks long secrets with trailing preview", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("••••••••••••mnop");
  });

  it("returns null for empty values", () => {
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret("   ")).toBeNull();
  });
});
