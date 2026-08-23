import { describe, expect, it } from "vitest";
import {
  checkNumeric,
  contentWords,
  deterministicGrade,
  extractNumbers,
  normalizeAnswer,
} from "../src/grading/policy.js";
import { DEFAULT_SETTINGS, type ReviewSettings } from "../src/session/types.js";

const S: ReviewSettings = DEFAULT_SETTINGS;
const has = (text: string, n: number) => expect(extractNumbers(text)).toContain(n);

describe("normalisation", () => {
  it("folds case, accents and punctuation", () => {
    expect(normalizeAnswer("Café!  L'Étoile")).toBe("cafe l etoile");
  });

  it("drops filler when comparing content", () => {
    expect(contentWords("um, I think it was the Paris one")).toEqual(["paris", "one"]);
  });
});

describe("spoken numbers", () => {
  it("reads digits", () => has("1789", 1789));

  it("reads a year spoken as two pairs", () => {
    // The form people actually use out loud.
    has("seventeen eighty nine", 1789);
    has("nineteen forty five", 1945);
  });

  it("reads a hyphenated year", () => has("seventeen eighty-nine", 1789));

  it("reads a year with 'oh'", () => {
    has("nineteen oh five", 1905);
    has("nineteen o five", 1905);
  });

  it("reads standard composition", () => {
    has("one thousand seven hundred and eighty nine", 1789);
    has("two thousand and five", 2005);
    has("two thousand five", 2005);
  });

  it("reads plain small numbers", () => {
    has("forty two", 42);
    has("seven", 7);
  });

  it("does not fabricate a century from two small numbers", () => {
    // "three five" must not become 305.
    expect(extractNumbers("three five")).not.toContain(305);
  });

  it("keeps separate runs separate", () => {
    const nums = extractNumbers("born in nineteen forty five, died in two thousand and three");
    expect(nums).toContain(1945);
    expect(nums).toContain(2003);
  });
});

describe("numeric tolerance", () => {
  it("accepts a year inside the tolerance", () => {
    const r = checkNumeric("1789", "seventeen ninety one", S);
    expect(r.applicable).toBe(true);
    expect(r.withinTolerance).toBe(true);
    expect(r.actual).toBe(1791);
    expect(r.delta).toBe(2);
  });

  it("rejects a year outside the tolerance", () => {
    const r = checkNumeric("1789", "1850", S);
    expect(r.withinTolerance).toBe(false);
    expect(r.delta).toBe(61);
  });

  it("uses a relative tolerance for non-year quantities", () => {
    expect(checkNumeric("300", "298", S).withinTolerance).toBe(true); // within 5%
    expect(checkNumeric("300", "250", S).withinTolerance).toBe(false);
  });

  it("counts a missing number as wrong rather than unanswerable", () => {
    const r = checkNumeric("1789", "some time in the late eighteenth century", S);
    expect(r.applicable).toBe(true);
    expect(r.withinTolerance).toBe(false);
  });

  it("stays out of the way for prose answers containing a number", () => {
    // Semantic judgement belongs to the model here, not arithmetic.
    const r = checkNumeric(
      "The National Assembly abolished feudalism in August 1789",
      "1789",
      S,
    );
    expect(r.applicable).toBe(false);
  });

  it("applies to a short numeric answer with a unit", () => {
    expect(checkNumeric("300 million", "310 million", S).applicable).toBe(true);
  });

  it("respects a configured tolerance", () => {
    const strictYears: ReviewSettings = {
      ...S,
      numericTolerance: { years: 0, relative: 0 },
    };
    expect(checkNumeric("1789", "1790", strictYears).withinTolerance).toBe(false);
    expect(checkNumeric("1789", "1789", strictYears).withinTolerance).toBe(true);
  });
});

describe("deterministic grading", () => {
  it("marks silence as a lapse", () => {
    const r = deterministicGrade("Paris", "", S);
    expect(r).toMatchObject({ verdict: "forgot", confident: true });
  });

  it("accepts an exact match without a model call", () => {
    expect(deterministicGrade("Paris", "paris", S)).toMatchObject({
      verdict: "remembered",
      confident: true,
    });
  });

  it("defers prose to the model", () => {
    const r = deterministicGrade("The capital of France", "it's the French capital", S);
    expect(r.confident).toBe(false);
  });

  it("defers a near-miss year to the model in strict mode", () => {
    const strict: ReviewSettings = { ...S, strictness: "strict" };
    const r = deterministicGrade("1789", "1791", strict);
    expect(r.confident).toBe(false);
  });

  it("is confident about a clear numeric miss even in strict mode", () => {
    const strict: ReviewSettings = { ...S, strictness: "strict" };
    expect(deterministicGrade("1789", "1850", strict)).toMatchObject({
      verdict: "forgot",
      confident: true,
    });
  });
});

describe("regressions in spoken number parsing", () => {
  it("survives sentence punctuation on a transcript", () => {
    // Speech transcripts are punctuated. A trailing period used to make the
    // last word unclassifiable, turning "seventeen eighty-nine." into 1780.
    has("Seventeen eighty-nine.", 1789);
    has("1789.", 1789);
    expect(checkNumeric("1789", "Seventeen eighty-nine.", S).delta).toBe(0);
  });

  it("reads a spoken decimal", () => {
    has("nine point eight", 9.8);
    has("three point one four", 3.14);
    expect(checkNumeric("9.8", "nine point eight", S).withinTolerance).toBe(true);
  });

  it("keeps a negative sign", () => {
    has("-273", -273);
    has("minus 273", -273);
    has("negative two hundred seventy three", -273);
    // A sign error is a real error, not a rounding difference.
    expect(checkNumeric("-273", "273", S).withinTolerance).toBe(false);
  });

  it("does not fuse two numbers joined by 'and'", () => {
    const nums = extractNumbers("between nineteen fourteen and nineteen eighteen");
    expect(nums).toContain(1914);
    expect(nums).toContain(1918);
    // Grading "when did WWI begin" against 1914 must find it exactly.
    expect(checkNumeric("1914", "between nineteen fourteen and nineteen eighteen", S).delta).toBe(0);
  });

  it("still joins 'and' inside one standard number", () => {
    has("two thousand and five", 2005);
    has("one thousand seven hundred and eighty nine", 1789);
  });
});
