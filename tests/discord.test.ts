import { describe, it, expect } from "vitest";
import { parseDiscordExport, chunkDiscordMessages } from "../src/discord";

// Synthetic DCE-shaped fixture covering the cases most likely to break a
// naive parser: multi-author bursts, a >15-min gap that should split a unit,
// an empty-content attachment-only message, a reply, a bot message, a system
// message (join) that should be skipped, a custom emoji in content, and a
// migrated username (discriminator "0", no nickname).
function makeExport() {
  return {
    guild: { id: "1", name: "MUDD" },
    channel: { id: "10", type: "GuildTextChat", category: "world", name: "lore-discussion", topic: "worldbuilding" },
    dateRange: { after: null, before: null },
    exportedAt: "2024-01-15T13:00:00.000Z",
    messages: [
      {
        id: "100", type: "GuildMemberJoin", timestamp: "2024-01-15T11:59:00.000Z",
        content: "", author: { id: "a", name: "alice", discriminator: "0", nickname: null, isBot: false },
      },
      {
        id: "101", type: "Default", timestamp: "2024-01-15T12:00:00.000Z",
        content: "what's at the bottom of the shaft?",
        author: { id: "a", name: "alice", discriminator: "0", nickname: "Alice", isBot: false },
      },
      {
        id: "102", type: "Default", timestamp: "2024-01-15T12:01:00.000Z",
        content: "an old transit hub, mostly flooded :map:",
        author: { id: "b", name: "bob_the_dm", discriminator: "0", nickname: null, isBot: false },
      },
      {
        id: "103", type: "Reply", timestamp: "2024-01-15T12:02:00.000Z",
        content: "can we drain it?",
        author: { id: "a", name: "alice", discriminator: "0", nickname: "Alice", isBot: false },
        reference: { messageId: "102", channelId: "10", guildId: "1" },
      },
      {
        id: "104", type: "Default", timestamp: "2024-01-15T12:02:30.000Z",
        content: "", // attachment-only, no text -> dropped
        author: { id: "a", name: "alice", discriminator: "0", nickname: "Alice", isBot: false },
        attachments: [{ id: "x", url: "https://cdn/map.png", fileName: "map.png", fileSizeBytes: 1234 }],
      },
      {
        id: "105", type: "Default", timestamp: "2024-01-15T12:03:00.000Z",
        content: "Rolling for flood depth: 14",
        author: { id: "z", name: "DiceBot", discriminator: "0000", nickname: null, isBot: true },
      },
      // >15 min gap -> new conversation unit
      {
        id: "106", type: "Default", timestamp: "2024-01-15T12:45:00.000Z",
        content: "back. so the hub connects to the old rail line",
        author: { id: "b", name: "bob_the_dm", discriminator: "0", nickname: null, isBot: false },
      },
    ],
    messageCount: 7,
  };
}

describe("parseDiscordExport", () => {
  it("parses channel name with category", () => {
    const parsed = parseDiscordExport(makeExport());
    expect(parsed.channel).toBe("world / lore-discussion");
    expect(parsed.guild).toBe("MUDD");
  });

  it("skips system messages and empty-content messages", () => {
    const parsed = parseDiscordExport(makeExport());
    // 7 raw, minus the join (system) and the attachment-only empty message = 5
    expect(parsed.rawCount).toBe(7);
    expect(parsed.parsedCount).toBe(5);
    expect(parsed.messages.map((m) => m.messageId)).toEqual(["101", "102", "103", "105", "106"]);
  });

  it("uses nickname when present, else name", () => {
    const parsed = parseDiscordExport(makeExport());
    const byId = Object.fromEntries(parsed.messages.map((m) => [m.messageId, m]));
    expect(byId["101"].author).toBe("Alice");        // nickname
    expect(byId["102"].author).toBe("bob_the_dm");   // no nickname -> name
  });

  it("marks bot messages", () => {
    const parsed = parseDiscordExport(makeExport());
    const bot = parsed.messages.find((m) => m.messageId === "105");
    expect(bot?.isBot).toBe(true);
  });

  it("keeps reply messages as normal content", () => {
    const parsed = parseDiscordExport(makeExport());
    const reply = parsed.messages.find((m) => m.messageId === "103");
    expect(reply?.content).toBe("can we drain it?");
  });

  it("throws on non-object input", () => {
    expect(() => parseDiscordExport(null)).toThrow(/not a JSON object/);
    expect(() => parseDiscordExport("nope")).toThrow(/not a JSON object/);
  });

  it("throws on missing messages array with a diagnostic message", () => {
    expect(() => parseDiscordExport({ guild: { name: "x" } })).toThrow(/missing 'messages' array/);
  });

  it("handles a channel with no category", () => {
    const exp = makeExport();
    exp.channel = { id: "10", type: "GuildTextChat", category: "", name: "general", topic: "" } as never;
    expect(parseDiscordExport(exp).channel).toBe("general");
  });
});

