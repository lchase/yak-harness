import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type {
  IssueObservation,
  Observation,
  RunObservation,
} from "./observe.js";
import { type Action, deriveObserved, formatDuration, plan } from "./plan.js";

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
  mtimeAgeMs: null,
  recordedPid: null,
  terminalFailure: null,
  pr: o.class === "ok" ? "open" : null,
  ...o,
});

const gateStep = (stepId: string) => ({
  stepId,
  kind: "gate",
  renderedFirstLine: "…",
  gate: {
    rendered: "Proceed with this scope, narrow it, or abort?",
    answerSchema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["proceed", "narrow", "abort"] },
      },
      required: ["decision"],
    } as Record<string, unknown>,
    schemaSha: "abc123",
    fields: [
      {
        name: "decision",
        kind: "enum" as const,
        required: true,
        members: ["proceed", "narrow", "abort"],
      },
    ],
    bridgeError: null,
  },
});

const obs = (o: Partial<Observation>): Observation => ({
  issues: [],
  runs: [],
  pending: [],
  maxConcurrent: 2,
  launchBreadcrumbs: [],
  gatesPosted: [],
  gateReplies: [],
  gateReprompts: [],
  gateFailures: [],
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

describe("formatDuration", () => {
  test("minutes under an hour, hours with and without remainder, unknown", () => {
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(192 * 60_000)).toBe("3h 12m");
    expect(formatDuration(null)).toBe("an unknown period");
    expect(formatDuration(-5)).toBe("an unknown period");
  });
});

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
            steps: [gateStep("s2")],
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
            steps: [gateStep("s2")],
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

  test("a stalled run relabels to failed with a kill directive + stall duration", () => {
    const actions = plan(
      obs({
        issues: [linked(1, "r1", "running")],
        runs: [
          run({
            id: "r1",
            class: "stalled",
            mtimeAgeMs: 46 * 60_000,
            recordedPid: 4242,
          }),
        ],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
    expect(actions[0]).toMatchObject({
      to: "failed",
      escalate: true,
      stall: { durationText: "46m", pid: 4242 },
    });
    // stall drives the comment in `apply`; `escalation` is not pre-composed.
    expect((actions[0] as { escalation?: unknown }).escalation).toBeUndefined();
  });

  test("a stalled run with no recorded pid still relabels — stall.pid is null", () => {
    const actions = plan(
      obs({
        issues: [linked(1, "r1", "running")],
        runs: [run({ id: "r1", class: "stalled", mtimeAgeMs: 3 * 3600_000 })],
      }),
    );
    expect(actions[0]).toMatchObject({
      to: "failed",
      stall: { durationText: "3h", pid: null },
    });
  });

  test("a stalled run never produces a retry launch", () => {
    const i = { ...linked(1, "r1", "running"), attemptCount: 1 };
    const actions = plan(
      obs({
        issues: [i],
        runs: [run({ id: "r1", class: "stalled", recordedPid: 5 })],
      }),
    );
    expect(kinds(actions)).toEqual(["relabel"]);
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

// ── gate bridge (spec §7) ──────────────────────────────────────────

describe("plan — gate bridge", () => {
  const suspended = (id: string) => run({ id, class: "suspended" });

  test("A: suspended run with an unposted flat gate → post-gate-comment with a generated body", () => {
    const [action] = plan(
      obs({
        issues: [linked(2, "r2", "waiting")],
        runs: [suspended("r2")],
        pending: [{ runId: "r2", steps: [gateStep("s2")] }],
      }),
    );
    expect(action).toMatchObject({
      kind: "post-gate-comment",
      issue: 2,
      runId: "r2",
      stepId: "s2",
      guard: { noGateCommentFor: "r2\ts2" },
    });
    const body = (action as { body: string }).body;
    expect(body).toContain("decision: proceed | narrow | abort");
    expect(body).toContain(
      "<!-- yak-gate run=r2 step=s2 schema-sha=abc123 -->",
    );
    expect(body).toContain("Proceed with this scope");
  });

  test("A: no post once the gate is in gatesPosted", () => {
    expect(
      kinds(
        plan(
          obs({
            issues: [linked(2, "r2", "waiting")],
            runs: [suspended("r2")],
            pending: [{ runId: "r2", steps: [gateStep("s2")] }],
            gatesPosted: ["r2\ts2"],
          }),
        ),
      ),
    ).toEqual([]);
  });

  test("A′: a gateReprompt → one post-gate-reprompt action naming the fault", () => {
    const [action] = plan(
      obs({
        issues: [linked(2, "r2", "waiting")],
        runs: [suspended("r2")],
        gateReprompts: [
          {
            issue: 2,
            runId: "r2",
            stepId: "s2",
            attempt: 1,
            faults: ["`decision` must be one of: proceed | narrow | abort"],
            fields: gateStep("s2").gate.fields,
          },
        ],
      }),
    );
    expect(action).toMatchObject({
      kind: "post-gate-reprompt",
      issue: 2,
      attempt: 1,
    });
    expect((action as { body: string }).body).toContain(
      "<!-- yak-gate-reprompt run=r2 step=s2 attempt=1 -->",
    );
  });

  test("gateFailure → relabel to failed with the hand-write escalation", () => {
    const [action] = plan(
      obs({
        issues: [linked(2, "r2", "waiting")],
        runs: [suspended("r2")],
        gateFailures: [
          {
            issue: 2,
            runId: "r2",
            stepId: "s2",
            broke: "answerSchema is nested",
          },
        ],
      }),
    );
    expect(action).toMatchObject({
      kind: "relabel",
      issue: 2,
      from: "waiting",
      to: "failed",
      escalate: true,
      gateFail: { stepId: "s2", broke: "answerSchema is nested" },
    });
  });

  test("two gateFailures on one issue → one relabel carrying both reasons", () => {
    const actions = plan(
      obs({
        issues: [linked(2, "r2", "waiting")],
        runs: [suspended("r2")],
        gateFailures: [
          { issue: 2, runId: "r2", stepId: "a", broke: "nested" },
          { issue: 2, runId: "r2", stepId: "b", broke: "unreadable" },
        ],
      }),
    );
    expect(actions).toHaveLength(1);
    expect((actions[0] as { gateFail: { broke: string } }).gateFail.broke).toBe(
      "nested; unreadable",
    );
  });

  test("gateFailure is idempotent once the yak-failed marker is up", () => {
    expect(
      kinds(
        plan(
          obs({
            issues: [linked(2, "r2", "waiting")],
            runs: [suspended("r2")],
            gateFailures: [{ issue: 2, runId: "r2", stepId: "s2", broke: "x" }],
            escalated: ["r2"],
          }),
        ),
      ),
    ).toEqual([]);
  });

  test("B: a gateReply → write-answer-and-resume", () => {
    const [action] = plan(
      obs({
        issues: [linked(2, "r2", "waiting")],
        runs: [suspended("r2")],
        gateReplies: [
          {
            issue: 2,
            runId: "r2",
            stepId: "s2",
            answer: { decision: "narrow" },
          },
        ],
      }),
    );
    expect(action).toMatchObject({
      kind: "write-answer-and-resume",
      answer: { decision: "narrow" },
      guard: { runSuspended: true, noAnsweredMarkerFor: "r2\ts2" },
    });
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
