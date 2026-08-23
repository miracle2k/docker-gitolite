import type { PromptKind } from "../cards/parse.js";

/**
 * Mochi's scheduler has exactly one grade axis: Remembered or Forgot
 * (roughly interval x2 vs interval x0.5). There is no Again/Hard/Good/Easy
 * scale, so the voice agent only ever has to make a binary call.
 */
export type Verdict = "remembered" | "forgot";

/** Who decided a grade. User overrides always beat the model. */
export type VerdictSource = "model" | "user" | "policy";

export interface GradeRevision {
  at: string;
  from: Verdict;
  to: Verdict;
  source: VerdictSource;
  reason?: string;
}

export interface SessionEntry {
  /** 1-based position in the session, used for "go back two cards". */
  seq: number;
  cardId: string;
  /** Which sub-schedule of the card was asked ("forward", "cloze:2", ...). */
  promptKey: string;
  promptKind: PromptKind;
  deckId?: string;
  /** The question as actually posed (may be a rephrasing by the agent). */
  question: string;
  /** The reference answer taken from the card. */
  expectedAnswer: string;
  askedAt: string;
  answeredAt?: string;
  /** Transcript of what the learner said, when available. */
  learnerAnswer?: string;
  verdict?: Verdict;
  verdictSource?: VerdictSource;
  /**
   * Set when the card was deliberately left ungraded - the transcript was
   * unusable, the learner asked to skip, or the grader was not confident
   * enough to call it. A deferred card is never written to the sinks, so an
   * uncertain judgement leaves the schedule untouched instead of silently
   * becoming a lapse.
   */
  deferred?: boolean;
  deferredReason?: string;
  /** One line explaining the call, surfaced in the end-of-session summary. */
  rationale?: string;
  revisions: GradeRevision[];
  /** Set once the grade has been handed to the sinks. */
  syncedAt?: string;
  syncErrors?: string[];
}

export type QuestionStyle = "verbatim" | "rephrase" | "contextual";
export type Strictness = "lenient" | "balanced" | "strict";
export type SyncMode = "immediate" | "end-of-session";
export type PromptSelection = "least-recent" | "forward-only" | "random";

/**
 * Tunable review strategy. These are the knobs the user asked to be able to
 * experiment with: different ways of conducting the session that may work
 * better or worse. They are data, not code, so every front-end shares them.
 */
export interface ReviewSettings {
  /**
   * verbatim   - read the card as written
   * rephrase   - restate the prompt naturally, targeting the missing piece
   * contextual - build a short scenario around the prompt for variety
   */
  questionStyle: QuestionStyle;
  /** How forgiving the grader should be about wording. */
  strictness: Strictness;
  /** Absolute tolerance for numeric answers, by magnitude of the reference. */
  numericTolerance: {
    /** Years may be off by this many and still count. */
    years: number;
    /** Other numbers may be off by this fraction (0.05 = 5%). */
    relative: number;
  };
  /** Read the reference answer aloud even when the learner was right. */
  alwaysStateAnswer: boolean;
  /** Which sub-schedule to ask when a card has several. */
  promptSelection: PromptSelection;
  /** Stop the session after this many cards (0 = no limit). */
  maxCards: number;
  /** Write grades out as they happen, or all at once at the end. */
  syncMode: SyncMode;
  /** Skip cards whose prompt or answer cannot be spoken (image-only, etc.). */
  skipUnspeakable: boolean;
}

export const DEFAULT_SETTINGS: ReviewSettings = {
  questionStyle: "rephrase",
  strictness: "balanced",
  numericTolerance: { years: 3, relative: 0.05 },
  alwaysStateAnswer: true,
  promptSelection: "least-recent",
  maxCards: 0,
  // Deferred by default: it makes retroactive revision free, and the learner
  // very often corrects a grade one or two cards later.
  syncMode: "end-of-session",
  skipUnspeakable: true,
};

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  asked: number;
  remembered: number;
  forgot: number;
  ungraded: number;
  deferred: number;
  revised: number;
  remaining: number;
}
