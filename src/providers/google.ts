// Google Gemini chat (Unified Billing, v0.21.3).
//
// Gemini is proxied through env.AI.run but, unlike the OpenAI proxied models,
// it is NOT OpenAI-shaped. Verified against the CF model page, the binding
// passes Gemini-native format through in both directions:
//
//   env.AI.run("google/gemini-3.1-pro", {
//     contents: [{ role: "user", parts: [{ text: "..." }] }],
//     systemInstruction: { parts: [{ text: "..." }] },   // optional
//     generationConfig: { temperature: 0.3 },            // optional
//   })
//
// and returns { candidates: [{ content: { parts: [{ text }] } }],
//               usageMetadata: { promptTokenCount, candidatesTokenCount, ... } }.
//
// So this needs a transform from the worker's internal OpenAI-style message
// array, the same way Anthropic and Bedrock do. Two differences to get right:
//   - Roles: Gemini uses "user" and "model" (no "assistant", no "system" turn).
//     The system prompt is hoisted to systemInstruction by the caller (runChat
//     keeps it out of `messages` for provider "google"), but we also defensively
//     drop any stray system-role entry here.
//   - Content: the internal turns carry string content on the text path. We
//     coerce defensively (array content -> joined text parts) so a stray
//     multimodal turn degrades to text rather than throwing. (Vision input is
//     a later pass; the catalog entry is text-only for now.)
//
// Non-streaming only this pass. The stream gate returns 501 for provider
// "google", so a stream request can't reach a parser that doesn't exist yet.

import type { Env } from "../env";
import type { ModelEntry } from "../models";
import { aiRun, aiLogId } from "../ai-binding";

type InternalMessage = { role?: string; content?: unknown };

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return p?.type === "text" || typeof p?.text === "string" ? p.text ?? "" : "";
      })
      .join("");
  }
  return content == null ? "" : String(content);
}

// Pure transform: internal [{role, content}] -> Gemini `contents`. Exported
// for unit testing the role mapping (assistant -> model) and system drop.
export function geminiContentsFromMessages(
  messages: Array<unknown>,
): Array<{ role: string; parts: Array<{ text: string }> }> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const raw of messages) {
    const m = (raw ?? {}) as InternalMessage;
    if (m.role === "system") continue; // hoisted to systemInstruction
    const role = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: textFromContent(m.content) }] });
  }
  return contents;
}

export function prepareGeminiRequest(
  systemPrompt: string | undefined,
  messages: Array<unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: geminiContentsFromMessages(messages),
  };
  if (systemPrompt && systemPrompt.trim()) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  return body;
}

export async function callGemini(
  env: Env,
  model: ModelEntry,
  systemPrompt: string | undefined,
  messages: Array<unknown>,
): Promise<{ raw: unknown; logId: string | null }> {
  const raw = await aiRun(env, model.id, prepareGeminiRequest(systemPrompt, messages));
  return { raw, logId: aiLogId(env) };
}
