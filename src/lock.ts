// Overlap guard — the `.harness/tick.lock` file (spec §6.6).
//
// `yak-harness tick` takes an exclusive lock at startup and exits 0
// immediately if another tick holds it, so a slow tick overlapping the
// next cron fire is safe with no operator setup.
//
// There is no portable `flock(2)` in Node's stdlib, so this is an
// advisory PID lock: exclusive-create the file (`wx`), stamp our pid,
// and clean it up on exit. A tick that dies without cleanup (SIGKILL,
// power loss) leaves the file behind — the next tick reads the pid,
// sees it is dead, and steals the lock. That single stale-steal is why
// the file carries the pid at all.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { TICK_LOCK_NAME } from "./constants.js";

/** A held lock. `release()` is idempotent and safe to call from a `finally`. */
export interface TickLock {
  release(): void;
}

/** Thrown by {@link acquireTickLock} when a live tick already holds the lock. */
export class LockHeld extends Error {
  override name = "LockHeld";
}

/**
 * Take the exclusive tick lock in `harnessDirPath`. Returns a
 * {@link TickLock} on success; throws {@link LockHeld} when another live
 * tick holds it (the caller exits 0 — overlap is safe).
 */
export function acquireTickLock(harnessDirPath: string): TickLock {
  mkdirSync(harnessDirPath, { recursive: true });
  const path = join(harnessDirPath, TICK_LOCK_NAME);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return makeLock(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt === 0 && holderIsDead(path)) {
        // Stale file from a tick that died without cleanup — steal it once.
        try {
          unlinkSync(path);
        } catch {
          // Raced with another tick's steal; the retry will observe theirs.
        }
        continue;
      }
      throw new LockHeld(`another tick holds ${path}`);
    }
  }
  throw new LockHeld(`another tick holds ${path}`);
}

function makeLock(path: string): TickLock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    try {
      unlinkSync(path);
    } catch {
      // Already gone (stolen as stale, or a concurrent cleanup) — fine.
    }
  };
  // Best-effort cleanup if the process exits without hitting the caller's
  // `finally`. A hard kill skips this; the stale-steal path covers that.
  process.once("exit", release);
  return { release };
}

/** True when `path`'s recorded pid names no live process (or is unreadable garbage). */
function holderIsDead(path: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}
