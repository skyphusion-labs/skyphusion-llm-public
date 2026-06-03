// Pure helpers for the conversational-STT session (v0.108.0). Kept free of the
// `cloudflare:workers` import (which the DO needs) so they're unit-testable in
// the plain node test pool.

// WebSocket.close() only accepts 1000 or 3000-4999; codes like 1006/1011/1005
// arrive on close events but cannot be re-sent. Map anything illegal to 1011 so
// forwarding a peer's close code never throws and leaks the other socket.
export function sanitizeCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
}

// Join committed turns into a single transcript.
export function buildTranscript(turns: Array<{ text: string }>): string {
  return turns
    .map((t) => (t.text || "").trim())
    .filter((t) => t.length > 0)
    .join(" ")
    .trim();
}
