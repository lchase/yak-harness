import { describe, expect, test } from "vitest";
import { type ApplyDeps, apply, branchForRun, renderInput } from "./apply.js";
import type { Config } from "./config.js";
import type { Action } from "./plan.js";

const CONFIG: Config = {
  repo: "lchase/yak-harness",
  yakRepoPath: "/srv/yak",
  runsDir: "/srv/yak/.runs",
  qualifyingLabel: "yak",
  stalledAfterMinutes: 45,
  maxConcurrent: 2,
  workflow: "implement-change",
  inputTemplate: "issueRef={{repo}}#{{number}}",
};

const startedJournal = (
  runId: string,
  at = "2026-09-06T09:00:01Z",
  workflow = "implement-change",
): string =>
  JSON.stringify({
    t: "run.started",
    at,
    runId,
    workflow,
    inputHash: "h",
    adapter: "claude",
    isolation: "worktree",
  });

interface FakeOpts {
  initialRunDirs?: string[];
  /** Dirs that appear in `listRunDirs` the moment `spawnRun` is called. */
  newDirsOnSpawn?: string[];
  journals?: Record<string, string>;
  pid?: number;
}

function fake(opts: FakeOpts = {}) {
  const calls: string[] = [];
  let runDirs = [...(opts.initialRunDirs ?? [])];
  let nowMs = Date.parse("2026-09-06T09:00:00Z");
  const journals = opts.journals ?? {
    "run-new": startedJournal("run-new"),
  };

  const deps: ApplyDeps = {
    now: () => new Date(nowMs),
    listRunDirs: () => [...runDirs],
    spawnRun: (i) => {
      calls.push(`spawn ${i.workflow} :: ${i.input}`);
      runDirs = [...runDirs, ...(opts.newDirsOnSpawn ?? ["run-new"])];
      return { pid: opts.pid ?? 4242 };
    },
    readJournal: (id) => journals[id] ?? null,
    sleep: (ms) => {
      nowMs += ms;
    },
    writeBreadcrumb: (name, data) =>
      calls.push(`write ${name} ${JSON.stringify(data)}`),
    removeBreadcrumb: (name) => calls.push(`remove ${name}`),
    postComment: (issue, body) =>
      calls.push(`comment #${issue} :: ${body.split("\n").pop()}`),
    addLabel: (issue, label) => calls.push(`+label #${issue} ${label}`),
    removeLabel: (issue, label) => calls.push(`-label #${issue} ${label}`),
  };

  return { deps, calls };
}

const launch = (issue: number): Action => ({
  kind: "launch-run",
  issue,
  to: "running",
  guard: {
    inFlightCount: 0,
    maxConcurrent: 2,
    noMarkerComment: true,
    noLaunchBreadcrumb: true,
  },
});

// ── renderInput ─────────────────────────────────────────────────────

describe("renderInput", () => {
  test("substitutes {{repo}} and {{number}} (with/without inner spaces)", () => {
    expect(renderInput("issueRef={{repo}}#{{ number }}", "o/r", 12)).toBe(
      "issueRef=o/r#12",
    );
  });
});

// ── D: launch ───────────────────────────────────────────────────────

