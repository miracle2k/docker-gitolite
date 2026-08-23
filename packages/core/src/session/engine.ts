import type { MochiCard, MochiTemplate } from "../mochi/types.js";
import { parseCard, selectPrompt, type ParsedCard, type ReviewPrompt } from "../cards/parse.js";
import type { GradeSink } from "../sinks/types.js";
import {
  DEFAULT_SETTINGS,
  type GradeRevision,
  type ReviewSettings,
  type SessionEntry,
  type SessionSummary,
  type Verdict,
  type VerdictSource,
} from "./types.js";

export interface QueuedCard {
  card: MochiCard;
  parsed: ParsedCard;
  prompt: ReviewPrompt;
}

export interface EngineOptions {
  sessionId: string;
  cards: MochiCard[];
  templates?: Map<string, MochiTemplate>;
  /** Deck-level `review-reverse?`, keyed by deck id. */
  deckReviewReverse?: Record<string, boolean>;
  settings?: Partial<ReviewSettings>;
  sinks?: GradeSink[];
  now?: () => Date;
}

export interface PresentedCard {
  seq: number;
  cardId: string;
  promptKey: string;
  promptKind: string;
  deckId?: string;
  /** The raw prompt text. The voice agent rephrases this per `questionStyle`. */
  question: string;
  /** The reference answer. The agent must NOT speak this before grading. */
  expectedAnswer: string;
  /** Extra reveal steps on the card, for follow-up colour. */
  extra: string[];
  /** How many cards remain after this one. */
  remaining: number;
}

export interface GradeResult {
  entry: SessionEntry;
  /** Per-sink outcome, so the caller can tell the user if a write failed. */
  sync: { sink: string; ok: boolean; detail?: string }[];
  /** True when at least one sink genuinely advances Mochi's schedule. */
  advancedSchedule: boolean;
}

/** How a revision target is addressed by the voice agent. */
export interface ReviseTarget {
  /** Explicit card. */
  cardId?: string;
  /** Explicit session position (1-based). */
  seq?: number;
  /** N cards back from the most recently graded one; 0 = the last one. */
  back?: number;
}

export class SessionNotFoundError extends Error {}
export class NoSuchEntryError extends Error {}

/**
 * A single voice review session.
 *
 * The engine owns three things the voice model must not be trusted with:
 *  1. WHICH card is current (models lose their place across tool calls),
 *  2. the reference answer (so grading can be audited after the fact),
 *  3. the grade ledger, including revisions.
 *
 * Grades are revisable at any time, including after they have been written to
 * the sinks. That is a first-class operation, not an afterthought: the learner
 * routinely disagrees with the model's call one or two cards later, and the
 * agent has to be able to reach back and fix it without derailing the session.
 */
export class ReviewSessionEngine {
  readonly sessionId: string;
  readonly settings: ReviewSettings;
  readonly startedAt: string;
  endedAt?: string;

  private readonly queue: QueuedCard[] = [];
  private readonly skipped: { cardId: string; reason: string }[] = [];
  private readonly entries: SessionEntry[] = [];
  private readonly sinks: GradeSink[];
  private readonly now: () => Date;
  private cursor = 0;

  constructor(opts: EngineOptions) {
    this.sessionId = opts.sessionId;
    this.settings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
    this.sinks = opts.sinks ?? [];
    this.now = opts.now ?? (() => new Date());
    this.startedAt = this.now().toISOString();

    for (const card of opts.cards) {
      const deckReviewReverse = card["deck-id"]
        ? opts.deckReviewReverse?.[card["deck-id"]]
        : undefined;
      const parsed = parseCard(card, {
        templates: opts.templates,
        deckReviewReverse,
      });
      const prompt = selectPrompt(parsed, card, {
        preferKind: this.settings.promptSelection === "forward-only" ? "forward" : undefined,
      });
      if (!prompt) {
        this.skipped.push({
          cardId: card.id,
          reason: parsed.prompts[0]?.notes.join("; ") || "no answerable prompt",
        });
        continue;
      }
      if (!prompt.speakable && this.settings.skipUnspeakable) {
        this.skipped.push({ cardId: card.id, reason: prompt.notes.join("; ") });
        continue;
      }
      this.queue.push({ card, parsed, prompt });
    }

    if (this.settings.promptSelection === "random") shuffle(this.queue);
    if (this.settings.maxCards > 0) this.queue.length = Math.min(this.queue.length, this.settings.maxCards);
  }

  get remaining(): number {
    return Math.max(0, this.queue.length - this.cursor);
  }

  get skippedCards(): readonly { cardId: string; reason: string }[] {
    return this.skipped;
  }

  get log(): readonly SessionEntry[] {
    return this.entries;
  }

  /** Peek at the upcoming card without consuming it (used for prefetching). */
  peek(): QueuedCard | undefined {
    return this.queue[this.cursor];
  }

