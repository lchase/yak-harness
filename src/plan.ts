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

import type { YakStatus } from "./constants.js";
import type { IssueObservation, Observation } from "./observe.js";
import {
  transition,
  type CurrentStatus,
  type Observed,
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
  /** Transition into `yak:failed` — `apply` posts the one §9.4 comment. */
  escalate: boolean;
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
  guard: {
    inFlightCount: number;
    maxConcurrent: number;
    /** Issue carries no `yak-harness run=` marker. */
    noMarkerComment: true;
    /** No in-progress `.harness/runs/*` launch breadcrumb (spec §5.4). */
    noLaunchBreadcrumb: true;
  };
}

/** E — flag an orphan run / pending entry (spec §5.5). */
export interface FlagOrphanAction {
  kind: "flag-orphan";
  runId: string;
  orphanClass: string;
  live: boolean;
  /** Idempotency: the loud-log / needs-human marker is not already present. */
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

const gateKey = (runId: string, stepId: string): string => `${runId}\t${stepId}`;

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

  const aActions: PostGateCommentAction[] = [];
  const cActions: RelabelAction[] = [];
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
    if (t.kind === "relabel" && t.next !== issue.status) {
      cActions.push({
        kind: "relabel",
        issue: issue.number,
        from: current,
        to: t.next,
        runId: issue.currentRunId,
        escalate: t.next === "failed",
        guard: { currentStatus: current },
      });
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
  const actions: Action[] = [...eActions, ...bActions, ...aActions, ...cActions];

  // D — at most one launch per tick, and only with a free slot and no
  // live orphan wedging the diff (spec §5.1, §5.5, §6.3).
  if (
    !liveOrphan &&
    dCandidates.length > 0 &&
    inFlightCount < obs.maxConcurrent
  ) {
    actions.push(dCandidates[0]!);
  }

  return actions;
}
