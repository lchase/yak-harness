// The tick's decision phase (spec §6.1, §6.3) — a **pure function** of
// the `Observation`. No I/O, no clock, no mocks: its tests build
// `Observation` literals and assert the `Action[]` (CLAUDE.md invariant
// 4). Every label decision comes from the §8.2 `transition` table; no
// `yak:<status>` string appears in this file's body.
//
// The five action kinds (spec §6.3):
//
//   A `post-gate-comment`        — surface a new gate
//   B `write-answer-and-resume`  — a valid human reply is in
//   C `relabel`                  — move the `yak:<status>` label
//   D `launch-run`               — start one backlog run (the only
//                                  cap-consuming action)
//   E `flag-orphan`              — a `.runs/` dir / pending entry with
//                                  no marker (spec §5.5)
//
// Precedence within a tick (spec §6.3): **E** is surfaced first and a
// *live* orphan suppresses **D** this tick (an unrecoverable orphan
// wedges launches until a human clears it). Then **B** (resuming may
// free a slot the same tick), **A**, **C**, **D**. A/B/C/E run every
// tick regardless of in-flight count; only **D** looks at the cap.

import { MAX_RUN_ATTEMPTS, type YakStatus } from "./constants.js";
import type {
  IssueObservation,
  Observation,
  RunObservation,
} from "./observe.js";
import {
  type CurrentStatus,
  launchTarget,
  type Observed,
  transition,
} from "./transition.js";

// ── Actions ──────────────────────────────────────────────────────────

/** A — post the rendered gate prompt as an issue comment (spec §7.1). */
export interface PostGateCommentAction {
  kind: "post-gate-comment";
  issue: number;
  runId: string;
  stepId: string;
  /** Idempotency: no `<!-- yak-gate run=<id> step=<stepId> … -->` marker yet. */
  guard: { noGateCommentFor: string };
}

/** B — write the parsed answer, then `yak resume` (spec §7.5). */
export interface WriteAnswerAndResumeAction {
  kind: "write-answer-and-resume";
  issue: number;
  runId: string;
  stepId: string;
  answer: Record<string, unknown>;
  /** Idempotency: run still `suspended`, no `<!-- yak-answered … -->` marker. */
  guard: { runSuspended: true; noAnsweredMarkerFor: string };
}

/** C — move the single `yak:<status>` label to the transition target. */
export interface RelabelAction {
  kind: "relabel";
  issue: number;
  from: CurrentStatus;
  to: YakStatus;
  /** The issue's current run, for the §9.4 escalation comment / logs. */
  runId: string | null;
  /**
   * Transition into `yak:failed` and no `<!-- yak-failed run=<id> -->`
   * comment is on the issue yet — `apply` posts the one §9.4 escalation
   * comment. `false` when the move is not into `yak:failed`, or the
   * comment already landed (a tick died mid-transition); the label still
   * moves either way.
   */
  escalate: boolean;
  /**
   * The §9.4 comment body parts (`what broke` / `what was tried`),
   * composed here as a pure function of the `Observation`. Present only
   * when `escalate` is `true`.
   */
  escalation?: { broke: string; tried: string };
  /**
   * Set when this move into `yak:failed` is driven by a `stalled` run
   * (spec §9.3). `apply` kills `pid` first (verifying it is alive **and**
   * a `yak` process — pid-reuse guard), then composes the §9.4 comment
   * from `durationText` + the kill outcome (so `escalation` is not set
   * for a stall). `pid` is `null` when no pid file survives — `apply`
   * still relabels and comments, just skips the kill. `stalled` never
   * retries.
   */
  stall?: { durationText: string; pid: number | null };
  /** Idempotency: `gh` label add/remove is a no-op when already applied. */
  guard: { currentStatus: CurrentStatus };
}

