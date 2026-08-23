import { ReviewSessionEngine } from "./engine.js";

/**
 * Holds the live review sessions.
 *
 * Session state lives here, on the server, and NOT in the voice model's
 * context. That is the single most important structural decision in this
 * project: a model that tracks its own place in the deck will eventually lose
 * it, re-ask a card, or grade the wrong one - and it cannot be audited
 * afterwards. Here, "which card is current" and "what was card 4 graded" are
 * facts, and revising card 4 two cards later is a lookup rather than a feat
 * of recall.
 */
export class SessionStore {
  private readonly sessions = new Map<string, ReviewSessionEngine>();
  private readonly order: string[] = [];

  constructor(private readonly maxSessions = 32) {}

  put(engine: ReviewSessionEngine): void {
    this.sessions.set(engine.sessionId, engine);
    this.order.push(engine.sessionId);
    while (this.order.length > this.maxSessions) {
      const oldest = this.order.shift();
      if (oldest && oldest !== engine.sessionId) this.sessions.delete(oldest);
    }
  }

  get(id: string): ReviewSessionEngine | undefined {
    return this.sessions.get(id);
  }

  /**
   * The session to act on when the caller did not name one.
   *
   * Voice models routinely drop the session id from a tool call, so falling
   * back to the most recent unfinished session is what keeps a review from
   * dying on a missing argument.
   */
  latestActive(): ReviewSessionEngine | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const id = this.order[i];
      if (!id) continue;
      const s = this.sessions.get(id);
      if (s && !s.endedAt) return s;
    }
    return undefined;
  }

  resolve(id?: string): ReviewSessionEngine | undefined {
    if (id) return this.sessions.get(id) ?? undefined;
    return this.latestActive();
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}
