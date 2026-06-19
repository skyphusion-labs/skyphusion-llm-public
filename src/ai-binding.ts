// env.AI binding wrappers (v0.19.3; per-user gateway v0.164.0).
//
// Extracted from src/index.ts so provider modules and other code paths that
// call env.AI.run share one binding wrapper rather than each constructing its
// own opts object.
//
// `aiRun` is the standard call path: pass model, params, optional flag to
// return the raw Response (rather than a parsed object) for binary-output
// models like TTS.
//
// `aiLogId` reads the Cloudflare AI Gateway log ID from the env.AI binding
// after a call, when one exists.

import type { Env } from "./env";
import type { GatewayCredentials } from "./gateway-credentials";

export interface AiContext {
  env: Env;
  gateway: GatewayCredentials;
}

type RunOpts = { gateway: { id: string }; returnRawResponse?: boolean };
type RunFn = (model: string, params: unknown, opts?: RunOpts) => Promise<unknown>;

export function aiRun(ctx: AiContext, model: string, params: unknown, returnRaw = false): Promise<unknown> {
  const opts: RunOpts = { gateway: { id: ctx.gateway.gatewayId } };
  if (returnRaw) opts.returnRawResponse = true;
  return (ctx.env.AI as unknown as { run: RunFn }).run(model, params, opts);
}

export function aiLogId(ctx: AiContext): string | null {
  return (ctx.env.AI as unknown as { aiGatewayLogId?: string }).aiGatewayLogId ?? null;
}
