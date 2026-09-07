import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { Config } from "./config.js";
import {
  classifyRun,
  findOrphans,
  findStaleMarkers,
  linkMarkers,
  type MarkerScan,
  type Observation,
  type ObserveDeps,
  observe,
  parseJournal,
  parseMarkers,
  prStateFrom,
  type RawComment,
  type RawPr,
  type RunObservation,
  readLabels,
} from "./observe.js";

const FIX = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/observe",
);
const RUNS_DIR = join(FIX, "runs");
const NOW = new Date("2026-09-06T12:00:00Z");

const CONFIG: Config = {
  repo: "lchase/yak-harness",
  yakRepoPath: "/srv/yak",
  runsDir: RUNS_DIR,
  qualifyingLabel: "yak",
  stalledAfterMinutes: 45,
  maxConcurrent: 2,
  workflow: "implement-change",
  inputTemplate: "issueRef={{repo}}#{{number}}",
};

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(FIX, rel), "utf8")) as T;
}

const comment = (body: string, assoc = "NONE"): RawComment => ({
  body,
  authorAssociation: assoc,
  createdAt: "",
});

/**
 * {@link ObserveDeps} backed by the fixture tree: journals are read off
 * disk (so `parseJournal` runs for real), everything else is canned JSON.
 * `mtimeOverrides` feeds the `stalled` classifier a deterministic age.
 */
function fixtureDeps(
  opts: {
    now?: Date;
    mtimeOverrides?: Record<string, number>;
    runBreadcrumbs?: {
      runId: string;
      issue: number;
      launchedAt: string;
    }[];
  } = {},
): ObserveDeps {
  const now = opts.now ?? NOW;
  const freshMtime = now.getTime() - 60_000;
  const issues =
    readJson<{ number: number; title: string; labels: { name: string }[] }[]>(
      "gh/issues.json",
    );
  const comments = readJson<Record<string, RawComment[]>>("gh/comments.json");
  const pending =
    readJson<
      {
        runId: string;
        steps: { stepId: string; kind: string; rendered: string }[];
      }[]
    >("yak-pending.json");
  const prs = readJson<Record<string, RawPr>>("gh/prs.json");

  return {
    now: () => now,
    listIssues: () =>
      issues.map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels.map((l) => l.name),
      })),
    listComments: (n) => comments[String(n)] ?? [],
    listLaunchBreadcrumbs: () => [],
    listRunBreadcrumbs: () => opts.runBreadcrumbs ?? [],
    yakPending: () => pending,
    listRunDirs: () =>
      readdirSync(RUNS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    readRun: (id) => {
      let journal: string | null = null;
      try {
        journal = readFileSync(join(RUNS_DIR, id, "journal"), "utf8");
      } catch {
        journal = null;
      }
      return { journal, mtimeMs: opts.mtimeOverrides?.[id] ?? freshMtime };
    },
    prForRun: (id) => prs[id] ?? null,
  };
}

// ── parseMarkers ────────────────────────────────────────────────────

describe("parseMarkers", () => {
  test("extracts run/branch/launched in comment order, multiple per body", () => {
    const markers = parseMarkers([
      comment(
        "retry log\n<!-- yak-harness run=r1 branch=yak/r1 launched=2026-01-01T00:00:00Z -->\n<!-- yak-harness run=r2 branch=custom launched=2026-01-02T00:00:00Z -->",
      ),
      comment("chatter", "OWNER"),
      comment(
        "<!-- yak-harness run=r3 branch=yak/r3 launched=2026-01-03T00:00:00Z -->",
      ),
    ]);
    expect(markers.map((m) => m.runId)).toEqual(["r1", "r2", "r3"]);
    expect(markers[1]).toEqual({
      runId: "r2",
      branch: "custom",
      launched: "2026-01-02T00:00:00Z",
    });
  });

  test("a malformed marker (missing a field) is silently ignored", () => {
    expect(
      parseMarkers([comment("<!-- yak-harness run=r1 branch=yak/r1 -->")]),
    ).toEqual([]);
  });
});

// ── readLabels ──────────────────────────────────────────────────────

