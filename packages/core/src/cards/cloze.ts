/**
 * Mochi cloze deletions.
 *
 * Syntax is double braces, NOT Anki's `{{c1::...}}`:
 *
 *   Bare:     The capital of France is {{Paris}}.
 *   Numbered: {{1::Alice}} met {{2::Bob}} in {{1::Paris}}.
 *
 * Semantics that matter for a voice reviewer:
 *  - All BARE clozes on a card are hidden together and form ONE prompt.
 *  - Each distinct NUMBER forms its own prompt, with its own review history.
 *    The same number appearing twice hides both occurrences at once.
 *  - Mochi does not split these into separate card records; they are
 *    sub-schedules on a single card, surfaced as `cloze/indexes`.
 */

/** Matches `{{text}}` or `{{1::text}}`. Non-greedy so adjacent clozes don't merge. */
const CLOZE_RE = /\{\{(?:(\d+)::)?([\s\S]*?)\}\}/g;

export interface ClozeOccurrence {
  /** Group index, or null for a bare `{{...}}` cloze. */
  group: number | null;
  /** The hidden text. */
  text: string;
  /** Offsets into the source string, for blanking. */
  start: number;
  end: number;
}

export interface ClozeGroup {
  /** Group index, or null for the implicit "all bare clozes" group. */
  group: number | null;
  /** Every hidden span belonging to this group, in document order. */
  answers: string[];
}

export function findClozes(content: string): ClozeOccurrence[] {
  const out: ClozeOccurrence[] = [];
  CLOZE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOZE_RE.exec(content)) !== null) {
    out.push({
      group: m[1] === undefined ? null : Number(m[1]),
      text: (m[2] ?? "").trim(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

export function hasCloze(content: string): boolean {
  CLOZE_RE.lastIndex = 0;
  return CLOZE_RE.test(content);
}

/**
 * Group occurrences into the schedulable units Mochi uses: one unit per
 * distinct number, plus one unit for all bare clozes combined.
 */
export function clozeGroups(content: string): ClozeGroup[] {
  const occurrences = findClozes(content);
  const byGroup = new Map<number | null, string[]>();
  for (const occ of occurrences) {
    const existing = byGroup.get(occ.group);
    if (existing) existing.push(occ.text);
    else byGroup.set(occ.group, [occ.text]);
  }
  const groups: ClozeGroup[] = [];
  // Bare group first (it reads as "the" cloze when there are no numbers).
  const bare = byGroup.get(null);
  if (bare) groups.push({ group: null, answers: bare });
  for (const key of [...byGroup.keys()]
    .filter((k): k is number => k !== null)
    .sort((a, b) => a - b)) {
    groups.push({ group: key, answers: byGroup.get(key)! });
  }
  return groups;
}

export interface BlankOptions {
  /** What to substitute for the hidden span. */
  placeholder?: string;
  /**
   * How to render clozes that are NOT the target group. Mochi shows them
   * normally (revealed), which is what makes numbered clozes useful.
   */
  revealOthers?: boolean;
}

/**
 * Render `content` with one cloze group blanked out and the others revealed.
 * Pass `group: null` to blank the bare clozes.
 */
export function blankCloze(
  content: string,
  group: number | null,
  opts: BlankOptions = {},
): string {
  const placeholder = opts.placeholder ?? "___";
  const revealOthers = opts.revealOthers ?? true;
  const occurrences = findClozes(content);
  let out = "";
  let cursor = 0;
  for (const occ of occurrences) {
    out += content.slice(cursor, occ.start);
    if (occ.group === group) out += placeholder;
    else out += revealOthers ? occ.text : placeholder;
    cursor = occ.end;
  }
  out += content.slice(cursor);
  return out;
}

/** Strip cloze markup entirely, revealing every hidden span. */
export function revealClozes(content: string): string {
  return content.replace(CLOZE_RE, (_all, _n, text: string) => text);
}
