import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MochiClient,
  ReviewSessionEngine,
  SessionStore,
  buildInstructions,
  checkNumeric,
  deterministicGrade,
  type MochiTemplate,
  type ReviewSettings,
} from "@mochi-voice/core";
import type { ServerConfig } from "./config.js";

/**
 * The review protocol, as MCP tools.
 *
 * Three principles, each learned the hard way from how models behave over a
 * thirty-card session:
 *
 *  1. STATE LIVES HERE. The session handle is an ordinary tool argument (the
 *     pattern the MCP spec now prescribes for cross-call state), because
 *     transport-level sessions are gone from the spec and some clients open a
 *     fresh connection per tool call.
 *  2. EVERY RESULT RE-STEERS. Each tool returns a declared `instruction`
 *     field naming the next legal action. A description read once at
 *     tools/list will not survive thirty cards; a hint in every result will.
 *  3. ORDER IS ENFORCED, NOT REQUESTED. Out-of-order calls get a deterministic
 *     error that names the next legal step, rather than a silent wrong grade.
 */

const VERDICT = z.enum(["remembered", "forgot"]);

/** Shared shape for addressing an earlier card in the session. */
const TARGET_FIELDS = {
  card_id: z
    .string()
    .optional()
    .describe("The cardId of the card to act on. The most reliable way to name an earlier card."),
  back: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "How many cards ago, counting from the card just finished. 0 = the card you just graded, 1 = the one before it.",
    ),
  position: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based position in this session, if you know it."),
};

function target(args: { card_id?: string; back?: number; position?: number }) {
  if (args.card_id) return { cardId: args.card_id };
  if (args.position !== undefined) return { seq: args.position };
  if (args.back !== undefined) return { back: args.back };
  return undefined;
}

function textResult(text: string, structured: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
  };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

export interface ToolDeps {
  config: ServerConfig;
  client: MochiClient;
  store: SessionStore;
}