describe("readLabels", () => {
  test("bare qualifying label → no status, no fault", () => {
    expect(readLabels(["yak"], "yak")).toEqual({
      qualifying: true,
      held: false,
      status: null,
      fault: null,
    });
  });

  test("one yak:<status> is read; yak:hold is not a status", () => {
    expect(readLabels(["yak", "yak:running"], "yak").status).toBe("running");
    const held = readLabels(["yak", "yak:hold"], "yak");
    expect(held).toMatchObject({ held: true, status: null, fault: null });
  });

  test("two yak:<status> labels → fault, status null", () => {
    const r = readLabels(["yak", "yak:running", "yak:waiting"], "yak");
    expect(r.status).toBeNull();
    expect(r.fault).toMatch(/two yak:<status>/);
  });

  test("unknown yak: suffix is ignored", () => {
    expect(readLabels(["yak", "yak:bogus"], "yak").status).toBeNull();
  });
});

// ── parseJournal ────────────────────────────────────────────────────

describe("parseJournal", () => {
  test("null / empty → no events", () => {
    expect(parseJournal(null)).toEqual([]);
    expect(parseJournal("   \n\n")).toEqual([]);
  });

  test("skips a half-written trailing line, keeps valid events", () => {
    const text =
      '{"t":"run.started","at":"2026-09-06T09:12:44Z","runId":"r","workflow":"w","inputHash":"h","adapter":"a","isolation":"worktree"}\n{"t":"run.fini';
    expect(parseJournal(text).map((e) => e.t)).toEqual(["run.started"]);
  });

  test("keeps an unknown-but-valid JSON event line between two known events", () => {
    const text = [
      '{"t":"run.started","at":"2026-09-06T09:12:44Z","runId":"r","workflow":"w","inputHash":"h","adapter":"a","isolation":"worktree"}',
      '{"t":"budget.consumed","at":"2026-09-06T09:13:00Z","runId":"r","tokens":10}',
      '{"t":"run.finished","at":"2026-09-06T09:20:00Z","runId":"r","status":"ok"}',
    ].join("\n");
    expect(parseJournal(text).map((e) => e.t)).toEqual([
      "run.started",
      "budget.consumed",
      "run.finished",
    ]);
  });
});

// ── classifyRun ─────────────────────────────────────────────────────

describe("classifyRun", () => {
  const base = { now: NOW, stalledAfterMinutes: 45 };
  const started = (runId: string) =>
    `{"t":"run.started","at":"2026-09-06T09:12:44Z","runId":"${runId}","workflow":"w","inputHash":"h","adapter":"a","isolation":"worktree"}`;
  const finished = (status: string) =>
    `{"t":"run.finished","at":"2026-09-06T10:00:00Z","runId":"r","status":"${status}"}`;

  test("last event not run.finished, journal fresh → alive", () => {
    const r = classifyRun({
      ...base,
      journal: started("r"),
      mtimeMs: NOW.getTime() - 5 * 60_000,
    });
    expect(r.runClass).toBe("alive");
    expect(r.lastEventAt).toBe("2026-09-06T09:12:44Z");
  });

  test("alive + journal mtime older than threshold → stalled", () => {
    expect(
      classifyRun({
        ...base,
        journal: started("r"),
        mtimeMs: NOW.getTime() - 46 * 60_000,
      }).runClass,
    ).toBe("stalled");
  });

  test("stalled boundary is strict — exactly the threshold is still alive", () => {
    expect(
      classifyRun({
        ...base,
        journal: started("r"),
        mtimeMs: NOW.getTime() - 45 * 60_000,
      }).runClass,
    ).toBe("alive");
  });

  test("no journal + a stale dir mtime → stalled (never 'alive' forever)", () => {
    expect(
      classifyRun({
        ...base,
        journal: null,
        mtimeMs: NOW.getTime() - 90 * 60_000,
      }).runClass,
    ).toBe("stalled");
  });

  test("no journal + no mtime → alive (nothing to age against)", () => {
    expect(
      classifyRun({ ...base, journal: null, mtimeMs: null }).runClass,
    ).toBe("alive");
  });

  test("run.finished suspended / ok / failed", () => {
    for (const [status, cls] of [
      ["suspended", "suspended"],
      ["ok", "ok"],
      ["failed", "failed"],
    ] as const) {
      expect(
        classifyRun({
          ...base,
          journal: `${started("r")}\n${finished(status)}`,
          mtimeMs: NOW.getTime() - 90 * 60_000,
        }).runClass,
      ).toBe(cls);
    }
  });

  test("run.finished with a status yak added later → failed (terminal, needs a human)", () => {
    expect(
      classifyRun({
        ...base,
        journal: `${started("r")}\n${finished("cancelled")}`,
        mtimeMs: NOW.getTime(),
      }).runClass,
    ).toBe("failed");
  });

  test("failed run surfaces the most recent typed StepFailure; a malformed final one is skipped", () => {
    const journal = [
      started("r"),
      '{"t":"step.failed","at":"2026-09-06T09:30:00Z","runId":"r","stepId":"a","failure":{"reason":"adapter-error","detail":"first","recoverable":false}}',
      '{"t":"step.failed","at":"2026-09-06T09:40:00Z","runId":"r","stepId":"b","failure":{"reason":"command-failed","detail":"npm test exited 1","recoverable":true}}',
      '{"t":"run.finished","at":"2026-09-06T09:40:01Z","runId":"r","status":"failed"}',
    ].join("\n");
    const r = classifyRun({ ...base, journal, mtimeMs: NOW.getTime() });
    expect(r.runClass).toBe("failed");
    expect(r.terminalFailure).toEqual({
      reason: "command-failed",
      detail: "npm test exited 1",
      recoverable: true,
    });
  });

  test("failed run with no parseable failure → terminalFailure null", () => {
    const r = classifyRun({
      ...base,
      journal: `${started("r")}\n${finished("failed")}`,
      mtimeMs: NOW.getTime(),
    });
    expect(r.terminalFailure).toBeNull();
  });
});

