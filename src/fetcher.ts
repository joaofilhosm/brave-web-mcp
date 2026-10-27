/**
 * Web fetch engine: retrieves a page and converts it to clean Markdown.
 *
 * The SSRF protection is essential here: the /mcp endpoint is publicly reachable,
 * so web_fetch must never be usable to read loopback, link-local (cloud metadata)
 * or private network addresses. Every redirect hop is validated before use, and
 * DNS resolution is re-checked at connect time to block DNS rebinding.
 *
 * Adapted from sunwu51/orz-mcp (MIT).
 */

import dns from "node:dns";
import net from "node:net";
import TurndownService from "turndown";
// @ts-ignore -- turndown-plugin-gfm ships no type declarations
import { gfm } from "turndown-plugin-gfm";
import { Agent, fetch as undiciFetch } from "undici";

// ============================================================================
// Config
// ============================================================================

const MAX_REDIRECT_HOPS = 5;
const MAX_REFRESH_HOPS = 2;
const DEFAULT_TIMEOUT_MS = 15000;

const ALLOWED_PRIVATE_HOSTS = new Set(
  (process.env.FETCH_ALLOW_PRIVATE_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

// ============================================================================
// SSRF protection
// ============================================================================

const privateRanges = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  privateRanges.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 (can embed a private IPv4)
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 (can embed a private IPv4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  privateRanges.addSubnet(addr, prefix, "ipv6");
}

/** IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) match the IPv4 ranges. */
function isPrivateIp(ip: string): boolean {
  const family = net.isIPv6(ip) ? "ipv6" : "ipv4";
  return privateRanges.check(ip, family);
}

function blockedError(host: string): Error {
  return new Error(
    `Blocked: "${host}" is a private or internal address and cannot be fetched.`,
  );
}

/** Validate scheme and destination of one request URL. */
async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Blocked: unsupported URL scheme "${url.protocol}" (only http and https).`,
    );
  }

  // WHATWG URL already normalises decimal/hex/octal IPv4 forms to dotted quad.
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (ALLOWED_PRIVATE_HOSTS.has(host)) return;

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw blockedError(host);
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw blockedError(host);
    return;
  }

  const addresses = await dns.promises.lookup(host, { all: true });
  if (addresses.some((a) => isPrivateIp(a.address))) throw blockedError(host);
}

/** Connect-time DNS check, so a name cannot resolve public now and private later. */
function guardedLookup(
  hostname: string,
  options: any,
  callback: (...args: any[]) => void,
) {
  dns.lookup(hostname, options, (err: any, address: any, family: any) => {
    if (err) return callback(err, address, family);
    const list: Array<{ address: string }> = Array.isArray(address)
      ? address
      : [{ address }];
    if (
      !ALLOWED_PRIVATE_HOSTS.has(hostname.toLowerCase()) &&
      list.some((a) => isPrivateIp(a.address))
    ) {
      return callback(blockedError(hostname));
    }
    callback(null, address, family);
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup as any } });

// ============================================================================
// HTML → Markdown
// ============================================================================

const PAIRED_NOISE_TAGS = [
  "script",
  "style",
  "iframe",
  "noscript",
  "svg",
  "object",
  "embed",
  "applet",
  "head",
  "nav",
  "footer",
  "aside",
];
const VOID_NOISE_TAGS = ["meta", "link"];

function removeUselessTags(html: string): string {
  let cleaned = html;
  for (const tag of PAIRED_NOISE_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}(?=[\\s/>])[^>]*\\/>`, "gi"), "");
    cleaned = cleaned.replace(
      new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
      "",
    );
  }
  for (const tag of VOID_NOISE_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}(?=[\\s/>])[^>]*>`, "gi"), "");
  }
  return cleaned.replace(/<!--[\s\S]*?-->/g, "");
}

function decodeHtmlEntities(text: string): string {
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

function htmlToMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.use(gfm);
  // The default rule only handles <pre><code>; a bare <pre> loses its line breaks.
  service.addRule("preBlock", {
    filter: "pre",
    replacement: (_content: string, node: any) => {
      const cls: string =
        node.querySelector?.("code")?.getAttribute("class") ||
        node.getAttribute("class") ||
        "";
      const lang = cls.match(/(?:language|lang)-([\w+#-]+)/)?.[1] ?? "";
      const text = String(node.textContent ?? "").replace(/\n$/, "");
      const fence = text.includes("```") ? "~~~" : "```";
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });
  service.remove(["script", "style", "iframe", "noscript", "svg", "nav", "footer"]);

  try {
    let md = service.turndown(html);
    md = md.replace(/\n{3,}/g, "\n\n");
    md = md.replace(/[ \t]+$/gm, "");
    return md.trim();
  } catch {
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

/**
 * Find the first element matching openRe (group 1 captures the tag name), starting
 * at `from`, pairing its closing tag by same-name nesting depth.
 */
function findBalanced(
  html: string,
  openRe: RegExp,
  from = 0,
): { inner: string; end: number } | null {
  const open = new RegExp(openRe.source, openRe.flags.replace("g", "") + "g");
  open.lastIndex = from;
  const m = open.exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const start = m.index + m[0].length;
  const tagRe = new RegExp(`<(\\/?)${tag}(?=[\\s/>])[^>]*>`, "gi");
  tagRe.lastIndex = start;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(html)) !== null) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) {
      return { inner: html.slice(start, t.index), end: t.index + t[0].length };
    }
  }
  return { inner: html.slice(start), end: html.length };
}

function visibleTextLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
}

function extractMainContent(html: string): string {
  const body = findBalanced(html, /<(body)\b[^>]*>/i)?.inner ?? html;
  const bodyLen = visibleTextLength(body);

  let candidate: string | null = findBalanced(html, /<(main)\b[^>]*>/i)?.inner ?? null;

  if (candidate === null) {
    // Without <main>, keep every <article> (listing pages use one per entry).
    const articles: string[] = [];
    let pos = 0;
    for (let a; (a = findBalanced(html, /<(article)\b[^>]*>/i, pos)); pos = a.end) {
      articles.push(a.inner);
    }
    if (articles.length > 0) candidate = articles.join("\n");
  }

  if (candidate === null) {
    candidate =
      findBalanced(
        html,
        /<(div|section)\b[^>]*(?:\bid=["'](?:content|main-content|main)["']|\brole=["']main["'])[^>]*>/i,
      )?.inner ?? null;
  }

  // If the candidate has almost no text (e.g. it matched a single card), use the whole body.
  if (candidate !== null) {
    const len = visibleTextLength(candidate);
    if (len >= 200 || len >= bodyLen * 0.3) return candidate;
  }
  return body;
}

/** Target of <meta http-equiv="refresh">; ignored when the page already has real content. */
function findMetaRefresh(html: string, baseUrl: string): string | null {
  const tag = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i)?.[0];
  if (!tag) return null;
  const content = tag.match(/content=(["'])([\s\S]*?)\1/i)?.[2];
  const target = content?.match(/url\s*=\s*['"]?([^'";]+)/i)?.[1]?.trim();
  if (!target) return null;
  if (visibleTextLength(removeUselessTags(html)) >= 500) return null;
  try {
    const next = new URL(decodeHtmlEntities(target), baseUrl);
    if (!/^https?:$/.test(next.protocol) || next.href === baseUrl) return null;
    return next.href;
  } catch {
    return null;
  }
}

/** Binary types (PDF, images, archives...) cannot be converted: fail loudly. */
function isTextContentType(contentType: string): boolean {
  if (!contentType) return true;
  return /^text\/|json|xml|javascript|yaml|toml|markdown|x-www-form-urlencoded/i.test(
    contentType,
  );
}

function httpError(resp: Response): Error {
  let msg = `HTTP ${resp.status}${resp.statusText ? `: ${resp.statusText}` : ""}`;
  if ([401, 403, 429, 503].includes(resp.status)) {
    msg += " (the site refused the request; it may block automated access)";
  }
  return new Error(msg);
}

// ============================================================================
// Fetch
// ============================================================================

/** GET with manual redirect handling so every hop is validated. */
async function safeFetch(
  startUrl: string,
  signal: AbortSignal,
): Promise<{ resp: Response; finalUrl: string }> {
  let current: URL;
  try {
    current = new URL(startUrl);
  } catch {
    throw new Error(`Invalid URL: "${startUrl}"`);
  }

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    await assertPublicHttpUrl(current);

    let resp: Response;
    try {
      resp = (await undiciFetch(current.href, {
        headers: BROWSER_HEADERS,
        signal,
        redirect: "manual",
        dispatcher: guardedAgent,
      })) as unknown as Response;
    } catch (e) {
      // undici reports only "fetch failed"; the useful reason is in `cause`.
      const cause = (e as any)?.cause;
      if ((e as Error).name !== "AbortError" && cause instanceof Error) throw cause;
      throw e;
    }

    const location = resp.headers.get("location");
    if (resp.status >= 300 && resp.status < 400 && location) {
      resp.body?.cancel().catch(() => {});
      current = new URL(location, current);
      continue;
    }
    return { resp, finalUrl: current.href };
  }
  throw new Error(`Too many redirects (more than ${MAX_REDIRECT_HOPS}).`);
}

export interface FetchOptions {
  maxCharSize?: number;
  simplify?: boolean;
  timeoutMs?: number;
}

export interface FetchOutcome {
  url: string;
  finalUrl: string;
  content: string;
  contentType: string;
}

/**
 * Fetches a page and returns its main content as Markdown (or raw text).
 */
export async function webFetch(
  url: string,
  options: FetchOptions = {},
): Promise<FetchOutcome> {
  const maxCharSize = options.maxCharSize ?? 50000;
  const simplify = options.simplify ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;
    for (let refreshHops = 0; ; refreshHops++) {
      const { resp, finalUrl } = await safeFetch(currentUrl, controller.signal);

      if (!resp.ok) {
        resp.body?.cancel().catch(() => {});
        throw httpError(resp);
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (!isTextContentType(contentType)) {
        resp.body?.cancel().catch(() => {});
        throw new Error(
          `Unsupported content type "${contentType.split(";")[0]}": only text and HTML pages can be fetched.`,
        );
      }

      const body = await resp.text();
      if (!contentType.includes("html")) {
        return {
          url,
          finalUrl,
          content: body.substring(0, maxCharSize),
          contentType,
        };
      }

      const refreshUrl =
        refreshHops < MAX_REFRESH_HOPS ? findMetaRefresh(body, finalUrl) : null;
      if (refreshUrl) {
        currentUrl = refreshUrl;
        continue;
      }

      if (!simplify) {
        return {
          url,
          finalUrl,
          content: body.substring(0, maxCharSize),
          contentType,
        };
      }

      const mainContent = extractMainContent(removeUselessTags(body));
      return {
        url,
        finalUrl,
        content: htmlToMarkdown(mainContent).substring(0, maxCharSize),
        contentType,
      };
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`Timeout: failed to fetch "${url}" within ${timeoutMs}ms.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