  /**
   * Advance to the next card and record that it was asked.
   * Returns undefined when the queue is exhausted.
   */
  next(): PresentedCard | undefined {
    const item = this.queue[this.cursor];
    if (!item) return undefined;
    this.cursor += 1;

    const entry: SessionEntry = {
      seq: this.entries.length + 1,
      cardId: item.card.id,
      promptKey: item.prompt.key,
      promptKind: item.prompt.kind,
      deckId: item.card["deck-id"],
      question: item.prompt.question,
      expectedAnswer: item.prompt.answer,
      askedAt: this.now().toISOString(),
      revisions: [],
    };
    this.entries.push(entry);

    return {
      seq: entry.seq,
      cardId: entry.cardId,
      promptKey: entry.promptKey,
      promptKind: entry.promptKind,
      deckId: entry.deckId,
      question: entry.question,
      expectedAnswer: entry.expectedAnswer,
      extra: item.prompt.extra,
      remaining: this.remaining,
    };
  }

  /**
   * The entry currently awaiting a grade, if any.
   *
   * A deliberately deferred card is NOT awaiting a grade - it has been dealt
   * with. Treating it as pending would wedge the session, because the tool
   * surfaces refuse to serve another card while one is unanswered.
   */
  current(): SessionEntry | undefined {
    const last = this.entries[this.entries.length - 1];
    if (!last) return undefined;
    if (last.deferred) return undefined;
    return last.verdict === undefined ? last : undefined;
  }

  /**
   * Record a verdict. Defaults to the most recently asked ungraded card, but
   * may target any earlier card so a late correction does not have to
   * interrupt the flow.
   */
  async grade(input: {
    verdict: Verdict;
    learnerAnswer?: string;
    rationale?: string;
    source?: VerdictSource;
    target?: ReviseTarget;
  }): Promise<GradeResult> {
    const entry = input.target
      ? this.resolve(input.target)
      : (this.current() ?? this.resolve({ back: 0 }));

    const isRegrade = entry.verdict !== undefined;
    const previous = entry.verdict;

    entry.verdict = input.verdict;
    entry.verdictSource = input.source ?? "model";
    entry.deferred = false;
    entry.deferredReason = undefined;
    entry.answeredAt = this.now().toISOString();
    if (input.learnerAnswer !== undefined) entry.learnerAnswer = input.learnerAnswer;
    if (input.rationale !== undefined) entry.rationale = input.rationale;

    if (isRegrade && previous !== undefined) {
      const revision: GradeRevision = {
        at: this.now().toISOString(),
        from: previous,
        to: input.verdict,
        source: input.source ?? "user",
        reason: input.rationale,
      };
      entry.revisions.push(revision);
      return this.pushRevision(entry, revision);
    }

    if (this.settings.syncMode === "immediate") return this.pushRecord(entry);
    return { entry, sync: [], advancedSchedule: false };
  }

  /**
   * Deliberately leave a card ungraded.
   *
   * Used when the answer could not be judged rather than when it was wrong:
   * an unusable transcript, a mid-session interruption, or a grader that is
   * not confident enough to call it. This is a real terminal state, not a
   * failure - a false "forgot" costs an extra review, but a wrong grade
   * recorded from a broken transcript corrupts the schedule invisibly.
   */
  async defer(
    input: { reason: string; target?: ReviseTarget } = { reason: "not graded" },
  ): Promise<SessionEntry> {
    const entry = input.target ? this.resolve(input.target) : (this.current() ?? this.resolve({ back: 0 }));
    const previous = entry.verdict;
    entry.deferred = true;
    entry.deferredReason = input.reason;
    entry.verdict = undefined;
    entry.verdictSource = undefined;
    entry.answeredAt = this.now().toISOString();

    // If a grade was already written out, retract it. Sinks derive their
    // state from the entry's current verdict, so a revise call with no
    // verdict is what removes a tag or logs the retraction.
    if (entry.syncedAt && previous !== undefined) {
      const revision: GradeRevision = {
        at: this.now().toISOString(),
        from: previous,
        to: previous,
        source: "user",
        reason: `retracted: ${input.reason}`,
      };
      for (const sink of this.sinks) {
        if (sink.capabilities.revise) await sink.revise(entry, revision);
      }
      entry.syncedAt = undefined;
    }
    return entry;
  }

