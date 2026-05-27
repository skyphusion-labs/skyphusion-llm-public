// Bedrock chat + video-Q&A dispatch (v0.19.2).
//
// Extracted from src/index.ts following the v0.19.0/0.19.1 pattern. Owns the
// AWS SigV4 setup, request building, and three call paths:
//   - callBedrockNova        Converse API, non-streaming
//   - callBedrockNovaStream  ConverseStream API, binary eventstream
//   - callBedrockPegasus     InvokeModel API for TwelveLabs Pegasus 1.2 video-Q&A
//
// All three share AWS credential checks and aws4fetch client construction.
// Nova chat (Converse / ConverseStream) covers Nova 2 Lite / 2 Pro / Lite / Pro.
// Pegasus 1.2 is video-Q&A: takes a video file and a text prompt, returns text
// analysis. Different in that it doesn't use Converse, requires a video
// attachment, has a 25MB InvokeModel payload limit, and is region-restricted
// to us-west-2 / eu-west-1 (configurable via AWS_REGION_PEGASUS).

import type { Env } from "../env";
import type { ModelEntry } from "../models";
import type { InputAttachment, InputVideoFullAttachment } from "../types";
import type { ProviderStreamEvent } from "../parsers/types";
import { parseBedrockEventStreamFrames } from "../parsers/bedrock-eventstream";

// Shared request builder for both callBedrockNova (non-streaming) and
// callBedrockNovaStream (eventstream). All the AWS client setup, model-
// name resolution, message transform, and URL construction lives here. The
// only thing that differs between the two callers is the endpoint suffix
// (converse vs converse-stream), driven by opts.stream.

async function prepareBedrockNovaRequest(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
  opts: { stream: boolean },
) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set; Bedrock BYOK requires AWS credentials (npx wrangler secret put AWS_ACCESS_KEY_ID; npx wrangler secret put AWS_SECRET_ACCESS_KEY)");
  }
  const region = env.AWS_REGION || "us-east-1";
  const modelName = model.byok_alias ?? model.id.replace(/^bedrock\//, "");

  // Transform our messages array into Bedrock Converse format. System messages
  // are pulled out separately; user/assistant become content-block arrays.
  const bedrockMessages: Array<{ role: string; content: Array<{ text: string }> }> = [];
  for (const msg of messages) {
    const m = msg as { role: string; content: unknown };
    if (m.role === "system") continue; // we use systemPrompt arg instead
    if (typeof m.content === "string") {
      bedrockMessages.push({ role: m.role, content: [{ text: m.content }] });
    } else if (Array.isArray(m.content)) {
      // Multi-part content (e.g. text + image). For now, concatenate text parts.
      // TODO: pass through image parts as Bedrock image content blocks when adding vision.
      const textParts = (m.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p.type === "text" || typeof p.text === "string")
        .map((p) => p.text || "")
        .join("\n");
      bedrockMessages.push({ role: m.role, content: [{ text: textParts || "(empty)" }] });
    }
  }

  const body: Record<string, unknown> = {
    messages: bedrockMessages,
    inferenceConfig: { maxTokens: 4096 },
  };
  if (systemPrompt) {
    body.system = [{ text: systemPrompt }];
  }

  // Dynamic import so the aws4fetch bundle isn't loaded for users who only
  // use other providers.
  const { AwsClient } = await import("aws4fetch");
  const awsClient = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region,
    service: "bedrock",
  });

  // Endpoint suffix: converse for sync, converse-stream for SSE.
  const endpoint = opts.stream ? "converse-stream" : "converse";
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelName)}/${endpoint}`;

  return { awsClient, url, bodyJson: JSON.stringify(body) };
}

export async function callBedrockNova(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
): Promise<{ raw: unknown; logId: string | null }> {
  const { awsClient, url, bodyJson } = await prepareBedrockNovaRequest(
    env, model, systemPrompt, messages, { stream: false },
  );

  const resp = await awsClient.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyJson,
  });

  if (!resp.ok) {
    throw new Error(`Bedrock Nova ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const raw = await resp.json();
  // logId: Bedrock doesn't return a Cloudflare-style log id. Pass null.
  return { raw, logId: null };
}

// Async generator: drives a Bedrock Nova model via ConverseStream and yields
// normalized text + usage events.
//
// Bedrock streams over the application/vnd.amazon.eventstream binary protocol.
// All the frame-parsing complexity lives in parseBedrockEventStreamFrames
// (extracted in v0.18.0); this generator is the thin shell that handles
// fetch I/O, buffer accumulation, and AbortSignal forwarding.
//
// Abort handling: aws4fetch forwards `signal` to fetch(), so client
// disconnect cancels the upstream request mid-stream.

