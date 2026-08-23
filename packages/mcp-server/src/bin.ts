#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createMcpServer, startHttpServer } from "./server.js";

/**
 * Two transports, one tool surface.
 *
 * stdio  - for local clients (Claude Code, Claude Desktop, Cursor) while
 *          developing and for driving a review from a terminal.
 * http   - for the voice path. OpenAI's Realtime API connects to a remote
 *          MCP server from ITS OWN infrastructure, so this must be reachable
 *          from the internet (a tunnel is the usual answer for a NAS).
 */
async function main(): Promise<void> {
  const mode = process.argv.includes("--stdio") ? "stdio" : "http";
  const config = loadConfig();

  if (mode === "stdio") {
    const server = createMcpServer(config);
    await server.connect(new StdioServerTransport());
    return;
  }

  const { http } = await startHttpServer(config);
  const where = `http://${config.host}:${config.port}/mcp`;
  process.stderr.write(`mochi-voice MCP server listening on ${where}\n`);
  if (config.warnings) {
    process.stderr.write(`Ignored bad configuration:\n${config.warnings}\n`);
  }
  if (!config.authToken) {
    process.stderr.write(
      "WARNING: MCP_AUTH_TOKEN is not set. Anyone who can reach this port can read your cards and tag them. Set it before exposing this beyond your LAN.\n",
    );
  }

  const shutdown = () => {
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