  /**
   * Change a grade that was already given - the "actually, mark that one
   * wrong" case. Works whether or not the grade has reached the sinks.
   */
  async revise(input: {
    verdict: Verdict;
    target?: ReviseTarget;
    reason?: string;
    source?: VerdictSource;
  }): Promise<GradeResult> {
    const entry = this.resolve(input.target ?? { back: 0 });
    if (entry.verdict === undefined) {
      // Never graded: treat as a first grade rather than failing on a technicality.
      return this.grade({
        verdict: input.verdict,
        rationale: input.reason,
        source: input.source ?? "user",
        target: input.target,
      });
    }
    if (entry.verdict === input.verdict) {
      return { entry, sync: [], advancedSchedule: false };
    }

    const revision: GradeRevision = {
      at: this.now().toISOString(),
      from: entry.verdict,
      to: input.verdict,
      source: input.source ?? "user",
      reason: input.reason,
    };
    entry.verdict = input.verdict;
    entry.verdictSource = input.source ?? "user";
    entry.revisions.push(revision);

    return this.pushRevision(entry, revision);
  }

  /**
   * Resolve a revision target. `back: 0` means the most recent GRADED entry,
   * which is what "that last one" means once the agent has moved on.
   */
  private resolve(target: ReviseTarget): SessionEntry {
    if (target.cardId) {
      // Last occurrence: a card can legitimately be asked twice in a session.
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const e = this.entries[i];
        if (e && e.cardId === target.cardId) return e;
      }
      throw new NoSuchEntryError(`card ${target.cardId} was not asked in this session`);
    }
    if (target.seq !== undefined) {
      const found = this.entries.find((e) => e.seq === target.seq);
      if (!found) throw new NoSuchEntryError(`no card at position ${target.seq}`);
      return found;
    }
    const back = target.back ?? 0;
    const graded = this.entries.filter((e) => e.verdict !== undefined);
    const pool = graded.length > 0 ? graded : this.entries;
    const found = pool[pool.length - 1 - back];
    if (!found) throw new NoSuchEntryError(`cannot go back ${back} card(s)`);
    return found;
  }

  private async pushRecord(entry: SessionEntry): Promise<GradeResult> {
    const sync: GradeResult["sync"] = [];
    let advanced = false;
    for (const sink of this.sinks) {
      const res = await sink.record(entry);
      sync.push({ sink: sink.name, ok: res.ok, detail: res.detail });
      if (res.ok && sink.capabilities.advancesSchedule) advanced = true;
    }
    const errs = sync.filter((s) => !s.ok).map((s) => `${s.sink}: ${s.detail}`);
    entry.syncErrors = errs.length ? errs : undefined;
    // Only count it as written if something actually accepted it. Otherwise
    // leave it unsynced so flush() tries again rather than silently dropping
    // the grade.
    if (sync.length === 0 || sync.some((s) => s.ok)) {
      entry.syncedAt = this.now().toISOString();
    }
    return { entry, sync, advancedSchedule: advanced };
  }

  private async pushRevision(
    entry: SessionEntry,
    revision: GradeRevision,
  ): Promise<GradeResult> {
    // Nothing was written yet, so the revision is just a local edit.
    if (!entry.syncedAt) {
      if (this.settings.syncMode === "immediate") return this.pushRecord(entry);
      return { entry, sync: [], advancedSchedule: false };
    }
    const sync: GradeResult["sync"] = [];
    let advanced = false;
    for (const sink of this.sinks) {
      const res = sink.capabilities.revise
        ? await sink.revise(entry, revision)
        : { ok: false, detail: "sink cannot revise an already-written grade" };
      sync.push({ sink: sink.name, ok: res.ok, detail: res.detail });
      if (res.ok && sink.capabilities.advancesSchedule) advanced = true;
    }
    const errs = sync.filter((s) => !s.ok).map((s) => `${s.sink}: ${s.detail}`);
    entry.syncErrors = errs.length ? errs : undefined;
    return { entry, sync, advancedSchedule: advanced };
  }

  /**
   * Write every still-unwritten grade out. Called at the end of a session in
   * the default deferred mode, so revisions made mid-session cost nothing.
   */
  async flush(): Promise<GradeResult[]> {
    const results: GradeResult[] = [];
    for (const entry of this.entries) {
      if (entry.verdict === undefined || entry.syncedAt) continue;
      results.push(await this.pushRecord(entry));
    }
    for (const sink of this.sinks) await sink.flush?.();
    return results;
  }

  async end(): Promise<{ summary: SessionSummary; flushed: GradeResult[] }> {
    const flushed = await this.flush();
    this.endedAt = this.now().toISOString();
    return { summary: this.summary(), flushed };
  }

  summary(): SessionSummary {
    const graded = this.entries.filter((e) => e.verdict !== undefined);
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      asked: this.entries.length,
      remembered: graded.filter((e) => e.verdict === "remembered").length,
      forgot: graded.filter((e) => e.verdict === "forgot").length,
      ungraded: this.entries.length - graded.length,
      deferred: this.entries.filter((e) => e.deferred).length,
      revised: this.entries.filter((e) => e.revisions.length > 0).length,
      remaining: this.remaining,
    };
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = arr[i]!;
    const b = arr[j]!;
    arr[i] = b;
    arr[j] = a;
  }
}
