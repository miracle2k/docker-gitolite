import type { ReviewSettings, Verdict } from "../session/types.js";

/**
 * Deterministic grading support.
 *
 * The semantic judgement ("is this paraphrase good enough?") belongs to the
 * voice model - it heard the audio and holds the conversation. But two things
 * must NOT be left to vibes:
 *
 *  - numeric and date answers, where "close enough" should be arithmetic,
 *    not an impression. This is exactly the case the user called out: a year
 *    that is a few off should count.
 *  - trivially exact matches, which should never cost a model call or risk
 *    an over-strict reading.
 *
 * So this module returns a verdict ONLY when it is confident, and otherwise
 * defers to the model. It never overrides an explicit user instruction.
 */

const FILLER = new Set([
  "a", "an", "the", "is", "was", "were", "are", "of", "to", "in", "on", "at",
  "and", "or", "it", "its", "that", "this", "um", "uh", "er", "like", "i",
  "think", "guess", "maybe", "probably", "answer",
]);

export function normalizeAnswer(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks so "café" matches "cafe" - speech transcripts are
    // inconsistent about accents.
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function contentWords(text: string): string[] {
  return normalizeAnswer(text)
    .split(" ")
    .filter((w) => w.length > 0 && !FILLER.has(w));
}

/**
 * Spoken numbers.
 *
 * People say years as "seventeen eighty-nine", not "one thousand seven
 * hundred and eighty-nine", and a transcript may render either. Since years
 * are far and away the most common numeric flashcard answer, both forms have
 * to parse - reading "seventeen eighty-nine" as the numbers 17, 80 and 9
 * would fail a learner who answered perfectly.
 */
const UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, nought: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
};

/** Words that introduce a decimal fraction: "nine point eight" -> 9.8. */
const POINT_WORDS = new Set(["point", "decimal"]);
/** Spoken sign, so "minus two seventy three" is not read as positive. */
const NEGATIVE_WORDS = new Set(["minus", "negative"]);

type NumWord =
  /** A spoken unit or teen. `opensOnes` marks "oh"/"o", which fills a tens
   *  slot with a leading zero: "nineteen oh five" is 19-05, not 19+0+5. */
  | { kind: "unit"; value: number; opensOnes: boolean }
  | { kind: "tens"; value: number }
  | { kind: "scale"; value: number }
  | { kind: "digits"; value: number }
  | { kind: "point" }
  | { kind: "negate" };

function classify(word: string): NumWord | undefined {
  if (POINT_WORDS.has(word)) return { kind: "point" };
  if (NEGATIVE_WORDS.has(word)) return { kind: "negate" };
  if (/^-?\d+(?:\.\d+)?$/.test(word)) {
    const n = Number(word);
    return Number.isFinite(n) ? { kind: "digits", value: n } : undefined;
  }
  const unit = UNITS[word];
  if (unit !== undefined) {
    return { kind: "unit", value: unit, opensOnes: word === "oh" || word === "o" };
  }
  const tens = TENS[word];
  if (tens !== undefined) return { kind: "tens", value: tens };
  const scale = SCALES[word];
  if (scale !== undefined) return { kind: "scale", value: scale };
  return undefined;
}

/**
 * Break a run of number words into the groups a speaker actually utters:
 * "seventeen eighty nine" -> [17, 89]; "nineteen oh five" -> [19, 5].
 */
function groupRun(words: NumWord[]): number[] {
  const groups: number[] = [];
  let current: number | undefined;
  let currentIsTens = false;

  const flush = () => {
    if (current !== undefined) groups.push(current);
    current = undefined;
    currentIsTens = false;
  };

  for (const w of words) {
    if (w.kind === "point" || w.kind === "negate") continue;
    if (w.kind === "scale") {
      current = (current ?? 1) * w.value;
      currentIsTens = false;
      continue;
    }
    if (w.kind === "digits") {
      flush();
      current = w.value;
      continue;
    }
    if (w.kind === "tens") {
      flush();
      current = w.value;
      currentIsTens = true;
      continue;
    }
    if (w.opensOnes) {
      // "oh" opens a two-digit slot whose tens digit is zero.
      flush();
      current = 0;
      currentIsTens = true;
      continue;
    }
    if (current === undefined) {
      current = w.value;
    } else if (currentIsTens && w.value < 10) {
      current += w.value; // "eighty" then "nine", or "oh" then "five"
      currentIsTens = false;
    } else {
      flush();
      current = w.value;
    }
  }
  flush();
  return groups;
}

/** Standard composition: "two thousand and five" -> 2005. */
function composeStandard(words: NumWord[]): number | undefined {
  if (words.length === 0) return undefined;
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w.kind === "point" || w.kind === "negate") continue;
    if (w.kind === "scale") {
      if (w.value >= 1000) {
        total += (current || 1) * w.value;
        current = 0;
      } else {
        current = (current || 1) * w.value;
      }
    } else {
      current += w.value;
    }
  }
  return total + current;
}

/**
 * Every plausible numeric reading of one run of number words.
 *
 * Returning several candidates is safe: the caller compares them against a
 * known reference and takes the closest, so an extra reading cannot invent a
 * match where the learner said nothing like the answer.
 */
