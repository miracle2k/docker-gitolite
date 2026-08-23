import { createServer, type Server } from "node:http";
import type { MochiCard } from "@mochi-voice/core";

/**
 * Stand-in for the Mochi API, shaped from the real wire format: Basic auth
 * with an empty password, `{cards: [...]}` from /due, `{docs, bookmark}` from
 * the list endpoints, and the literal "nil" bookmark that ends a listing.
 */
export interface FakeMochi {
  server: Server;
  baseUrl: string;
  updates: { id: string; body: Record<string, unknown> }[];
  cards: Map<string, MochiCard>;
  close(): Promise<void>;
}

export async function startFakeMochi(initial: MochiCard[]): Promise<FakeMochi> {
  const cards = new Map(initial.map((c) => [c.id, structuredClone(c)]));
  const updates: { id: string; body: Record<string, unknown> }[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Basic ")) return send(401, { errors: ["unauthorized"] });

    if (url.pathname === "/api/due" && req.method === "GET") {
      return send(200, { cards: [...cards.values()] });
    }
    if (url.pathname === "/api/templates" && req.method === "GET") {
      return send(200, { docs: [], bookmark: "nil" });
    }
    if (url.pathname === "/api/decks" && req.method === "GET") {
      return send(200, { docs: [{ id: "d1", name: "Test" }], bookmark: "nil" });
    }

    const cardMatch = /^\/api\/cards\/(.+)$/.exec(url.pathname);
    if (cardMatch) {
      const id = decodeURIComponent(cardMatch[1]!);
      const card = cards.get(id);
      if (!card) return send(404, { errors: ["not found"] });
      if (req.method === "GET") return send(200, card);
      if (req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw || "{}") as Record<string, unknown>;
          updates.push({ id, body });
          Object.assign(card, body);
          send(200, card);
        });
        return;
      }
    }
    send(404, { errors: ["no route"] });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/api`,
    updates,
    cards,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
