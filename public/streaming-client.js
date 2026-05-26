// streaming-client.js
//
// Pass 1 of the v0.13.0 SSE rollout. Connects to POST /api/chat/stream,
// decodes the custom wire envelope, invokes callbacks for each delta and
// the terminal event. Intentionally framework-free so it drops into the
// existing vanilla-JS app.js without dependencies.
//
// Wire format expected from the server (text/event-stream):
//   data: {"type":"delta","text":"..."}
//   data: {"type":"done","row_id":N,"latency_ms":N,"tokens_in":N|null,
//          "tokens_out":N|null,"conversation_id":"...","turn_index":N}
//   data: {"type":"error","message":"..."}
//
// Anything else on the wire is ignored. Anthropic's native event names are
// stripped server-side; the client only sees the envelope above.
//
// Why not EventSource:
//   EventSource is GET-only and doesn't let you set request headers or send
//   a JSON body. POST + ReadableStream reader is the standard pattern for
//   fetch-driven SSE.

/**
 * Open a streaming chat connection.
 *
 * @param {Object} body  Same shape as POST /api/chat:
 *   { model, user_input, system_prompt?, attachments?, use_docs?, conversation_id? }
 * @param {Object} callbacks
 *   onDelta(text: string) - one text fragment, called many times during a stream
 *   onDone(meta: {row_id, latency_ms, tokens_in, tokens_out, conversation_id, turn_index})
 *     - called exactly once on success
 *   onError(message: string)
 *     - called once on any failure; mutually exclusive with onDone
 *
 * @returns {Function} cancel() - aborts the in-flight stream. Safe to call after onDone/onError.
 */
export async function streamChat(body, callbacks) {
  const controller = new AbortController();
  const cancel = () => {
    try { controller.abort(); } catch { /* already aborted */ }
  };

  let resp;
  try {
    resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") return cancel;
    callbacks.onError(err && err.message ? err.message : String(err));
    return cancel;
  }

  // Non-2xx responses from the streaming endpoint are JSON error bodies (the
  // server only switches to SSE once validation passes). Parse and surface.
  if (!resp.ok) {
    let errBody;
    try {
      errBody = await resp.json();
    } catch {
      errBody = { error: `HTTP ${resp.status}` };
    }
    callbacks.onError(errBody.error || `HTTP ${resp.status}`);
    return cancel;
  }
  if (!resp.body) {
    callbacks.onError("No response body");
    return cancel;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawTerminal = false; // tripped once we see "done" or "error"

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE event boundary is \n\n. Within each event, we look only at
      // `data:` lines. Multiple data lines per event would be concatenated
      // by SSE spec, but the server never emits that, so the first data
      // line wins.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        let payload = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("data: ")) payload = line.slice(6);
          else if (line.startsWith("data:")) payload = line.slice(5);
        }
        if (!payload) continue;

        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // malformed payload, skip
        }

        if (event.type === "delta" && typeof event.text === "string") {
          callbacks.onDelta(event.text);
        } else if (event.type === "done") {
          sawTerminal = true;
          callbacks.onDone({
            row_id: event.row_id,
            latency_ms: event.latency_ms,
            tokens_in: event.tokens_in,
            tokens_out: event.tokens_out,
            conversation_id: event.conversation_id,
            turn_index: event.turn_index,
          });
        } else if (event.type === "error") {
          sawTerminal = true;
          callbacks.onError(event.message || "Unknown stream error");
        }
        // unknown event types are ignored (forward compatibility)
      }
    }

    // Stream closed without a terminal event. Treat as truncation error
    // unless the user cancelled us (in which case we don't fire onError).
    if (!sawTerminal && !controller.signal.aborted) {
      callbacks.onError("Stream closed unexpectedly");
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      // User-initiated cancel - don't fire onError.
      return cancel;
    }
    if (!sawTerminal) {
      callbacks.onError(err && err.message ? err.message : String(err));
    }
  }

  return cancel;
}

// ----- Integration sketch -----
//
// Drop the function above into your app.js (or import from a script tag /
// module). In the chat send handler, branch on whether the selected model
// has `streaming: true` in the catalog you already fetch from /api/models:
//
//   async function sendChat() {
//     const modelId = MODEL_SELECT.value;
//     const modelEntry = MODELS.find(m => m.id === modelId);
//     const body = {
//       model: modelId,
//       user_input: INPUT.value,
//       system_prompt: SYSTEM_PROMPT.value || undefined,
//       use_docs: USE_DOCS_CHECKBOX.checked,
//       conversation_id: currentConversationId || undefined,
//       attachments: collectedAttachments(),
//     };
//
//     if (modelEntry?.streaming) {
//       // Streaming path
//       const bubble = appendAssistantBubble("");   // empty bubble, fills as deltas arrive
//       setSendButtonState("streaming");
//
//       const cancelStream = await streamChat(body, {
//         onDelta: (text) => {
//           bubble.textContent += text;
//           scrollChatToBottom();
//         },
//         onDone: (meta) => {
//           currentConversationId = meta.conversation_id;
//           markBubbleComplete(bubble, meta);    // attach latency/token stats
//           refreshHistorySidebar();
//           setSendButtonState("idle");
//         },
//         onError: (msg) => {
//           bubble.classList.add("error");
//           bubble.textContent += `\n[stream error: ${msg}]`;
//           setSendButtonState("idle");
//         },
//       });
//       // Wire your "stop generating" button to call cancelStream().
//
//     } else {
//       // Existing non-streaming path (POST /api/chat, JSON in/out).
//       // ... your current code ...
//     }
//   }
//
// Notes:
//   - The catalog from /api/models now includes a `streaming` field on each
//     entry. Anthropic models have it true; everything else is false (Pass 1).
//   - On the assistant bubble, accumulate text via textContent +=, not
//     innerHTML, to avoid breaking markdown rendering mid-stream. Defer
//     markdown / syntax-highlighting until onDone fires, then re-render the
//     bubble once with your existing pipeline.
//   - If you have a markdown renderer, you'll likely want a "rendering mode"
//     toggle: raw text during streaming, parsed markdown after onDone. Doing
//     a partial markdown parse on every delta is expensive and visually
//     janky (code fences open and close partway through).
//   - The conversation_id flows back on onDone same as the non-stream path,
//     so multi-turn continuation Just Works.
