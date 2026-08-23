import type {
  MochiCard,
  MochiCardUpdate,
  MochiDeck,
  MochiDueResponse,
  MochiListResponse,
  MochiTemplate,
} from "./types.js";

export const MOCHI_API_BASE = "https://app.mochi.cards/api";

export interface MochiClientOptions {
  /** Mochi API token. Mochi Pro only; free accounts get 403. */
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Max attempts for a request that fails with 429 or 5xx. */
  maxRetries?: number;
  /** Base delay for exponential backoff, ms. */
  retryBaseMs?: number;
  /** Injected for tests so backoff does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class MochiApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `Mochi API ${status}: ${body.slice(0, 300)}`);
    this.name = "MochiApiError";
  }

  /** Mochi returns this when the account is not on the Pro plan. */
  get isUpgradeRequired(): boolean {
    return this.status === 403 && this.body.includes("upgrade");
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Client for the Mochi HTTP API.
 *
 * Mochi allows only ONE concurrent request per account and returns 429 on
 * bursts, so every request goes through a serial queue. Callers may fire
 * requests concurrently; they will be executed one at a time in order.
 */
export class MochiClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly doFetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Tail of the serial request queue. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: MochiClientOptions) {
    if (!opts.token) throw new Error("MochiClient requires an API token");
    this.baseUrl = (opts.baseUrl ?? MOCHI_API_BASE).replace(/\/+$/, "");
    // HTTP Basic with the token as username and an EMPTY password.
    this.authHeader =
      "Basic " + Buffer.from(`${opts.token}:`, "utf8").toString("base64");
    this.doFetch = opts.fetchImpl ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 4;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.sleep = opts.sleepImpl ?? sleep;
  }

  /** Serialize every call: Mochi permits one concurrent request per account. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the chain alive even when a call rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    return this.enqueue(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (attempt > 0) await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
        let res: Response;
        try {
          res = await this.doFetch(url.toString(), {
            method,
            headers: {
              Authorization: this.authHeader,
              Accept: "application/json",
              ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          });
        } catch (err) {
          lastErr = err;
          continue; // network blip: retry
        }

        // Treat any 2xx as success - Mochi is inconsistent about 200/201/204.
        if (res.ok) {
          const text = await res.text();
          if (!text.trim()) return undefined as T;
          return JSON.parse(text) as T;
        }

        const body = await res.text().catch(() => "");
        const err = new MochiApiError(res.status, body);
        // 429 (concurrency) and 5xx are transient; everything else is fatal.
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`Mochi request failed after ${this.maxRetries + 1} attempts`);
    });
  }

  // --- Due cards -----------------------------------------------------------

  /**
   * Cards due for review. This is the entry point for a review session.
   *
   * @param date ISO-8601 date; defaults to today server-side.
   * @param deckId restrict to one deck (uses `GET /due/:deck-id`).
   *
   * Note the envelope is `{cards: [...]}`, unlike the list endpoints, and it is
   * NOT paginated - the whole due queue comes back at once.
   */
  async getDue(opts: { date?: string; deckId?: string } = {}): Promise<MochiCard[]> {
    const path = opts.deckId ? `/due/${encodeURIComponent(opts.deckId)}` : "/due";
    const res = await this.request<MochiDueResponse>("GET", path, {
      query: { date: opts.date },
    });
    return res?.cards ?? [];
  }

  // --- Cards ---------------------------------------------------------------

  async getCard(id: string): Promise<MochiCard> {
    return this.request<MochiCard>("GET", `/cards/${encodeURIComponent(id)}`);
  }

  /**
   * Walk the paginated card listing. Mochi caps `limit` at 100 and signals the
   * end of the listing with the LITERAL STRING "nil" as the bookmark, so the
   * termination check has to cover that as well as the usual empty cases.
   */
  async *listCards(opts: { deckId?: string; limit?: number } = {}): AsyncGenerator<MochiCard> {
    let bookmark: string | undefined;
    const limit = Math.min(opts.limit ?? 100, 100);
    for (;;) {
      const page = await this.request<MochiListResponse<MochiCard>>("GET", "/cards", {
        query: { "deck-id": opts.deckId, limit, bookmark },
      });
      const docs = page?.docs ?? [];
      for (const card of docs) yield card;
      const next = page?.bookmark;
      if (!next || next === "nil" || docs.length === 0) return;
      bookmark = next;
    }
  }

  /** Update a card. Note: POST, not PUT/PATCH. Only `MochiCardUpdate` keys apply. */
  async updateCard(id: string, update: MochiCardUpdate): Promise<MochiCard> {
    return this.request<MochiCard>("POST", `/cards/${encodeURIComponent(id)}`, {
      body: update,
    });
  }

  // --- Decks & templates ---------------------------------------------------

  async listDecks(): Promise<MochiDeck[]> {
    const out: MochiDeck[] = [];
    let bookmark: string | undefined;
    for (;;) {
      const page = await this.request<MochiListResponse<MochiDeck>>("GET", "/decks", {
        query: { bookmark },
      });
      const docs = page?.docs ?? [];
      out.push(...docs);
      const next = page?.bookmark;
      if (!next || next === "nil" || docs.length === 0) return out;
      bookmark = next;
    }
  }

  async listTemplates(): Promise<MochiTemplate[]> {
    const out: MochiTemplate[] = [];
    let bookmark: string | undefined;
    for (;;) {
      const page = await this.request<MochiListResponse<MochiTemplate>>("GET", "/templates", {
        query: { bookmark },
      });
      const docs = page?.docs ?? [];
      out.push(...docs);
      const next = page?.bookmark;
      if (!next || next === "nil" || docs.length === 0) return out;
      bookmark = next;
    }
  }

  async getTemplate(id: string): Promise<MochiTemplate> {
    return this.request<MochiTemplate>("GET", `/templates/${encodeURIComponent(id)}`);
  }
}
