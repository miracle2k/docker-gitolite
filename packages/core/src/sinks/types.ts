import type { GradeRevision, SessionEntry } from "../session/types.js";

export interface SinkResult {
  ok: boolean;
  detail?: string;
}

/**
 * Where a grade goes once it is decided.
 *
 * This indirection exists because of a hard constraint: Mochi's public API is
 * READ-ONLY with respect to review scheduling. There is no endpoint to submit
 * a Remembered/Forgot result. See docs/mochi-api-constraints.md.
 *
 * So the engine never assumes it can advance Mochi's schedule. It records
 * every verdict to whatever sinks are configured, and each sink declares
 * honestly whether it actually moves Mochi's scheduler.
 */
export interface GradeSink {
  readonly name: string;
  readonly capabilities: {
    /** Can a previously recorded grade be changed after the fact? */
    revise: boolean;
    /** Does writing here actually advance Mochi's own spaced-repetition schedule? */
    advancesSchedule: boolean;
  };
  record(entry: SessionEntry): Promise<SinkResult>;
  revise(entry: SessionEntry, revision: GradeRevision): Promise<SinkResult>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}
