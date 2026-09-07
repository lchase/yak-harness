import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TICK_LOG_NAME } from "./constants.js";
import { appendTickLog, type TickLogRecord } from "./tick-log.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "yh-log-"));
}

function record(overrides: Partial<TickLogRecord> = {}): TickLogRecord {
  return {
    ts: "2026-09-07T09:00:00.000Z",
    durationMs: 12,
    counts: { issues: 3, runs: { alive: 1, ok: 2 } },
    actions: ["launched run run-x for #12"],
    errors: [],
    ...overrides,
  };
}

test("appends exactly one newline-terminated JSON line per call", () => {
  const dir = freshDir();
  appendTickLog(dir, record());
  appendTickLog(dir, record({ durationMs: 34 }));

  const lines = readFileSync(join(dir, TICK_LOG_NAME), "utf8")
    .split("\n")
    .filter(Boolean);
  expect(lines).toHaveLength(2);
  const parsed = JSON.parse(lines[0] ?? "");
  expect(parsed.counts.runs.ok).toBe(2);
  expect(parsed.actions).toEqual(["launched run run-x for #12"]);
});

test("creates the .harness directory if missing", () => {
  const dir = join(freshDir(), "nested", ".harness");
  appendTickLog(dir, record());
  expect(existsSync(join(dir, TICK_LOG_NAME))).toBe(true);
});

test("rotates to tick.log.1 once the size cap is reached", () => {
  const dir = freshDir();
  const path = join(dir, TICK_LOG_NAME);

  appendTickLog(dir, record({ actions: ["first"] }), 50);
  // File now exceeds the tiny cap → next call rotates before appending.
  appendTickLog(dir, record({ actions: ["second"] }), 50);

  expect(JSON.parse(readFileSync(path, "utf8").trim()).actions).toEqual([
    "second",
  ]);
  expect(JSON.parse(readFileSync(`${path}.1`, "utf8").trim()).actions).toEqual([
    "first",
  ]);
});

test("rotation keeps only one generation (tick.log.1 is overwritten)", () => {
  const dir = freshDir();
  const path = join(dir, TICK_LOG_NAME);
  appendTickLog(dir, record({ actions: ["a"] }), 40);
  appendTickLog(dir, record({ actions: ["b"] }), 40);
  appendTickLog(dir, record({ actions: ["c"] }), 40);
  expect(JSON.parse(readFileSync(`${path}.1`, "utf8").trim()).actions).toEqual([
    "b",
  ]);
  expect(existsSync(`${path}.2`)).toBe(false);
});

test("aborted flag is recorded when set", () => {
  const dir = freshDir();
  appendTickLog(dir, record({ aborted: true, errors: ["two markers on #9"] }));
  const parsed = JSON.parse(
    readFileSync(join(dir, TICK_LOG_NAME), "utf8").trim(),
  );
  expect(parsed.aborted).toBe(true);
  expect(parsed.errors).toEqual(["two markers on #9"]);
});
