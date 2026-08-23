/**
 * Markdown -> speakable text.
 *
 * Card content is Markdown and routinely contains things a text-to-speech
 * voice must not read literally: attachment image refs, code fences, LaTeX,
 * tables, link URLs. This module flattens content for speech and, just as
 * importantly, reports when a card CANNOT be reviewed by voice (e.g. the
 * answer is an image), so the engine can skip it instead of asking a question
 * the user cannot possibly answer.
 */

export interface SpeakableResult {
  /** Text suitable for handing to a voice model. */
  text: string;
  /** False when the content is essentially non-verbal (image/audio only). */
  speakable: boolean;
  /** Human-readable notes about what was stripped, for diagnostics. */
  notes: string[];
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const BLOCK_MATH_RE = /\$\$([\s\S]*?)\$\$/g;
const INLINE_MATH_RE = /\$([^$\n]+)\$/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/gm;
const BLOCKQUOTE_RE = /^\s{0,3}>\s?/gm;
const EMPHASIS_RE = /(\*\*\*|\*\*|\*|___|__|_|~~)(?=\S)([\s\S]*?\S)\1/g;
const LIST_BULLET_RE = /^\s*[-*+]\s+/gm;
const HRULE_RE = /^\s*(?:-{4,}|_{3,}|\*{3,})\s*$/gm;
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/gm;

export function toSpeakable(markdown: string): SpeakableResult {
  const notes: string[] = [];
  let text = markdown ?? "";

  const hadImages = IMAGE_RE.test(text);
  IMAGE_RE.lastIndex = 0;
  if (hadImages) {
    // Keep alt text when there is any - it is often the real answer.
    text = text.replace(IMAGE_RE, (_all, alt: string) => (alt?.trim() ? alt : " "));
    notes.push("stripped image(s)");
  }

  if (FENCE_RE.test(text)) {
    FENCE_RE.lastIndex = 0;
    text = text.replace(FENCE_RE, " (code) ");
    notes.push("replaced code block(s)");
  }

  text = text
    .replace(BLOCK_MATH_RE, (_a, inner: string) => ` ${inner} `)
    .replace(INLINE_MATH_RE, (_a, inner: string) => ` ${inner} `)
    .replace(INLINE_CODE_RE, (_a, inner: string) => inner)
    .replace(LINK_RE, (_all, label: string) => label)
    .replace(HTML_TAG_RE, " ")
    .replace(HEADING_RE, "")
    .replace(BLOCKQUOTE_RE, "")
    .replace(TABLE_DIVIDER_RE, " ")
    .replace(HRULE_RE, " ")
    .replace(LIST_BULLET_RE, "")
    .replace(EMPHASIS_RE, (_all, _marker, inner: string) => inner)
    .replace(/\|/g, ", ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // A card whose renderable content was only an image/attachment leaves us
  // with nothing to say.
  const speakable = text.replace(/[^\p{L}\p{N}]/gu, "").length > 0;
  if (!speakable) notes.push("no speakable text remains");

  return { text, speakable, notes };
}
