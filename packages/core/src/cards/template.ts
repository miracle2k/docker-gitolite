import type { MochiCard, MochiTemplate } from "../mochi/types.js";

/**
 * Mochi template rendering.
 *
 * A template-backed card has `template-id` + `fields` and an EMPTY `content`.
 * The renderable markdown lives on the template, using its own placeholder
 * syntax (angle-double-brackets, referencing fields by NAME, not id):
 *
 *   << Field Name >>              value substitution
 *   <<# Field >> ... <</ Field >> render only if the field is non-empty
 *   <<^ Field >> ... <</ Field >> render only if the field IS empty
 *
 * The template's content also contains the `---` side separators, so rendering
 * the template is what produces the front/back split for these cards.
 *
 * There is no per-field "this is the question" marker, and the field literally
 * named `name` is NOT reliably the front - real templates put it on the back.
 * Front vs back can only be determined by rendering and splitting on `---`.
 */

const SECTION_RE = /<<([#^])\s*([^>]*?)\s*>>([\s\S]*?)<<\/\s*\2\s*>>/g;
const FIELD_RE = /<<\s*([^#^/][^>]*?)\s*>>/g;

/** Map a card's `fields` (keyed by field id) to values keyed by field NAME. */
export function fieldValuesByName(
  card: MochiCard,
  template: MochiTemplate,
): Record<string, string> {
  const byName: Record<string, string> = {};
  for (const [fieldId, field] of Object.entries(template.fields ?? {})) {
    const value = card.fields?.[fieldId]?.value ?? "";
    byName[field.name] = value;
    // Also expose by id: some templates reference the built-in `name` field.
    if (!(fieldId in byName)) byName[fieldId] = value;
  }
  // Include any card field the template does not declare, keyed by its id.
  for (const [fieldId, fv] of Object.entries(card.fields ?? {})) {
    if (!(fieldId in byName)) byName[fieldId] = fv?.value ?? "";
  }
  return byName;
}

/** Render template markdown against a card's field values. */
export function renderTemplate(
  template: MochiTemplate,
  values: Record<string, string>,
): string {
  const lookup = (name: string): string => values[name] ?? "";

  // Conditional sections first, innermost-last; loop until stable so that
  // nested sections resolve.
  let out = template.content ?? "";
  for (let pass = 0; pass < 8; pass++) {
    SECTION_RE.lastIndex = 0;
    const next = out.replace(
      SECTION_RE,
      (_all, kind: string, name: string, body: string) => {
        const filled = lookup(name).trim() !== "";
        const keep = kind === "#" ? filled : !filled;
        return keep ? body : "";
      },
    );
    if (next === out) break;
    out = next;
  }

  FIELD_RE.lastIndex = 0;
  out = out.replace(FIELD_RE, (_all, name: string) => lookup(name));
  return out;
}

/**
 * The markdown a card actually renders as: its own `content`, or the rendered
 * template when the card is template-backed.
 */
export function effectiveContent(
  card: MochiCard,
  templates?: Map<string, MochiTemplate> | Record<string, MochiTemplate>,
): string {
  const templateId = card["template-id"];
  if (!templateId) return card.content ?? "";
  const template =
    templates instanceof Map ? templates.get(templateId) : templates?.[templateId];
  if (!template) {
    // No template available: fall back to concatenating field values so the
    // card is still reviewable, rather than producing an empty prompt.
    const values = Object.values(card.fields ?? {})
      .map((f) => f?.value ?? "")
      .filter((v) => v.trim() !== "");
    return values.join("\n---\n");
  }
  return renderTemplate(template, fieldValuesByName(card, template));
}