/** D — launch one fresh backlog run (spec §6.3, at most one per tick). */
export interface LaunchRunAction {
  kind: "launch-run";
  issue: number;
  /**
   * The `yak:<status>` label `apply` sets once the launch resolves — the
   * §8.2 target for a launch (`yak:running`). Carried here so no label
   * string is named in `apply`'s body (CLAUDE.md invariant 4).
   */
  to: YakStatus;
  /**
   * A §9.1 auto-retry rather than a fresh backlog launch: yak marked the
   * terminal failure `recoverable` and the issue is under the attempt
   * cap. Carries the failed run being retried and the `yak:<status>` the
   * issue currently sits at (`apply` moves off it). `null` / absent for a
   * backlog launch off the `∅` cell.
   */
  retry?: {
    failedRunId: string;
    from: CurrentStatus;
    /** The attempt this launch begins — `attemptCount + 1` (spec §9.2). */
    attempt: number;
  };
  guard: {
    inFlightCount: number;
    maxConcurrent: number;
    /** Backlog launch only: issue carries no `yak-harness run=` marker. */
    noMarkerComment?: true;
    /** No in-progress `.harness/runs/*` launch breadcrumb (spec §5.4). */
    noLaunchBreadcrumb: true;
    /** Retry only: yak's own `recoverable` flag on the terminal failure. */
    recoverableFailure?: true;
    /** Retry only: distinct-marker attempt count when planned (`< 2`). */
    attemptCount?: number;
  };
}

/** E — flag an orphan run / pending entry (spec §5.5). */
export interface FlagOrphanAction {
  kind: "flag-orphan";
  runId: string;
  orphanClass: string;
  live: boolean;
  /**
   * Set when a `.harness/runs/<run-id>.json` breadcrumb names the issue
   * this run belongs to (spec §5.5). `apply` reposts the lost marker to
   * `issue` with `branch` = `yak/<runId>` and this `launchedAt`, which
   * re-links the run — so next tick it is no longer an orphan.
   * `null` → not recoverable; a live one wedges launches (`plan` already
   * suppressed D this tick) until a human intervenes. Never a guess.
   */
  recovery: { issue: number; launchedAt: string } | null;
  /**
   * Idempotency: a recovered orphan stops being an orphan once its
   * marker is back, so the repost never repeats; a non-recoverable
   * orphan has no issue to comment on — `apply` only logs it.
   */
  guard: { notAlreadyFlagged: true };
}

export type Action =
  | PostGateCommentAction
  | WriteAnswerAndResumeAction
  | RelabelAction
  | LaunchRunAction
  | FlagOrphanAction;

// ── Observed-column derivation ───────────────────────────────────────

/**
 * Widen the run behind an issue's current marker to a §8.2 column.
 *
 *   - no marker at all            → `none`
 *   - marker, but the run dir is gone (stale, spec §5.5) → `terminal-bad`
 *   - `alive` / `suspended`       → as-is
 *   - `failed` / `stalled`        → `terminal-bad`
 *   - `ok`                        → split by PR disposition (spec §8.3)
 */
export function deriveObserved(
  issue: IssueObservation,
  obs: Observation,
): Observed {
  const runId = issue.currentRunId;
  if (runId === null) return "none";

  const run = obs.runs.find((r) => r.id === runId);
  if (!run) return "terminal-bad"; // stale marker — run dir pruned / box replaced

  switch (run.class) {
    case "alive":
      return "alive";
    case "suspended":
      return "suspended";
    case "failed":
    case "stalled":
      return "terminal-bad";
    case "ok":
      switch (run.pr) {
        case "open":
          return "ok-pr-open";
        case "merged":
          return "ok-pr-merged";
        case "closed-unmerged":
          return "ok-pr-closed";
        default:
          return "ok-no-pr"; // `missing` or an unclassified `ok`
      }
  }
}

const gateKey = (runId: string, stepId: string): string =>
  `${runId}\t${stepId}`;

/** Human-readable stall age for the §9.4 comment — `45m`, `3h 12m`, `2h`. */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "an unknown period";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

/**
 * Compose the §9.4 escalation comment's `what broke` / `what was tried`
 * lines — a pure function of the observed run behind a `yak:failed`
 * transition. `run` is `undefined` for a stale marker (run dir gone).
 */