describe("apply — launch (D)", () => {
  test("happy path: breadcrumb → spawn → resolve id → pid file → marker → label", () => {
    const { deps, calls } = fake();
    const result = apply([launch(1)], CONFIG, deps);

    expect(result.aborted).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(calls).toEqual([
      'write launching-1.json {"issue":1,"launchedAt":"2026-09-06T09:00:00.000Z"}',
      "spawn implement-change :: issueRef=lchase/yak-harness#1",
      'write run-new.json {"pid":4242,"issue":1,"launchedAt":"2026-09-06T09:00:00.000Z"}',
      "comment #1 :: <!-- yak-harness run=run-new branch=yak/run-new launched=2026-09-06T09:00:00.000Z -->",
      "remove launching-1.json",
      "+label #1 yak:running",
    ]);
  });

  test("no new run dir before the timeout → abort, nothing published", () => {
    const { deps, calls } = fake({ newDirsOnSpawn: [] });
    const result = apply([launch(1)], CONFIG, deps);

    expect(result.aborted).toBe(true);
    expect(result.errors[0]).toMatch(/no new run dir/);
    expect(calls.some((c) => c.startsWith("comment"))).toBe(false);
    expect(calls.some((c) => c.startsWith("+label"))).toBe(false);
    expect(calls).toContain(
      "write launching-1.json " +
        '{"issue":1,"launchedAt":"2026-09-06T09:00:00.000Z"}',
    );
  });

  test("two new run dirs at once → abort (cannot disambiguate)", () => {
    const { deps } = fake({ newDirsOnSpawn: ["run-a", "run-b"] });
    const result = apply([launch(1)], CONFIG, deps);
    expect(result.aborted).toBe(true);
    expect(result.errors[0]).toMatch(/2 new run dirs/);
  });

  test("a pre-existing dir is ignored — only the post-spawn delta counts", () => {
    const { deps, calls } = fake({
      initialRunDirs: ["run-old"],
      newDirsOnSpawn: ["run-new"],
    });
    const result = apply([launch(1)], CONFIG, deps);
    expect(result.aborted).toBe(false);
    expect(calls).toContain("+label #1 yak:running");
  });

  test("journal has no run.started first event → abort", () => {
    const { deps, calls } = fake({ journals: {} });
    const result = apply([launch(1)], CONFIG, deps);
    expect(result.aborted).toBe(true);
    expect(result.errors[0]).toMatch(/no run\.started/);
    // pid file / marker / label never happen; launching breadcrumb stays.
    expect(calls.some((c) => c.startsWith("comment"))).toBe(false);
    expect(calls).not.toContain("remove launching-1.json");
  });

  test("journal run.started names a different workflow → abort", () => {
    const { deps } = fake({
      journals: {
        "run-new": startedJournal("run-new", "2026-09-06T09:00:01Z", "other"),
      },
    });
    const result = apply([launch(1)], CONFIG, deps);
    expect(result.aborted).toBe(true);
    expect(result.errors[0]).toMatch(/expected implement-change/);
  });

  test("run.started timestamp far in the past → abort (diffed into a stale dir)", () => {
    const { deps } = fake({
      journals: {
        "run-new": startedJournal("run-new", "2025-01-01T00:00:00Z"),
      },
    });
    const result = apply([launch(1)], CONFIG, deps);
    expect(result.aborted).toBe(true);
    expect(result.errors[0]).toMatch(/outside the tick window/);
  });

  test("a path-unsafe resolved run id → abort before any publish", () => {
    const { deps, calls } = fake({
      newDirsOnSpawn: ["../evil"],
      journals: { "../evil": startedJournal("../evil") },
    });
    const result = apply([launch(1)], CONFIG, deps);
    expect(result.aborted).toBe(true);
    expect(result.errors[0]).toMatch(/not a safe id/);
    expect(calls.some((c) => c.startsWith("comment"))).toBe(false);
  });

  test("a §9.1 retry launch: same flow, plus it reports the attempt", () => {
    const { deps, calls } = fake();
    const retry: Action = {
      kind: "launch-run",
      issue: 1,
      to: "running",
      retry: { failedRunId: "r1", from: "running", attempt: 2 },
      guard: {
        inFlightCount: 0,
        maxConcurrent: 2,
        noLaunchBreadcrumb: true,
        recoverableFailure: true,
        attemptCount: 1,
      },
    };
    const result = apply([retry], CONFIG, deps);
    expect(result.aborted).toBe(false);
    // from === to === running → no spurious -label
    expect(calls).not.toContain("-label #1 yak:running");
    expect(calls).toContain("+label #1 yak:running");
    expect(result.applied[0]).toMatch(
      /retry attempt 2 \(was r1\) run run-new for #1/,
    );
  });

  test("a retry from yak:waiting moves the status label off waiting", () => {
    const { deps, calls } = fake();
    const retry: Action = {
      kind: "launch-run",
      issue: 1,
      to: "running",
      retry: { failedRunId: "r1", from: "waiting", attempt: 2 },
      guard: {
        inFlightCount: 0,
        maxConcurrent: 2,
        noLaunchBreadcrumb: true,
        recoverableFailure: true,
        attemptCount: 1,
      },
    };
    apply([retry], CONFIG, deps);
    expect(calls).toContain("+label #1 yak:running");
    expect(calls).toContain("-label #1 yak:waiting");
  });

  test("at most one launch per tick — a second launch action is refused", () => {
    const { deps, calls } = fake();
    const result = apply([launch(1), launch(2)], CONFIG, deps);
    expect(result.applied).toHaveLength(1);
    expect(result.errors[0]).toMatch(/second launch/);
    expect(calls.filter((c) => c.startsWith("spawn"))).toHaveLength(1);
  });
});

// ── C: relabel ──────────────────────────────────────────────────────

