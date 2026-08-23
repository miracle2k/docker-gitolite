import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_SETTINGS,
  MemorySink,
  ReviewSessionEngine,
  SessionStore,
  type MochiCard,
} from "@mochi-voice/core";
import { REVIEW_TOOLS, runTool, type ToolContext } from "../src/tools.js";
import { buildSessionConfig, handleEvent } from "../src/realtime.js";

const CARDS: MochiCard[] = [
  { id: "c1", content: "Capital of France?\n---\nParis" },
  { id: "c2", content: "Year the Bastille fell?\n---\n1789" },
];

let ctx: ToolContext;
let sink: MemorySink;

beforeEach(() => {
  const store = new SessionStore();
  sink = new MemorySink();
  const engine = new ReviewSessionEngine({
    sessionId: "s1",
    cards: CARDS,
    settings: DEFAULT_SETTINGS,
    sinks: [sink],
  });
  store.put(engine);
  ctx = { store, sessionId: "s1", settings: DEFAULT_SETTINGS };
});

const call = (name: string, args: Record<string, unknown> = {}) => runTool(name, args, ctx);

describe("session config", () => {
  it("uses the GA field names, not the beta ones", () => {
    const cfg = buildSessionConfig({ settings: DEFAULT_SETTINGS }) as any;
    // `modalities` was renamed and `temperature` was removed in the GA shape.
    expect(cfg.output_modalities).toEqual(["audio"]);
    expect(cfg.modalities).toBeUndefined();
    expect(cfg.temperature).toBeUndefined();
    expect(cfg.type).toBe("realtime");
  });

  it("waits for a learner who pauses to think", () => {
    const cfg = buildSessionConfig({ settings: DEFAULT_SETTINGS }) as any;
    const td = cfg.audio.input.turn_detection;
    expect(td.type).toBe("semantic_vad");
    expect(td.eagerness).toBe("low");
    expect(td.idle_timeout_ms).toBeGreaterThanOrEqual(8000);
  });

  it("ships the review tools", () => {
    const cfg = buildSessionConfig({ settings: DEFAULT_SETTINGS }) as any;
    expect(cfg.tools.map((t: any) => t.name)).toContain("revise_grade");
  });

  it("tells the model the answer is not for the learner", () => {
    const cfg = buildSessionConfig({ settings: DEFAULT_SETTINGS }) as any;
    expect(cfg.instructions).toContain("NEVER say it");
  });
});

describe("tool definitions", () => {
  it("declares revise_grade so the model knows corrections are possible", () => {
    const revise = REVIEW_TOOLS.find((t) => t.name === "revise_grade")!;
    expect(revise.description).toContain("disputes");
    expect(revise.description).toContain("even after the grade was written");
  });
});

describe("running tools", () => {
  it("serves a card without leaking the answer into the question", async () => {
    const r = await call("next_card");
    expect(r.question).toBe("Capital of France?");
    expect(r.expected_answer).toBe("Paris");
    expect(r.remaining).toBe(1);
  });

  it("refuses to abandon an ungraded card", async () => {
    await call("next_card");
    const r = await call("next_card");
    expect(r.error).toContain("not graded");
    expect(r.instruction).toContain("grade_card");
  });

  it("grades and reports the arithmetic check", async () => {
    await call("next_card");
    await call("grade_card", { verdict: "remembered" });
    await call("next_card");
    const r = await call("grade_card", {
      verdict: "remembered",
      learner_answer: "seventeen ninety one",
    });
    expect(r.numeric_check).toContain("tolerance 3");
    expect(r.arithmetic_disagrees).toBeUndefined();
  });

  it("flags when the model's call contradicts the arithmetic", async () => {
    await call("next_card");
    await call("grade_card", { verdict: "remembered" });
    await call("next_card");
    const r = await call("grade_card", { verdict: "remembered", learner_answer: "1850" });
    expect(r.arithmetic_disagrees).toBe("forgot");
    expect(String(r.instruction)).toContain("arithmetic check says 'forgot'");
  });

  it("revises an earlier grade without touching the card in progress", async () => {
    await call("next_card");
    await call("grade_card", { verdict: "remembered" });
    await call("next_card");
    const r = await call("revise_grade", { verdict: "forgot", reason: "learner objected" });
    expect(r.card_id).toBe("c1");
    expect(r.from).toBe("remembered");
    expect(String(r.instruction)).toContain("Do not re-ask");
    expect(ctx.store.get("s1")!.current()!.cardId).toBe("c2");
  });

  it("never throws at the model, even for a bad call", async () => {
    const r = await call("revise_grade", { verdict: "forgot", card_id: "nope" });
    expect(r.error).toBeDefined();
    expect(r.instruction).toBeDefined();
  });

  it("survives an ended session without crashing the call", async () => {
    ctx.store.delete("s1");
    const r = await call("next_card");
    expect(r.error).toContain("ended");
  });

  it("writes only the corrected verdict at the end", async () => {
    await call("next_card");
    await call("grade_card", { verdict: "remembered" });
    await call("revise_grade", { verdict: "forgot" });
    await call("end_session");
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]!.verdict).toBe("forgot");
  });
});