export function escalationDetail(
  observed: Observed,
  run: RunObservation | undefined,
  attemptCount: number,
): { broke: string; tried: string } {
  if (observed === "ok-no-pr") {
    return {
      broke:
        "the run finished ok but produced no PR — the workflow's open-pr step yielded nothing (workflow bug)",
      tried: "not retried — a successful run is not a failure",
    };
  }
  if (observed === "ok-pr-closed") {
    return {
      broke:
        "the pull request was closed without being merged — the harness runs no PR-revision loop (spec §11)",
      tried: "not retried — a closed PR is not a run failure",
    };
  }
  if (!run) {
    return {
      broke:
        "the run marker is stale — no `.runs/` directory for it (the box was replaced or `.runs/` was pruned)",
      tried:
        "not retried — a stale marker is never auto-relaunched (spec §8.2)",
    };
  }
  if (run.class === "stalled") {
    return {
      broke: "the run stalled — no journal activity within the stalled window",
      tried: "not retried — stalled runs never retry (spec §9.3)",
    };
  }
  // class === "failed"
  const tf = run.terminalFailure;
  const broke = tf
    ? `${tf.reason}: ${tf.detail}`
    : "the run finished `failed` with no terminal StepFailure in its journal";
  if (tf?.recoverable === true) {
    // Recoverable, yet we still landed on `yak:failed` → the attempt cap
    // is spent.
    return {
      broke,
      tried: `attempt ${attemptCount} of ${MAX_RUN_ATTEMPTS} — the retry cap is spent, no further attempts`,
    };
  }
  return {
    broke,
    tried: tf
      ? `not retried — yak marked \`${tf.reason}\` not recoverable`
      : "not retried — no recoverable signal",
  };
}

// ── plan ─────────────────────────────────────────────────────────────

