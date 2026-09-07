import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { TICK_LOCK_NAME } from "./constants.js";
import { acquireTickLock, LockHeld, type TickLock } from "./lock.js";

const held: TickLock[] = [];
afterEach(() => {
  for (const l of held.splice(0)) l.release();
});
function acquire(dir: string): TickLock {
  const l = acquireTickLock(dir);
  held.push(l);
  return l;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "yh-lock-"));
}

test("first acquire writes the pid file; release removes it", () => {
  const dir = freshDir();
  const lock = acquire(dir);
  const path = join(dir, TICK_LOCK_NAME);
  expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
  lock.release();
  expect(existsSync(path)).toBe(false);
});

test("release is idempotent", () => {
  const lock = acquire(freshDir());
  lock.release();
  expect(() => lock.release()).not.toThrow();
});

test("a second acquire while the first is held throws LockHeld", () => {
  const dir = freshDir();
  acquire(dir);
  expect(() => acquireTickLock(dir)).toThrow(LockHeld);
});

test("a stale lock file (dead pid) is stolen", () => {
  const dir = freshDir();
  // pid 2^31-1 is effectively never a live process.
  writeFileSync(join(dir, TICK_LOCK_NAME), "2147483646\n");
  const lock = acquire(dir);
  expect(readFileSync(join(dir, TICK_LOCK_NAME), "utf8").trim()).toBe(
    String(process.pid),
  );
  lock.release();
});

test("a lock file held by a live process (this one) is not stolen", () => {
  const dir = freshDir();
  writeFileSync(join(dir, TICK_LOCK_NAME), `${process.pid}\n`);
  expect(() => acquireTickLock(dir)).toThrow(LockHeld);
});

test("a pid we cannot signal (EPERM, e.g. pid 1) is treated as live, not stolen", () => {
  const dir = freshDir();
  writeFileSync(join(dir, TICK_LOCK_NAME), "1\n");
  expect(() => acquireTickLock(dir)).toThrow(LockHeld);
});

test("garbage in the lock file is treated as stale", () => {
  const dir = freshDir();
  writeFileSync(join(dir, TICK_LOCK_NAME), "not-a-pid\n");
  const lock = acquire(dir);
  expect(existsSync(join(dir, TICK_LOCK_NAME))).toBe(true);
  lock.release();
});
