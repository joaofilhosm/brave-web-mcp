/**
 * Vercel serverless entrypoint for the MCP server.
 *
 * Exposes the MCP Streamable HTTP transport at POST /api/mcp (and /mcp via the
 * rewrite in vercel.json). Stateless mode: no session id is generated, so each
 * request spins up a fresh server — required for serverless, where instances
 * are not guaranteed to be reused.
 *
 * Uses the SDK's web-standard transport, which consumes a Web Request and
 * returns a Web Response directly. That maps cleanly onto Vercel functions and
 * avoids buffering the request body twice.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { setupMCPServer } from "../src/server.js";

const app = new Hono();

app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "Mcp-Session-Id",
      "MCP-Session-Id",
      "mcp-session-id",
      "Last-Event-ID",
      "MCP-Protocol-Version",
    ],
    exposeHeaders: ["Mcp-Session-Id", "MCP-Session-Id", "mcp-session-id"],
    maxAge: 86400,
  }),
);

app.post("/mcp", async (c) => {
  const server = setupMCPServer();

  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    const response = await transport.handleRequest(c.req.raw);

    // The transport closes itself when the response ends; make sure the MCP
    // server is torn down too, otherwise the event loop stays alive.
    response.clone().text().catch(() => {}).finally(() => {
      transport.close();
      server.close();
    });

    return response;
  } catch (error) {
    console.error("[mcp] error handling request:", error);
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      },
      { status: 500 },
    );
  }
});

app.get("/mcp", async (c) =>
  c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    },
    { status: 405 },
  ),
);

app.delete("/mcp", async (c) =>
  c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    },
    { status: 405 },
  ),
);

export default app;