function runCandidates(words: NumWord[]): number[] {
  // A leading "minus"/"negative" flips the sign of whatever follows.
  if (words[0]?.kind === "negate") {
    return runCandidates(words.slice(1)).map((n) => -n);
  }

  // A spoken decimal: everything before "point" is the integer part, and each
  // word after it is one digit after the point.
  const pointAt = words.findIndex((w) => w.kind === "point");
  if (pointAt >= 0) {
    const whole = runCandidates(words.slice(0, pointAt));
    const digits = words
      .slice(pointAt + 1)
      .filter((w): w is Extract<NumWord, { kind: "unit" | "digits" }> =>
        w.kind === "unit" || w.kind === "digits",
      )
      .map((w) => String(Math.abs(w.value)))
      .join("");
    if (whole.length && digits) {
      const value = Number(`${whole[0]}.${digits}`);
      if (Number.isFinite(value)) return [value];
    }
    return whole;
  }

  // A scale word ("hundred", "thousand", "million") means the speaker used
  // standard composition, so that is the only sensible reading.
  if (words.some((w) => w.kind === "scale")) {
    const standard = composeStandard(words);
    return standard === undefined ? [] : [standard];
  }

  const groups = groupRun(words);
  if (groups.length === 1) return [groups[0]!];

  if (groups.length === 2) {
    const century = groups[0]!;
    const rest = groups[1]!;
    // "seventeen eighty-nine" -> 1789, but never "three five" -> 305.
    if (century >= 10 && century <= 99 && rest >= 0 && rest <= 99) {
      return [century * 100 + rest];
    }
  }

  // Otherwise the speaker said several separate numbers; do not invent a
  // composition that joins them.
  return groups;
}

export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const norm = normalizeAnswer(text);

  // Digits participate in runs alongside words, so "300 million" composes.
  //
  // Splitting on "-" as well as whitespace would eat the minus sign of "-273",
  // and leaving trailing punctuation attached would make "nine." unclassifiable
  // - which silently turned "seventeen eighty-nine." into 1780. So: split on
  // whitespace, strip surrounding punctuation, then break the remainder on
  // internal hyphens ("eighty-nine") while keeping a leading minus.
  const words: string[] = [];
  for (const raw of norm.split(/\s+/)) {
    const trimmed = raw.replace(/^[.,;:!?]+/, "").replace(/[.,;:!?]+$/, "");
    if (!trimmed) continue;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      words.push(trimmed);
      continue;
    }
    for (const part of trimmed.split("-")) {
      if (part) words.push(part);
    }
  }

  let run: NumWord[] = [];
  let lastWasScale = false;
  const endRun = () => {
    if (run.length) out.push(...runCandidates(run));
    run = [];
    lastWasScale = false;
  };
  for (const word of words) {
    const c = classify(word);
    if (c) {
      run.push(c);
      lastWasScale = c.kind === "scale";
      continue;
    }
    // "two thousand and five" is one number; "nineteen fourteen and nineteen
    // eighteen" is two. Only a scale word makes a following "and" internal.
    if (word === "and" && lastWasScale) continue;
    endRun();
  }
  endRun();

  return out;
}

/** A number that looks like a calendar year, where year tolerance applies. */
function isYear(n: number): boolean {
  return Number.isInteger(n) && n >= 1000 && n <= 2200;
}

export interface NumericCheck {
  applicable: boolean;
  withinTolerance?: boolean;
  expected?: number;
  actual?: number;
  delta?: number;
  detail?: string;
}

/**
 * Compare the numbers in a reference answer against those in a spoken answer.
 *
 * Only applies when the reference answer is essentially numeric - a date, a
 * year, a quantity. If the reference is prose that happens to contain a
 * number, semantic judgement is the right tool and we stay out of the way.
 */
export function checkNumeric(
  expected: string,
  learner: string,
  settings: Pick<ReviewSettings, "numericTolerance">,
): NumericCheck {
  const expectedNums = dedupe(extractNumbers(expected));
  if (expectedNums.length !== 1) return { applicable: false };

  // The reference must be essentially the number itself, not prose containing
  // one: "1789" qualifies, "signed in 1789 by the National Assembly" does not.
  const words = contentWords(expected).filter((w) => !/^-?\d/.test(w));
  if (words.length > 2) return { applicable: false };

  const target = expectedNums[0]!;
  const learnerNums = extractNumbers(learner);
  if (learnerNums.length === 0) {
    return {
      applicable: true,
      withinTolerance: false,
      expected: target,
      detail: "no number in answer",
    };
  }

  const tol = isYear(target)
    ? settings.numericTolerance.years
    : Math.abs(target) * settings.numericTolerance.relative;

  // Take the learner's closest number: people restate the question, and a
  // spoken run can have more than one valid reading.
  let best = learnerNums[0]!;
  for (const n of learnerNums) {
    if (Math.abs(n - target) < Math.abs(best - target)) best = n;
  }
  const delta = Math.abs(best - target);
  return {
    applicable: true,
    withinTolerance: delta <= tol,
    expected: target,
    actual: best,
    delta,
    detail: `|${best} - ${target}| = ${delta}, tolerance ${tol}`,
  };
}

function dedupe(nums: number[]): number[] {
  return [...new Set(nums)];
}

export interface DeterministicVerdict {
  verdict?: Verdict;
  confident: boolean;
  reason: string;
}

/**
 * Grade without a model where that is safe. Returns `confident: false` for
 * anything requiring semantic judgement.
 */
export function deterministicGrade(
  expected: string,
  learner: string,
  settings: ReviewSettings,
): DeterministicVerdict {
  const learnerNorm = normalizeAnswer(learner);
  if (learnerNorm === "") {
    return { verdict: "forgot", confident: true, reason: "no answer given" };
  }

  if (normalizeAnswer(expected) === learnerNorm) {
    return { verdict: "remembered", confident: true, reason: "exact match" };
  }

  const numeric = checkNumeric(expected, learner, settings);
  if (numeric.applicable) {
    return {
      verdict: numeric.withinTolerance ? "remembered" : "forgot",
      // In strict mode a near-miss year is still a miss, so let the model see it.
      confident: settings.strictness !== "strict" || numeric.withinTolerance === false,
      reason: `numeric comparison: ${numeric.detail}`,
    };
  }

  return { confident: false, reason: "requires semantic judgement" };
}