describe("apply — relabel (C)", () => {
  const relabel = (o: Partial<Action> & { issue: number }): Action =>
    ({
      kind: "relabel",
      from: "running",
      to: "pr-open",
      runId: "r1",
      escalate: false,
      guard: { currentStatus: "running" },
      ...o,
    }) as Action;

  test("moves the single yak:<status> label: remove old, add new", () => {
    const { deps, calls } = fake();
    const result = apply([relabel({ issue: 7 })], CONFIG, deps);
    expect(result.applied).toEqual(["relabelled #7: running → pr-open"]);
    expect(calls).toEqual(["-label #7 yak:running", "+label #7 yak:pr-open"]);
  });

  test("from ∅ (marker recovery) → only adds a label", () => {
    const { deps, calls } = fake();
    apply(
      [
        relabel({
          issue: 7,
          from: "none",
          to: "running",
          guard: { currentStatus: "none" },
        }),
      ],
      CONFIG,
      deps,
    );
    expect(calls).toEqual(["+label #7 yak:running"]);
  });

  test("escalate → posts the one §9.4 comment (before the label move), then moves the label", () => {
    const { deps, calls } = fake();
    const result = apply(
      [
        relabel({
          issue: 7,
          to: "failed",
          escalate: true,
          escalation: {
            broke: "command-failed: boom",
            tried: "attempt 2 of 2",
          },
        }),
      ],
      CONFIG,
      deps,
    );
    expect(calls).toEqual([
      "comment #7 :: <!-- yak-failed run=r1 -->",
      "-label #7 yak:running",
      "+label #7 yak:failed",
    ]);
    expect(result.applied[0]).toMatch(
      /§9\.4 escalation comment on #7 for run r1/,
    );
  });

  test("escalate:false → label moves, no comment (a prior tick already escalated)", () => {
    const { deps, calls } = fake();
    apply([relabel({ issue: 7, to: "failed", escalate: false })], CONFIG, deps);
    expect(calls).toEqual(["-label #7 yak:running", "+label #7 yak:failed"]);
  });
});

// ── E: orphan / stale-marker flagging (spec §5.5) ───────────────────

describe("apply — flag-orphan (E)", () => {
  const orphan = (o: Partial<Action> & { runId: string }): Action =>
    ({
      kind: "flag-orphan",
      orphanClass: "alive",
      live: true,
      recovery: null,
      guard: { notAlreadyFlagged: true },
      ...o,
    }) as Action;

  test("recoverable → reposts the lost marker to the breadcrumb's issue", () => {
    const { deps, calls } = fake();
    const result = apply(
      [
        orphan({
          runId: "run-x",
          recovery: { issue: 8, launchedAt: "2026-09-06T09:00:00Z" },
        }),
      ],
      CONFIG,
      deps,
    );
    expect(result.aborted).toBe(false);
    expect(result.errors).toEqual([]);
    expect(calls).toEqual([
      "comment #8 :: <!-- yak-harness run=run-x branch=yak/run-x launched=2026-09-06T09:00:00Z -->",
    ]);
    expect(result.applied[0]).toMatch(/recovered orphan run run-x → #8/);
  });

  test("live + not recoverable → loud error, no side effect, not aborted", () => {
    const { deps, calls } = fake();
    const result = apply(
      [orphan({ runId: "run-x", orphanClass: "alive", live: true })],
      CONFIG,
      deps,
    );
    expect(result.aborted).toBe(false);
    expect(calls).toEqual([]);
    expect(result.errors[0]).toMatch(/LIVE ORPHAN run=run-x/);
  });

  test("already-terminal orphan → one note, tick carries on", () => {
    const { deps, calls } = fake();
    const result = apply(
      [orphan({ runId: "run-x", orphanClass: "failed", live: false })],
      CONFIG,
      deps,
    );
    expect(calls).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.notes[0]).toMatch(/orphan run run-x \(failed\).*ignoring/);
  });

  test("recovery breadcrumb with a path-unsafe run id → error, no comment", () => {
    const { deps, calls } = fake();
    const result = apply(
      [
        orphan({
          runId: "../evil",
          recovery: { issue: 8, launchedAt: "2026-09-06T09:00:00Z" },
        }),
      ],
      CONFIG,
      deps,
    );
    expect(calls).toEqual([]);
    expect(result.errors[0]).toMatch(/unsafe run id/);
  });
});

test("branchForRun is the deterministic worktree branch", () => {
  expect(branchForRun("2026-09-06T09-12-44Z-a1b2")).toBe(
    "yak/2026-09-06T09-12-44Z-a1b2",
  );
});