export function plan(obs: Observation): Action[] {
  const inFlightCount = obs.runs.filter(
    (r) => r.class === "alive" || r.class === "suspended",
  ).length;

  // E — every orphan is flagged; a live one wedges D this tick (§5.5).
  const eActions: FlagOrphanAction[] = obs.orphans.map((o) => ({
    kind: "flag-orphan",
    runId: o.runId,
    orphanClass: o.class,
    live: o.live,
    recovery: o.recovery,
    guard: { notAlreadyFlagged: true },
  }));
  const liveOrphan = obs.orphans.some((o) => o.live);

  // B — valid, unanswered gate replies (parsing / marker checks are the
  // gate bridge's job, spec §7 / ticket #6; here they arrive pre-parsed).
  const bActions: WriteAnswerAndResumeAction[] = (obs.gateReplies ?? []).map(
    (r) => ({
      kind: "write-answer-and-resume",
      issue: r.issue,
      runId: r.runId,
      stepId: r.stepId,
      answer: r.answer,
      guard: {
        runSuspended: true,
        noAnsweredMarkerFor: gateKey(r.runId, r.stepId),
      },
    }),
  );

  const gatesPosted = new Set(obs.gatesPosted ?? []);
  const breadcrumbs = new Set(obs.launchBreadcrumbs ?? []);
  const escalated = new Set(obs.escalated ?? []);

  const aActions: PostGateCommentAction[] = [];
  const cActions: RelabelAction[] = [];
  const retryCandidates: LaunchRunAction[] = [];
  const dCandidates: LaunchRunAction[] = [];

  for (const issue of obs.issues) {
    // A faulted issue (two `yak:<status>` labels, shared run id,
    // unreadable comments) is untouchable — act on nothing (spec §8.1).
    if (issue.fault) continue;

    const current: CurrentStatus = issue.status ?? "none";
    const observed = deriveObserved(issue, obs);
    const t = transition(current, observed);

    // A — a suspended run linked here: post each open gate step not yet
    // surfaced. `gatesPosted` is empty until the gate bridge populates it.
    if (observed === "suspended" && issue.currentRunId !== null) {
      const runId = issue.currentRunId;
      const pending = obs.pending.find((p) => p.runId === runId);
      for (const step of pending?.steps ?? []) {
        if (!gatesPosted.has(gateKey(runId, step.stepId))) {
          aActions.push({
            kind: "post-gate-comment",
            issue: issue.number,
            runId,
            stepId: step.stepId,
            guard: { noGateCommentFor: gateKey(runId, step.stepId) },
          });
        }
      }
    }

    // C — relabel when the §8.2 target differs from the current label.
    // A move into `yak:failed` off a `recoverable` run failure under the
    // attempt cap is pre-empted by a §9.1 retry (a fresh `yak run`, D).
    if (
      t.kind === "relabel" &&
      t.next !== issue.status &&
      // A launch (backlog or a §9.1 retry) spawned for this issue this
      // tick but has not linked its marker yet: hold the one-way move
      // into `yak:failed` — with its permanent escalation comment — until
      // the spawn resolves or orphan-recovery re-links it (spec §5.4,
      // §5.5). Mirrors D's breadcrumb guard. Benign moves still proceed.
      !(t.next === "failed" && breadcrumbs.has(issue.number))
    ) {
      const runId = issue.currentRunId;
      const run = runId ? obs.runs.find((r) => r.id === runId) : undefined;

      const retryable =
        t.next === "failed" &&
        issue.qualifying && // a retry is a fresh launch — the scope defence still applies (spec §5.3)
        run?.class === "failed" &&
        run.terminalFailure?.recoverable === true &&
        issue.attemptCount < MAX_RUN_ATTEMPTS;

      if (retryable) {
        retryCandidates.push({
          kind: "launch-run",
          issue: issue.number,
          to: launchTarget(),
          retry: {
            failedRunId: runId!,
            from: current,
            attempt: issue.attemptCount + 1,
          },
          guard: {
            inFlightCount,
            maxConcurrent: obs.maxConcurrent,
            noLaunchBreadcrumb: true,
            recoverableFailure: true,
            attemptCount: issue.attemptCount,
          },
        });
      } else {
        const escalate = t.next === "failed" && !escalated.has(runId ?? "");
        // §9.3 — a stall drives the kill + a duration-bearing comment that
        // `apply` composes once it knows the pid's fate.
        const stall =
          t.next === "failed" && run?.class === "stalled"
            ? {
                durationText: formatDuration(run.mtimeAgeMs),
                pid: run.recordedPid,
              }
            : undefined;
        cActions.push({
          kind: "relabel",
          issue: issue.number,
          from: current,
          to: t.next,
          runId,
          escalate,
          ...(stall ? { stall } : {}),
          ...(escalate && !stall
            ? {
                escalation: escalationDetail(observed, run, issue.attemptCount),
              }
            : {}),
          guard: { currentStatus: current },
        });
      }
    }

    // D — the only cap-consuming action. Candidate only; capped below.
    if (
      t.kind === "launch" &&
      issue.qualifying && // the scope defence — only launch what a human scoped (spec §5.3)
      issue.markers.length === 0 &&
      !breadcrumbs.has(issue.number)
    ) {
      dCandidates.push({
        kind: "launch-run",
        issue: issue.number,
        to: t.next,
        guard: {
          inFlightCount,
          maxConcurrent: obs.maxConcurrent,
          noMarkerComment: true,
          noLaunchBreadcrumb: true,
        },
      });
    }
  }

  // Precedence: E, then B, then A, then C, then D (spec §6.3).
  const actions: Action[] = [
    ...eActions,
    ...bActions,
    ...aActions,
    ...cActions,
  ];

  // D — at most one launch per tick, and only with a free slot and no
  // live orphan wedging the diff (spec §5.1, §5.5, §6.3). A §9.1 retry is
  // a launch too; retries go first so started work finishes before new
  // work starts.
  const launchCandidates = [...retryCandidates, ...dCandidates];
  if (
    !liveOrphan &&
    launchCandidates.length > 0 &&
    inFlightCount < obs.maxConcurrent
  ) {
    actions.push(launchCandidates[0]!);
  }

  return actions;
}
