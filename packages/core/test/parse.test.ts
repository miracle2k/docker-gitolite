import { describe, expect, it } from "vitest";
import { parseCard, selectPrompt, splitSides } from "../src/cards/parse.js";
import type { MochiCard, MochiTemplate } from "../src/mochi/types.js";

const card = (over: Partial<MochiCard> = {}): MochiCard => ({
  id: "c1",
  content: "",
  ...over,
});

describe("side splitting", () => {
  it("splits on a line of exactly three dashes", () => {
    expect(splitSides("front\n---\nback")).toEqual(["front", "back"]);
  });

  it("does NOT split on a horizontal rule of four or more dashes", () => {
    // Mochi reserves `---` as the side separator, so a real rule is written
    // with four or more. Splitting on it would corrupt the card.
    expect(splitSides("front\n----\nstill front")).toEqual(["front\n----\nstill front"]);
  });

  it("supports more than two sides", () => {
    expect(splitSides("a\n---\nb\n---\nc")).toEqual(["a", "b", "c"]);
  });

  it("tolerates trailing whitespace on the separator line", () => {
    expect(splitSides("front\n---  \nback")).toEqual(["front", "back"]);
  });
});

describe("parseCard", () => {
  it("builds a forward prompt from a two-sided card", () => {
    const parsed = parseCard(card({ content: "Capital of France?\n---\nParis" }));
    const forward = parsed.prompts.find((p) => p.key === "forward")!;
    expect(forward.question).toBe("Capital of France?");
    expect(forward.answer).toBe("Paris");
    expect(forward.speakable).toBe(true);
  });

  it("adds a reverse prompt when review-reverse? is set on the card", () => {
    const parsed = parseCard(card({ content: "chien\n---\ndog", "review-reverse?": true }));
    const reverse = parsed.prompts.find((p) => p.kind === "reverse")!;
    expect(reverse.question).toBe("dog");
    expect(reverse.answer).toBe("chien");
  });

  it("inherits review-reverse? from the deck when the card does not set it", () => {
    const parsed = parseCard(card({ content: "chien\n---\ndog", "deck-id": "d1" }), {
      deckReviewReverse: true,
    });
    expect(parsed.prompts.some((p) => p.kind === "reverse")).toBe(true);
  });

  it("produces one prompt per cloze group", () => {
    const parsed = parseCard(card({ content: "{{1::Alice}} met {{2::Bob}}" }));
    const cloze = parsed.prompts.filter((p) => p.kind === "cloze");
    expect(cloze.map((p) => p.key)).toEqual(["cloze:1", "cloze:2"]);
    expect(cloze[0]!.answer).toBe("Alice");
    expect(cloze[0]!.question).toContain("blank");
    expect(cloze[0]!.question).toContain("Bob");
  });

  it("marks a single-sided card with no cloze as unanswerable", () => {
    // There is nothing withheld, so there is no question to ask.
    const parsed = parseCard(card({ content: "Just a note." }));
    expect(parsed.prompts[0]!.speakable).toBe(false);
    expect(parsed.prompts[0]!.notes.join(" ")).toContain("nothing to ask");
  });

  it("marks an image-only answer as unspeakable", () => {
    const parsed = parseCard(card({ content: "What is this?\n---\n![](@media/x.png)" }));
    expect(parsed.prompts.find((p) => p.key === "forward")!.speakable).toBe(false);
  });

  it("renders template-backed cards through the template", () => {
    const template: MochiTemplate = {
      id: "t1",
      name: "Vocab",
      content: "# << Furi >>\n---\n<< Translation >>",
      fields: {
        f1: { id: "f1", name: "Furi" },
        name: { id: "name", name: "Translation" },
      },
    };
    const parsed = parseCard(
      card({
        content: "",
        "template-id": "t1",
        fields: { f1: { id: "f1", value: "いぬ" }, name: { id: "name", value: "Hund" } },
      }),
      { templates: new Map([["t1", template]]) },
    );
    const forward = parsed.prompts.find((p) => p.key === "forward")!;
    // The `name` field is the BACK here - front vs back comes from the
    // template layout, never from which field is called "name".
    expect(forward.question).toBe("いぬ");
    expect(forward.answer).toBe("Hund");
  });

  it("honours template conditional sections", () => {
    const template: MochiTemplate = {
      id: "t1",
      name: "T",
      content: "<< Q >><<# Hint >> (hint: << Hint >>)<</ Hint >>\n---\n<< A >>",
      fields: {
        q: { id: "q", name: "Q" },
        h: { id: "h", name: "Hint" },
        a: { id: "a", name: "A" },
      },
    };
    const withHint = parseCard(
      card({
        "template-id": "t1",
        fields: {
          q: { id: "q", value: "Capital?" },
          h: { id: "h", value: "France" },
          a: { id: "a", value: "Paris" },
        },
      }),
      { templates: new Map([["t1", template]]) },
    );
    expect(withHint.prompts[0]!.question).toContain("hint: France");

    const withoutHint = parseCard(
      card({
        "template-id": "t1",
        fields: {
          q: { id: "q", value: "Capital?" },
          h: { id: "h", value: "" },
          a: { id: "a", value: "Paris" },
        },
      }),
      { templates: new Map([["t1", template]]) },
    );
    expect(withoutHint.prompts[0]!.question).toBe("Capital?");
  });

  it("falls back to concatenated fields when the template is unavailable", () => {
    const parsed = parseCard(
      card({
        "template-id": "missing",
        fields: { a: { id: "a", value: "front" }, b: { id: "b", value: "back" } },
      }),
    );
    expect(parsed.sides).toEqual(["front", "back"]);
  });
});

describe("selectPrompt", () => {
  it("prefers the least recently reviewed sub-schedule", () => {
    const c = card({
      content: "chien\n---\ndog",
      "review-reverse?": true,
      reviews: [{ date: { date: "2026-08-20T00:00:00Z" }, "remembered?": true }],
      // The reverse direction has never been reviewed, so it should win.
      "reverse-reviews": [],
    });
    const parsed = parseCard(c);
    expect(selectPrompt(parsed, c)!.kind).toBe("reverse");
  });

  it("honours a forward-only preference", () => {
    const c = card({ content: "chien\n---\ndog", "review-reverse?": true });
    const parsed = parseCard(c);
    expect(selectPrompt(parsed, c, { preferKind: "forward" })!.kind).toBe("forward");
  });

  it("returns undefined when nothing is answerable", () => {
    const c = card({ content: "Just a note." });
    expect(selectPrompt(parseCard(c), c)).toBeUndefined();
  });
});
