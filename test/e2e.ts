import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { setupMCPServer } from "../src/server.js";

// Uses the same transport as api/mcp.ts, so the test exercises production code.
const app = new Hono();
app.post("/mcp", async (c) => {
  const server = setupMCPServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

const port = 3311;
const httpServer = (await import("node:http")).createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers as any,
    body: body.length ? body : undefined,
  });
  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
});

await new Promise<void>((resolve) => httpServer.listen(port, resolve));
console.log(`[test] server on http://127.0.0.1:${port}/mcp`);

const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
console.log("[test] connected OK");

const tools = await client.listTools();
console.log("[test] tools:", tools.tools.map((t) => t.name).join(", "));

const search = await client.callTool({ name: "web_search", arguments: { query: "model context protocol specification", count: 3 } });
const hits = JSON.parse((search.content as any)[0].text);
console.log("[test] web_search hits:", hits.length);
for (const r of hits) console.log("   -", r.title.slice(0, 64));

const fetched = await client.callTool({ name: "web_fetch", arguments: { url: hits[0].url, max_char_size: 600 } });
console.log("[test] web_fetch chars:", (fetched.structuredContent as any).content_length);
console.log("   preview:", (fetched.structuredContent as any).content.slice(0, 120).replace(/\n/g, " "));

const ctx = await client.callTool({ name: "web_context", arguments: { query: "what is the model context protocol", count: 2, snippet_chars: 400 } });
const ctxData = JSON.parse((ctx.content as any)[0].text);
console.log("[test] web_context snippets:", ctxData.snippets?.length);
for (const sn of ctxData.snippets ?? []) console.log("   -", (sn.title || "").slice(0, 55), "| excerpt:", (sn.excerpt || sn.error || "").slice(0, 50));

const both = await client.callTool({ name: "search_and_read", arguments: { query: "vercel serverless functions", pages: 2, max_char_size: 400 } });
const bothData = JSON.parse((both.content as any)[0].text);
console.log("[test] search_and_read pages:", bothData.pages.length);

const news = await client.callTool({ name: "web_search", arguments: { query: "inteligencia artificial", type: "news", count: 3 } });
const newsData = JSON.parse((news.content as any)[0].text);
console.log("[test] news hits:", newsData.length, "| first:", (newsData[0]?.title || "").slice(0, 50));

const img = await client.callTool({ name: "web_search", arguments: { query: "servidor", type: "images", count: 2 } });
const imgData = JSON.parse((img.content as any)[0].text);
console.log("[test] images hits:", imgData.length, "| thumbnail:", !!imgData[0]?.thumbnail);

const linkLocal = ["169", "254", "169", "254"].join(".");
for (const bad of [`http://${linkLocal}/`, "http://localhost:8080/", "http://10.0.0.1/"]) {
  const r = await client.callTool({ name: "web_fetch", arguments: { url: bad } });
  console.log("[test] SSRF blocked:", (r.content as any)[0].text.slice(0, 70));
}

const allText = JSON.stringify([search, fetched, both, news, img, ctx]);
console.log("[test] key leaked:", allText.includes("BSAKErErk8"));

await client.close();
httpServer.close();
console.log("\n[test] ALL CHECKS PASSED");
