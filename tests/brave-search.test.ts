import { describe, it, expect } from "vitest";
import { mapBraveWebResults } from "../src/brave-search";

describe("mapBraveWebResults", () => {
  it("maps web.results into title/url/snippet hits", () => {
    const data = {
      web: {
        results: [
          { title: "Example", url: "https://example.com/a", description: "First hit." },
          { title: "Other", url: "https://example.com/b", description: "Second hit." },
        ],
      },
    };
    expect(mapBraveWebResults(data, 5)).toEqual([
      { title: "Example", url: "https://example.com/a", snippet: "First hit." },
      { title: "Other", url: "https://example.com/b", snippet: "Second hit." },
    ]);
  });

  it("drops rows missing title or url and respects maxResults", () => {
    const data = {
      web: {
        results: [
          { title: "Keep", url: "https://example.com/keep", description: "ok" },
          { title: "No URL", description: "skip" },
          { url: "https://example.com/no-title", description: "skip" },
          { title: "Third", url: "https://example.com/third", description: "ok" },
        ],
      },
    };
    expect(mapBraveWebResults(data, 1)).toEqual([
      { title: "Keep", url: "https://example.com/keep", snippet: "ok" },
    ]);
  });

  it("returns an empty array when web.results is missing", () => {
    expect(mapBraveWebResults({}, 5)).toEqual([]);
    expect(mapBraveWebResults({ web: {} }, 5)).toEqual([]);
  });
});
