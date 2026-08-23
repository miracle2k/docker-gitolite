import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MochiClient, SessionStore } from "@mochi-voice/core";
import { registerReviewTools } from "./tools.js";
import type { ServerConfig } from "./config.js";

export const SERVER_INFO = { name: "mochi-voice-review", version: "0.1.0" };

export function createMcpServer(config: ServerConfig): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Conducts a spoken spaced-repetition review of the Mochi cards due today. Call start_review first, then loop next_card -> grade_card until the queue is empty. Fetch review_instructions for the full procedure.",
  });
  registerReviewTools(server, {
    config,
    client: new MochiClient({ token: config.mochiToken }),
    store: new SessionStore(),
  });
  return server;
}

function unauthorized(res: ServerResponse, reason: string): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="mochi-voice"',
  });
  res.end(JSON.stringify({ error: reason }));
}

/**
 * Check the caller is allowed.
 *
 * Origin validation is required by the MCP spec: without it a web page the
 * user visits could drive their review session (and their Mochi account)
 * through DNS rebinding against a LAN-bound server. Requests with no Origin
 * at all are non-browser callers - OpenAI's hosted MCP client is one - and
 * are allowed through to the bearer check.
 */
function checkAccess(req: IncomingMessage, config: ServerConfig): string | undefined {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
    return `origin ${origin} is not allowed`;
  }
  if (origin && config.allowedOrigins.length === 0) {
    return "browser origins are refused; set MCP_ALLOWED_ORIGINS to permit one";
  }
  if (config.authToken) {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== config.authToken) return "invalid or missing bearer token";
  }
  return undefined;
}

export async function startHttpServer(config: ServerConfig) {
  // Stateless mode: no Mcp-Session-Id, and a FRESH server+transport pair per
  // request.
  //
  // Reusing one transport across requests looks like an obvious saving and is
  // a real bug: in stateless mode the transport correlates responses to
  // callers by raw JSON-RPC request id, and every SDK client starts its ids at
  // 0. Two overlapping callers - exactly the traffic pattern here, since
  // OpenAI's hosted client and Home Assistant both open a fresh connection per
  // tool call - would cross-deliver each other's responses.
  //
  // Review state is unaffected because it lives in the session handle we mint
  // ourselves, not in the transport.
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const mcp = createMcpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // MUST stay false. OpenAI's hosted MCP client requires POST responses to
      // be SSE-framed; replying with plain application/json makes the session
      // silently report zero tools rather than erroring.
      enableJsonResponse: false,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  };

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: SERVER_INFO }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found; the MCP endpoint is /mcp" }));
      return;
    }

    const denied = checkAccess(req, config);
    if (denied) {
      unauthorized(res, denied);
      return;
    }

    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  await new Promise<void>((resolve) => http.listen(config.port, config.host, resolve));
  return { http };
}
