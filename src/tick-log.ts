// The `.harness/tick.log` JSON-lines file (spec §10.5).
//
// One line per real tick: timestamp, duration, counts, every action
// taken, and any non-fatal errors. The harness rotates the file itself
// at a size cap (`tick.log` → `tick.log.1`, one generation kept) — no
// `logrotate` dependency. Fatal preconditions go to stderr + a non-zero
// exit, never here. Nothing remote.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { TICK_LOG_MAX_BYTES, TICK_LOG_NAME } from "./constants.js";

export interface TickLogRecord {
  /** ISO-8601 UTC timestamp of when the tick started. */
  ts: string;
  /** Wall-clock duration of the tick in milliseconds. */
  durationMs: number;
  counts: {
    issues: number;
    /** Run count keyed by observed class (`alive`, `suspended`, `ok`, …). */
    runs: Record<string, number>;
  };
  /** One string per action `apply` carried out, in order. */
  actions: string[];
  /** Non-fatal problems — the tick still exited 0 unless it also aborted. */
  errors: string[];
  /** Set when `apply` bailed out and left state for a human (spec §5.1). */
  aborted?: boolean;
}

/**
 * Append one record to `<harnessDirPath>/tick.log`, rotating first if the
 * file has reached `maxBytes`. Creates the directory if missing.
 */
export function appendTickLog(
  harnessDirPath: string,
  record: TickLogRecord,
  maxBytes: number = TICK_LOG_MAX_BYTES,
): void {
  mkdirSync(harnessDirPath, { recursive: true });
  const path = join(harnessDirPath, TICK_LOG_NAME);

  try {
    if (statSync(path).size >= maxBytes) {
      renameSync(path, `${path}.1`); // overwrites any prior generation
    }
  } catch {
    // No file yet — nothing to rotate.
  }

  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