export async function* callBedrockNovaStream(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  const { awsClient, url, bodyJson } = await prepareBedrockNovaRequest(
    env, model, systemPrompt, messages, { stream: true },
  );

  const resp = await awsClient.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyJson,
    signal,
  });

  if (!resp.ok) {
    throw new Error(`Bedrock Nova streaming ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  if (!resp.body) {
    throw new Error("Bedrock Nova streaming: response body missing");
  }

  const reader = resp.body.getReader();
  let buf: Uint8Array = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append new bytes to accumulated buffer.
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0);
      merged.set(value, buf.length);
      buf = merged;

      // Extract whatever complete frames are now available; remainder waits
      // for more bytes on the next read.
      const { events, remainder } = parseBedrockEventStreamFrames(buf);
      buf = remainder;
      for (const event of events) yield event;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}

// TwelveLabs Pegasus 1.2 on Bedrock (v0.11.0).
//
// Pegasus is video-Q&A: takes a video file and a text prompt, returns text
// analysis. Different from chat in that:
//   - Doesn't use Converse API; uses InvokeModel directly
//   - Requires a video attachment (validated in dispatch)
//   - Body shape: {inputPrompt: string, mediaSource: {base64String|s3Location}}
//   - Region restricted: us-west-2 or eu-west-1 only (cross-region inference
//     from other US/EU regions can work; configurable via AWS_REGION_PEGASUS).
//   - Bedrock InvokeModel payload limit is 25MB, so base64-encoded video must
//     stay under roughly 18MB binary. Larger videos would require S3 (not
//     supported in this build - we'd need to add an S3 binding).

export async function callBedrockPegasus(
  env: Env,
  model: ModelEntry,
  prompt: string,
  attachments: InputAttachment[],
): Promise<{ raw: unknown; logId: string | null }> {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set for Pegasus BYOK");
  }

  // Find the first video attachment. Pegasus requires exactly one video.
  // Frontend uploads as "video_full" (the raw video file as a data URL) when
  // the selected model is Pegasus, rather than the default frame-extraction
  // behavior used for vision-capable chat models.
  // v0.17.1: type predicate narrows the find result to InputVideoFullAttachment
  // so videoAtt.data is typed `string` without needing a `?? ""` fallback.
  const videoAtt = attachments.find(
    (a): a is InputVideoFullAttachment => a.type === "video_full",
  );
  if (!videoAtt) {
    throw new Error("Pegasus 1.2 requires a video attachment. Attach an .mp4 (or similar) file before sending the prompt.");
  }

  // Decode the data URL to raw bytes, then re-encode as base64 (no data: prefix).
  // videoAtt.data is a "data:video/mp4;base64,AAAA..." string per the type.
  const dataUrl = videoAtt.data;
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) {
    throw new Error("Pegasus: video attachment data URL is malformed");
  }
  const base64Raw = dataUrl.slice(commaIdx + 1);

  // Hard size check. 18MB binary = ~24MB base64. Bedrock InvokeModel cap is 25MB.
  // Conservatively reject videos that base64-encode to over 24MB.
  const PEGASUS_MAX_BASE64_BYTES = 24 * 1024 * 1024;
  if (base64Raw.length > PEGASUS_MAX_BASE64_BYTES) {
    const mb = (base64Raw.length * 0.75 / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Pegasus: video too large (~${mb}MB binary). Bedrock InvokeModel has a 25MB request limit; ` +
      `videos must be under roughly 18MB. For larger videos you'd need S3 integration (not yet supported).`
    );
  }

  // Region selection: Pegasus is only available in us-west-2 and eu-west-1.
  // AWS_REGION_PEGASUS lets the operator pin Pegasus to a different region
  // than the default Nova region (which is typically us-east-1).
  const region = env.AWS_REGION_PEGASUS || env.AWS_REGION || "us-west-2";

  const body = {
    inputPrompt: prompt,
    mediaSource: { base64String: base64Raw },
    temperature: 0.2,
  };

  const { AwsClient } = await import("aws4fetch");
  const awsClient = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region,
    service: "bedrock",
  });

  const modelName = model.byok_alias ?? "twelvelabs.pegasus-1-2-v1:0";
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelName)}/invoke`;

  const resp = await awsClient.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`Pegasus ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
  const raw = await resp.json();
  return { raw, logId: null };
}