describe("realtime event handling", () => {
  it("answers a function call and asks the model to speak again", async () => {
    const sent: Record<string, unknown>[] = [];
    await handleEvent(
      {
        type: "response.function_call_arguments.done",
        name: "next_card",
        call_id: "fc_1",
        arguments: "{}",
      },
      ctx,
      (p) => sent.push(p),
    );

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "fc_1" },
    });
    const output = JSON.parse(String((sent[0] as any).item.output));
    expect(output.question).toBe("Capital of France?");
    // Without this the model runs the tool and then says nothing at all,
    // which is indistinguishable from a crash to someone listening.
    expect(sent[1]).toEqual({ type: "response.create" });
  });

  it("ignores unrelated events", async () => {
    const sent: unknown[] = [];
    await handleEvent({ type: "response.audio.delta" }, ctx, (p) => sent.push(p));
    expect(sent).toHaveLength(0);
  });

  it("tolerates malformed tool arguments", async () => {
    const sent: Record<string, unknown>[] = [];
    await handleEvent(
      {
        type: "response.function_call_arguments.done",
        name: "grade_card",
        call_id: "fc_2",
        arguments: "{not json",
      },
      ctx,
      (p) => sent.push(p),
    );
    expect(sent).toHaveLength(2); // still replies rather than hanging the call
  });
});

describe("regressions", () => {
  it("rejects a verdict it cannot parse instead of guessing", async () => {
    // Coercing anything-but-"forgot" to "remembered" meant a malformed tool
    // call silently recorded a correct recall.
    await call("next_card");
    for (const bad of [undefined, "Forgot", "incorrect", "", 1, null]) {
      const r = await call("grade_card", { verdict: bad as unknown });
      expect(r.error).toContain("remembered");
      expect(r.instruction).toBeDefined();
    }
    // And the card is genuinely still ungraded.
    const status = await call("session_status");
    expect(status.remembered).toBe(0);
    expect(status.forgot).toBe(0);
  });

  it("rejects an unparseable verdict on revise too", async () => {
    await call("next_card");
    await call("grade_card", { verdict: "remembered" });
    const r = await call("revise_grade", { verdict: "wrong" });
    expect(r.error).toContain("remembered");
  });

  it("a malformed tool call does not become a grade", async () => {
    const sent: Record<string, unknown>[] = [];
    await call("next_card");
    await handleEvent(
      {
        type: "response.function_call_arguments.done",
        name: "grade_card",
        call_id: "fc_x",
        arguments: "{not json",
      },
      ctx,
      (p) => sent.push(p),
    );
    const output = JSON.parse(String((sent[0] as any).item.output));
    expect(output.error).toBeDefined();
    const status = await call("session_status");
    expect(status.remembered).toBe(0);
  });

  it("skipping does not wedge the voice session either", async () => {
    await call("next_card");
    await call("skip_card", { reason: "garbled" });
    const next = await call("next_card");
    expect(next.error).toBeUndefined();
    expect(next.card_id).toBe("c2");
  });
});
