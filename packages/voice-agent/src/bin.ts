#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  MochiClient,
  ReviewSessionEngine,
  SessionStore,
  buildInstructions,
  formatIssues,
  settingsFromEnv,
  sinksFromEnv,
  type MochiTemplate,
} from "@mochi-voice/core";
import { preview } from "./preview.js";
import { attachSideband, buildSessionConfig, exchangeSdp, mintClientSecret, DEFAULT_MODEL } from "./realtime.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`${name} is not set.\n`);
    process.exit(1);
  }
  return v;
}

// -------------------------------------------------------------- preview ---

async function cmdPreview(argv: string[]): Promise<void> {
  const client = new MochiClient({
    token: requireEnv("MOCHI_API_TOKEN"),
    ...(process.env.MOCHI_API_BASE_URL ? { baseUrl: process.env.MOCHI_API_BASE_URL } : {}),
  });
  const { settings, issues } = settingsFromEnv(process.env);
  if (issues.length) process.stderr.write(`Ignored bad configuration:\n${formatIssues(issues)}\n`);
  const deckId = argFor(argv, "--deck");
  const date = argFor(argv, "--date");
  const limit = Number(argFor(argv, "--limit") ?? "0") || undefined;

  const { lines, skipped, total } = await preview({
    client,
    settings,
    ...(deckId ? { deckId } : {}),
    ...(date ? { date } : {}),
    ...(limit ? { limit } : {}),
  });

  process.stdout.write(`${total} card(s) due; ${lines.length} reviewable by voice.\n\n`);
  lines.forEach((l, i) => {
    process.stdout.write(`${String(i + 1).padStart(3)}. [${l.kind}] ${l.question}\n`);
    process.stdout.write(`     -> ${l.answer}\n`);
  });
  if (skipped.length) {
    process.stdout.write(`\n${skipped.length} card(s) skipped:\n`);
    for (const s of skipped) process.stdout.write(`  ${s.cardId}: ${s.reason}\n`);
  }
}

// ---------------------------------------------------------- instructions ---

function cmdInstructions(): void {
  const { settings } = settingsFromEnv(process.env);
  process.stdout.write(buildInstructions({ settings }) + "\n");
}

// --------------------------------------------------------------- broker ---

/**
 * The voice broker.
 *
 * Flow: the phone sends its SDP offer here; we mint an ephemeral key, forward
 * the offer to OpenAI, keep the call id, open a control socket back to
 * OpenAI, and return only the SDP answer to the phone. Every tool call is
 * then answered here, against the review engine.
 *
 * The phone ends up holding no OpenAI key, no Mochi token and no grading
 * logic - and this process needs no inbound port from the internet, only from
 * your own network.
 */
async function cmdBroker(): Promise<void> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const mochiToken = requireEnv("MOCHI_API_TOKEN");
  const authToken = process.env.BROKER_AUTH_TOKEN ?? "";
  const model = process.env.OPENAI_REALTIME_MODEL ?? DEFAULT_MODEL;
  const port = Number(process.env.PORT ?? 8766);
  const { settings, issues } = settingsFromEnv(process.env);

  const client = new MochiClient({
    token: mochiToken,
    ...(process.env.MOCHI_API_BASE_URL ? { baseUrl: process.env.MOCHI_API_BASE_URL } : {}),
  });
  const store = new SessionStore();
  // Shared with the MCP server, so every documented knob and every sink -
  // including the webhook, the only one that can claim to move the schedule -
  // behaves the same on both paths.
  const { sinks, issues: sinkIssues } = sinksFromEnv(process.env, client);
  const warnings = formatIssues([...issues, ...sinkIssues]);

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/healthz") return json(200, { ok: true });

    if (authToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${authToken}`) return json(401, { error: "unauthorized" });
    }

    if (url.pathname === "/call" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          try {
            // Load today's queue before the call connects, so the first
            // next_card is instant rather than a long silence.
            const due = await client.getDue({});
            const templates = new Map<string, MochiTemplate>();
            if (due.some((c) => c["template-id"])) {
              for (const t of await client.listTemplates()) templates.set(t.id, t);
            }
            // Reverse review is normally enabled on the DECK, not the card.
            const deckReviewReverse: Record<string, boolean> = {};
            for (const d of await client.listDecks()) {
              if (d["review-reverse?"]) deckReviewReverse[d.id] = true;
            }
            const engine = new ReviewSessionEngine({
              sessionId: randomUUID(),
              cards: due,
              templates,
              deckReviewReverse,
              settings,
              sinks,
            });
            store.put(engine);

            const sessionConfig = buildSessionConfig({ model, settings });
            const secret = await mintClientSecret(apiKey, sessionConfig);
            const answer = await exchangeSdp(secret.value, body, { model });

            attachSideband({
              apiKey,
              callId: answer.callId,
              ctx: { store, sessionId: engine.sessionId, settings },
              onClose: () => {
                // Never lose a session's grades because the call dropped.
                void engine.flush();
              },
              onError: (err) => {
                process.stderr.write(`sideband socket error: ${err.message}\n`);
                void engine.flush();
              },
            });

            res.writeHead(200, { "Content-Type": "application/sdp" });
            res.end(answer.sdp);
          } catch (err) {
            json(500, { error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
      return;
    }

    json(404, { error: "not found; POST your SDP offer to /call" });
  });

  http.listen(port, "0.0.0.0", () => {
    process.stderr.write(`mochi-voice broker listening on :${port} (model ${model})\n`);
    if (warnings) process.stderr.write(`Ignored bad configuration:\n${warnings}\n`);
    if (!authToken) {
      process.stderr.write("WARNING: BROKER_AUTH_TOKEN is not set; anyone on this network can start a session on your OpenAI key.\n");
    }
  });
}

function argFor(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const USAGE = `mochi-voice <command>

  preview [--deck ID] [--date ISO] [--limit N]
      Print every question and reference answer a session would use today.
      Run this first: it shows how your cards actually parse, and which ones
      cannot be reviewed by voice, without needing an OpenAI key.

  instructions
      Print the review instructions generated from the current settings.

  broker
      Run the voice broker for the iOS app (see ios/README.md).
`;

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "preview":
      return cmdPreview(rest);
    case "instructions":
      return cmdInstructions();
    case "broker":
      return cmdBroker();
    default:
      process.stdout.write(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
