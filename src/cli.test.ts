import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cli } from "./cli.js";
import { HARNESS_DIR_NAME, TICK_LOCK_NAME } from "./constants.js";

function writeConfig(dir: string): string {
  const path = join(dir, "ok.json");
  writeFileSync(
    path,
    JSON.stringify({
      repo: "lchase/yak",
      yakRepoPath: dir,
      runsDir: join(dir, ".runs"),
      stalledAfterMinutes: 45,
    }),
  );
  return path;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    out,
    err,
  };
}

test("no command → usage on stderr, exit 2", () => {
  const c = capture();
  expect(cli([], c.io)).toBe(2);
  expect(c.err.join("\n")).toContain("usage:");
});

test("unknown command → exit 2", () => {
  const c = capture();
  expect(cli(["frobnicate", "--config", "x"], c.io)).toBe(2);
});

test("doctor without --config → exit 2 naming the flag", () => {
  const c = capture();
  expect(cli(["doctor"], c.io)).toBe(2);
  expect(c.err.join("\n")).toContain("--config");
});

test("unknown argument → exit 2", () => {
  const c = capture();
  expect(cli(["doctor", "--config", "x", "--wat"], c.io)).toBe(2);
  expect(c.err.join("\n")).toContain("--wat");
});

test("doctor with an invalid config → ConfigError on stderr, exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "yh-cli-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, JSON.stringify({ repo: "lchase/yak" }));
  const c = capture();
  expect(cli(["doctor", "--config", path], c.io)).toBe(1);
  expect(c.err.join("\n")).toContain("stalledAfterMinutes");
});

test("tick with a valid config runs observe → plan (no gh here) and no longer reports 'not implemented'", () => {
  const dir = mkdtempSync(join(tmpdir(), "yh-cli-"));
  const path = join(dir, "ok.json");
  writeFileSync(
    path,
    JSON.stringify({
      repo: "lchase/yak",
      yakRepoPath: dir,
      runsDir: join(dir, ".runs"),
      stalledAfterMinutes: 45,
    }),
  );
  const c = capture();
  // No `gh` issues match (empty repo view) / `gh` may be absent — either
  // way the command is wired: it must not claim to be unimplemented.
  const code = cli(["tick", "--config", path, "--dry-run"], c.io);
  expect([0, 1]).toContain(code);
  expect([...c.out, ...c.err].join("\n")).not.toContain("not implemented");
});

test("tick with a live lock held → exits 0 immediately, does nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "yh-cli-"));
  const path = writeConfig(dir);
  const lockPath = join(dir, HARNESS_DIR_NAME, TICK_LOCK_NAME);
  mkdirSync(join(dir, HARNESS_DIR_NAME), { recursive: true });
  writeFileSync(lockPath, `${process.pid}\n`); // this process is alive

  const c = capture();
  expect(cli(["tick", "--config", path], c.io)).toBe(0);
  expect(c.err.join("\n")).toContain("holds");
  expect(c.out).toEqual([]);
  // Not stolen — the holder's file is untouched.
  expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
});

test("tick releases the lock on exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "yh-cli-"));
  const path = writeConfig(dir);
  const c = capture();
  // observe will likely fail (`gh` unauthenticated in CI) → exit 1, but
  // the lock must still be gone afterwards.
  cli(["tick", "--config", path], c.io);
  expect(existsSync(join(dir, HARNESS_DIR_NAME, TICK_LOCK_NAME))).toBe(false);
});

test("--dry-run does not take the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "yh-cli-"));
  const path = writeConfig(dir);
  const lockPath = join(dir, HARNESS_DIR_NAME, TICK_LOCK_NAME);
  mkdirSync(join(dir, HARNESS_DIR_NAME), { recursive: true });
  writeFileSync(lockPath, `${process.pid}\n`);

  const c = capture();
  // Held lock is irrelevant to a dry run — it must still produce a plan.
  const code = cli(["tick", "--config", path, "--dry-run"], c.io);
  expect([0, 1]).toContain(code);
  expect(c.err.join("\n")).not.toContain("holds");
});
