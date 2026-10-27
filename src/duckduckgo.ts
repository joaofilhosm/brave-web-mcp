/**
 * DuckDuckGo fallback search.
 *
 * Used when the Brave API is unavailable (missing key, quota exhausted, upstream
 * error). DuckDuckGo has no official API, so this scrapes the HTML endpoint and
 * parses the result blocks. It is best-effort by nature: the endpoint can
 * answer with an anti-bot challenge, so every parser checks for that and the
 * caller falls back gracefully.
 *
 * Adapted from sunwu51/orz-mcp (MIT).
 */

const DDG_FALLBACK_URLS = [
  "https://html.duckduckgo.com/html/",
  "https://duckduckgo.com/html/",
  "https://lite.duckduckgo.com/lite/",
];

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Referer: "https://duckduckgo.com/",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-User": "?1",
};

export interface DdgResult {
  title: string;
  url: string;
  description: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function isChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("anomaly-modal") ||
    lower.includes("please complete the following challenge") ||
    lower.includes("bots use duckduckgo too") ||
    lower.includes("making sure you") ||
    lower.includes("security check") ||
    lower.includes("verifying your browser")
  );
}

/** DuckDuckGo wraps outbound links in /l/?uddg=<encoded-url>. */
function unwrapUrl(raw: string): string {
  let url = raw;
  if (url.startsWith("//")) url = "https:" + url;
  if (url.includes("uddg=")) {
    const encoded = url.split("uddg=")[1]?.split("&")[0] ?? "";
    const decoded = decodeURIComponent(encoded);
    if (decoded) url = decoded;
  }
  return url;
}

function parseHtmlResults(html: string): DdgResult[] {
  const results: DdgResult[] = [];

  // Standard layout: a.result__a + a.result__snippet
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: Array<{ rawUrl: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ rawUrl: decodeEntities(m[1]), title: stripHtml(m[2]) });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]));
  }

  for (let i = 0; i < links.length; i++) {
    const url = unwrapUrl(links[i].rawUrl);
    const title = links[i].title;
    if (!url || !title) continue;
    if (url.includes("duckduckgo.com/y.js")) continue;
    results.push({
      url,
      title,
      description: i < snippets.length ? snippets[i] : "",
    });
  }

  if (results.length > 0) return results;

  // Lite layout: a.result-link + td.result-snippet
  const liteLinkRe = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const liteSnipRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  const liteLinks: Array<{ rawUrl: string; title: string }> = [];
  while ((m = liteLinkRe.exec(html)) !== null) {
    liteLinks.push({ rawUrl: decodeEntities(m[1]), title: stripHtml(m[2]) });
  }
  const liteSnips: string[] = [];
  while ((m = liteSnipRe.exec(html)) !== null) {
    liteSnips.push(stripHtml(m[1]));
  }
  for (let i = 0; i < liteLinks.length; i++) {
    const url = unwrapUrl(liteLinks[i].rawUrl);
    if (!url || !liteLinks[i].title) continue;
    results.push({
      url,
      title: liteLinks[i].title,
      description: i < liteSnips.length ? liteSnips[i] : "",
    });
  }

  return results;
}

/**
 * Best-effort DuckDuckGo search. Returns an empty array when every endpoint
 * answers with an anti-bot challenge or fails.
 */
export async function duckduckgoSearch(
  query: string,
  count = 8,
  timeoutMs = 8000,
): Promise<DdgResult[]> {
  for (const base of DDG_FALLBACK_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(base);
      url.searchParams.set("q", query);
      url.searchParams.set("kl", "wt-wt");

      const response = await fetch(url.toString(), {
        headers: BROWSER_HEADERS,
        signal: controller.signal,
        redirect: "follow",
      });

      if (!response.ok) continue;
      const html = await response.text();
      if (isChallenge(html)) continue;

      const parsed = parseHtmlResults(html);
      if (parsed.length > 0) {
        return parsed.slice(0, count);
      }
    } catch {
      // Try the next endpoint.
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}
