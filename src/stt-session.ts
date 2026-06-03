// Conversational STT session Durable Object (v0.108.0).
//
// Wraps a @cf/deepgram/flux WebSocket session so the final transcript can be
// persisted to /history on close, which a plain Worker cannot do reliably (no
// clean hook after the 101 to write D1). The DO:
//   - accepts the browser socket via the Hibernation API (ctx.acceptWebSocket),
//   - opens the upstream flux socket (env.AI.run({websocket:true})) and bridges
//     audio up / Deepgram events down,
//   - accumulates each committed turn into DO SQLite (hibernation-safe; the
//     in-memory upstream socket is NOT — outbound sockets do not hibernate, so
//     we lean on the fact that an active STT session streams audio continuously
//     and never goes idle long enough to hibernate, with a guard if it does),
//   - on close, concatenates the turns and writes one chats row (model_type
//     "voice") so the session shows up in history.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { buildTranscript, sanitizeCloseCode } from "./stt-util";

export const FLUX_STT_MODEL = "@cf/deepgram/flux";

interface FluxRunResult {
  webSocket?: WebSocket | null;
}

export class SttSession extends DurableObject<Env> {
  private upstream: WebSocket | null = null;
  private finalized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS turns (seq INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, confidence REAL)`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const userEmail = request.headers.get("cf-access-authenticated-user-email") ?? "anonymous";
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO meta (k, v) VALUES ('user', ?), ('model', ?), ('started_at', ?)`,
      userEmail,
      FLUX_STT_MODEL,
      new Date().toISOString(),
    );

    let upstream: WebSocket | null;
    try {
      const resp = (await (this.env.AI as unknown as {
        run: (m: string, p: unknown, o: { websocket: boolean }) => Promise<FluxRunResult>;
      }).run(FLUX_STT_MODEL, { encoding: "linear16", sample_rate: "16000" }, { websocket: true }));
      upstream = resp?.webSocket ?? null;
    } catch (err) {
      return Response.json(
        { error: `flux upstream open failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }
    if (!upstream) {
      return Response.json({ error: "flux did not return a WebSocket" }, { status: 502 });
    }
    upstream.accept();
    this.upstream = upstream;

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // Hibernation API for the browser-facing socket: webSocketMessage / -Close
    // fire even after an idle eviction, and DO SQLite holds the transcript.
    this.ctx.acceptWebSocket(server);

    // Upstream -> browser. Outbound socket, so regular listeners (these run only
    // while the DO is in memory, which an active session keeps it).
    upstream.addEventListener("message", (e: MessageEvent) => this.onUpstreamMessage(e));
    upstream.addEventListener("close", (e: CloseEvent) => {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(sanitizeCloseCode(e.code), e.reason);
        } catch {
          /* peer gone */
        }
      }
    });
    upstream.addEventListener("error", () => {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1011, "upstream error");
        } catch {
          /* peer gone */
        }
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private onUpstreamMessage(e: MessageEvent): void {
    // Relay the raw frame to the browser first, then parse (text = JSON events,
    // binary would never be parsed). Never let a parse error drop the relay.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(e.data);
      } catch {
        /* peer gone */
      }
    }
    if (typeof e.data !== "string") return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    // Flux nests turn events: {type:"TurnInfo", event:"EndOfTurn", ...}. (It used
    // to be flat {type:"EndOfTurn"}; the API changed.) Handle both shapes.
    const type = ev.type === "TurnInfo" ? (ev.event as string) : ((ev.type as string) || (ev.event as string) || "");
    if (type === "EndOfTurn") {
      const text = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
      if (text) {
        const conf = typeof ev.end_of_turn_confidence === "number" ? ev.end_of_turn_confidence : null;
        this.ctx.storage.sql.exec(`INSERT INTO turns (text, confidence) VALUES (?, ?)`, text, conf);
      }
    }
  }

  // Browser -> upstream (binary linear16 PCM frames, or a client text control).
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.upstream) {
      try {
        this.upstream.send(message);
      } catch {
        /* upstream gone */
      }
      return;
    }
    // The DO was evicted mid-session and lost the (non-hibernatable) upstream
    // socket; a flux session can't be resumed, so close cleanly and persist
    // whatever turns we captured.
    try {
      ws.close(1011, "session expired");
    } catch {
      /* */
    }
    await this.finalize();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      this.upstream?.close(sanitizeCloseCode(code), reason);
    } catch {
      /* */
    }
    this.upstream = null;
    await this.finalize();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      this.upstream?.close(1011);
    } catch {
      /* */
    }
    this.upstream = null;
    await this.finalize();
  }

  // Write the accumulated transcript to /history as one chats row. Idempotent:
  // close + error can both fire, but only the first persists.
  private async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const turns = this.ctx.storage.sql
      .exec<{ text: string }>(`SELECT text FROM turns ORDER BY seq`)
      .toArray();
    const transcript = buildTranscript(turns);
    if (!transcript) return; // nothing said; don't litter history with empties

    const meta = Object.fromEntries(
      this.ctx.storage.sql.exec<{ k: string; v: string }>(`SELECT k, v FROM meta`).toArray().map((r) => [r.k, r.v]),
    );
    try {
      // Minimal voice row; chats column defaults cover the rest. conversation_id
      // mirrors persistChat's synthetic single-<id> so the history sidebar groups
      // it as a standalone conversation.
      const inserted = await this.env.DB.prepare(
        `INSERT INTO chats (user_email, model, model_type, system_prompt, user_input, output, status, turn_index)
         VALUES (?, ?, 'voice', NULL, '(live voice session)', ?, 'done', 0) RETURNING id`,
      )
        .bind(meta.user ?? "anonymous", meta.model ?? FLUX_STT_MODEL, transcript)
        .first<{ id: number }>();
      if (inserted?.id != null) {
        await this.env.DB.prepare(`UPDATE chats SET conversation_id = ? WHERE id = ?`)
          .bind(`single-${inserted.id}`, inserted.id)
          .run();
      }
    } catch (err) {
      console.warn("stt-session persist failed:", err instanceof Error ? err.message : String(err));
    }
  }
}
