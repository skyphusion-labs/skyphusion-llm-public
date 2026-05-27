// Anthropic BYOK chat dispatch (v0.19.0).
//
// Extracted from src/index.ts. Owns the request builder, message transform,
// non-streaming caller, and streaming caller for Anthropic Messages API
// through Cloudflare AI Gateway.
//
// Auth strategy: stored-keys-first. If env.ANTHROPIC_API_KEY is set, we send
// it as x-api-key (inline auth, takes priority at the gateway). If it isn't,
// we omit the header and let the gateway inject the key you've stored in
// dashboard > AI Gateway > Provider Keys. Either path works.
//
// The message format coming in is OpenAI-style (role + content array with
// text / image_url blocks). We transform to Anthropic's Messages API shape:
// system pulled to a top-level field, image_url blocks rewritten as image
// blocks with base64 source.

import type { Env } from "../env";
import type { ModelEntry } from "../models";
import type { ProviderStreamEvent } from "../parsers/types";
import { parseDataUrl } from "../utils";
import { extractSSEDataPayloads } from "../parsers/sse-framer";
import { interpretAnthropicSSEFrame } from "../parsers/anthropic-sse";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Array<unknown>;
}

function transformToAnthropic(
  messages: Array<unknown>,
  systemPromptOverride: string | undefined,
): { system: string | undefined; messages: AnthropicMessage[] } {
  let system: string | undefined = systemPromptOverride && systemPromptOverride.trim()
    ? systemPromptOverride
    : undefined;
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    const msg = m as { role: string; content: unknown };
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : "";
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: [{ type: "text", text: msg.content }] });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const content: Array<unknown> = [];
    for (const block of msg.content) {
      const b = block as { type?: string; text?: string; image_url?: { url?: string } };
      if (b.type === "text" && typeof b.text === "string") {
        content.push({ type: "text", text: b.text });
      } else if (b.type === "image_url" && b.image_url?.url) {
        const parsed = parseDataUrl(b.image_url.url);
        if (parsed) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: parsed.mime, data: parsed.base64 },
          });
        }
      }
    }
    out.push({ role: msg.role, content });
  }

  return { system, messages: out };
}

// Shared request builder for both callAnthropic (non-streaming) and
// callAnthropicStream (eventstream). The transform, URL, auth headers, and
// body shape are identical between the two; only stream:true on the body
// and accept:text/event-stream on the headers differ, conditional on
// opts.stream. Mirrors the v0.17.2 prepareXaiRequest / prepareBedrockNovaRequest
// pattern.

async function prepareAnthropicRequest(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
  opts: { stream: boolean },
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  const { system, messages: aMessages } = transformToAnthropic(messages, systemPrompt);

  const baseUrl = await (env.AI as unknown as {
    gateway: (id: string) => { getUrl: (provider: string) => Promise<string> };
  }).gateway(env.GATEWAY_ID).getUrl("anthropic");

  // Strip the "anthropic/" prefix we use in our internal IDs; Anthropic's API
  // expects just the model name (e.g. "claude-opus-4-6").
  const modelName = model.id.replace(/^anthropic\//, "");

  const bodyObj: Record<string, unknown> = {
    model: modelName,
    max_tokens: 4096,
    messages: aMessages,
  };
  if (system) bodyObj.system = system;
  if (opts.stream) bodyObj.stream = true;

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (opts.stream) headers["accept"] = "text/event-stream";
  if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  return {
    url: `${baseUrl}/v1/messages`,
    headers,
    body: JSON.stringify(bodyObj),
  };
}

export async function callAnthropic(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
): Promise<{ raw: unknown; logId: string | null }> {
  const { url, headers, body } = await prepareAnthropicRequest(
    env, model, systemPrompt, messages, { stream: false },
  );

  const resp = await fetch(url, { method: "POST", headers, body });

  const logId = resp.headers.get("cf-aig-log-id");

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const raw = await resp.json();
  return { raw, logId };
}

export async function* callAnthropicStream(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  const { url, headers, body } = await prepareAnthropicRequest(
    env, model, systemPrompt, messages, { stream: true },
  );

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 500)}`);
  }
  if (!resp.body) throw new Error("Anthropic returned no stream body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE event boundaries are \n\n. Within an event, the fields we care
      // about are `data: <json>` lines; everything else (event: name, id:,
      // retry:) we ignore. Anthropic uses `event:` for the type and `data:`
      // for the payload; the payload's own `type` field also carries the
      // event kind, so we can rely on that alone.
      const { payloads, remainder } = extractSSEDataPayloads(buffer);
      buffer = remainder;

      for (const payload of payloads) {
        let data: unknown;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const event of interpretAnthropicSSEFrame(data)) yield event;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* fine */ }
  }
}
