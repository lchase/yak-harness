import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  branchIsSafe,
  issueLabelSearch,
  ObserveError,
  parseCommentsJson,
  parseIssueListJson,
  parsePrListJson,
  parsePrViewJson,
  parseRunBreadcrumb,
  prUrlLooksValid,
  runIdIsSafe,
  scanPendingRuns,
} from "./observe-deps.js";

describe("runIdIsSafe", () => {
  test("accepts real yak run ids", () => {
    expect(runIdIsSafe("2026-09-06T09-12-44Z-a1b2")).toBe(true);
  });
  test("rejects path-traversal and separators", () => {
    for (const bad of ["../etc", "..", "a/b", "a\\b", "/abs", ".hidden", ""]) {
      expect(runIdIsSafe(bad)).toBe(false);
    }
  });
});

describe("parseRunBreadcrumb", () => {
  const body = JSON.stringify({
    pid: 4242,
    issue: 7,
    launchedAt: "2026-09-06T09:00:00.000Z",
  });

  test("well-formed pid file → runId from filename + issue + launchedAt + pid", () => {
    expect(parseRunBreadcrumb("2026-09-06T09-12-44Z-a1b2.json", body)).toEqual({
      runId: "2026-09-06T09-12-44Z-a1b2",
      issue: 7,
      launchedAt: "2026-09-06T09:00:00.000Z",
      pid: 4242,
    });
  });

  test("the transient launching-<issue> breadcrumb is not a run breadcrumb", () => {
    expect(parseRunBreadcrumb("launching-7.json", body)).toBeNull();
  });

  test("path-unsafe filename, non-JSON, or wrong shape → null", () => {
    expect(parseRunBreadcrumb("../evil.json", body)).toBeNull();
    expect(parseRunBreadcrumb("r.json", "{ half-written")).toBeNull();
    expect(parseRunBreadcrumb("r.json", '{"pid":1}')).toBeNull();
    expect(parseRunBreadcrumb("r.txt", body)).toBeNull();
  });
});

describe("branchIsSafe", () => {
  test("accepts yak/<id> and custom names, rejects flag-like values", () => {
    expect(branchIsSafe("yak/2026-09-06T09-12-44Z-a1b2")).toBe(true);
    expect(branchIsSafe("feature/x")).toBe(true);
    expect(branchIsSafe("--head")).toBe(false);
    expect(branchIsSafe("-x")).toBe(false);
    expect(branchIsSafe("a b")).toBe(false);
  });
});

describe("prUrlLooksValid", () => {
  test("only a PR URL on the configured repo passes", () => {
    const repo = "lchase/yak";
    expect(prUrlLooksValid("https://github.com/lchase/yak/pull/12", repo)).toBe(
      true,
    );
    expect(
      prUrlLooksValid("https://github.com/lchase/yak/pull/12 ", repo),
    ).toBe(true);
    expect(
      prUrlLooksValid("https://github.com/lchase/other/pull/12", repo),
    ).toBe(false);
    expect(
      prUrlLooksValid("https://github.com/lchase/yak/issues/12", repo),
    ).toBe(false);
    expect(prUrlLooksValid("--repo=x", repo)).toBe(false);
    expect(
      prUrlLooksValid("https://evil.example/lchase/yak/pull/12", repo),
    ).toBe(false);
  });
});

describe("issueLabelSearch", () => {
  test("qualifying label OR every status label", () => {
    expect(issueLabelSearch("yak")).toBe(
      'label:"yak","yak:running","yak:waiting","yak:pr-open","yak:failed","yak:done"',
    );
  });
});

describe("parseIssueListJson", () => {
  test("flattens gh label objects to names", () => {
    const json = JSON.stringify([
      {
        number: 7,
        title: "T",
        labels: [{ name: "yak" }, { name: "yak:running" }],
      },
    ]);
    expect(parseIssueListJson(json)).toEqual([
      { number: 7, title: "T", labels: ["yak", "yak:running"] },
    ]);
  });
  test("non-JSON raises a typed ObserveError with a readable cause", () => {
    expect(() => parseIssueListJson("gh: rate limit exceeded")).toThrow(
      ObserveError,
    );
  });
});

