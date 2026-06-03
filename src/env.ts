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
  // v0.39.1: separate bucket for storyboard / render artifacts (bundles,
  // silent MP4s, SDXL keyframes, project state tarballs, staged character
  // refs). The vivijure-serverless GPU worker reads + writes this bucket
  // via its own R2_BUCKET env var; the Worker uses this binding so chat-
  // side R2 (`R2`) stays untouched. Point both bindings at the same
  // bucket in wrangler.toml if you don't want the split.
  R2_RENDERS: R2Bucket;
  // v0.107.0: R2 S3-compatible credentials for SigV4 presigning (src/r2-presign.ts).
  // The container backends have no R2 binding, so the Worker presigns short-lived
  // GET/PUT URLs against the R2_RENDERS bucket over the public S3 endpoint.
  // ACCESS_KEY_ID + SECRET_ACCESS_KEY are secrets (R2 API token, Object R+W on the
  // bucket); ENDPOINT (https://<accountid>.r2.cloudflarestorage.com) and BUCKET are
  // non-secret [vars]. All optional so presign-free deploys still typecheck.
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  R2_S3_ENDPOINT?: string;
  R2_S3_BUCKET?: string;
  VEC: VectorizeIndex;
  ASSETS: Fetcher;
  GATEWAY_ID: string;
  // v0.12.0: Workflow binding for Unified Billing video + music gen. The
  // class is LongRunWorkflow, defined at the bottom of src/index.ts. Each
  // instance invokes env.AI.run (long-running), downloads the artifact,
  // uploads to R2, and finalizes the D1 row across retryable steps.
  LONGRUN: Workflow;
  // v0.107.0: Cloudflare Container DO for CPU-only audio beat analysis
  // (librosa). The cast/planner audio flow presigns an R2 GET URL and POSTs
  // it to the container's /analyze; class is AudioBeatSyncContainer in
  // src/containers/audio-beat-sync.ts. Replaces the reverted GPU pod action.
  AUDIO_BEAT_SYNC: DurableObjectNamespace;
  // v0.107.0: Container DO for CPU rembg background removal on cast portraits
  // (class ImagePrepContainer in src/containers/image-prep.ts). Worker presigns
  // R2 GET/PUT and POSTs to /portrait/prep at bundle time; moves rembg off the
  // GPU pod. See docs/image-prep-container.md.
  IMAGE_PREP: DurableObjectNamespace;
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
  // v0.32.0: RunPod serverless endpoint credentials for /api/storyboard/render.
  // RUNPOD_API_KEY is a Bearer token from the RunPod console (User Settings ->
  // API Keys). RUNPOD_ENDPOINT_ID is the vivijure-serverless endpoint id (the
  // path segment after /v2/ on a RunPod endpoint URL). Both optional; the
  // submit / poll routes return 503 with a clear error when either is missing.
  RUNPOD_API_KEY?: string;
  RUNPOD_ENDPOINT_ID?: string;
}
