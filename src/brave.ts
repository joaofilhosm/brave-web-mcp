/**
 * Brave Search API client.
 *
 * Docs: https://api-dashboard.search.brave.com/app/documentation/web-search
 *
 * Notes learned from live testing:
 * - The API rejects the `Accept: application/json` header (422). Only `Accept-Encoding` is safe.
 * - `search_lang` uses values like `pt-br`, `pt-pt`, `en-gb` — plain `pt` is invalid.
 * - Auth is the `X-Subscription-Token` header.
 */

const BRAVE_BASE = "https://api.search.brave.com/res/v1";

export type BraveSearchType = "web" | "news" | "images" | "videos";

export interface BraveSearchOptions {
  /** Brave locale, e.g. `pt-br`, `en-gb`, `en`. */
  searchLang?: string;
  /** Two-letter country code, e.g. `BR`, `US`. */
  country?: string;
  /** 1..20 */
  count?: number;
  /** e.g. `pd` (24h), `pw` (7d), `pm` (31d), `py` (1y). */
  freshness?: string;
  /** Extra Brave query params. */
  extra?: Record<string, string>;
}

export interface BraveResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  source?: string;
  thumbnail?: string;
}

function apiKey(): string {
  const key = process.env.BRAVE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "BRAVE_API_KEY is not set. Add it as an environment variable in your deployment.",
    );
  }
  return key;
}

function buildUrl(type: BraveSearchType, query: string, opts: BraveSearchOptions): string {
  const url = new URL(`${BRAVE_BASE}/${type}/search`);
  url.searchParams.set("q", query);

  const count = Math.min(Math.max(opts.count ?? 10, 1), 20);
  url.searchParams.set("count", String(count));

  if (opts.searchLang) url.searchParams.set("search_lang", opts.searchLang);
  if (opts.country) url.searchParams.set("country", opts.country);
  if (opts.freshness) url.searchParams.set("freshness", opts.freshness);

  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

async function braveFetch<T>(url: string, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "X-Subscription-Token": apiKey(),
        // NOTE: do not add "Accept: application/json" — Brave returns 422 for it.
        "Accept-Encoding": "gzip",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Brave Search API returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}. ${body.slice(0, 400)}`,
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Brave Search API timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface RawBraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  source?: string;
  thumbnail?: { src?: string };
  properties?: { thumbnail?: { src?: string } };
}

interface RawBraveResponse {
  /** /web/search nests results under a bucket. */
  web?: { results?: RawBraveResult[] };
  mixed?: { results?: RawBraveResult[] };
  videos?: { results?: RawBraveResult[] };
  /** /news/search and /images/search return results at the root of the payload. */
  results?: RawBraveResult[];
}

/**
 * Brave returns results in different shapes depending on the endpoint:
 * - /web/search  -> payload.web.results (or payload.mixed.results)
 * - /news/search -> payload.results
 * - /images/search -> payload.results
 * - /videos/search -> payload.results
 */
function collectResults(payload: RawBraveResponse, type: BraveSearchType): RawBraveResult[] {
  if (type === "web") {
    return payload.web?.results ?? payload.mixed?.results ?? [];
  }
  if (type === "videos") {
    return payload.videos?.results ?? payload.results ?? [];
  }
  return payload.results ?? [];
}

function normalize(raw: RawBraveResult): BraveResult {
  return {
    title: raw.title ?? "",
    url: raw.url ?? "",
    description: raw.description ?? "",
    age: raw.age,
    source: raw.source,
    thumbnail: raw.thumbnail?.src ?? raw.properties?.thumbnail?.src,
  };
}

/**
 * Runs a Brave search and returns normalized results.
 * `type` selects the endpoint (web / news / images / videos).
 */
export async function braveSearch(
  query: string,
  type: BraveSearchType = "web",
  options: BraveSearchOptions = {},
): Promise<BraveResult[]> {
  const url = buildUrl(type, query, options);
  const payload = await braveFetch<RawBraveResponse>(url);
  return collectResults(payload, type).map(normalize);
}
