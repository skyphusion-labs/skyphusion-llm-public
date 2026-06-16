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
  GATEWAY_ID: string;
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
  // v0.93.0: Anthropic moved off BYOK to Cloudflare Unified Billing, so there
  // is no longer an ANTHROPIC_API_KEY; it authorizes via CF_AIG_TOKEN below.
  XAI_API_KEY?: string;       // optional; preferred is to store in AI Gateway dashboard
  // v0.22.1: OpenAI BYOK, used ONLY for direct image gen (transparent PNG).
  // OpenAI chat/image otherwise route through the Unified Billing proxy, but the
  // proxy's image schema rejects `background`/`output_format`, so transparency
  // requires a direct call to api.openai.com. When this key is set, gpt-image-1.5
  // goes direct + transparent; when unset, it falls back to the opaque proxy path.
  OPENAI_API_KEY?: string;
  // Required for Anthropic Unified Billing (v0.93.0) and for any gateway with
  // Authenticated Gateway enabled. Bearer token sent as cf-aig-authorization.
  CF_AIG_TOKEN?: string;
  // v0.17.0: Tavily Search API key for the optional web-search retrieval source.
  // Optional: when unset, web search uses Wikipedia only (no key required).
  TAVILY_API_KEY?: string;
}
