import type { GradeRevision, SessionEntry } from "../session/types.js";
import type { GradeSink, SinkResult } from "./types.js";

export interface WebhookSinkOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /**
   * JSON body with `{{placeholder}}` substitution. Available placeholders:
   * cardId, verdict, remembered ("true"/"false"), promptKey, question,
   * expectedAnswer, learnerAnswer, rationale, seq, at.
   */
  bodyTemplate?: string;
  /** Declared by the operator: does this endpoint really move Mochi's scheduler? */
  advancesSchedule?: boolean;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BODY = JSON.stringify({
  "card-id": "{{cardId}}",
  "remembered?": "{{remembered}}",
  at: "{{at}}",
});

/**
 * Generic outbound grade sink.
 *
 * Mochi's public API cannot record reviews. This sink is the escape hatch: if
 * you have some other endpoint that can - your own automation, a Shortcut, a
 * home-automation webhook, or an endpoint Mochi adds later - you point this at
 * it and describe the request, rather than waiting on this project to support
 * it natively.
 *
 * Nothing is assumed about the target. Set `advancesSchedule` honestly so the
 * session summary can tell the user whether their reviews actually landed.
 */
export class WebhookSink implements GradeSink {
  readonly name = "webhook";
  readonly capabilities: { revise: boolean; advancesSchedule: boolean };
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: WebhookSinkOptions) {
    this.capabilities = {
      revise: true,
      advancesSchedule: opts.advancesSchedule ?? false,
    };
    this.doFetch = opts.fetchImpl ?? globalThis.fetch;
  }

  private render(entry: SessionEntry): string {
    const values: Record<string, string> = {
      cardId: entry.cardId,
      verdict: entry.verdict ?? "",
      remembered: String(entry.verdict === "remembered"),
      promptKey: entry.promptKey,
      question: entry.question,
      expectedAnswer: entry.expectedAnswer,
      learnerAnswer: entry.learnerAnswer ?? "",
      rationale: entry.rationale ?? "",
      seq: String(entry.seq),
      at: new Date().toISOString(),
    };
    return (this.opts.bodyTemplate ?? DEFAULT_BODY).replace(
      /\{\{(\w+)\}\}/g,
      (_all, key: string) => {
        const v = values[key] ?? "";
        // Escape for embedding inside a JSON string literal.
        return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
      },
    );
  }

  private async send(entry: SessionEntry): Promise<SinkResult> {
    try {
      const res = await this.doFetch(this.opts.url, {
        method: this.opts.method ?? "POST",
        headers: { "Content-Type": "application/json", ...(this.opts.headers ?? {}) },
        body: this.render(entry),
      });
      if (!res.ok) {
        return { ok: false, detail: `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async record(entry: SessionEntry): Promise<SinkResult> {
    return this.send(entry);
  }

  async revise(entry: SessionEntry, _revision: GradeRevision): Promise<SinkResult> {
    return this.send(entry);
  }
}
