import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEFAULT_SETTINGS,
  MochiClient,
  MochiTagSink,
  MemorySink,
  SessionStore,
  type MochiCard,
} from "@mochi-voice/core";
import { registerReviewTools } from "../src/tools.js";
import { startFakeMochi, type FakeMochi } from "./fake-mochi.js";

const CARDS: MochiCard[] = [
  { id: "c1", content: "Capital of France?\n---\nParis", "deck-id": "d1" },
  { id: "c2", content: "Year the Bastille fell?\n---\n1789", "deck-id": "d1" },
  { id: "c3", content: "Capital of Japan?\n---\nTokyo", "deck-id": "d1" },
];

let mochi: FakeMochi;
let client: Client;
let memory: MemorySink;

async function connect(settings = {}) {
  const mochiClient = new MochiClient({ token: "t", baseUrl: mochi.baseUrl });
  memory = new MemorySink();
  const server = new McpServer({ name: "test", version: "0" });
  registerReviewTools(server, {
    config: {
      mochiToken: "t",
      settings: { ...DEFAULT_SETTINGS, ...settings },
      sinks: [memory, new MochiTagSink({ client: mochiClient })],
      authToken: "",
      port: 0,
      host: "127.0.0.1",
      allowedOrigins: [],
      sessionTtlMs: 60000,
    },
    client: mochiClient,
    store: new SessionStore(),
  });
  client = new Client({ name: "test-client", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
}

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return res as { structuredContent?: any; isError?: boolean; content: { text: string }[] };
};

beforeEach(async () => {
  mochi = await startFakeMochi(CARDS);
  await connect();
});

afterEach(async () => {
  await mochi.close();
});

describe("tool surface", () => {
  it("exposes the review tools in a stable order", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "start_review",
      "next_card",
      "grade_card",
      "revise_grade",
      "skip_card",
      "session_status",
      "end_session",
      "review_instructions",
    ]);
  });

  it("tells the model the reference answer is not for the learner", async () => {
    const { tools } = await client.listTools();
    const next = tools.find((t) => t.name === "next_card")!;
    expect(next.description).toContain("NOT FOR THE LEARNER");
  });
});

describe("a full review session", () => {
  it("runs start -> ask -> grade -> end", async () => {
    const start = await call("start_review");
    expect(start.structuredContent.due_count).toBe(3);
    const sid = start.structuredContent.session_id;

    const first = await call("next_card", { session_id: sid });
    expect(first.structuredContent.question).toBe("Capital of France?");
    expect(first.structuredContent.expected_answer).toBe("Paris");
    expect(first.structuredContent.remaining).toBe(2);

    const graded = await call("grade_card", {
      session_id: sid,
      verdict: "remembered",
      learner_answer: "Paris",
    });
    expect(graded.structuredContent.verdict).toBe("remembered");

    const end = await call("end_session", { session_id: sid });
    expect(end.structuredContent.asked).toBe(1);
    expect(end.structuredContent.remembered).toBe(1);
  });

  it("works without a session_id, using the running session", async () => {
    await call("start_review");
    const card = await call("next_card");
    expect(card.structuredContent.card_id).toBe("c1");
    const g = await call("grade_card", { verdict: "remembered" });
    expect(g.structuredContent.card_id).toBe("c1");
  });

  it("refuses to skip past an ungraded card", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    await call("next_card", { session_id: sid });
    const second = await call("next_card", { session_id: sid });
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toContain("not graded");
  });

  it("reports the queue as finished and tells the model to end", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    for (let i = 0; i < 3; i++) {
      await call("next_card", { session_id: sid });
      await call("grade_card", { session_id: sid, verdict: "remembered" });
    }
    const done = await call("next_card", { session_id: sid });
    expect(done.structuredContent.finished).toBe(true);
    expect(done.structuredContent.instruction).toContain("end_session");
  });

  it("errors usefully when no session has been started", async () => {
    const res = await call("next_card");
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("start_review");
  });
});

