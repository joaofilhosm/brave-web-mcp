/**
 * MCP server definition: web search + page reading tools.
 *
 * Search runs on the Brave Search API and falls back to DuckDuckGo when Brave
 * is unavailable. Page reading uses a hardened fetch engine with SSRF guards.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { webSearch } from "./search.js";
import type { BraveSearchType } from "./brave.js";
import { webFetch } from "./fetcher.js";

const resultSchema = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string(),
  age: z.string().optional(),
  source: z.string().optional(),
  thumbnail: z.string().optional(),
});

const DEFAULT_LOCALE = process.env.BRAVE_SEARCH_LANG?.trim() || "pt-br";
const DEFAULT_COUNTRY = process.env.BRAVE_SEARCH_COUNTRY?.trim() || "BR";

function localeOptions(lang?: string, country?: string) {
  return {
    searchLang: lang?.trim() || DEFAULT_LOCALE,
    country: country?.trim() || DEFAULT_COUNTRY,
  };
}

export function setupMCPServer(): McpServer {
  const server = new McpServer(
    { name: "brave-web-mcp", version: "1.0.0" },
    { capabilities: { logging: {} } },
  );

  // ---------------------------------------------------------------------
  // web_search
  // ---------------------------------------------------------------------
  server.registerTool(
    "web_search",
    {
      title: "Web Search",
      description:
        "Search the live web. Uses the Brave Search API and falls back to DuckDuckGo automatically " +
        "when Brave is unavailable. Covers web pages, news, images and videos. " +
        "Always prefer this over answering from memory when facts may have changed. " +
        "For full page text, follow up with web_fetch or use search_and_read.",
      inputSchema: {
        query: z.string().describe("Search keywords, e.g. 'vercel mcp server'"),
        count: z
          .number()
          .describe("Number of results to return, 1..20 (default: 10)")
          .default(10),
        type: z
          .enum(["web", "news", "images", "videos"])
          .describe("Which engine endpoint to query (default: web)")
          .default("web"),
        search_lang: z
          .string()
          .describe("Locale, e.g. 'pt-br', 'en-gb', 'en'. Defaults to the server setting.")
          .optional(),
        country: z
          .string()
          .describe("Two-letter country code, e.g. 'BR', 'US'. Defaults to the server setting.")
          .optional(),
        freshness: z
          .string()
          .describe("Recency filter: 'pd' (24h), 'pw' (7d), 'pm' (31d), 'py' (1y)")
          .optional(),
      },
      outputSchema: {
        query: z.string(),
        engine: z.string(),
        total: z.number(),
        results: z.array(resultSchema),
      },
    },
    async ({ query, count, type, search_lang, country, freshness }) => {
      if (!query || query.trim() === "") {
        return {
          content: [
            { type: "text", text: "Error: query parameter is required and cannot be empty." },
          ],
          isError: true,
        };
      }
      try {
        const outcome = await webSearch(query, type as BraveSearchType, {
          ...localeOptions(search_lang, country),
          count,
          freshness,
        });

        const text =
          outcome.results.length > 0
            ? JSON.stringify(outcome.results, null, 2)
            : `No results found for "${query}".` +
              (outcome.fallbackReason ? ` ${outcome.fallbackReason}` : "");

        return {
          content: [{ type: "text", text }],
          structuredContent: {
            query,
            engine: outcome.engine,
            total: outcome.results.length,
            results: outcome.results,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------
  // web_context
  // ---------------------------------------------------------------------
  server.registerTool(
    "web_context",
    {
      title: "Web Context",
      description:
        "Search the web and return grounding excerpts taken from the top pages themselves. " +
        "Each snippet carries the page title, URL and the first passages of its main content. " +
        "Use this when you need sourced context without pulling full pages. " +
        "For full page content use web_fetch instead.",
      inputSchema: {
        query: z.string().describe("Search keywords to ground the answer"),
        count: z
          .number()
          .describe("How many pages to extract (default: 5, max: 10)")
          .default(5),
        snippet_chars: z
          .number()
          .describe("Characters to keep per page excerpt (default: 1500)")
          .default(1500),
        search_lang: z.string().describe("Locale, e.g. 'pt-br'").optional(),
        country: z.string().describe("Two-letter country code, e.g. 'BR'").optional(),
      },
      outputSchema: {
        query: z.string(),
        engine: z.string(),
        total: z.number(),
        snippets: z.array(
          z.object({
            url: z.string(),
            title: z.string(),
            description: z.string(),
            excerpt: z.string(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ query, count, snippet_chars, search_lang, country }) => {
      if (!query || query.trim() === "") {
        return {
          content: [
            { type: "text", text: "Error: query parameter is required and cannot be empty." },
          ],
          isError: true,
        };
      }
      try {
        const outcome = await webSearch(query, "web", {
          ...localeOptions(search_lang, country),
          count: Math.min(count, 10),
        });

        const snippets = await Promise.all(
          outcome.results.slice(0, Math.min(count, 10)).map(async (result) => {
            try {
              const page = await webFetch(result.url, {
                maxCharSize: snippet_chars,
                timeoutMs: 12000,
              });
              return {
                url: result.url,
                title: result.title,
                description: result.description,
                excerpt: page.content.slice(0, snippet_chars),
              };
            } catch (e) {
              // A blocked or unreachable page still contributes its search description.
              return {
                url: result.url,
                title: result.title,
                description: result.description,
                excerpt: "",
                error: (e as Error).message,
              };
            }
          }),
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { query, engine: outcome.engine, total: snippets.length, snippets },
                null,
                2,
              ),
            },
          ],
          structuredContent: {
            query,
            engine: outcome.engine,
            total: snippets.length,
            snippets,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------
  // web_fetch
  // ---------------------------------------------------------------------
  server.registerTool(
    "web_fetch",
    {
      title: "Web Fetch",
      description:
        "Fetch a web page and return its main content as clean Markdown. " +
        "Scripts, styles, navigation and footers are stripped; the main article body is extracted. " +
        "Use this to read a URL returned by web_search. Binary content (PDF, images) is rejected.",
      inputSchema: {
        url: z.string().describe("The absolute http(s) URL to fetch"),
        max_char_size: z
          .number()
          .describe("Maximum number of characters to return (default: 50000)")
          .default(50000),
        simplify: z
          .boolean()
          .describe("Convert to Markdown and extract the main content (default: true)")
          .default(true),
        timeout_ms: z
          .number()
          .describe("Timeout in milliseconds (default: 15000, max: 30000)")
          .optional(),
      },
      outputSchema: {
        url: z.string(),
        final_url: z.string(),
        content_length: z.number(),
        content: z.string(),
      },
    },
    async ({ url, max_char_size, simplify, timeout_ms }) => {
      if (!url || url.trim() === "") {
        return {
          content: [
            { type: "text", text: "Error: url parameter is required and cannot be empty." },
          ],
          isError: true,
        };
      }
      try {
        const outcome = await webFetch(url, {
          maxCharSize: max_char_size,
          simplify,
          timeoutMs: Math.min(timeout_ms ?? 15000, 30000),
        });
        return {
          content: [{ type: "text", text: outcome.content }],
          structuredContent: {
            url: outcome.url,
            final_url: outcome.finalUrl,
            content_length: outcome.content.length,
            content: outcome.content,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------
  // search_and_read
  // ---------------------------------------------------------------------
  server.registerTool(
    "search_and_read",
    {
      title: "Search and Read",
      description:
        "Search the web and immediately fetch the top results, returning both the result list and the " +
        "page contents as Markdown. Best for research questions that need real sources, in a single tool " +
        "call instead of web_search followed by many web_fetch calls.",
      inputSchema: {
        query: z.string().describe("Search keywords"),
        pages: z
          .number()
          .describe("How many top results to fetch (default: 3, max: 5)")
          .default(3),
        max_char_size: z
          .number()
          .describe("Max characters per page (default: 20000)")
          .default(20000),
        search_lang: z.string().describe("Locale, e.g. 'pt-br'").optional(),
        country: z.string().describe("Two-letter country code, e.g. 'BR'").optional(),
      },
      outputSchema: {
        query: z.string(),
        engine: z.string(),
        total: z.number(),
        results: z.array(resultSchema),
        pages: z.array(
          z.object({
            url: z.string(),
            title: z.string(),
            content: z.string(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ query, pages, max_char_size, search_lang, country }) => {
      if (!query || query.trim() === "") {
        return {
          content: [
            { type: "text", text: "Error: query parameter is required and cannot be empty." },
          ],
          isError: true,
        };
      }
      try {
        const outcome = await webSearch(query, "web", {
          ...localeOptions(search_lang, country),
          count: pages,
        });

        const fetched = await Promise.all(
          outcome.results.slice(0, Math.min(pages, 5)).map(async (result) => {
            try {
              const page = await webFetch(result.url, { maxCharSize: max_char_size });
              return { url: result.url, title: result.title, content: page.content };
            } catch (e) {
              return {
                url: result.url,
                title: result.title,
                content: "",
                error: (e as Error).message,
              };
            }
          }),
        );

        const payload = {
          query,
          engine: outcome.engine,
          total: outcome.results.length,
          results: outcome.results,
          pages: fetched,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
