// DiscordChatExporter (DCE) JSON parsing + conversation-aware chunking (v0.20.3).
//
// DCE's JSON export is a single top-level object:
//   {
//     guild:   { id, name, iconUrl },
//     channel: { id, type, categoryId, category, name, topic },
//     dateRange: { after, before },
//     exportedAt: "ISO8601",
//     messages: [ { ...per message... } ],
//     messageCount: N
//   }
//
// Per message (fields this module relies on):
//   id           Discord snowflake (string)
//   type         "Default" | "Reply" | system kinds ("ThreadCreated",
//                "ChannelPinnedMessage", "GuildMemberJoin", "Call", ...)
//   timestamp    ISO8601 string
//   content      message text (markdown-processed when exported WITHOUT
//                --markdown false, which is what we want for RAG: mentions
//                render as @name, custom emoji as :name:)
//   author       { id, name, discriminator, nickname, isBot, ... }
//   attachments  [ { id, url, fileName, fileSizeBytes } ]
//
// Schema verified against the JsonMessageWriter source and the documented
// CSV column set (AuthorID, Author=FullName, Date, Content, ...) as of the
// Feb 2026 DCE index. The parser is defensive: it validates the top-level
// shape on entry and throws a clear error naming the problem rather than
// producing garbage. Real exports may carry version-specific quirks
// (migrated usernames with discriminator "0", thread/forum channels as
// separate channel objects); those are handled below.

// ---------- Public types ----------

export interface DiscordMessage {
  messageId: string;
  channel: string;       // hierarchical channel name (category / name when both present)
  author: string;        // display name: nickname when set, else name
  authorId: string | null;
  isBot: boolean;
  sentAt: string;        // ISO8601 (raw from the export)
  content: string;       // trimmed text content
}

export interface DiscordChunk {
  text: string;          // formatted transcript with a channel header
  channel: string;
  authors: string[];     // distinct authors in first-seen order
  sentAtStart: string;   // ISO8601 of earliest message in the chunk
  sentAtEnd: string;     // ISO8601 of latest message in the chunk
  messageIds: string[];  // source message ids, for traceability
}

export interface ParsedDiscordExport {
  guild: string;
  channel: string;
  messages: DiscordMessage[];
  // Counts for the ingestion summary. parsedCount is messages kept after
  // filtering system/empty messages; rawCount is the export's message total.
  rawCount: number;
  parsedCount: number;
}

export interface ChunkOptions {
  gapMinutes?: number;   // gap that starts a new conversation unit (default 15)
  targetChars?: number;  // soft cap per chunk (default 1000; larger than the
                         // 500-char document default since conversation units
                         // benefit from more surrounding context)
  includeBots?: boolean; // keep bot messages (default true)
}

// DCE message `type` values we treat as real conversation content. Everything
// else (joins, pins, thread-created, calls, recipient add/remove, channel
// name/icon changes, etc.) is a system notification and is skipped.
const CONTENT_MESSAGE_TYPES = new Set(["Default", "Reply"]);

const DEFAULT_GAP_MINUTES = 15;
const DEFAULT_TARGET_CHARS = 1000;

// ---------- Parser ----------

/**
 * Parse a DCE JSON export (already JSON.parse'd into an object) into
 * normalized messages. Throws on a shape that doesn't look like a DCE
 * export, with an error message naming the missing/wrong field so a real
 * export that differs is diagnosable rather than silently mangled.
 *
 * Filtering:
 *  - System messages (type not in CONTENT_MESSAGE_TYPES) are dropped.
 *  - Messages whose content is empty after trim are dropped (attachment-only
 *    or embed-only messages carry no text for retrieval). This is a
 *    deliberate v0.20.3 simplification; representing attachments as
 *    "[attachment: name]" is a possible future refinement.
 */
