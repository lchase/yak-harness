import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

function writeConfig(body: unknown | string): string {
  const dir = mkdtempSync(join(tmpdir(), "yh-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

const valid = {
  repo: "lchase/yak",
  yakRepoPath: "/srv/yak",
  stalledAfterMinutes: 45,
};

test("parses a minimal valid config and applies defaults", () => {
  const c = loadConfig(writeConfig(valid));
  expect(c.repo).toBe("lchase/yak");
  expect(c.qualifyingLabel).toBe("yak");
  expect(c.maxConcurrent).toBe(2);
  expect(c.workflow).toBe("implement-change");
  expect(c.inputTemplate).toBe("issueRef={{repo}}#{{number}}");
  expect(c.runsDir).toBe("/srv/yak/.runs");
});

test("honours an explicit runsDir", () => {
  const c = loadConfig(writeConfig({ ...valid, runsDir: "/data/runs" }));
  expect(c.runsDir).toBe("/data/runs");
});

test("missing stalledAfterMinutes is a ConfigError naming the field", () => {
  const { stalledAfterMinutes, ...rest } = valid;
  void stalledAfterMinutes;
  try {
    loadConfig(writeConfig(rest));
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("stalledAfterMinutes");
  }
});

test("rejects a malformed repo slug", () => {
  expect(() =>
    loadConfig(writeConfig({ ...valid, repo: "not-a-slug" })),
  ).toThrow(/repo.*owner\/name/);
});

test("rejects an unknown key", () => {
  expect(() => loadConfig(writeConfig({ ...valid, maxConcurent: 3 }))).toThrow(
    ConfigError,
  );
});

test("rejects a non-positive stalledAfterMinutes", () => {
  expect(() =>
    loadConfig(writeConfig({ ...valid, stalledAfterMinutes: 0 })),
  ).toThrow(ConfigError);
});

test("rejects a relative yakRepoPath", () => {
  expect(() =>
    loadConfig(writeConfig({ ...valid, yakRepoPath: "srv/yak" })),
  ).toThrow(/absolute/);
});

test("rejects a relative runsDir", () => {
  expect(() =>
    loadConfig(writeConfig({ ...valid, runsDir: "relative/runs" })),
  ).toThrow(/runsDir: must be an absolute path/);
});

test("non-JSON file is a ConfigError", () => {
  expect(() => loadConfig(writeConfig("{ not json"))).toThrow(/not valid JSON/);
});

test("missing file is a ConfigError", () => {
  expect(() => loadConfig("/no/such/config.json")).toThrow(
    /cannot read config/,
  );
});
