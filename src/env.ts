// Worker Env binding (v0.19.0).
//
// Extracted from src/index.ts so provider modules (anthropic, xai, google,
// workers-ai) and future feature modules can import it without circular
// reference to the worker entry. The runtime binding shape is identical
// to what wrangler types regenerate from wrangler.toml; this file is the
// hand-authored interface the worker code references for type checking.
//
// Adding a binding: update wrangler.example.toml, regenerate types
// (`npx wrangler types`), then mirror the new field here. Optional secrets
// (BYOK keys, gateway tokens) stay optional in this interface so missing-
// secret runtime paths surface meaningful errors instead of TypeScript
// telling deployers they need fields they may legitimately not have set.

export interface Env {
  AI: Ai;
  DB: D1Database;
  R2: R2Bucket;
  VEC: VectorizeIndex;
  ASSETS: Fetcher;
  GATEWAY_ID?: string;
  // v0.164.0: optional on the worker when running in public demo mode; each
  // user may store their own gateway slug in D1 user_prefs instead.
  // v0.12.0: Workflow binding for Unified Billing video + music gen. The
  // class is LongRunWorkflow, defined at the bottom of src/index.ts. Each
  // instance invokes env.AI.run (long-running), downloads the artifact,
  // uploads to R2, and finalizes the D1 row across retryable steps.
  LONGRUN: Workflow;
  // v0.108.0: per-session Durable Object that wraps a @cf/deepgram/flux
  // conversational STT WebSocket so the final transcript persists to /history
  // on close (a plain Worker has no reliable post-101 hook to write D1). Class
  // SttSession in src/stt-session.ts. One DO instance per session (newUniqueId).
  STT_SESSION: DurableObjectNamespace;
  // v0.22.1: optional deployer BYOK for gpt-image-1.5 transparent PNG only.
  // OpenAI chat rides Unified Billing; the proxy image schema rejects
  // background/output_format, so transparency requires api.openai.com direct.
  OPENAI_API_KEY?: string;
  // Unified Billing auth for Anthropic, xAI, and proxied partners. Bearer token
  // sent as cf-aig-authorization. Also used when Authenticated Gateway is on.
  // v0.164.0: optional on the worker in public demo mode (per-user token in D1).
  CF_AIG_TOKEN?: string;
  // v0.17.0: Tavily Search API key for the optional web-search retrieval source.
  // Optional: when unset, that source is silently skipped.
  TAVILY_API_KEY?: string;
  // v0.164.0: Brave Search API key for the optional web-search retrieval source.
  // Optional: when unset, that source is silently skipped.
  BRAVE_API_KEY?: string;
}
