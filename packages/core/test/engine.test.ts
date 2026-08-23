import { beforeEach, describe, expect, it } from "vitest";
import { ReviewSessionEngine } from "../src/session/engine.js";
import { MemorySink } from "../src/sinks/memory.js";
import type { GradeSink, SinkResult } from "../src/sinks/types.js";
import type { GradeRevision, SessionEntry } from "../src/session/types.js";
import type { MochiCard } from "../src/mochi/types.js";

const cards: MochiCard[] = [
  { id: "c1", content: "Capital of France?\n---\nParis" },
  { id: "c2", content: "Year of the French Revolution?\n---\n1789" },
  { id: "c3", content: "Capital of Japan?\n---\nTokyo" },
];

const engineWith = (sinks: GradeSink[] = [], settings = {}) =>
  new ReviewSessionEngine({ sessionId: "s1", cards, sinks, settings });

describe("session flow", () => {
  it("serves cards in order and reports what remains", () => {
    const e = engineWith();
    const first = e.next()!;
    expect(first.cardId).toBe("c1");
    expect(first.question).toBe("Capital of France?");
    expect(first.expectedAnswer).toBe("Paris");
    expect(first.remaining).toBe(2);
    expect(e.next()!.cardId).toBe("c2");
    expect(e.next()!.cardId).toBe("c3");
    expect(e.next()).toBeUndefined();
  });

  it("skips cards that cannot be answered by voice", () => {
    const e = new ReviewSessionEngine({
      sessionId: "s",
      cards: [{ id: "img", content: "What?\n---\n![](@media/a.png)" }, cards[0]!],
    });
    expect(e.remaining).toBe(1);
    expect(e.next()!.cardId).toBe("c1");
    expect(e.skippedCards[0]!.cardId).toBe("img");
  });

  it("respects maxCards", () => {
    const e = engineWith([], { maxCards: 2 });
    expect(e.remaining).toBe(2);
  });

  it("grades the card in progress by default", async () => {
    const e = engineWith();
    e.next();
    const { entry } = await e.grade({ verdict: "remembered", learnerAnswer: "Paris" });
    expect(entry.cardId).toBe("c1");
    expect(entry.verdict).toBe("remembered");
    expect(e.summary().remembered).toBe(1);
  });
});

describe("retroactive grade revision", () => {
  it("revises the previous card after moving on", async () => {
    const e = engineWith();
    e.next();
    await e.grade({ verdict: "remembered" });
    e.next(); // now on c2; the learner disputes c1

    const { entry } = await e.revise({ verdict: "forgot", reason: "not close enough" });
    expect(entry.cardId).toBe("c1");
    expect(entry.verdict).toBe("forgot");
    expect(entry.revisions).toHaveLength(1);
    expect(entry.revisions[0]).toMatchObject({ from: "remembered", to: "forgot" });
    // The in-progress card is untouched.
    expect(e.current()!.cardId).toBe("c2");
  });

  it("revises a card several steps back", async () => {
    const e = engineWith();
    for (let i = 0; i < 3; i++) {
      e.next();
      await e.grade({ verdict: "remembered" });
    }
    const { entry } = await e.revise({ verdict: "forgot", target: { back: 2 } });
    expect(entry.cardId).toBe("c1");
  });

  it("counts `back` from the most recently graded card", async () => {
    const e = engineWith();
    e.next();
    await e.grade({ verdict: "remembered" }); // c1
    e.next();
    await e.grade({ verdict: "remembered" }); // c2
    e.next(); // now asking c3, ungraded

    // "that last one" is c2, not c3 - c3 has not been answered yet.
    expect((await e.revise({ verdict: "forgot", target: { back: 0 } })).entry.cardId).toBe("c2");
    expect((await e.revise({ verdict: "forgot", target: { back: 1 } })).entry.cardId).toBe("c1");
  });

  it("revises by card id", async () => {
    const e = engineWith();
    e.next();
    await e.grade({ verdict: "remembered" });
    e.next();
    await e.grade({ verdict: "remembered" });
    const { entry } = await e.revise({ verdict: "forgot", target: { cardId: "c1" } });
    expect(entry.cardId).toBe("c1");
    expect(entry.verdict).toBe("forgot");
  });

  it("revises by session position", async () => {
    const e = engineWith();
    e.next();
    await e.grade({ verdict: "remembered" });
    e.next();
    await e.grade({ verdict: "forgot" });
    const { entry } = await e.revise({ verdict: "remembered", target: { seq: 2 } });
    expect(entry.cardId).toBe("c2");
    expect(entry.verdict).toBe("remembered");
  });

  it("is a no-op when the verdict already matches", async () => {
    const e = engineWith();
    e.next();
    await e.grade({ verdict: "forgot" });
    const { entry } = await e.revise({ verdict: "forgot" });
    expect(entry.revisions).toHaveLength(0);
  });

  it("treats a revision of an ungraded card as a first grade", async () => {
    const e = engineWith();
    e.next();
    const { entry } = await e.revise({ verdict: "remembered" });
    expect(entry.verdict).toBe("remembered");
    expect(entry.revisions).toHaveLength(0);
  });

  it("throws for a card that was never asked", async () => {
    const e = engineWith();
    e.next();
    await expect(e.revise({ verdict: "forgot", target: { cardId: "nope" } })).rejects.toThrow();
  });

  it("records the user as the authority for a revision", async () => {
    const e = engineWith();
    e.next();
    await e.grade({ verdict: "remembered", source: "model" });
    const { entry } = await e.revise({ verdict: "forgot" });
    expect(entry.verdictSource).toBe("user");
    expect(entry.revisions[0]!.source).toBe("user");
  });
});

