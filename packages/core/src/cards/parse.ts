import type { MochiCard, MochiTemplate } from "../mochi/types.js";
import { blankCloze, clozeGroups, hasCloze, revealClozes } from "./cloze.js";
import { effectiveContent } from "./template.js";
import { toSpeakable } from "./speech.js";

/**
 * Turning a Mochi card into something answerable out loud.
 *
 * A single Mochi card can carry SEVERAL independently schedulable prompts:
 *  - forward (front -> back)
 *  - reverse (back -> front), when `review-reverse?` is set
 *  - one per numbered cloze group, plus one for all bare clozes
 *
 * `GET /due` does not say WHICH of these is due (see docs/mochi-api-constraints.md),
 * so we enumerate every prompt a card can produce and let the session policy
 * choose. This is the one place where we knowingly diverge from Mochi's own
 * scheduling, and it is recorded as such.
 */

/** Split card markdown into sides. The separator is a line of EXACTLY three dashes. */
export function splitSides(content: string): string[] {
  return content
    .split(/^[ \t]*---[ \t]*$/m)
    .map((s) => s.trim())
    .filter((s, i, arr) => s !== "" || arr.length === 1);
}

export type PromptKind = "forward" | "reverse" | "cloze";

export interface ReviewPrompt {
  /** Stable id for this prompt within the card, e.g. "forward", "cloze:2". */
  key: string;
  kind: PromptKind;
  /** Cloze group index for cloze prompts (null = the bare-cloze group). */
  clozeGroup?: number | null;
  /** What the learner is shown/told, as speakable text. */
  question: string;
  /** What counts as the correct answer, as speakable text. */
  answer: string;
  /** Additional sides beyond the answer (extra reveal steps), for context. */
  extra: string[];
  /** False when this prompt cannot be delivered by voice (e.g. image answer). */
  speakable: boolean;
  notes: string[];
}

export interface ParsedCard {
  id: string;
  deckId?: string;
  /** Fully rendered markdown (template applied), clozes still marked up. */
  content: string;
  sides: string[];
  isCloze: boolean;
  reviewReverse: boolean;
  prompts: ReviewPrompt[];
}

export interface ParseOptions {
  templates?: Map<string, MochiTemplate> | Record<string, MochiTemplate>;
  /**
   * Deck-level `review-reverse?`. Mochi exposes the flag on both the card and
   * the deck; the deck value applies when the card does not set its own.
   */
  deckReviewReverse?: boolean;
  /** Placeholder spoken in place of a blanked cloze. */
  clozePlaceholder?: string;
}

export function parseCard(card: MochiCard, opts: ParseOptions = {}): ParsedCard {
  const content = effectiveContent(card, opts.templates);
  const sides = splitSides(content);
  const isCloze = hasCloze(content);
  const reviewReverse = card["review-reverse?"] ?? opts.deckReviewReverse ?? false;

  const prompts: ReviewPrompt[] = [];

  if (isCloze) {
    // Cloze cards are prompted in place: the whole text with one group hidden.
    for (const group of clozeGroups(content)) {
      const blanked = blankCloze(content, group.group, {
        placeholder: opts.clozePlaceholder ?? "blank",
      });
      const q = toSpeakable(stripSideSeparators(blanked));
      const a = toSpeakable(group.answers.join("; "));
      prompts.push({
        key: group.group === null ? "cloze" : `cloze:${group.group}`,
        kind: "cloze",
        clozeGroup: group.group,
        question: q.text,
        answer: a.text,
        extra: [],
        speakable: q.speakable && a.speakable,
        notes: [...q.notes, ...a.notes],
      });
    }
  }

  // A card can be BOTH cloze and two-sided; Mochi schedules the sides too.
  if (sides.length > 1) {
    const front = sides[0] ?? "";
    const back = sides[1] ?? "";
    const rest = sides.slice(2);
    const fq = toSpeakable(revealClozes(front));
    const fa = toSpeakable(revealClozes(back));
    prompts.push({
      key: "forward",
      kind: "forward",
      question: fq.text,
      answer: fa.text,
      extra: rest.map((s) => toSpeakable(revealClozes(s)).text),
      speakable: fq.speakable && fa.speakable,
      notes: [...fq.notes, ...fa.notes],
    });

    if (reviewReverse) {
      prompts.push({
        key: "reverse",
        kind: "reverse",
        question: fa.text,
        answer: fq.text,
        extra: rest.map((s) => toSpeakable(revealClozes(s)).text),
        speakable: fq.speakable && fa.speakable,
        notes: [...fq.notes, ...fa.notes],
      });
    }
  } else if (!isCloze) {
    // Single-sided, no cloze: there is nothing to withhold, so it cannot be
    // turned into a question. Surface it as unspeakable rather than asking
    // the user to guess at a statement.
    const only = toSpeakable(content);
    prompts.push({
      key: "forward",
      kind: "forward",
      question: only.text,
      answer: only.text,
      extra: [],
      speakable: false,
      notes: [...only.notes, "card has a single side and no cloze - nothing to ask"],
    });
  }

  return {
    id: card.id,
    deckId: card["deck-id"],
    content,
    sides,
    isCloze,
    reviewReverse,
    prompts,
  };
}

/** Remove `---` side separators, used when a cloze prompt spans all sides. */
function stripSideSeparators(content: string): string {
  return content.replace(/^[ \t]*---[ \t]*$/gm, "\n");
}

/**
 * Pick which of a card's prompts to ask. Mochi's `/due` payload does not tell
 * us which sub-schedule fell due, so we apply a deterministic policy:
 * least-recently-reviewed sub-schedule first, then declaration order.
 */
export function selectPrompt(
  parsed: ParsedCard,
  card: MochiCard,
  opts: { preferKind?: PromptKind } = {},
): ReviewPrompt | undefined {
  const usable = parsed.prompts.filter((p) => p.speakable);
  if (usable.length === 0) return undefined;
  if (opts.preferKind) {
    const preferred = usable.find((p) => p.kind === opts.preferKind);
    if (preferred) return preferred;
  }

  const lastReviewed = (p: ReviewPrompt): number => {
    let history = card.reviews;
    if (p.kind === "reverse") history = card["reverse-reviews"];
    else if (p.kind === "cloze") {
      const key = p.clozeGroup === null ? "null" : String(p.clozeGroup);
      history = card["cloze/reviews"]?.[key];
    }
    const last = history?.[history.length - 1]?.date?.date;
    return last ? Date.parse(last) : 0; // never reviewed sorts first
  };

  return [...usable].sort((a, b) => lastReviewed(a) - lastReviewed(b))[0];
}
