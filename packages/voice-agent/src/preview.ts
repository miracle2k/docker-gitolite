import {
  MochiClient,
  ReviewSessionEngine,
  parseCard,
  type MochiTemplate,
  type ReviewSettings,
} from "@mochi-voice/core";

/**
 * Show what a review session would ask, without any voice model involved.
 *
 * This exists because card parsing is the part most likely to be wrong
 * against a real collection: templates, cloze groups, reversed cards and
 * image-only answers all vary per user. Being able to run one command and
 * see every question, every reference answer, and every card that had to be
 * skipped - before spending a cent on audio - is worth more than any amount
 * of unit testing against invented cards.
 */
export interface PreviewOptions {
  client: MochiClient;
  settings: ReviewSettings;
  deckId?: string;
  date?: string;
  limit?: number;
}

export interface PreviewLine {
  cardId: string;
  promptKey: string;
  kind: string;
  question: string;
  answer: string;
  skipped?: string;
}

export async function preview(opts: PreviewOptions): Promise<{
  lines: PreviewLine[];
  skipped: { cardId: string; reason: string }[];
  total: number;
}> {
  const due = await opts.client.getDue({
    ...(opts.date ? { date: opts.date } : {}),
    ...(opts.deckId ? { deckId: opts.deckId } : {}),
  });

  const templates = new Map<string, MochiTemplate>();
  if (due.some((c) => c["template-id"])) {
    for (const t of await opts.client.listTemplates()) templates.set(t.id, t);
  }
  const deckReviewReverse: Record<string, boolean> = {};
  for (const d of await opts.client.listDecks()) {
    if (d["review-reverse?"]) deckReviewReverse[d.id] = true;
  }

  const engine = new ReviewSessionEngine({
    sessionId: "preview",
    cards: due,
    templates,
    deckReviewReverse,
    settings: { ...opts.settings, ...(opts.limit ? { maxCards: opts.limit } : {}) },
    sinks: [],
  });

  const lines: PreviewLine[] = [];
  for (;;) {
    const card = engine.next();
    if (!card) break;
    lines.push({
      cardId: card.cardId,
      promptKey: card.promptKey,
      kind: card.promptKind,
      question: card.question,
      answer: card.expectedAnswer,
    });
  }

  return { lines, skipped: [...engine.skippedCards], total: due.length };
}

/** Every prompt a single card can produce, for debugging one awkward card. */
export function explainCard(
  card: Parameters<typeof parseCard>[0],
  templates?: Map<string, MochiTemplate>,
): string[] {
  const parsed = parseCard(card, templates ? { templates } : {});
  return parsed.prompts.map(
    (p) =>
      `${p.key} (${p.kind})${p.speakable ? "" : " [UNUSABLE]"}\n  Q: ${p.question}\n  A: ${p.answer}` +
      (p.notes.length ? `\n  notes: ${p.notes.join("; ")}` : ""),
  );
}
