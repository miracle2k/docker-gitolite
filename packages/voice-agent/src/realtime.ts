import { WebSocket } from "ws";
import { buildInstructions, type ReviewSettings } from "@mochi-voice/core";
import { REVIEW_TOOLS, runTool, type ToolContext } from "./tools.js";

/**
 * OpenAI Realtime wiring.
 *
 * NOTE ON VERIFICATION: OpenAI's docs were unreachable from the machine this
 * was written on, so the event and field names below were taken from OpenAI's
 * own OpenAPI-generated SDK types rather than from prose documentation. Two
 * changes in the GA session shape are easy to get wrong and are handled here:
 * `modalities` is now `output_modalities`, and `temperature` is gone from the
 * GA config. Treat this file as the first thing to check against live docs.
 */

export const DEFAULT_MODEL = "gpt-realtime-2.1";
const OPENAI_BASE = "https://api.openai.com/v1";

export interface SessionConfigOptions {
  model?: string;
  voice?: string;
  settings: ReviewSettings;
  /** Extra text appended to the generated review instructions. */
  extraInstructions?: string;
}

/**
 * Session configuration for a flashcard review.
 *
 * The turn-detection settings are the part that most affects whether this
 * feels good. A learner recalling a fact pauses mid-sentence, so the default
 * 200ms silence threshold would cut them off constantly. `semantic_vad` with
 * low eagerness waits for them to actually be finished, and `idle_timeout_ms`
 * re-prompts someone who has gone quiet rather than stalling forever.
 */
export function buildSessionConfig(opts: SessionConfigOptions): Record<string, unknown> {
  return {
    type: "realtime",
    model: opts.model ?? DEFAULT_MODEL,
    output_modalities: ["audio"],
    instructions: buildInstructions({
      settings: opts.settings,
      ...(opts.extraInstructions ? { extra: opts.extraInstructions } : {}),
    }),
    audio: {
      input: {
        transcription: { model: "gpt-4o-transcribe" },
        turn_detection: {
          type: "semantic_vad",
          // Low eagerness waits up to ~8s before deciding the learner is
          // done. For a recall task that is a feature, not latency.
          eagerness: "low",
          create_response: true,
          interrupt_response: true,
          idle_timeout_ms: 12000,
        },
      },
      output: {
        voice: opts.voice ?? "cedar",
        speed: 1.0,
      },
    },
    tools: REVIEW_TOOLS,
    tool_choice: "auto",
  };
}

export interface EphemeralKey {
  value: string;
  expiresAt?: number;
}

/**
 * Mint a short-lived client secret so the phone never holds the real API key.
 *
 * The session config is attached to the secret rather than sent from the
 * device, which means the app literally cannot change the agent's behaviour
 * or its tool list.
 */
export async function mintClientSecret(
  apiKey: string,
  sessionConfig: Record<string, unknown>,
  opts: { ttlSeconds?: number; fetchImpl?: typeof fetch } = {},
): Promise<EphemeralKey> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(`${OPENAI_BASE}/realtime/client_secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: opts.ttlSeconds ?? 600 },
      session: sessionConfig,
    }),
  });
  if (!res.ok) {
    throw new Error(`client_secrets failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { value: string; expires_at?: number };
  return { value: body.value, expiresAt: body.expires_at };
}

export interface SdpAnswer {
  sdp: string;
  callId: string;
}

/**
 * Exchange the phone's SDP offer for an answer, capturing the call id.
 *
 * The call id is the whole point: with it, this server can attach a control
 * socket to the same call and answer every tool call itself. The device only
 * ever carries audio.
 */
export async function exchangeSdp(
  clientSecret: string,
  offerSdp: string,
  opts: { model?: string; fetchImpl?: typeof fetch } = {},
): Promise<SdpAnswer> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = `${OPENAI_BASE}/realtime/calls?model=${encodeURIComponent(opts.model ?? DEFAULT_MODEL)}`;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp",
    },
    body: offerSdp,
  });
  if (!res.ok) {
    throw new Error(`SDP exchange failed: ${res.status} ${await res.text()}`);
  }
  const sdp = await res.text();
  const location = res.headers.get("location") ?? "";
  const callId = location.split("/").pop() ?? "";
  if (!callId) throw new Error("SDP exchange returned no call id in the Location header");
  return { sdp, callId };
}

export interface SidebandOptions {
  apiKey: string;
  callId: string;
  ctx: ToolContext;
  /** Injected in tests. */
  socketFactory?: (url: string, headers: Record<string, string>) => WebSocket;
  onEvent?: (event: Record<string, unknown>) => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Attach a control socket to a live call and answer its tool calls.
 *
 * This is what lets the review engine live on a home NAS: the connection is
 * OUTBOUND to OpenAI, so there is no inbound port, no public hostname and no
 * tunnel to maintain.
 */
export function attachSideband(opts: SidebandOptions): { close: () => void } {
  const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(opts.callId)}`;
  const headers = { Authorization: `Bearer ${opts.apiKey}` };
  const ws = opts.socketFactory
    ? opts.socketFactory(url, headers)
    : new WebSocket(url, { headers });

  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  ws.on("message", (raw: unknown) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    opts.onEvent?.(event);
    void handleEvent(event, opts.ctx, send);
  });

  // Without an 'error' listener, ws re-throws as an uncaught exception and
  // takes the whole broker process down - every other in-flight review with
  // it - when a single call hits a 401, a 429 or a plain ECONNRESET.
  ws.on("error", (err: unknown) => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on("close", () => opts.onClose?.());

  return {
    close: () => ws.close(),
  };
}

/**
 * Handle one server event.
 *
 * Function calls surface as a completed `response.function_call_arguments.done`
 * event; the result goes back as a conversation item, then `response.create`
 * asks the model to speak again. Without that second step the model executes
 * the tool and then says nothing, which sounds exactly like a crash.
 */
export async function handleEvent(
  event: Record<string, unknown>,
  ctx: ToolContext,
  send: (payload: Record<string, unknown>) => void,
): Promise<void> {
  if (event.type !== "response.function_call_arguments.done") return;

  const name = String(event.name ?? "");
  const callId = String(event.call_id ?? "");
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(String(event.arguments ?? "{}")) as Record<string, unknown>;
  } catch {
    args = {};
  }

  const result = await runTool(name, args, ctx);

  send({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(result),
    },
  });
  send({ type: "response.create" });
}