describe("sink synchronisation", () => {
  it("defers writes to the end of the session by default", async () => {
    const sink = new MemorySink();
    const e = engineWith([sink]);
    e.next();
    await e.grade({ verdict: "remembered" });
    expect(sink.recorded).toHaveLength(0); // nothing written yet

    await e.end();
    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]!.verdict).toBe("remembered");
  });

  it("a revision before the flush costs no sink traffic at all", async () => {
    const sink = new MemorySink();
    const e = engineWith([sink]);
    e.next();
    await e.grade({ verdict: "remembered" });
    await e.revise({ verdict: "forgot" });
    await e.end();

    expect(sink.revisions).toHaveLength(0);
    expect(sink.recorded).toHaveLength(1);
    // Only the final, corrected verdict was ever written.
    expect(sink.recorded[0]!.verdict).toBe("forgot");
  });

  it("writes immediately in immediate mode and pushes revisions through", async () => {
    const sink = new MemorySink();
    const e = engineWith([sink], { syncMode: "immediate" });
    e.next();
    await e.grade({ verdict: "remembered" });
    expect(sink.recorded).toHaveLength(1);

    await e.revise({ verdict: "forgot" });
    expect(sink.revisions).toHaveLength(1);
    expect(sink.recorded[0]!.verdict).toBe("forgot");
  });

  it("reports when a sink cannot revise an already-written grade", async () => {
    const oneWay: GradeSink = {
      name: "one-way",
      capabilities: { revise: false, advancesSchedule: true },
      async record(): Promise<SinkResult> {
        return { ok: true };
      },
      async revise(_e: SessionEntry, _r: GradeRevision): Promise<SinkResult> {
        return { ok: true };
      },
    };
    const e = engineWith([oneWay], { syncMode: "immediate" });
    e.next();
    await e.grade({ verdict: "remembered" });
    const res = await e.revise({ verdict: "forgot" });
    expect(res.sync[0]!.ok).toBe(false);
    expect(res.sync[0]!.detail).toContain("cannot revise");
  });

  it("reports honestly that nothing advanced Mochi's schedule", async () => {
    const e = engineWith([new MemorySink()], { syncMode: "immediate" });
    e.next();
    const res = await e.grade({ verdict: "remembered" });
    expect(res.advancedSchedule).toBe(false);
  });

  it("does not lose the rest of the flush when one sink fails", async () => {
    const failing: GradeSink = {
      name: "bad",
      capabilities: { revise: true, advancesSchedule: false },
      async record(): Promise<SinkResult> {
        return { ok: false, detail: "boom" };
      },
      async revise(): Promise<SinkResult> {
        return { ok: false, detail: "boom" };
      },
    };
    const good = new MemorySink();
    const e = engineWith([failing, good]);
    e.next();
    await e.grade({ verdict: "remembered" });
    const { summary } = await e.end();
    expect(good.recorded).toHaveLength(1);
    expect(summary.remembered).toBe(1);
    expect(e.log[0]!.syncErrors?.[0]).toContain("boom");
  });
});

describe("summary", () => {
  it("counts grades, revisions and what is left", async () => {
    const e = engineWith();
    e.next();
    await e.grade({ verdict: "remembered" });
    e.next();
    await e.grade({ verdict: "forgot" });
    // back: 0 is the card just finished (c2); back: 1 would be c1.
    await e.revise({ verdict: "remembered", target: { back: 0 } });
    const s = e.summary();
    expect(s.asked).toBe(2);
    expect(s.remembered).toBe(2);
    expect(s.forgot).toBe(0);
    expect(s.revised).toBe(1);
    expect(s.remaining).toBe(1);
  });
});