describe("retroactive correction", () => {
  it("changes an earlier grade without disturbing the card in progress", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;

    await call("next_card", { session_id: sid });
    await call("grade_card", { session_id: sid, verdict: "remembered", learner_answer: "Paris" });
    await call("next_card", { session_id: sid }); // now on c2

    const revised = await call("revise_grade", {
      session_id: sid,
      verdict: "forgot",
      reason: "learner said it should not count",
    });
    expect(revised.structuredContent.card_id).toBe("c1");
    expect(revised.structuredContent.from).toBe("remembered");
    expect(revised.structuredContent.to).toBe("forgot");
    expect(revised.structuredContent.instruction).toContain("Do not re-ask");

    // c2 is still the card awaiting an answer.
    const status = await call("session_status", { session_id: sid });
    expect(status.structuredContent.remembered).toBe(0);
    expect(status.structuredContent.revised).toBe(1);
  });

  it("reaches back several cards", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    for (let i = 0; i < 3; i++) {
      await call("next_card", { session_id: sid });
      await call("grade_card", { session_id: sid, verdict: "remembered" });
    }
    const r = await call("revise_grade", { session_id: sid, verdict: "forgot", back: 2 });
    expect(r.structuredContent.card_id).toBe("c1");
  });

  it("reaches back by card id", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    for (let i = 0; i < 2; i++) {
      await call("next_card", { session_id: sid });
      await call("grade_card", { session_id: sid, verdict: "remembered" });
    }
    const r = await call("revise_grade", { session_id: sid, verdict: "forgot", card_id: "c1" });
    expect(r.structuredContent.card_id).toBe("c1");
  });

  it("only the corrected verdict ever reaches the sinks", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    await call("next_card", { session_id: sid });
    await call("grade_card", { session_id: sid, verdict: "remembered" });
    await call("revise_grade", { session_id: sid, verdict: "forgot" });
    await call("end_session", { session_id: sid });

    expect(memory.recorded).toHaveLength(1);
    expect(memory.recorded[0]!.verdict).toBe("forgot");
    // And the card was tagged in Mochi exactly once, with the final verdict.
    const tagged = mochi.updates.filter((u) => u.id === "c1");
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.body["manual-tags"]).toEqual(["voice-forgot"]);
  });

  it("guides the model when it names a card that was never asked", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    await call("next_card", { session_id: sid });
    const r = await call("revise_grade", { session_id: sid, verdict: "forgot", card_id: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("session_status");
  });
});

describe("numeric tolerance", () => {
  it("accepts a year that is close and says so", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    await call("next_card", { session_id: sid }); // c1
    await call("grade_card", { session_id: sid, verdict: "remembered" });
    await call("next_card", { session_id: sid }); // c2: 1789

    const g = await call("grade_card", {
      session_id: sid,
      verdict: "remembered",
      learner_answer: "seventeen ninety one",
    });
    expect(g.structuredContent.suggested_verdict).toBe("remembered");
    expect(g.structuredContent.numeric_check).toContain("tolerance 3");
  });

  it("flags a year that is well outside tolerance", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    await call("next_card", { session_id: sid });
    await call("grade_card", { session_id: sid, verdict: "remembered" });
    await call("next_card", { session_id: sid });

    const g = await call("grade_card", {
      session_id: sid,
      verdict: "remembered",
      learner_answer: "1850",
    });
    expect(g.structuredContent.suggested_verdict).toBe("forgot");
    // The model said 'remembered'; the arithmetic disagrees and says so.
    expect(g.structuredContent.instruction).toContain("arithmetic check says 'forgot'");
  });
});

describe("skipping", () => {
  it("leaves a card ungraded and writes nothing for it", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    await call("next_card", { session_id: sid });
    await call("skip_card", { session_id: sid, reason: "transcript was garbled" });
    const end = await call("end_session", { session_id: sid });
    expect(end.structuredContent.skipped).toBe(1);
    expect(end.structuredContent.asked).toBe(1);
    expect(memory.recorded).toHaveLength(0);
  });
});

describe("honesty about write-back", () => {
  it("says plainly that Mochi's schedule was not advanced", async () => {
    const start = await call("start_review");
    expect(start.structuredContent.write_back).toContain("cannot record reviews");

    const sid = start.structuredContent.session_id;
    await call("next_card", { session_id: sid });
    await call("grade_card", { session_id: sid, verdict: "forgot" });
    const end = await call("end_session", { session_id: sid });
    expect(end.structuredContent.advanced_mochi_schedule).toBe(false);
  });

  it("tags missed cards in Mochi but leaves correct ones alone", async () => {
    const sid = (await call("start_review")).structuredContent.session_id;
    await call("next_card", { session_id: sid });
    await call("grade_card", { session_id: sid, verdict: "forgot" });
    await call("next_card", { session_id: sid });
    await call("grade_card", { session_id: sid, verdict: "remembered" });
    await call("end_session", { session_id: sid });

    expect(mochi.updates.map((u) => u.id)).toEqual(["c1"]);
    expect(mochi.updates[0]!.body["manual-tags"]).toEqual(["voice-forgot"]);
  });

  it("preserves the learner's own tags when tagging", async () => {
    mochi.cards.get("c1")!["manual-tags"] = ["mine", "voice-forgot"];
    const sid = (await call("start_review")).structuredContent.session_id;
    await call("next_card", { session_id: sid });
    await call("grade_card", { session_id: sid, verdict: "remembered" });
    await call("end_session", { session_id: sid });

    // Graded right, so our tag comes off - but "mine" survives.
    expect(mochi.updates[0]!.body["manual-tags"]).toEqual(["mine"]);
  });
});
