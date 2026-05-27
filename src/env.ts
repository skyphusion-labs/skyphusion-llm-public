// Worker Env binding (v0.19.0).
//
// Extracted from src/index.ts so provider modules (anthropic, xai, bedrock,
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
  ANTHROPIC_API_KEY?: string; // optional; preferred is to store in AI Gateway dashboard
  XAI_API_KEY?: string;       // optional; preferred is to store in AI Gateway dashboard
  // v0.11.0: AWS credentials for Bedrock BYOK. Scope IAM key to Bedrock invoke only.
  // AWS_REGION defaults to us-east-1 for Nova; Pegasus 1.2 requires us-west-2 or eu-west-1.
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  AWS_REGION_PEGASUS?: string; // optional override for Pegasus calls
  CF_AIG_TOKEN?: string;      // only needed if gateway has Authenticated Gateway enabled
  // v0.17.0: Tavily Search API key for the optional web-search retrieval source.
  // Optional: when unset, web search uses Wikipedia only (no key required).
  TAVILY_API_KEY?: string;
}
