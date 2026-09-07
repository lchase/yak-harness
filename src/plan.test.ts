import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type {
  IssueObservation,
  Observation,
  RunObservation,
} from "./observe.js";
import { type Action, deriveObserved, plan } from "./plan.js";

// ── builders (plain literals — `plan` needs no mocks) ────────────────

const issue = (
  o: Partial<IssueObservation> & { number: number },
): IssueObservation => ({
  title: `issue ${o.number}`,
  qualifying: true,
  status: null,
  fault: null,
  markers: [],
  currentRunId: null,
  attemptCount: 0,
  ...o,
});

/** An issue that already launched run `runId` (one marker), at `status`. */
const linked = (
  number: number,
  runId: string,
  status: IssueObservation["status"],
): IssueObservation =>
  issue({
    number,
    status,
    currentRunId: runId,
    attemptCount: 1,
    markers: [
      { runId, branch: `yak/${runId}`, launched: "2026-01-01T00:00:00Z" },
    ],
  });

const run = (
  o: Partial<RunObservation> & { id: string; class: RunObservation["class"] },
): RunObservation => ({
  lastEventAt: null,
  journalMtimeMs: null,
  terminalFailure: null,
  pr: o.class === "ok" ? "open" : null,
  ...o,
});

const obs = (o: Partial<Observation>): Observation => ({
  issues: [],
  runs: [],
  pending: [],
  maxConcurrent: 2,
  launchBreadcrumbs: [],
  gatesPosted: [],
  gateReplies: [],
  runToIssue: {},
  issueToRun: {},
  orphans: [],
  stale: [],
  linkageFaults: [],
  escalated: [],
  ...o,
});

const orphan = (
  o: Partial<import("./observe.js").Orphan> & {
    runId: string;
    class: import("./observe.js").Orphan["class"];
    live: boolean;
  },
): import("./observe.js").Orphan => ({ recovery: null, ...o });

const kinds = (actions: Action[]): string[] => actions.map((a) => a.kind);

// ── deriveObserved ──────────────────────────────────────────────────

describe("deriveObserved", () => {
  test("no marker → none", () => {
    expect(deriveObserved(issue({ number: 1 }), obs({}))).toBe("none");
  });

  test("marker but no run dir → terminal-bad (stale)", () => {
    expect(
      deriveObserved(linked(1, "gone", "running"), obs({ runs: [] })),
    ).toBe("terminal-bad");
  });

  test("ok run splits by PR disposition", () => {
    for (const [pr, expected] of [
      ["open", "ok-pr-open"],
      ["merged", "ok-pr-merged"],
      ["closed-unmerged", "ok-pr-closed"],
      ["missing", "ok-no-pr"],
    ] as const) {
      expect(
        deriveObserved(
          linked(1, "r", "running"),
          obs({ runs: [run({ id: "r", class: "ok", pr })] }),
        ),
      ).toBe(expected);
    }
  });

  test("stalled collapses to terminal-bad", () => {
    expect(
      deriveObserved(
        linked(1, "r", "running"),
        obs({ runs: [run({ id: "r", class: "stalled" })] }),
      ),
    ).toBe("terminal-bad");
  });
});

// ── plan: quiet / basic ─────────────────────────────────────────────

describe("plan", () => {
  test("a quiet backlog produces no actions", () => {
    expect(plan(obs({}))).toEqual([]);
  });

  test("∅ qualifying issue with a free slot → one launch-run", () => {
    const actions = plan(obs({ issues: [issue({ number: 1 })] }));
    expect(actions).toEqual([
      {
        kind: "launch-run",
        issue: 1,
        to: "running",
        guard: {
          inFlightCount: 0,
          maxConcurrent: 2,
          noMarkerComment: true,
          noLaunchBreadcrumb: true,
        },
      },
    ]);
  });

  test("a non-qualifying ∅ issue is never launched", () => {
    expect(
      plan(obs({ issues: [issue({ number: 1, qualifying: false })] })),
    ).toEqual([]);
  });

  test("an in-flight issue still gets label transitions after the qualifying label is dropped", () => {
    const i = { ...linked(1, "r", "running"), qualifying: false };
    const actions = plan(
      obs({ issues: [i], runs: [run({ id: "r", class: "ok", pr: "open" })] }),
    );
    expect(actions).toEqual([
      {
        kind: "relabel",
        issue: 1,
        from: "running",
        to: "pr-open",
        runId: "r",
        escalate: false,
        guard: { currentStatus: "running" },
      },
    ]);
  });

  test("two `yak:<status>` labels (fault) → the issue produces nothing", () => {
    const faulted = issue({
      number: 1,
      status: "running",
      fault: "two yak:<status> labels (running, waiting) — harness fault",
      currentRunId: "r",
      markers: [{ runId: "r", branch: "b", launched: "t" }],
    });
    expect(
      plan(
        obs({
          issues: [faulted],
          runs: [run({ id: "r", class: "ok", pr: "open" })],
        }),
      ),
    ).toEqual([]);
  });
});

