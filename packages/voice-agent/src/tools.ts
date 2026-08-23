import {
  ReviewSessionEngine,
  SessionStore,
  checkNumeric,
  type ReviewSettings,
} from "@mochi-voice/core";

/**
 * The review tools as OpenAI Realtime FUNCTION tools.
 *
 * The MCP server and this share one engine but expose it two ways, and that
 * is deliberate rather than duplication:
 *
 *  - Hosted MCP has OpenAI's infrastructure call your server, so the server
 *    must be reachable from the public internet.
 *  - These function tools are answered over a sideband socket that WE open
 *    to OpenAI, so a box behind NAT needs no inbound port at all.
 *
 * The second is what makes a NAS deployment practical, so both exist.
 */

export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const TARGET_PROPS = {
  card_id: { type: "string", description: "cardId of the card to act on." },
  back: {
    type: "integer",
    minimum: 0,
    description: "How many cards ago: 0 = the card you just graded, 1 = the one before it.",
  },
};

export const REVIEW_TOOLS: RealtimeTool[] = [
  {
    type: "function",
    name: "next_card",
    description:
      "Get the next due card. Returns the question and, separately, the reference answer - which is for you, not the learner. Ask, listen, then call grade_card. Never call this twice in a row.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "grade_card",
    description:
      "Record whether the learner recalled the card. Only after they have actually answered. If you could not judge what they said, call skip_card instead - never guess.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["remembered", "forgot"] },
        learner_answer: { type: "string", description: "What they said, as you heard it." },
        rationale: { type: "string", description: "One short line on why." },
      },
      required: ["verdict"],
    },
  },
  {
    type: "function",
    name: "revise_grade",
    description:
      "Change a grade you already gave, including for an earlier card. Use whenever the learner disputes a call - 'no, that should count', 'actually mark that wrong'. Omit card_id and back to correct the card you most recently graded. Works even after the grade was written. Do not re-ask the card.",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["remembered", "forgot"] },
        reason: { type: "string" },
        ...TARGET_PROPS,
      },
      required: ["verdict"],
    },
  },
  {
    type: "function",
    name: "skip_card",
    description:
      "Leave the current card ungraded because the answer could not be judged (garbled transcript, interruption). NOT for 'I don't know' - that is a real lapse, grade it 'forgot'.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    type: "function",
    name: "session_status",
    description: "Counts so far. Use when the learner asks how they are doing.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "end_session",
    description:
      "Finish and write out every grade. Handle any last correction BEFORE calling this.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

export interface ToolContext {
  store: SessionStore;
  sessionId: string;
  settings: ReviewSettings;
}

function engineFor(ctx: ToolContext): ReviewSessionEngine {
  const engine = ctx.store.get(ctx.sessionId);
  if (!engine) throw new Error("This review session has ended. Tell the learner and stop.");
  return engine;
}

function targetFrom(args: Record<string, unknown>) {
  if (typeof args.card_id === "string" && args.card_id) return { cardId: args.card_id };
  if (typeof args.back === "number") return { back: args.back };
  return undefined;
}

/**
 * Execute one tool call. Returns a JSON-serialisable result that goes back
 * to the model as a function_call_output.
 *
 * Errors are returned as data rather than thrown: a voice session must never
 * die because the model called something in the wrong order. It gets told
 * what the next legal step is and carries on.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  try {
    const engine = engineFor(ctx);

    switch (name) {
      case "next_card": {
        const pending = engine.current();
        if (pending) {
          return {
            error: `Card ${pending.cardId} was asked but not graded.`,
            instruction: "Call grade_card (or skip_card) before asking for another card.",
          };
        }
        const card = engine.next();
        if (!card) {
          return {
            finished: true,
            remaining: 0,
            instruction: "No cards left. Call end_session and give a short spoken summary.",
          };
        }
        return {
          card_id: card.cardId,
          question: card.question,
          expected_answer: card.expectedAnswer,
          extra_detail: card.extra,
          remaining: card.remaining,
          finished: false,
          instruction:
            "Ask this in your own words without revealing the answer, then wait for the learner to finish. Then call grade_card.",
        };
      }

      case "grade_card": {
        const verdict = args.verdict === "forgot" ? "forgot" : "remembered";
        const learnerAnswer = typeof args.learner_answer === "string" ? args.learner_answer : undefined;
        const pending = engine.current();

        let numeric: ReturnType<typeof checkNumeric> | undefined;
        if (pending && learnerAnswer) {
          numeric = checkNumeric(pending.expectedAnswer, learnerAnswer, engine.settings);
        }

        const res = await engine.grade({
          verdict,
          ...(learnerAnswer !== undefined ? { learnerAnswer } : {}),
          ...(typeof args.rationale === "string" ? { rationale: args.rationale } : {}),
          source: "model",
        });

        const suggested = numeric?.applicable
          ? numeric.withinTolerance
            ? "remembered"
            : "forgot"
          : undefined;

        return {
          card_id: res.entry.cardId,
          verdict,
          ...(numeric?.applicable ? { numeric_check: numeric.detail } : {}),
          ...(suggested && suggested !== verdict ? { arithmetic_disagrees: suggested } : {}),
          remaining: engine.remaining,
          instruction:
            (engine.settings.alwaysStateAnswer || verdict === "forgot"
              ? "State the correct answer briefly, then call next_card."
              : "Confirm briefly, then call next_card.") +
            (suggested && suggested !== verdict
              ? ` The arithmetic check says '${suggested}' (${numeric?.detail}); give the exact value.`
              : ""),
        };
      }

      case "revise_grade": {
        const verdict = args.verdict === "forgot" ? "forgot" : "remembered";
        const target = targetFrom(args);
        const res = await engine.revise({
          verdict,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
          source: "user",
          ...(target ? { target } : {}),
        });
        const last = res.entry.revisions[res.entry.revisions.length - 1];
        return {
          card_id: res.entry.cardId,
          question: res.entry.question,
          from: last?.from,
          to: verdict,
          instruction:
            "Acknowledge in a few words and continue with the card in progress. Do not re-ask the corrected card.",
        };
      }

      case "skip_card": {
        const entry = engine.defer({
          reason: typeof args.reason === "string" ? args.reason : "not graded",
        });
        return {
          card_id: entry.cardId,
          remaining: engine.remaining,
          instruction: "Move on: call next_card.",
        };
      }

      case "session_status": {
        const s = engine.summary();
        return {
          asked: s.asked,
          remembered: s.remembered,
          forgot: s.forgot,
          skipped: s.deferred,
          revised: s.revised,
          remaining: s.remaining,
          instruction: "Report the numbers briefly, then continue.",
        };
      }

      case "end_session": {
        const { summary } = await engine.end();
        const missed = engine.log
          .filter((e) => e.verdict === "forgot")
          .slice(0, 10)
          .map((e) => ({ question: e.question.slice(0, 120), answer: e.expectedAnswer.slice(0, 120) }));
        return {
          asked: summary.asked,
          remembered: summary.remembered,
          forgot: summary.forgot,
          skipped: summary.deferred,
          revised: summary.revised,
          missed_cards: missed,
          instruction:
            "Give a short spoken summary: how many they got and one line on what they missed. Then stop talking.",
        };
      }

      default:
        return { error: `Unknown tool ${name}`, instruction: "Continue with next_card." };
    }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      instruction: "Tell the learner something went wrong, then continue or stop.",
    };
  }
}
