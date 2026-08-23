import {
  DEFAULT_SETTINGS,
  type ReviewSettings,
} from "../session/types.js";
import { MochiClient } from "../mochi/client.js";
import { JsonlSink } from "../sinks/jsonl.js";
import { MochiTagSink } from "../sinks/mochi-tag.js";
import { WebhookSink } from "../sinks/webhook.js";
import type { GradeSink } from "../sinks/types.js";

/**
 * One place that turns environment variables into settings and sinks.
 *
 * This lives in core rather than in each entry point because the MCP server
 * and the voice broker MUST agree: if the broker quietly supports fewer knobs
 * than the MCP server, a documented setting silently does nothing on the
 * voice path, which is the worst kind of bug to find at 7am mid-review.
 */

export interface EnvIssue {
  variable: string;
  value: string;
  message: string;
}

export interface LoadedSettings {
  settings: ReviewSettings;
  /** Bad values, so the caller can warn rather than failing silently. */
  issues: EnvIssue[];
}

function oneOf<T extends string>(
  variable: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  issues: EnvIssue[],
): T {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  if ((allowed as readonly string[]).includes(value)) return value as T;
  issues.push({
    variable,
    value,
    message: `expected one of ${allowed.join(", ")}; using ${fallback}`,
  });
  return fallback;
}

function number(
  variable: string,
  raw: string | undefined,
  fallback: number,
  issues: EnvIssue[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    issues.push({ variable, value: raw, message: `not a number; using ${fallback}` });
    return fallback;
  }
  return n;
}

function boolean(
  variable: string,
  raw: string | undefined,
  fallback: boolean,
  issues: EnvIssue[],
): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  issues.push({ variable, value: raw, message: `not a boolean; using ${fallback}` });
  return fallback;
}

export function settingsFromEnv(env: Record<string, string | undefined>): LoadedSettings {
  const issues: EnvIssue[] = [];
  const settings: ReviewSettings = {
    questionStyle: oneOf(
      "REVIEW_QUESTION_STYLE",
      env.REVIEW_QUESTION_STYLE,
      ["verbatim", "rephrase", "contextual"] as const,
      DEFAULT_SETTINGS.questionStyle,
      issues,
    ),
    strictness: oneOf(
      "REVIEW_STRICTNESS",
      env.REVIEW_STRICTNESS,
      ["lenient", "balanced", "strict"] as const,
      DEFAULT_SETTINGS.strictness,
      issues,
    ),
    numericTolerance: {
      years: number("REVIEW_YEAR_TOLERANCE", env.REVIEW_YEAR_TOLERANCE, DEFAULT_SETTINGS.numericTolerance.years, issues),
      relative: number("REVIEW_RELATIVE_TOLERANCE", env.REVIEW_RELATIVE_TOLERANCE, DEFAULT_SETTINGS.numericTolerance.relative, issues),
    },
    alwaysStateAnswer: boolean("REVIEW_ALWAYS_STATE_ANSWER", env.REVIEW_ALWAYS_STATE_ANSWER, DEFAULT_SETTINGS.alwaysStateAnswer, issues),
    promptSelection: oneOf(
      "REVIEW_PROMPT_SELECTION",
      env.REVIEW_PROMPT_SELECTION,
      ["least-recent", "forward-only", "random"] as const,
      DEFAULT_SETTINGS.promptSelection,
      issues,
    ),
    maxCards: number("REVIEW_MAX_CARDS", env.REVIEW_MAX_CARDS, DEFAULT_SETTINGS.maxCards, issues),
    syncMode: oneOf(
      "REVIEW_SYNC_MODE",
      env.REVIEW_SYNC_MODE,
      ["immediate", "end-of-session"] as const,
      DEFAULT_SETTINGS.syncMode,
      issues,
    ),
    skipUnspeakable: boolean("REVIEW_SKIP_UNSPEAKABLE", env.REVIEW_SKIP_UNSPEAKABLE, DEFAULT_SETTINGS.skipUnspeakable, issues),
  };
  return { settings, issues };
}

export interface LoadedSinks {
  sinks: GradeSink[];
  issues: EnvIssue[];
}

export function sinksFromEnv(
  env: Record<string, string | undefined>,
  client: MochiClient,
): LoadedSinks {
  const issues: EnvIssue[] = [];
  // Always on: the durable local ledger. It is the only record that survives
  // when nothing else accepts a write.
  const sinks: GradeSink[] = [new JsonlSink(env.REVIEW_LOG_PATH ?? "./data/reviews.jsonl")];

  if (boolean("MOCHI_TAG_SINK", env.MOCHI_TAG_SINK, true, issues)) {
    sinks.push(
      new MochiTagSink({
        client,
        forgotTag: env.MOCHI_FORGOT_TAG ?? "voice-forgot",
        ...(env.MOCHI_REMEMBERED_TAG ? { rememberedTag: env.MOCHI_REMEMBERED_TAG } : {}),
      }),
    );
  }

  if (env.GRADE_WEBHOOK_URL) {
    let headers: Record<string, string> = {};
    if (env.GRADE_WEBHOOK_HEADERS) {
      try {
        headers = JSON.parse(env.GRADE_WEBHOOK_HEADERS) as Record<string, string>;
      } catch {
        issues.push({
          variable: "GRADE_WEBHOOK_HEADERS",
          value: env.GRADE_WEBHOOK_HEADERS,
          message: "not valid JSON; sending no extra headers",
        });
      }
    }
    sinks.push(
      new WebhookSink({
        url: env.GRADE_WEBHOOK_URL,
        method: env.GRADE_WEBHOOK_METHOD ?? "POST",
        headers,
        ...(env.GRADE_WEBHOOK_BODY ? { bodyTemplate: env.GRADE_WEBHOOK_BODY } : {}),
        // The operator asserts this; we never assume a webhook moves Mochi.
        advancesSchedule: boolean(
          "GRADE_WEBHOOK_ADVANCES_SCHEDULE",
          env.GRADE_WEBHOOK_ADVANCES_SCHEDULE,
          false,
          issues,
        ),
      }),
    );
  }

  return { sinks, issues };
}

export function formatIssues(issues: EnvIssue[]): string {
  return issues.map((i) => `  ${i.variable}="${i.value}": ${i.message}`).join("\n");
}
