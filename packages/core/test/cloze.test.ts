import { describe, expect, it } from "vitest";
import { blankCloze, clozeGroups, findClozes, hasCloze, revealClozes } from "../src/cards/cloze.js";

describe("cloze parsing", () => {
  it("finds bare clozes", () => {
    const found = findClozes("The capital of France is {{Paris}}.");
    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe("Paris");
    expect(found[0]!.group).toBeNull();
  });

  it("finds numbered clozes", () => {
    const found = findClozes("{{1::Alice}} met {{2::Bob}} in {{1::Paris}}.");
    expect(found.map((f) => f.group)).toEqual([1, 2, 1]);
    expect(found.map((f) => f.text)).toEqual(["Alice", "Bob", "Paris"]);
  });

  it("does not treat Anki syntax as a numbered group", () => {
    // Anki writes {{c1::x}}; Mochi uses {{1::x}}. The `c` form must fall
    // through to a bare cloze rather than silently becoming group 1.
    const found = findClozes("{{c1::Paris}}");
    expect(found[0]!.group).toBeNull();
    expect(found[0]!.text).toBe("c1::Paris");
  });

  it("groups bare clozes into one unit and numbers into their own", () => {
    const groups = clozeGroups("{{a}} and {{b}} then {{2::c}} and {{1::d}}");
    expect(groups.map((g) => g.group)).toEqual([null, 1, 2]);
    expect(groups[0]!.answers).toEqual(["a", "b"]);
    expect(groups[1]!.answers).toEqual(["d"]);
  });

  it("blanks the target group and reveals the others", () => {
    const out = blankCloze("{{1::Alice}} met {{2::Bob}}", 1, { placeholder: "blank" });
    expect(out).toBe("blank met Bob");
  });

  it("blanks every occurrence of a repeated group index", () => {
    const out = blankCloze("{{1::Alice}} met {{2::Bob}} in {{1::Paris}}", 1, {
      placeholder: "___",
    });
    expect(out).toBe("___ met Bob in ___");
  });

  it("reveals all clozes", () => {
    expect(revealClozes("{{1::Alice}} met {{Bob}}")).toBe("Alice met Bob");
  });

  it("detects absence of clozes", () => {
    expect(hasCloze("plain text")).toBe(false);
    expect(hasCloze("has {{one}}")).toBe(true);
  });
});
