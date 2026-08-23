import {
  DEFAULT_SETTINGS,
  JsonlSink,
  MochiClient,
  MochiTagSink,
  WebhookSink,
  type GradeSink,
  type ReviewSettings,
} from "@mochi-voice/core";

export interface ServerConfig {
  mochiToken: string;
  settings: ReviewSettings;
  sinks: GradeSink[];
  /** Bearer token callers must present. Empty disables auth (LAN-only!). */
  authToken: string;
  port: number;
  host: string;
  /** Allowed Origin header values; MCP requires origin validation. */
  allowedOrigins: string[];
  sessionTtlMs: number;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mochiToken = env.MOCHI_API_TOKEN ?? "";
  if (!mochiToken) {
    throw new Error(
      "MOCHI_API_TOKEN is required. Get it from Mochi > Settings > API (Mochi Pro only).",
    );
  }

  const settings: ReviewSettings = {
    ...DEFAULT_SETTINGS,
    questionStyle: (env.REVIEW_QUESTION_STYLE as ReviewSettings["questionStyle"]) ?? DEFAULT_SETTINGS.questionStyle,
    strictness: (env.REVIEW_STRICTNESS as ReviewSettings["strictness"]) ?? DEFAULT_SETTINGS.strictness,
    numericTolerance: {
      years: num(env.REVIEW_YEAR_TOLERANCE, DEFAULT_SETTINGS.numericTolerance.years),
      relative: num(env.REVIEW_RELATIVE_TOLERANCE, DEFAULT_SETTINGS.numericTolerance.relative),
    },
    alwaysStateAnswer: bool(env.REVIEW_ALWAYS_STATE_ANSWER, DEFAULT_SETTINGS.alwaysStateAnswer),
    promptSelection: (env.REVIEW_PROMPT_SELECTION as ReviewSettings["promptSelection"]) ?? DEFAULT_SETTINGS.promptSelection,
    maxCards: num(env.REVIEW_MAX_CARDS, DEFAULT_SETTINGS.maxCards),
    syncMode: (env.REVIEW_SYNC_MODE as ReviewSettings["syncMode"]) ?? DEFAULT_SETTINGS.syncMode,
    skipUnspeakable: bool(env.REVIEW_SKIP_UNSPEAKABLE, DEFAULT_SETTINGS.skipUnspeakable),
  };

  const client = new MochiClient({ token: mochiToken });
  const sinks: GradeSink[] = [];

  // Always on: the durable local ledger. It is the only record that survives
  // when nothing else can accept a write.
  sinks.push(new JsonlSink(env.REVIEW_LOG_PATH ?? "./data/reviews.jsonl"));

  if (bool(env.MOCHI_TAG_SINK, true)) {
    sinks.push(
      new MochiTagSink({
        client,
        forgotTag: env.MOCHI_FORGOT_TAG ?? "voice-forgot",
        ...(env.MOCHI_REMEMBERED_TAG ? { rememberedTag: env.MOCHI_REMEMBERED_TAG } : {}),
      }),
    );
  }

  if (env.GRADE_WEBHOOK_URL) {
    sinks.push(
      new WebhookSink({
        url: env.GRADE_WEBHOOK_URL,
        method: env.GRADE_WEBHOOK_METHOD ?? "POST",
        headers: env.GRADE_WEBHOOK_HEADERS ? JSON.parse(env.GRADE_WEBHOOK_HEADERS) : {},
        ...(env.GRADE_WEBHOOK_BODY ? { bodyTemplate: env.GRADE_WEBHOOK_BODY } : {}),
        // The operator asserts this; we never assume a webhook moves Mochi.
        advancesSchedule: bool(env.GRADE_WEBHOOK_ADVANCES_SCHEDULE, false),
      }),
    );
  }

  return {
    mochiToken,
    settings,
    sinks,
    authToken: env.MCP_AUTH_TOKEN ?? "",
    port: num(env.PORT, 8765),
    host: env.HOST ?? "0.0.0.0",
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sessionTtlMs: num(env.REVIEW_SESSION_TTL_MS, 60 * 60 * 1000),
  };
}
