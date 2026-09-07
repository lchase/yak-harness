import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cli } from "./cli.js";

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

test("tick is not implemented yet → exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "yh-cli-"));
  const path = join(dir, "ok.json");
  writeFileSync(
    path,
    JSON.stringify({
      repo: "lchase/yak",
      yakRepoPath: "/srv/yak",
      stalledAfterMinutes: 45,
    }),
  );
  const c = capture();
  expect(cli(["tick", "--config", path], c.io)).toBe(1);
  expect(c.err.join("\n")).toContain("not implemented");
});
