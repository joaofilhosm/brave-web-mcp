/**
 * Unified web search: Brave Search API first, DuckDuckGo as fallback.
 *
 * Brave is the reliable engine (official API, structured results). DuckDuckGo
 * is scraped and therefore best-effort, so it only runs when Brave cannot
 * answer: no API key configured, quota exhausted, or an upstream error.
 *
 * The returned "engine" field tells the caller which one produced the results.
 */

import { braveSearch, type BraveSearchOptions, type BraveSearchType } from "./brave.js";
import { duckduckgoSearch } from "./duckduckgo.js";

export type SearchEngine = "brave" | "duckduckgo";

export interface SearchHit {
  title: string;
  url: string;
  description: string;
  age?: string;
  source?: string;
  thumbnail?: string;
}

export interface SearchOutcome {
  query: string;
  engine: SearchEngine;
  results: SearchHit[];
  /** Populated when the primary engine failed and the fallback was used. */
  fallbackReason?: string;
}

export function hasBraveKey(): boolean {
  return Boolean(process.env.BRAVE_API_KEY?.trim());
}

function dedupe(results: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const item of results) {
    if (!item.url) continue;
    let key: string;
    try {
      const parsed = new URL(item.url);
      key = (parsed.hostname.replace(/^www\./, "") + parsed.pathname.replace(/\/+$/, "")).toLowerCase();
    } catch {
      key = item.url.toLowerCase();
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Searches the web. Brave is tried first whenever it is configured; DuckDuckGo
 * takes over if Brave is missing, failing, or returns nothing usable.
 */
export async function webSearch(
  query: string,
  type: BraveSearchType = "web",
  options: BraveSearchOptions & { count?: number } = {},
): Promise<SearchOutcome> {
  const count = Math.min(Math.max(options.count ?? 10, 1), 20);

  if (hasBraveKey()) {
    try {
      const results = await braveSearch(query, type, { ...options, count });
      if (results.length > 0) {
        return { query, engine: "brave", results: dedupe(results) };
      }
      // Brave answered but with nothing: fall through to the backup engine.
      const fallback = await duckduckgoSearch(query, count);
      if (fallback.length > 0) {
        return {
          query,
          engine: "duckduckgo",
          results: fallback,
          fallbackReason: "Brave returned no results for this query.",
        };
      }
      return { query, engine: "brave", results: [] };
    } catch (error) {
      const reason = (error as Error).message;
      const fallback = await duckduckgoSearch(query, count);
      if (fallback.length > 0) {
        return {
          query,
          engine: "duckduckgo",
          results: fallback,
          fallbackReason: `Brave Search failed: ${reason}`,
        };
      }
      throw new Error(
        `Both search engines failed. Brave: ${reason}. DuckDuckGo: no results returned.`,
      );
    }
  }

  // No Brave key: DuckDuckGo is the only option.
  const fallback = await duckduckgoSearch(query, count);
  if (fallback.length > 0) {
    return {
      query,
      engine: "duckduckgo",
      results: fallback,
      fallbackReason: "BRAVE_API_KEY is not configured; using DuckDuckGo.",
    };
  }
  return {
    query,
    engine: "duckduckgo",
    results: [],
    fallbackReason:
      "BRAVE_API_KEY is not configured and DuckDuckGo returned no results (it may be rate limited).",
  };
}