// ── plan: the cap (spec §6.3) ───────────────────────────────────────

describe("plan — launch cap", () => {
  test("at most one launch per tick even with many free slots", () => {
    const actions = plan(
      obs({
        maxConcurrent: 5,
        issues: [
          issue({ number: 1 }),
          issue({ number: 2 }),
          issue({ number: 3 }),
        ],
      }),
    );
    expect(kinds(actions)).toEqual(["launch-run"]);
    expect((actions[0] as { issue: number }).issue).toBe(1);
  });

  test("a suspended run counts toward in_flight_count and can fill the cap", () => {
    const actions = plan(
      obs({
        maxConcurrent: 1,
        issues: [linked(1, "r1", "waiting"), issue({ number: 2 })],
        runs: [run({ id: "r1", class: "suspended" })],
      }),
    );
    expect(kinds(actions)).not.toContain("launch-run");
  });

  test("an in-progress launch breadcrumb blocks a second launch for that issue", () => {
    const actions = plan(
      obs({ issues: [issue({ number: 1 })], launchBreadcrumbs: [1] }),
    );
    expect(actions).toEqual([]);
  });

  test("an already-marked issue is never re-launched off the ∅ cell", () => {
    // marker present, run dir gone → stale → relabel to failed, no launch
    const actions = plan(
      obs({
        issues: [
          issue({
            number: 1,
            currentRunId: "gone",
            markers: [{ runId: "gone", branch: "b", launched: "t" }],
          }),
        ],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
    expect(actions[0]).toMatchObject({ to: "failed", escalate: true });
  });
});

// ── plan: precedence (spec §6.3) ────────────────────────────────────

describe("plan — precedence", () => {
  test("a live orphan is flagged and suppresses D this tick", () => {
    const actions = plan(
      obs({
        issues: [issue({ number: 1 })],
        orphans: [orphan({ runId: "x", class: "alive", live: true })],
      }),
    );
    expect(kinds(actions)).toEqual(["flag-orphan"]);
  });

  test("a finished (non-live) orphan is flagged but does not suppress D", () => {
    const actions = plan(
      obs({
        issues: [issue({ number: 1 })],
        orphans: [orphan({ runId: "x", class: "failed", live: false })],
      }),
    );
    expect(kinds(actions)).toEqual(["flag-orphan", "launch-run"]);
  });

  test("E, then B, then A, then C, then D", () => {
    const actions = plan(
      obs({
        maxConcurrent: 5,
        issues: [
          linked(1, "r1", "waiting"), // B — a valid reply is in
          linked(2, "r2", "waiting"), // A — a fresh gate to surface
          linked(3, "r3", "running"), // C — run finished ok, PR open
          issue({ number: 4 }), // D — a fresh backlog launch
        ],
        runs: [
          run({ id: "r1", class: "suspended" }),
          run({ id: "r2", class: "suspended" }),
          run({ id: "r3", class: "ok", pr: "open" }),
        ],
        pending: [
          {
            runId: "r2",
            steps: [{ stepId: "s2", kind: "gate", renderedFirstLine: "…" }],
          },
        ],
        gateReplies: [
          {
            issue: 1,
            runId: "r1",
            stepId: "s1",
            answer: { decision: "proceed" },
          },
        ],
        orphans: [orphan({ runId: "orph", class: "failed", live: false })], // E, non-live
      }),
    );
    expect(kinds(actions)).toEqual([
      "flag-orphan",
      "write-answer-and-resume",
      "post-gate-comment",
      "relabel",
      "launch-run",
    ]);
    expect(actions[3]).toMatchObject({ issue: 3, to: "pr-open" });
  });

  test("A is skipped when the gate comment is already posted", () => {
    const actions = plan(
      obs({
        issues: [linked(2, "r2", "waiting")],
        runs: [run({ id: "r2", class: "suspended" })],
        pending: [
          {
            runId: "r2",
            steps: [{ stepId: "s2", kind: "gate", renderedFirstLine: "…" }],
          },
        ],
        gatesPosted: ["r2\ts2"],
      }),
    );
    expect(kinds(actions)).toEqual([]);
  });
});

// ── §9.1 auto-retry + §9.4 escalation ───────────────────────────────

const failure = (recoverable: boolean) => ({
  reason: recoverable ? "command-failed" : "tool-denied",
  detail: "npm test exited 1",
  recoverable,
});

describe("plan — §9.1 retry", () => {
  test("recoverable failure, 1 marker → a fresh retry launch, no relabel", () => {
    const i = linked(1, "r1", "running");
    const actions = plan(
      obs({
        issues: [i],
        runs: [
          run({ id: "r1", class: "failed", terminalFailure: failure(true) }),
        ],
      }),
    );
    expect(kinds(actions)).toEqual(["launch-run"]);
    expect(actions[0]).toMatchObject({
      kind: "launch-run",
      issue: 1,
      retry: { failedRunId: "r1", from: "running", attempt: 2 },
    });
  });

  test("recoverable failure, 2 markers (cap hit) → relabel to failed, no retry", () => {
    const i = {
      ...linked(1, "r2", "running"),
      attemptCount: 2,
      markers: [
        { runId: "r1", branch: "b", launched: "t" },
        { runId: "r2", branch: "b", launched: "t" },
      ],
    };
    const actions = plan(
      obs({
        issues: [i],
        runs: [
          run({ id: "r2", class: "failed", terminalFailure: failure(true) }),
        ],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
    expect(actions[0]).toMatchObject({ to: "failed", escalate: true });
    expect(
      (actions[0] as { escalation: { tried: string } }).escalation.tried,
    ).toMatch(/attempt 2 of 2/);
  });

  test("non-recoverable failure → straight to yak:failed, escalation names the reason", () => {
    const actions = plan(
      obs({
        issues: [linked(1, "r1", "running")],
        runs: [
          run({ id: "r1", class: "failed", terminalFailure: failure(false) }),
        ],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
    expect(
      (actions[0] as { escalation: { tried: string } }).escalation.tried,
    ).toMatch(/tool-denied.*not recoverable/);
  });

  test("ok run with no PR → yak:failed with the produced-no-PR reason, not retried", () => {
    const actions = plan(
      obs({
        issues: [linked(1, "r1", "running")],
        runs: [run({ id: "r1", class: "ok", pr: "missing" })],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
    const esc = (actions[0] as { escalation: { broke: string; tried: string } })
      .escalation;
    expect(esc.broke).toMatch(/produced no PR/);
    expect(esc.tried).toMatch(/not a failure/);
  });

  test("a retry counts against the cap like any launch", () => {
    const actions = plan(
      obs({
        maxConcurrent: 1,
        issues: [
          linked(1, "r1", "running"), // failed, retry wants a slot
          linked(2, "r2", "waiting"), // suspended → fills the cap
        ],
        runs: [
          run({ id: "r1", class: "failed", terminalFailure: failure(true) }),
          run({ id: "r2", class: "suspended" }),
        ],
      }),
    );
    expect(kinds(actions)).not.toContain("launch-run");
  });

  test("escalation is suppressed when a yak-failed comment already exists", () => {
    const actions = plan(
      obs({
        issues: [linked(1, "r1", "running")],
        runs: [
          run({ id: "r1", class: "failed", terminalFailure: failure(false) }),
        ],
        escalated: ["r1"],
      }),
    );
    expect(actions[0]).toMatchObject({ to: "failed", escalate: false });
    expect((actions[0] as { escalation?: unknown }).escalation).toBeUndefined();
  });

  test("an in-progress launch breadcrumb holds the move into yak:failed (no premature escalation)", () => {
    const actions = plan(
      obs({
        issues: [linked(1, "r1", "running")],
        runs: [
          run({ id: "r1", class: "failed", terminalFailure: failure(false) }),
        ],
        launchBreadcrumbs: [1],
      }),
    );
    expect(actions).toEqual([]);
  });

  test("a stalled run escalates with the never-retries reason", () => {
    const actions = plan(
      obs({
        issues: [linked(1, "r1", "running")],
        runs: [run({ id: "r1", class: "stalled" })],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
    const esc = (actions[0] as { escalation: { broke: string; tried: string } })
      .escalation;
    expect(esc.broke).toMatch(/stalled/);
    expect(esc.tried).toMatch(/never retry/);
  });

  test("a failed run with no terminal StepFailure still escalates (not retried)", () => {
    const actions = plan(
      obs({
        issues: [linked(1, "r1", "running")],
        runs: [run({ id: "r1", class: "failed", terminalFailure: null })],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
    expect(
      (actions[0] as { escalation: { broke: string } }).escalation.broke,
    ).toMatch(/no terminal StepFailure/);
  });

  test("a retry beats a backlog launch for the single per-tick slot", () => {
    const actions = plan(
      obs({
        maxConcurrent: 2,
        issues: [
          issue({ number: 1 }), // backlog D
          linked(2, "r2", "running"), // recoverable failure → retry
        ],
        runs: [
          run({ id: "r2", class: "failed", terminalFailure: failure(true) }),
        ],
      }),
    );
    expect(kinds(actions)).toEqual(["launch-run"]);
    expect(actions[0]).toMatchObject({ issue: 2, retry: { attempt: 2 } });
  });

  test("retry pre-empts relabel only while the issue keeps the qualifying label", () => {
    const i = { ...linked(1, "r1", "running"), qualifying: false };
    const actions = plan(
      obs({
        issues: [i],
        runs: [
          run({ id: "r1", class: "failed", terminalFailure: failure(true) }),
        ],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
    expect(actions[0]).toMatchObject({ to: "failed" });
  });
});

// ── CLAUDE.md invariant 4: no label strings in `plan` ────────────────

test("no `yak:` literal string appears in plan's body", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./plan.ts", import.meta.url)),
    "utf8",
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  expect(code).not.toContain("yak:");
});