// ── prStateFrom ─────────────────────────────────────────────────────

describe("prStateFrom", () => {
  test("maps every gh PR shape", () => {
    expect(prStateFrom(null)).toBe("missing");
    expect(prStateFrom({ state: "OPEN", mergedAt: null })).toBe("open");
    expect(
      prStateFrom({ state: "MERGED", mergedAt: "2026-09-07T00:00:00Z" }),
    ).toBe("merged");
    expect(
      prStateFrom({ state: "CLOSED", mergedAt: "2026-09-07T00:00:00Z" }),
    ).toBe("merged");
    expect(prStateFrom({ state: "CLOSED", mergedAt: null })).toBe(
      "closed-unmerged",
    );
  });
});

// ── linkMarkers ─────────────────────────────────────────────────────

describe("linkMarkers", () => {
  const scan = (
    number: number,
    runIds: string[],
    held = false,
  ): MarkerScan => ({
    number,
    held,
    markers: runIds.map((runId) => ({
      runId,
      branch: `yak/${runId}`,
      launched: "",
    })),
  });

  test("first-seen wins for runToIssue; issueToRun is last-marker", () => {
    const r = linkMarkers([scan(10, ["a", "b"]), scan(11, ["c"])]);
    expect(r.runToIssue).toEqual({ a: 10, b: 10, c: 11 });
    expect(r.issueToRun).toEqual({ 10: "b", 11: "c" });
    expect(r.runIdToBranch.b).toBe("yak/b");
  });

  test("a run id on two issues → a linkage fault, first owner kept", () => {
    const r = linkMarkers([scan(10, ["x"]), scan(11, ["x"])]);
    expect(r.runToIssue.x).toBe(10);
    expect(r.faults).toEqual([{ runId: "x", issues: [10, 11] }]);
  });

  test("held issue contributes to runToIssue (orphan suppression) but not issueToRun", () => {
    const r = linkMarkers([scan(16, ["h"], true)]);
    expect(r.runToIssue).toEqual({ h: 16 });
    expect(r.issueToRun).toEqual({});
  });
});

// ── findOrphans / findStaleMarkers ──────────────────────────────────

