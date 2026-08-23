import type { GradeRevision, SessionEntry } from "../session/types.js";
import type { GradeSink, SinkResult } from "./types.js";

/** In-memory sink, used by tests and by dry-run sessions. */
export class MemorySink implements GradeSink {
  readonly name = "memory";
  readonly capabilities = { revise: true, advancesSchedule: false };
  readonly recorded: SessionEntry[] = [];
  readonly revisions: GradeRevision[] = [];

  async record(entry: SessionEntry): Promise<SinkResult> {
    this.recorded.push(structuredClone(entry));
    return { ok: true };
  }

  async revise(entry: SessionEntry, revision: GradeRevision): Promise<SinkResult> {
    this.revisions.push(revision);
    const idx = this.recorded.findIndex((e) => e.seq === entry.seq);
    if (idx >= 0) this.recorded[idx] = structuredClone(entry);
    return { ok: true };
  }
}