export function parseDiscordExport(raw: unknown): ParsedDiscordExport {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Discord export is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.messages)) {
    throw new Error("Discord export missing 'messages' array (is this a DiscordChatExporter JSON export?)");
  }

  const channelName = resolveChannelName(obj.channel);
  const guildName = resolveGuildName(obj.guild);

  const messages: DiscordMessage[] = [];
  for (const m of obj.messages as unknown[]) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as Record<string, unknown>;

    const type = typeof msg.type === "string" ? msg.type : "Default";
    if (!CONTENT_MESSAGE_TYPES.has(type)) continue;

    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!content) continue;

    const messageId = typeof msg.id === "string" ? msg.id : String(msg.id ?? "");
    const sentAt = typeof msg.timestamp === "string" ? msg.timestamp : "";
    if (!sentAt) continue; // a message with no timestamp can't be ordered or filtered

    const author = msg.author;
    let authorName = "Unknown";
    let authorId: string | null = null;
    let isBot = false;
    if (typeof author === "object" && author !== null) {
      const a = author as Record<string, unknown>;
      // Display name: nickname when present and non-empty, else name. The
      // discriminator ("1234", or "0" for migrated usernames) isn't used
      // for display.
      const nickname = typeof a.nickname === "string" ? a.nickname.trim() : "";
      const name = typeof a.name === "string" ? a.name.trim() : "";
      authorName = nickname || name || "Unknown";
      authorId = typeof a.id === "string" ? a.id : (a.id != null ? String(a.id) : null);
      isBot = a.isBot === true;
    }

    messages.push({
      messageId,
      channel: channelName,
      author: authorName,
      authorId,
      isBot,
      sentAt,
      content,
    });
  }

  return {
    guild: guildName,
    channel: channelName,
    messages,
    rawCount: (obj.messages as unknown[]).length,
    parsedCount: messages.length,
  };
}

function resolveChannelName(channel: unknown): string {
  if (typeof channel !== "object" || channel === null) return "unknown-channel";
  const c = channel as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim() : "";
  const category = typeof c.category === "string" ? c.category.trim() : "";
  if (name && category) return `${category} / ${name}`;
  return name || "unknown-channel";
}

function resolveGuildName(guild: unknown): string {
  if (typeof guild !== "object" || guild === null) return "unknown-guild";
  const g = guild as Record<string, unknown>;
  return typeof g.name === "string" && g.name.trim() ? g.name.trim() : "unknown-guild";
}

// ---------- Chunker ----------

/**
 * Group normalized messages into conversation-aware chunks. A new chunk
 * starts when the channel changes or when the gap since the previous
 * message exceeds gapMinutes. Within a unit, messages are formatted as a
 * readable transcript with a channel header:
 *
 *   [#general]
 *   Alice (2024-01-15 12:00): what's at the bottom of the shaft?
 *   Bob (2024-01-15 12:01): an old transit hub, mostly flooded
 *
 * Units larger than targetChars are split on message boundaries, repeating
 * the channel header on each piece. A single message longer than targetChars
 * is hard-split (its author prefix stays on the first piece only).
 */
export function chunkDiscordMessages(
  messages: DiscordMessage[],
  opts: ChunkOptions = {},
): DiscordChunk[] {
  const gapMinutes = opts.gapMinutes ?? DEFAULT_GAP_MINUTES;
  const targetChars = opts.targetChars ?? DEFAULT_TARGET_CHARS;
  const includeBots = opts.includeBots ?? true;

  const filtered = includeBots ? messages : messages.filter((m) => !m.isBot);
  if (filtered.length === 0) return [];

  // Sort by timestamp ascending. DCE exports are already chronological, but
  // be defensive (a hand-merged file might not be). Stable sort on ISO
  // strings is a lexical sort, which is correct for ISO8601.
  const sorted = [...filtered].sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0));

  // Partition into conversation units by channel boundary + time gap.
  const units: DiscordMessage[][] = [];
  let current: DiscordMessage[] = [];
  for (const msg of sorted) {
    if (current.length === 0) {
      current.push(msg);
      continue;
    }
    const prev = current[current.length - 1];
    const sameChannel = prev.channel === msg.channel;
    const withinGap = minutesBetween(prev.sentAt, msg.sentAt) <= gapMinutes;
    if (sameChannel && withinGap) {
      current.push(msg);
    } else {
      units.push(current);
      current = [msg];
    }
  }
  if (current.length) units.push(current);

  // Format each unit into one or more chunks, splitting on message
  // boundaries when the formatted transcript exceeds targetChars.
  const chunks: DiscordChunk[] = [];
  for (const unit of units) {
    chunks.push(...formatUnit(unit, targetChars));
  }
  return chunks;
}

