/**
 * Wire types for the Mochi HTTP API (https://app.mochi.cards/api/).
 *
 * Mochi is written in Clojure, so JSON keys are kebab-case and boolean keys
 * carry a trailing `?`. Timestamps are wrapped objects: `{"date": "<ISO>"}`.
 *
 * These shapes were recovered from the official docs plus the source of several
 * independent clients (a typed Go client, the Obsidian plugin, mochi-heatmap,
 * and three MCP servers). Fields marked READ-ONLY are returned by the API but
 * are not accepted by `POST /cards/:id`.
 */

/** Mochi wraps every timestamp in an object rather than using a bare string. */
export interface MochiDate {
  date: string;
}

/**
 * One recorded review of a card. READ-ONLY: the public API returns these but
 * offers no way to append one. See docs/mochi-api-constraints.md.
 */
export interface MochiReview {
  /** When the review happened. */
  date?: MochiDate;
  /** When the card next came due as a result of this review. */
  due?: MochiDate;
  /** Whether the user hit "Remembered". This is Mochi's only grade axis. */
  "remembered?"?: boolean;
  /** Scheduling interval in days. May be fractional. */
  interval?: number;
  /** Seconds spent on the card. Undocumented; present in exports. */
  duration?: number;
  /** Set when this was a re-review of a lapsed card. Undocumented. */
  "rereview?"?: boolean;
}

/** A template field value as stored on a card: fieldId -> {id, value}. */
export interface MochiFieldValue {
  id: string;
  value: string;
}

export interface MochiCard {
  id: string;
  /** Markdown. Empty string for template-backed cards. */
  content: string;
  /** Display name Mochi derives from the content or the `name` field. READ-ONLY. */
  name?: string;
  "deck-id"?: string;
  "template-id"?: string;
  /** Lexicographic sort key within the deck. */
  pos?: string;
  /** All tags, including those parsed out of the content. READ-ONLY. */
  tags?: string[];
  /** Tags set explicitly. This IS writable - our only sanctioned write channel. */
  "manual-tags"?: string[];
  /** fieldId -> {id, value}, for template-backed cards. */
  fields?: Record<string, MochiFieldValue>;
  attachments?: unknown[];
  references?: unknown[];
  /** READ-ONLY review history (forward direction). */
  reviews?: MochiReview[];
  /** READ-ONLY review history for the back->front direction. */
  "reverse-reviews"?: MochiReview[];
  /** Cloze group indices present in the content, e.g. [1, 2]. READ-ONLY. */
  "cloze/indexes"?: number[];
  /** Per-cloze-group review history, keyed by group index. READ-ONLY. */
  "cloze/reviews"?: Record<string, MochiReview[]>;
  "created-at"?: MochiDate;
  "updated-at"?: MochiDate;
  /** True until the card has been reviewed at least once. READ-ONLY. */
  "new?"?: boolean;
  "archived?"?: boolean;
  /** Soft delete. Set to an ISO timestamp to trash. */
  "trashed?"?: string | null;
  /** When true the card is also reviewed back-to-front as a separate schedule. */
  "review-reverse?"?: boolean;
}

export interface MochiDeck {
  id: string;
  name: string;
  "parent-id"?: string;
  sort?: number;
  "archived?"?: boolean;
  "trashed?"?: string | null;
  "review-reverse?"?: boolean;
  "template-id"?: string;
}

export interface MochiTemplateField {
  id: string;
  name: string;
  pos?: string;
  options?: Record<string, unknown>;
}

export interface MochiTemplate {
  id: string;
  name: string;
  /** Markdown with `<< Field Name >>` placeholders and `---` side separators. */
  content: string;
  /** fieldId -> field definition. Placeholders reference fields by NAME. */
  fields: Record<string, MochiTemplateField>;
}

/** Envelope returned by the paginated list endpoints (`/cards`, `/decks`, `/templates`). */
export interface MochiListResponse<T> {
  /** Opaque cursor. The literal string "nil" means the listing is exhausted. */
  bookmark?: string;
  docs: T[];
}

/**
 * Envelope returned by `GET /due` and `GET /due/:deck-id`.
 * Note this differs from the list endpoints: `cards`, not `docs`, and no bookmark.
 */
export interface MochiDueResponse {
  cards: MochiCard[];
}

/** The exact set of keys `POST /cards/:id` accepts. Anything else is ignored. */
export interface MochiCardUpdate {
  content?: string;
  "deck-id"?: string;
  "template-id"?: string;
  "archived?"?: boolean;
  "review-reverse?"?: boolean;
  pos?: string;
  "manual-tags"?: string[];
  fields?: Record<string, MochiFieldValue>;
  "trashed?"?: string | null;
}