export function registerReviewTools(server: McpServer, deps: ToolDeps): void {
  const { config, client, store } = deps;

  const resolveSession = (id?: string) => {
    const session = store.resolve(id);
    if (!session) {
      throw new Error(
        id
          ? `No review session with id ${id}. It may have expired. Call start_review to begin a new one.`
          : "No review session is running. Call start_review first.",
      );
    }
    return session;
  };

  // ---------------------------------------------------------------- start ---

  server.registerTool(
    "start_review",
    {
      title: "Start a review session",
      description: `MANDATORY FIRST STEP. Loads the Mochi cards due today and opens a review session.

Returns a session_id that every other review tool requires. Sessions expire after 60 minutes of inactivity; if a tool reports an unknown session, call this again.

WORKFLOW for the whole session:
1) start_review
2) next_card
3) Ask the learner the question in your own words. Do not reveal expectedAnswer.
4) Listen to their answer.
5) grade_card
6) Say the correct answer, then go back to step 2.
7) When next_card reports the queue is empty, call end_session.`,
      inputSchema: {
        deck_id: z.string().optional().describe("Restrict to one Mochi deck. Omit for all due cards."),
        date: z
          .string()
          .optional()
          .describe("ISO-8601 date to review as-of. Omit for today."),
        max_cards: z.number().int().min(1).optional().describe("Cap the session length."),
      },
      outputSchema: {
        session_id: z.string(),
        due_count: z.number(),
        skipped_count: z.number(),
        skipped_reason_sample: z.array(z.string()),
        settings_summary: z.string(),
        write_back: z.string(),
        instruction: z.string(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ deck_id, date, max_cards }) => {
      const due = await client.getDue({
        ...(date ? { date } : {}),
        ...(deck_id ? { deckId: deck_id } : {}),
      });

      // Template-backed cards render through their template, so fetch those
      // once up front rather than per card - Mochi allows one concurrent
      // request per account and some clients time tools out at 10s.
      const templates = new Map<string, MochiTemplate>();
      if (due.some((c) => c["template-id"])) {
        for (const t of await client.listTemplates()) templates.set(t.id, t);
      }

      const deckReviewReverse: Record<string, boolean> = {};
      if (due.some((c) => c["deck-id"])) {
        for (const d of await client.listDecks()) {
          if (d["review-reverse?"]) deckReviewReverse[d.id] = true;
        }
      }

      const settings: ReviewSettings = {
        ...config.settings,
        ...(max_cards ? { maxCards: max_cards } : {}),
      };

      const engine = new ReviewSessionEngine({
        sessionId: randomUUID(),
        cards: due,
        templates,
        deckReviewReverse,
        settings,
        sinks: config.sinks,
      });
      store.put(engine);

      const advancing = config.sinks.filter((s) => s.capabilities.advancesSchedule);
      const writeBack =
        advancing.length > 0
          ? `Grades are written via: ${advancing.map((s) => s.name).join(", ")}.`
          : "Mochi's API cannot record reviews, so grades are logged locally and cards you miss are tagged in Mochi rather than rescheduled.";

      const structured = {
        session_id: engine.sessionId,
        due_count: engine.remaining,
        skipped_count: engine.skippedCards.length,
        skipped_reason_sample: engine.skippedCards.slice(0, 3).map((s) => s.reason),
        settings_summary: `style=${settings.questionStyle}, strictness=${settings.strictness}, year tolerance=±${settings.numericTolerance.years}`,
        write_back: writeBack,
        instruction:
          engine.remaining === 0
            ? "Nothing is due. Tell the learner they are done for today and stop."
            : `${engine.remaining} card(s) due. Greet the learner briefly, then call next_card.`,
      };

      return textResult(
        `Session ${engine.sessionId} started with ${engine.remaining} card(s) due.`,
        structured,
      );
    },
  );

  // ----------------------------------------------------------------- next ---

  server.registerTool(
    "next_card",
    {
      title: "Get the next card",
      description: `Serve the next due card.

Returns the question to ask and, separately, the reference answer.

The reference answer is FOR YOU, NOT FOR THE LEARNER. Do not say it, hint at it, or shape your question around its wording until they have answered.

Ask, listen, then call grade_card. Do not call next_card twice in a row - that abandons the current card ungraded.`,
      inputSchema: {
        session_id: z.string().optional().describe("From start_review. Omit to use the running session."),
      },
      outputSchema: {
        card_id: z.string().optional(),
        position: z.number().optional(),
        question: z.string().optional(),
        expected_answer: z.string().optional(),
        extra_detail: z.array(z.string()).optional(),
        prompt_kind: z.string().optional(),
        remaining: z.number(),
        finished: z.boolean(),
        instruction: z.string(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ session_id }) => {
      let session;
      try {
        session = resolveSession(session_id);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      const pending = session.current();
      if (pending) {
        return errorResult(
          `Card ${pending.cardId} was asked but not graded. Call grade_card (or skip_card if it could not be judged) before asking for the next one.`,
        );
      }

      const card = session.next();
      if (!card) {
        return textResult("The review queue is empty.", {
          remaining: 0,
          finished: true,
          instruction: "No cards left. Call end_session and give a short spoken summary.",
        });
      }

      return textResult(
        `Card ${card.seq}: ${card.question}`,
        {
          card_id: card.cardId,
          position: card.seq,
          question: card.question,
          expected_answer: card.expectedAnswer,
          extra_detail: card.extra,
          prompt_kind: card.promptKind,
          remaining: card.remaining,
          finished: false,
          instruction:
            "Ask this in your own words without revealing the answer, then wait for the learner to finish speaking. Then call grade_card.",
        },
      );
    },
  );

  // ---------------------------------------------------------------- grade ---

  server.registerTool(
    "grade_card",
    {
      title: "Record a verdict",
      description: `Record whether the learner recalled the card. Use this ONLY after they have actually answered.

Grade on meaning, not wording. Numbers and dates are checked arithmetically against the configured tolerance and the result is returned to you - trust it over your own impression.

If you could not judge what they said (unusable transcript, they were interrupted), call skip_card instead. Never guess a grade.

Calling this again for the same card overwrites the previous verdict.`,
      inputSchema: {
        session_id: z.string().optional(),
        verdict: VERDICT.describe("'remembered' if they recalled it, 'forgot' if not."),
        learner_answer: z
          .string()
          .optional()
          .describe("What the learner actually said, as you heard it. Recorded for later review."),
        rationale: z.string().optional().describe("One short line on why you called it that way."),
        ...TARGET_FIELDS,
      },
      outputSchema: {
        card_id: z.string(),
        verdict: z.string(),
        numeric_check: z.string().optional(),
        suggested_verdict: z.string().optional(),
        remaining: z.number(),
        written: z.boolean(),
        advanced_mochi_schedule: z.boolean(),
        instruction: z.string(),
      },
    },
    async ({ session_id, verdict, learner_answer, rationale, card_id, back, position }) => {
      let session;
      try {
        session = resolveSession(session_id);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      const tgt = target({
        ...(card_id ? { card_id } : {}),
        ...(back !== undefined ? { back } : {}),
        ...(position !== undefined ? { position } : {}),
      });

      let numericDetail: string | undefined;
      let suggested: string | undefined;
      const pending = tgt ? undefined : session.current();
      if (pending && learner_answer) {
        // Arithmetic beats impression for dates and quantities - this is the
        // "a year that's close should count" case, decided by subtraction.
        const numeric = checkNumeric(pending.expectedAnswer, learner_answer, session.settings);
        if (numeric.applicable) {
          numericDetail = numeric.detail;
          suggested = numeric.withinTolerance ? "remembered" : "forgot";
        } else {
          const det = deterministicGrade(pending.expectedAnswer, learner_answer, session.settings);
          if (det.confident && det.verdict) suggested = det.verdict;
        }
      }

      try {
        const res = await session.grade({
          verdict,
          ...(learner_answer !== undefined ? { learnerAnswer: learner_answer } : {}),
          ...(rationale !== undefined ? { rationale } : {}),
          source: "model",
          ...(tgt ? { target: tgt } : {}),
        });

        const disagreement =
          suggested && suggested !== verdict
            ? ` The arithmetic check says '${suggested}' (${numericDetail ?? "exact comparison"}); mention the exact value when you state the answer.`
            : "";

        return textResult(
          `Recorded ${verdict} for card ${res.entry.cardId}.`,
          {
            card_id: res.entry.cardId,
            verdict,
            ...(numericDetail ? { numeric_check: numericDetail } : {}),
            ...(suggested ? { suggested_verdict: suggested } : {}),
            remaining: session.remaining,
            written: res.entry.syncedAt !== undefined,
            advanced_mochi_schedule: res.advancedSchedule,
            instruction:
              (session.settings.alwaysStateAnswer
                ? "State the correct answer briefly, then call next_card."
                : verdict === "forgot"
                  ? "Say the correct answer, then call next_card."
                  : "Confirm briefly, then call next_card.") + disagreement,
          },
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --------------------------------------------------------------- revise ---

  server.registerTool(
    "revise_grade",
    {
      title: "Change a grade already given",
      description: `Change a verdict you already recorded, including for a card from earlier in the session.

Use this whenever the learner disputes a call - "no, that should count", "that was wrong, mark it wrong", "actually I got that one". Their judgement wins; do not argue.

Naming the card: omit all of card_id/back/position to change the card you most recently graded. Use back=1 for the one before it, or card_id when you are sure of it.

This works even after the grade has been written out. It never re-asks the card and never disturbs the card in progress - acknowledge in a few words and carry on.`,
      inputSchema: {
        session_id: z.string().optional(),
        verdict: VERDICT.describe("The corrected verdict."),
        reason: z.string().optional().describe("What the learner said, in short."),
        ...TARGET_FIELDS,
      },
      outputSchema: {
        card_id: z.string(),
        question: z.string(),
        from: z.string().optional(),
        to: z.string(),
        rewritten: z.boolean(),
        instruction: z.string(),
      },
    },
    async ({ session_id, verdict, reason, card_id, back, position }) => {
      let session;
      try {
        session = resolveSession(session_id);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      try {
        const before = session.log.find((e) => e.cardId === card_id)?.verdict;
        const tgt = target({
          ...(card_id ? { card_id } : {}),
          ...(back !== undefined ? { back } : {}),
          ...(position !== undefined ? { position } : {}),
        });
        const res = await session.revise({
          verdict,
          ...(reason !== undefined ? { reason } : {}),
          source: "user",
          ...(tgt ? { target: tgt } : {}),
        });
        const last = res.entry.revisions[res.entry.revisions.length - 1];
        return textResult(
          `Card ${res.entry.cardId} is now ${verdict}.`,
          {
            card_id: res.entry.cardId,
            question: res.entry.question,
            from: last?.from ?? before,
            to: verdict,
            rewritten: res.sync.length > 0,
            instruction:
              "Acknowledge in a few words and continue with the card in progress. Do not re-ask the corrected card.",
          },
        );
      } catch (err) {
        return errorResult(
          `${err instanceof Error ? err.message : String(err)} Ask the learner which card they mean, or call session_status to see what has been asked.`,
        );
      }
    },
  );

  // ----------------------------------------------------------------- skip ---

  server.registerTool(
    "skip_card",
    {
      title: "Leave a card ungraded",
      description: `Leave the current card without a verdict.

Use this when the answer could not be judged rather than when it was wrong: the transcript was unusable, the learner was interrupted, or you are genuinely unsure. A skipped card is not written anywhere and its schedule is untouched.

Do NOT use this for "I don't know" - that is a real lapse, so grade it 'forgot'.`,
      inputSchema: {
        session_id: z.string().optional(),
        reason: z.string().describe("Why it could not be graded."),
        ...TARGET_FIELDS,
      },
      outputSchema: {
        card_id: z.string(),
        remaining: z.number(),
        instruction: z.string(),
      },
    },
    async ({ session_id, reason, card_id, back, position }) => {
      let session;
      try {
        session = resolveSession(session_id);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      const tgt = target({
        ...(card_id ? { card_id } : {}),
        ...(back !== undefined ? { back } : {}),
        ...(position !== undefined ? { position } : {}),
      });
      const entry = session.defer({ reason, ...(tgt ? { target: tgt } : {}) });
      return textResult(`Card ${entry.cardId} left ungraded.`, {
        card_id: entry.cardId,
        remaining: session.remaining,
        instruction: "Move on: call next_card.",
      });
    },
  );

  // --------------------------------------------------------------- status ---

  server.registerTool(
    "session_status",
    {
      title: "How the session is going",
      description:
        "Counts for the session so far. Use when the learner asks how they are doing, or when you have lost track of which cards have been asked.",
      inputSchema: { session_id: z.string().optional() },
      outputSchema: {
        asked: z.number(),
        remembered: z.number(),
        forgot: z.number(),
        skipped: z.number(),
        revised: z.number(),
        remaining: z.number(),
        recent: z.array(z.object({ position: z.number(), card_id: z.string(), question: z.string(), verdict: z.string() })),
        instruction: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id }) => {
      let session;
      try {
        session = resolveSession(session_id);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      const s = session.summary();
      const recent = session.log.slice(-5).map((e) => ({
        position: e.seq,
        card_id: e.cardId,
        question: e.question.slice(0, 80),
        verdict: e.deferred ? "skipped" : (e.verdict ?? "ungraded"),
      }));
      return textResult(
        `${s.remembered} right, ${s.forgot} missed, ${s.remaining} to go.`,
        {
          asked: s.asked,
          remembered: s.remembered,
          forgot: s.forgot,
          skipped: s.deferred,
          revised: s.revised,
          remaining: s.remaining,
          recent,
          instruction: "Report the numbers briefly, then continue where you left off.",
        },
      );
    },
  );

  // ------------------------------------------------------------------ end ---

  server.registerTool(
    "end_session",
    {
      title: "Finish the session",
      description:
        "Close the session and write out every grade. Call this when the queue is empty or the learner wants to stop. After this, the session cannot be graded or revised further - so handle any last correction BEFORE calling it.",
      inputSchema: { session_id: z.string().optional() },
      outputSchema: {
        asked: z.number(),
        remembered: z.number(),
        forgot: z.number(),
        skipped: z.number(),
        revised: z.number(),
        write_errors: z.array(z.string()),
        advanced_mochi_schedule: z.boolean(),
        missed_cards: z.array(z.object({ question: z.string(), answer: z.string() })),
        instruction: z.string(),
      },
    },
    async ({ session_id }) => {
      let session;
      try {
        session = resolveSession(session_id);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
      const { summary, flushed } = await session.end();
      const writeErrors = flushed.flatMap((f) =>
        f.sync.filter((s) => !s.ok).map((s) => `${s.sink}: ${s.detail ?? "failed"}`),
      );
      const missed = session.log
        .filter((e) => e.verdict === "forgot")
        .slice(0, 10)
        .map((e) => ({ question: e.question.slice(0, 120), answer: e.expectedAnswer.slice(0, 120) }));

      return textResult(
        `Done: ${summary.remembered}/${summary.asked} recalled.`,
        {
          asked: summary.asked,
          remembered: summary.remembered,
          forgot: summary.forgot,
          skipped: summary.deferred,
          revised: summary.revised,
          write_errors: [...new Set(writeErrors)],
          advanced_mochi_schedule: flushed.some((f) => f.advancedSchedule),
          missed_cards: missed,
          instruction:
            "Give a short spoken summary: how many they got, and one line on what they missed. Then stop talking.",
        },
      );
    },
  );

  // -------------------------------------------------------- instructions ---

  server.registerTool(
    "review_instructions",
    {
      title: "How to conduct the review",
      description:
        "The full review procedure and grading policy, generated from the server's current settings. Fetch this once at the start if your session was not configured with these instructions already.",
      inputSchema: {},
      outputSchema: { instructions: z.string(), settings: z.string() },
      annotations: { readOnlyHint: true },
    },
    async () => {
      const text = buildInstructions({ settings: config.settings });
      return textResult(text, {
        instructions: text,
        settings: JSON.stringify(config.settings),
      });
    },
  );
}