describe("chunkDiscordMessages", () => {
  it("groups within-gap same-channel messages into one chunk", () => {
    const parsed = parseDiscordExport(makeExport());
    const chunks = chunkDiscordMessages(parsed.messages);
    // First unit: 101,102,103,105 (all within 15 min). Second unit: 106.
    expect(chunks.length).toBe(2);
    expect(chunks[0].messageIds).toEqual(["101", "102", "103", "105"]);
    expect(chunks[1].messageIds).toEqual(["106"]);
  });

  it("includes a channel header and author:timestamp lines", () => {
    const parsed = parseDiscordExport(makeExport());
    const chunks = chunkDiscordMessages(parsed.messages);
    expect(chunks[0].text).toContain("[#world / lore-discussion]");
    expect(chunks[0].text).toContain("Alice (2024-01-15 12:00): what's at the bottom of the shaft?");
    expect(chunks[0].text).toContain("bob_the_dm (2024-01-15 12:01): an old transit hub");
  });

  it("records distinct authors in first-seen order", () => {
    const parsed = parseDiscordExport(makeExport());
    const chunks = chunkDiscordMessages(parsed.messages);
    expect(chunks[0].authors).toEqual(["Alice", "bob_the_dm", "DiceBot"]);
  });

  it("records the time range of the chunk", () => {
    const parsed = parseDiscordExport(makeExport());
    const chunks = chunkDiscordMessages(parsed.messages);
    expect(chunks[0].sentAtStart).toBe("2024-01-15T12:00:00.000Z");
    expect(chunks[0].sentAtEnd).toBe("2024-01-15T12:03:00.000Z");
  });

  it("excludes bot messages when includeBots is false", () => {
    const parsed = parseDiscordExport(makeExport());
    const chunks = chunkDiscordMessages(parsed.messages, { includeBots: false });
    const allIds = chunks.flatMap((c) => c.messageIds);
    expect(allIds).not.toContain("105"); // DiceBot
    expect(allIds).toContain("101");
  });

  it("splits a unit when the gap exceeds the configured threshold", () => {
    const parsed = parseDiscordExport(makeExport());
    // Messages 101,102,103,105 are each 1 min apart; 106 is 42 min later.
    // With the default 15-min threshold they form 2 units. With a sub-minute
    // threshold (0.5 min = 30s), every 1-min gap splits, so each message
    // becomes its own unit: 5 messages -> 5 chunks.
    const chunks = chunkDiscordMessages(parsed.messages, { gapMinutes: 0.5 });
    expect(chunks.length).toBe(5);
  });

  it("never merges across channels", () => {
    const msgs = [
      { messageId: "1", channel: "a", author: "X", authorId: "1", isBot: false, sentAt: "2024-01-15T12:00:00.000Z", content: "hi" },
      { messageId: "2", channel: "b", author: "X", authorId: "1", isBot: false, sentAt: "2024-01-15T12:00:30.000Z", content: "yo" },
    ];
    const chunks = chunkDiscordMessages(msgs);
    expect(chunks.length).toBe(2);
    expect(chunks[0].channel).toBe("a");
    expect(chunks[1].channel).toBe("b");
  });

  it("splits an oversized single message, repeating the header", () => {
    const long = "word ".repeat(500).trim(); // ~2500 chars
    const msgs = [
      { messageId: "1", channel: "c", author: "X", authorId: "1", isBot: false, sentAt: "2024-01-15T12:00:00.000Z", content: long },
    ];
    const chunks = chunkDiscordMessages(msgs, { targetChars: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.startsWith("[#c]")).toBe(true);
      expect(c.text.length).toBeLessThanOrEqual(560); // target + header + prefix slack
    }
  });

  it("returns empty array for empty input", () => {
    expect(chunkDiscordMessages([])).toEqual([]);
  });
});
