// Brave Search API web retrieval (v0.164.0).
//
// Optional web-search source alongside Tavily and Wikipedia. Uses the Web
// Search endpoint documented at https://api.search.brave.com/app/documentation.

export interface BraveSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export function mapBraveWebResults(data: unknown, maxResults: number): BraveSearchHit[] {
  const root = data as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const items = root.web?.results ?? [];
  return items
    .filter((r) => r.url && r.title)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      snippet: normalizeBraveSnippet(r.description ?? ""),
    }));
}

function normalizeBraveSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function searchBraveWeb(
  apiKey: string,
  query: string,
  opts: { maxResults: number; timeoutMs: number },
): Promise<BraveSearchHit[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(20, Math.max(1, opts.maxResults))));
  url.searchParams.set("text_decorations", "false");

  const resp = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`Brave ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data: unknown = await resp.json();
  return mapBraveWebResults(data, opts.maxResults);
}