describe("findOrphans", () => {
  const run = (id: string, cls: RunObservation["class"]): RunObservation => ({
    id,
    class: cls,
    lastEventAt: null,
    journalMtimeMs: null,
    terminalFailure: null,
    pr: null,
  });

  test("unmarked run dirs become orphans; live iff not ok/failed", () => {
    const orphans = findOrphans(
      [
        run("a", "alive"),
        run("s", "stalled"),
        run("k", "ok"),
        run("f", "failed"),
        run("m", "alive"),
      ],
      [],
      new Set(["m"]),
      new Set(["a", "s", "k", "f", "m"]),
    );
    expect(orphans).toEqual([
      { runId: "a", class: "alive", live: true, recovery: null },
      { runId: "s", class: "stalled", live: true, recovery: null },
      { runId: "k", class: "ok", live: false, recovery: null },
      { runId: "f", class: "failed", live: false, recovery: null },
    ]);
  });

  test("a run with a recovery breadcrumb carries the issue + launch time", () => {
    const orphans = findOrphans(
      [run("a", "alive")],
      [],
      new Set(),
      new Set(["a"]),
      new Map([["a", { issue: 42, launchedAt: "2026-09-06T09:00:00Z" }]]),
    );
    expect(orphans[0]?.recovery).toEqual({
      issue: 42,
      launchedAt: "2026-09-06T09:00:00Z",
    });
  });

  test("a pending entry with no marker and no run dir → pending-only orphan", () => {
    const orphans = findOrphans(
      [],
      [{ runId: "ghost", steps: [] }],
      new Set(),
      new Set(),
    );
    expect(orphans).toEqual([
      { runId: "ghost", class: "pending-only", live: true, recovery: null },
    ]);
  });

  test("a pending entry that has a run dir is not double-counted", () => {
    const orphans = findOrphans(
      [run("g", "suspended")],
      [{ runId: "g", steps: [] }],
      new Set(),
      new Set(["g"]),
    );
    expect(orphans.map((o) => o.runId)).toEqual(["g"]);
  });
});

describe("findStaleMarkers", () => {
  test("issue whose current run has no dir, carrying the observed status", () => {
    const issues = [
      { number: 14, currentRunId: "gone", status: "running" },
      { number: 15, currentRunId: "here", status: "running" },
      { number: 16, currentRunId: null, status: null },
    ] as Parameters<typeof findStaleMarkers>[0];
    expect(findStaleMarkers(issues, new Set(["here"]))).toEqual([
      { issueNumber: 14, runId: "gone", status: "running" },
    ]);
  });
});

// ── observe (end to end over the fixture tree) ──────────────────────