describe("parseCommentsJson", () => {
  test("pulls body / authorAssociation / createdAt", () => {
    const json = JSON.stringify({
      comments: [
        {
          body: "hi",
          authorAssociation: "OWNER",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(parseCommentsJson(json)[0]).toMatchObject({
      body: "hi",
      authorAssociation: "OWNER",
    });
  });
});

describe("parsePrViewJson / parsePrListJson", () => {
  test("view: well-formed → record, malformed → null", () => {
    expect(parsePrViewJson('{"state":"OPEN","mergedAt":null}')).toEqual({
      state: "OPEN",
      mergedAt: null,
    });
    expect(parsePrViewJson('{"state":"OPEN"}')).toBeNull();
  });
  test("list: first row or null", () => {
    expect(
      parsePrListJson('[{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}]'),
    ).toEqual({
      state: "MERGED",
      mergedAt: "2026-01-01T00:00:00Z",
    });
    expect(parsePrListJson("[]")).toBeNull();
  });
});

describe("scanPendingRuns", () => {
  const warn = () => {};
  let runsDir: string;

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "yh-pending-"));
  });
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  const writeRequest = (runId: string, stepId: string, body: unknown): void => {
    const dir = join(runsDir, runId, "pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${stepId}.request.json`),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };

  test("reads one open gate request per run, grouped by run id", () => {
    writeRequest("r1", "confirm-scope", {
      kind: "gate",
      stepId: "confirm-scope",
      runId: "r1",
      rendered: "Proceed?",
    });
    expect(scanPendingRuns(runsDir, warn)).toEqual([
      {
        runId: "r1",
        steps: [
          { stepId: "confirm-scope", kind: "gate", rendered: "Proceed?" },
        ],
      },
    ]);
  });

  test("a run dir with no pending/ dir contributes nothing", () => {
    mkdirSync(join(runsDir, "r2"));
    expect(scanPendingRuns(runsDir, warn)).toEqual([]);
  });

  test("a request with a sibling answer file is no longer open", () => {
    writeRequest("r5", "confirm-scope", {
      kind: "gate",
      stepId: "confirm-scope",
      runId: "r5",
      rendered: "x",
    });
    writeRequest("r5", "design-review", {
      kind: "gate",
      stepId: "design-review",
      runId: "r5",
      rendered: "y",
    });
    writeFileSync(
      join(runsDir, "r5", "pending", "confirm-scope.answer.json"),
      "{}",
    );
    expect(scanPendingRuns(runsDir, warn)).toEqual([
      {
        runId: "r5",
        steps: [{ stepId: "design-review", kind: "gate", rendered: "y" }],
      },
    ]);
  });

  test("defaults a missing rendered to the empty string", () => {
    writeRequest("r3", "s", { kind: "gate", stepId: "s", runId: "r3" });
    expect(scanPendingRuns(runsDir, warn)[0]?.steps[0]?.rendered).toBe("");
  });

  test("drops a malformed / unreadable request file loudly, keeps the good ones", () => {
    const dropped: string[] = [];
    writeRequest("r4", "bad", "not json");
    writeRequest("r4", "nokind", { stepId: "nokind", runId: "r4" });
    writeRequest("r4", "ok", {
      kind: "gate",
      stepId: "ok",
      runId: "r4",
      rendered: "y",
    });
    const out = scanPendingRuns(runsDir, (m) => dropped.push(m));
    expect(out).toEqual([
      { runId: "r4", steps: [{ stepId: "ok", kind: "gate", rendered: "y" }] },
    ]);
    expect(dropped).toHaveLength(2);
  });

  test("a missing runsDir → empty, no throw", () => {
    expect(scanPendingRuns(join(runsDir, "nope"), warn)).toEqual([]);
  });

  test("skips an unsafe run-dir name", () => {
    writeRequest("..", "s", { kind: "gate", stepId: "s", runId: ".." });
    expect(scanPendingRuns(runsDir, warn)).toEqual([]);
  });
});
