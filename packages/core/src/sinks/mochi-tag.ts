import type { MochiClient } from "../mochi/client.js";
import type { GradeRevision, SessionEntry } from "../session/types.js";
import type { GradeSink, SinkResult } from "./types.js";

export interface MochiTagSinkOptions {
  client: MochiClient;
  /** Tag applied to cards answered incorrectly. */
  forgotTag?: string;
  /** Tag applied to cards answered correctly. Off by default - it adds noise. */
  rememberedTag?: string;
}

/**
 * The only officially supported way to write a review outcome back to Mochi.
 *
 * Mochi's API exposes no review endpoint, but `manual-tags` IS writable on
 * `POST /cards/:id`. So we tag the cards you got wrong. In the Mochi app you
 * can then filter to that tag and re-review exactly those cards, which is the
 * closest thing to schedule write-back the public API permits.
 *
 * This does NOT advance Mochi's scheduler, and says so via `capabilities`.
 *
 * Note `manual-tags` is replace-not-merge, so every write reads the card first
 * and preserves the user's own tags. `tags` (which also contains tags parsed
 * out of card content) is read-only and must never be sent back.
 */
export class MochiTagSink implements GradeSink {
  readonly name = "mochi-tag";
  readonly capabilities = { revise: true, advancesSchedule: false };
  private readonly forgotTag: string;
  private readonly rememberedTag: string | undefined;

  constructor(private readonly opts: MochiTagSinkOptions) {
    this.forgotTag = opts.forgotTag ?? "voice-forgot";
    this.rememberedTag = opts.rememberedTag;
  }

  private get managedTags(): string[] {
    return [this.forgotTag, ...(this.rememberedTag ? [this.rememberedTag] : [])];
  }

  private async applyTags(cardId: string, add: string[]): Promise<SinkResult> {
    try {
      const card = await this.opts.client.getCard(cardId);
      const existing = card["manual-tags"] ?? [];
      // Drop any tag we manage, then add back only the ones that apply now.
      const preserved = existing.filter((t) => !this.managedTags.includes(t));
      const next = [...preserved, ...add];
      const changed =
        next.length !== existing.length || next.some((t, i) => existing[i] !== t);
      if (!changed) return { ok: true, detail: "tags already correct" };
      await this.opts.client.updateCard(cardId, { "manual-tags": next });
      return { ok: true, detail: `manual-tags=[${next.join(", ")}]` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private tagsFor(entry: SessionEntry): string[] {
    if (entry.verdict === "forgot") return [this.forgotTag];
    if (entry.verdict === "remembered" && this.rememberedTag) return [this.rememberedTag];
    return [];
  }

  async record(entry: SessionEntry): Promise<SinkResult> {
    return this.applyTags(entry.cardId, this.tagsFor(entry));
  }

  /** A revision re-derives the tag set from the entry's current verdict. */
  async revise(entry: SessionEntry, _revision: GradeRevision): Promise<SinkResult> {
    return this.applyTags(entry.cardId, this.tagsFor(entry));
  }
}