function minutesBetween(isoA: string, isoB: string): number {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(b - a) / 60000;
}

// Compact, human-readable timestamp for the transcript body: "YYYY-MM-DD HH:MM".
// The raw ISO timestamp is preserved in chunk metadata; this is display only.
function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function channelHeader(channel: string): string {
  return `[#${channel}]`;
}

/**
 * Format one conversation unit (all same channel, within-gap messages) into
 * chunks. Lines are "Author (timestamp): content". The channel header leads
 * each chunk. Splits on message boundaries to stay near targetChars; a
 * single oversized message is hard-split.
 */
function formatUnit(unit: DiscordMessage[], targetChars: number): DiscordChunk[] {
  const channel = unit[0].channel;
  const header = channelHeader(channel);
  const out: DiscordChunk[] = [];

  let lines: string[] = [];
  let bufMessages: DiscordMessage[] = [];
  let bufLen = header.length;

  const flush = () => {
    if (bufMessages.length === 0) return;
    const text = `${header}\n${lines.join("\n")}`;
    out.push(buildChunk(channel, bufMessages, text));
    lines = [];
    bufMessages = [];
    bufLen = header.length;
  };

  for (const msg of unit) {
    const prefix = `${msg.author} (${formatTimestamp(msg.sentAt)}): `;
    const line = prefix + msg.content;

    // A single message whose line alone exceeds targetChars: flush whatever
    // is buffered, then hard-split this message across its own chunks.
    if (prefix.length + msg.content.length > targetChars) {
      flush();
      const pieces = hardSplit(msg.content, targetChars - prefix.length);
      for (let i = 0; i < pieces.length; i++) {
        const pieceLine = (i === 0 ? prefix : `${msg.author} (cont.): `) + pieces[i];
        const text = `${header}\n${pieceLine}`;
        out.push(buildChunk(channel, [msg], text));
      }
      continue;
    }

    // Starting a new line would overflow the target: flush first.
    if (bufMessages.length > 0 && bufLen + 1 + line.length > targetChars) {
      flush();
    }
    lines.push(line);
    bufMessages.push(msg);
    bufLen += 1 + line.length;
  }
  flush();

  return out;
}

function buildChunk(channel: string, msgs: DiscordMessage[], text: string): DiscordChunk {
  // Distinct authors in first-seen order.
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const m of msgs) {
    if (!seen.has(m.author)) {
      seen.add(m.author);
      authors.push(m.author);
    }
  }
  // Time range across the messages in this chunk (min/max by ISO lexical order).
  let start = msgs[0].sentAt;
  let end = msgs[0].sentAt;
  for (const m of msgs) {
    if (m.sentAt < start) start = m.sentAt;
    if (m.sentAt > end) end = m.sentAt;
  }
  return {
    text,
    channel,
    authors,
    sentAtStart: start,
    sentAtEnd: end,
    messageIds: msgs.map((m) => m.messageId),
  };
}

// Hard-split a long single message's content into <= size pieces, preferring
// to break on whitespace near the boundary so words aren't sliced.
function hardSplit(text: string, size: number): string[] {
  if (size <= 0) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = size;
    // Look back up to 80 chars for a space to break on.
    const window = remaining.slice(0, size);
    const lastSpace = window.lastIndexOf(" ");
    if (lastSpace > size - 80 && lastSpace > 0) cut = lastSpace;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}
