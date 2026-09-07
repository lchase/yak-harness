import { describe, expect, test } from "vitest";
import {
  branchIsSafe,
  issueLabelSearch,
  ObserveError,
  parseCommentsJson,
  parseIssueListJson,
  parsePendingJson,
  parsePrListJson,
  parsePrViewJson,
  parseRunBreadcrumb,
  prUrlLooksValid,
  runIdIsSafe,
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

  test("well-formed pid file → runId from filename + issue + launchedAt", () => {
    expect(parseRunBreadcrumb("2026-09-06T09-12-44Z-a1b2.json", body)).toEqual({
      runId: "2026-09-06T09-12-44Z-a1b2",
      issue: 7,
      launchedAt: "2026-09-06T09:00:00.000Z",
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

describe("parsePendingJson", () => {
  const warn = () => {};

  test("normalises id/runId and steps/pending aliases", () => {
    const json = JSON.stringify({
      runs: [
        {
          id: "r1",
          pending: [
            { id: "confirm-scope", kind: "gate", rendered: "Proceed?" },
          ],
        },
      ],
    });
    expect(parsePendingJson(json, warn)).toEqual([
      {
        runId: "r1",
        steps: [
          { stepId: "confirm-scope", kind: "gate", rendered: "Proceed?" },
        ],
      },
    ]);
  });

  test("accepts a bare array too", () => {
    const json = JSON.stringify([
      { runId: "r2", steps: [{ stepId: "s", kind: "gate", rendered: "" }] },
    ]);
    expect(parsePendingJson(json, warn)).toHaveLength(1);
  });

  test("drops an entry missing runId or a step kind, keeps the good ones", () => {
    const dropped: string[] = [];
    const json = JSON.stringify([
      { steps: [] },
      { runId: "r3", steps: [{ stepId: "s" }] },
      { runId: "r4", steps: [{ stepId: "s", kind: "gate", rendered: "ok" }] },
    ]);
    expect(parsePendingJson(json, (m) => dropped.push(m))).toEqual([
      { runId: "r4", steps: [{ stepId: "s", kind: "gate", rendered: "ok" }] },
    ]);
    expect(dropped).toHaveLength(2);
  });

  test("non-list output → empty, with a warning", () => {
    const dropped: string[] = [];
    expect(parsePendingJson('{"nope":true}', (m) => dropped.push(m))).toEqual(
      [],
    );
    expect(dropped).toHaveLength(1);
  });

  test("non-JSON raises ObserveError", () => {
    expect(() => parsePendingJson("not json", warn)).toThrow(ObserveError);
  });
});
