import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { GradeRevision, SessionEntry } from "../session/types.js";
import type { GradeSink, SinkResult } from "./types.js";

/**
 * Append-only local log of every verdict and every revision.
 *
 * This sink always works and never loses data, which matters because it is the
 * only durable record of a session when Mochi itself cannot be written to. It
 * is append-only by design: a revision is a new line, not an edit, so the
 * history of "graded right, then I said no, mark it wrong" survives.
 */
export class JsonlSink implements GradeSink {
  readonly name = "jsonl";
  readonly capabilities = { revise: true, advancesSchedule: false };
  private ensured = false;

  constructor(private readonly path: string) {}

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.ensured = true;
  }

  private async append(record: unknown): Promise<SinkResult> {
    try {
      await this.ensureDir();
      await appendFile(this.path, JSON.stringify(record) + "\n", "utf8");
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async record(entry: SessionEntry): Promise<SinkResult> {
    return this.append({ event: "grade", at: new Date().toISOString(), entry });
  }

  async revise(entry: SessionEntry, revision: GradeRevision): Promise<SinkResult> {
    return this.append({
      event: "revision",
      at: new Date().toISOString(),
      cardId: entry.cardId,
      seq: entry.seq,
      revision,
      entry,
    });
  }
}