describe("observe", () => {
  let obs: Observation;
  beforeAll(() => {
    obs = observe(CONFIG, fixtureDeps());
  });

  test("returns every Observation section", () => {
    expect(Object.keys(obs).sort()).toEqual(
      [
        "issues",
        "issueToRun",
        "linkageFaults",
        "orphans",
        "pending",
        "runToIssue",
        "runs",
        "stale",
        "maxConcurrent",
        "launchBreadcrumbs",
        "gatesPosted",
        "gateReplies",
      ].sort(),
    );
  });

  test("pre-launch issue #10 (yak only, no marker) is the ∅ state", () => {
    expect(obs.issues.find((i) => i.number === 10)).toMatchObject({
      qualifying: true,
      status: null,
      fault: null,
      currentRunId: null,
      attemptCount: 0,
    });
  });

  test("yak:hold issue #16 is absent from issues[] but its run is not an orphan", () => {
    expect(obs.issues.find((i) => i.number === 16)).toBeUndefined();
    expect(obs.runToIssue["run-held"]).toBe(16);
    expect(obs.orphans.find((o) => o.runId === "run-held")).toBeUndefined();
  });

  test("issue #15 with two status labels is flagged, not crashed", () => {
    expect(obs.issues.find((i) => i.number === 15)).toMatchObject({
      status: null,
      fault: expect.stringMatching(/two yak:<status>/),
    });
  });

  test("marker linkage: last-wins current run + distinct-launch attempt count", () => {
    expect(obs.issues.find((i) => i.number === 17)).toMatchObject({
      attemptCount: 2,
      currentRunId: "run-failed",
    });
    expect(obs.issueToRun[17]).toBe("run-failed");
    expect(obs.runToIssue["run-ok-no-pr"]).toBe(17);
    expect(obs.runToIssue["run-failed"]).toBe(17);
  });

  test("a re-quoted marker does not inflate the attempt count", () => {
    // #19 has the same run marker twice — one launch, not two.
    expect(obs.issues.find((i) => i.number === 19)).toMatchObject({
      attemptCount: 1,
      currentRunId: "run-dup",
    });
  });

  test("a run id claimed by two issues is a linkage fault on both", () => {
    expect(obs.linkageFaults).toContainEqual({
      runId: "run-shared",
      issues: [20, 21],
    });
    for (const n of [20, 21]) {
      expect(obs.issues.find((i) => i.number === n)?.fault).toMatch(
        /claimed by issues 20, 21/,
      );
    }
  });

  test("each run class is classified from its fixture journal", () => {
    const byId = Object.fromEntries(obs.runs.map((r) => [r.id, r.class]));
    expect(byId).toMatchObject({
      "run-alive": "alive",
      "run-suspended": "suspended",
      "run-ok-pr-open": "ok",
      "run-failed": "failed",
    });
  });

  test("stalled is derived purely from journal mtime vs stalledAfterMinutes", () => {
    expect(
      observe(CONFIG, fixtureDeps()).runs.find((r) => r.id === "run-stalled")
        ?.class,
    ).toBe("alive");
    expect(
      observe(
        CONFIG,
        fixtureDeps({
          mtimeOverrides: { "run-stalled": NOW.getTime() - 46 * 60_000 },
        }),
      ).runs.find((r) => r.id === "run-stalled")?.class,
    ).toBe("stalled");
  });

  test("PR state resolved only for ok runs", () => {
    const byId = Object.fromEntries(obs.runs.map((r) => [r.id, r.pr]));
    expect(byId["run-ok-pr-open"]).toBe("open");
    expect(byId["run-ok-pr-merged"]).toBe("merged");
    expect(byId["run-ok-closed"]).toBe("closed-unmerged");
    expect(byId["run-ok-no-pr"]).toBe("missing");
    expect(byId["run-alive"]).toBeNull();
  });

  test("orphans: unmarked run dir + pending-only entry", () => {
    const byId = Object.fromEntries(obs.orphans.map((o) => [o.runId, o]));
    expect(byId["run-orphan"]).toEqual({
      runId: "run-orphan",
      class: "alive",
      live: true,
      recovery: null,
    });
    expect(byId["run-ghost"]).toEqual({
      runId: "run-ghost",
      class: "pending-only",
      live: true,
      recovery: null,
    });
    expect(byId["run-alive"]).toBeUndefined();
  });

  test("a run breadcrumb re-links an orphan for recovery (spec §5.5)", () => {
    const recovered = observe(
      CONFIG,
      fixtureDeps({
        runBreadcrumbs: [
          {
            runId: "run-orphan",
            issue: 99,
            launchedAt: "2026-09-06T08:00:00Z",
          },
        ],
      }),
    );
    expect(
      recovered.orphans.find((o) => o.runId === "run-orphan")?.recovery,
    ).toEqual({ issue: 99, launchedAt: "2026-09-06T08:00:00Z" });
  });

  test("once the recovery marker is reposted, the run is no longer an orphan (E is idempotent)", () => {
    // Simulates the tick *after* `apply` reposted the lost marker for
    // `run-orphan` onto issue #10: the marker now links the run, so this
    // observation must not re-flag it or re-plan E (spec §5.5, criterion 5).
    const base = fixtureDeps();
    const afterRecovery = observe(CONFIG, {
      ...base,
      listComments: (n) =>
        n === 10
          ? [
              {
                body: "🐂 yak run started: `run-orphan`\n<!-- yak-harness run=run-orphan branch=yak/run-orphan launched=2026-09-06T08:00:00Z -->",
                authorAssociation: "NONE",
                createdAt: "",
              },
            ]
          : (base.listComments(n) ?? []),
    });

    expect(
      afterRecovery.orphans.find((o) => o.runId === "run-orphan"),
    ).toBeUndefined();
    expect(afterRecovery.runToIssue["run-orphan"]).toBe(10);
  });

  test("stale: issue #14's marker points at a run with no .runs/ dir", () => {
    expect(obs.stale).toContainEqual({
      issueNumber: 14,
      runId: "run-missing",
      status: "running",
    });
  });

  test("pending exposes step kind + first rendered line only", () => {
    expect(
      obs.pending.find((p) => p.runId === "run-suspended")?.steps[0],
    ).toEqual({
      stepId: "confirm-scope",
      kind: "gate",
      renderedFirstLine:
        "Triage thinks this is a bug in the retry backoff (confidence 0.71).",
    });
  });

  test("an issue whose comments cannot be read is faulted, not fatal", () => {
    const withUnreadable = observe(CONFIG, {
      ...fixtureDeps(),
      listComments: (n) => (n === 11 ? null : []),
    });
    expect(withUnreadable.issues.find((i) => i.number === 11)?.fault).toMatch(
      /could not be read/,
    );
  });

  test("a quiet backlog produces empty sections", () => {
    const quiet = observe(CONFIG, {
      ...fixtureDeps(),
      listIssues: () => [],
      yakPending: () => [],
      listRunDirs: () => [],
    });
    expect(quiet).toMatchObject({
      issues: [],
      runs: [],
      orphans: [],
      stale: [],
      linkageFaults: [],
    });
  });
});
