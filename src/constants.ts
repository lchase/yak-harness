// Locked constants (spec §4).
//
// These are part of a machine contract (marker-comment formats), a
// decision record (retry / re-prompt limits), or GitHub's own vocabulary
// (author_association). They are deliberately NOT configuration: an
// operator has no legitimate reason to tune them per box, and letting
// them drift would break the durable state other ticks reconstruct.
//
// Each carries the `// config candidate if a real need appears` marker
// the spec asks for.

import { join } from "node:path";

/** Max gate re-prompts before the issue is routed to `yak:failed` (spec §7.3, decision 04). */
export const GATE_REPROMPT_LIMIT = 1; // config candidate if a real need appears

/** Hard cap on `yak run` attempts per issue, retries included (spec §9, decision 05). */
export const MAX_RUN_ATTEMPTS = 2; // config candidate if a real need appears

/** Comment `author_association` values whose gate replies the harness trusts (spec §7.2, decision 04). */
export const ACCEPTED_AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
] as const; // config candidate if a real need appears

/** Prefix for the single harness-owned status label (spec §8.1, decision 03). */
export const YAK_STATUS_PREFIX = "yak:"; // config candidate if a real need appears

/**
 * The status label suffixes. Exactly one `yak:<status>` sits on a live
 * issue; its absence (the issue carries only the bare `yak` qualifying
 * label) is the sixth, pre-launch state (spec §8.1, decision 03).
 */
export const YAK_STATUS_NAMES = [
  "running",
  "waiting",
  "pr-open",
  "failed",
  "done",
] as const; // config candidate if a real need appears

export type YakStatus = (typeof YAK_STATUS_NAMES)[number];

/** Human-owned park override — while present the harness skips the issue entirely (spec §8.1). */
export const HOLD_LABEL = "yak:hold"; // config candidate if a real need appears

/** Operational scratch directory, relative to `yakRepoPath` (spec §4, §2). */
export const HARNESS_DIR_NAME = ".harness"; // config candidate if a real need appears

export const harnessDir = (yakRepoPath: string): string =>
  join(yakRepoPath, HARNESS_DIR_NAME);

/**
 * Per-run operational scratch under `.harness/` (spec §5.4): the durable
 * `<run-id>.json` pid file the stalled-kill reads (spec §9.3), and the
 * transient `launching-<issue>.json` breadcrumb a launch drops before the
 * spawn and clears once the marker comment is posted.
 */
export const HARNESS_RUNS_DIR_NAME = "runs"; // config candidate if a real need appears

export const harnessRunsDir = (yakRepoPath: string): string =>
  join(harnessDir(yakRepoPath), HARNESS_RUNS_DIR_NAME);

/** `launching-<issue>.json` — the pre-spawn launch-in-progress breadcrumb. */
export const launchingBreadcrumbName = (issue: number): string =>
  `launching-${issue}.json`;

/** `<run-id>.json` — the durable pid file kept for the §9.3 stalled kill. */
export const pidFileName = (runId: string): string => `${runId}.json`;

// Marker-comment formats (spec §5.2, §7, §9.4). `{...}` are substituted.
// Kept as builder functions so the exact string lives in exactly one place.

/** One per launch; its count across a thread is the attempt counter (spec §5.2, §9.2). */
export const runMarker = (args: {
  run: string;
  branch: string;
  launched: string;
}): string =>
  `<!-- yak-harness run=${args.run} branch=${args.branch} launched=${args.launched} -->`;

/**
 * The full launch comment body (spec §5.2): a human prose line plus the
 * machine-read marker. The machine reads only the HTML comment.
 */
export const runMarkerComment = (args: {
  run: string;
  branch: string;
  launched: string;
}): string => `🐂 yak run started: \`${args.run}\`\n${runMarker(args)}`;

/** Posted with a bridged gate prompt (spec §7.1). */
export const gateMarker = (args: {
  run: string;
  step: string;
  schemaSha: string;
}): string =>
  `<!-- yak-gate run=${args.run} step=${args.step} schema-sha=${args.schemaSha} -->`;

/** Posted with a re-prompt on a malformed reply (spec §7.3). */
export const gateRepromptMarker = (args: {
  run: string;
  step: string;
  attempt: number;
}): string =>
  `<!-- yak-gate-reprompt run=${args.run} step=${args.step} attempt=${args.attempt} -->`;

/** Written once a valid reply is parsed, before `yak resume` (spec §7.5). */
export const gateAnsweredMarker = (args: {
  run: string;
  step: string;
}): string => `<!-- yak-answered run=${args.run} step=${args.step} -->`;

/**
 * Launch poll (spec §5.1 step 3): after the detached spawn, `apply` polls
 * `runsDir` every {@link LAUNCH_POLL_INTERVAL_MS} until exactly one new
 * dir appears, giving up after {@link LAUNCH_POLL_TIMEOUT_MS}. yak `mkdir`s
 * the run dir early so this resolves sub-second in practice.
 */
export const LAUNCH_POLL_INTERVAL_MS = 200; // config candidate if a real need appears
export const LAUNCH_POLL_TIMEOUT_MS = 15_000; // config candidate if a real need appears

/** Guards the single escalation comment on entry to `yak:failed` (spec §9.4). */
export const failedMarker = (args: { run: string }): string =>
  `<!-- yak-failed run=${args.run} -->`;

/** What the §9.3 stalled kill did with the recorded pid. */
export type StalledKillOutcome =
  | "killed"
  | "already-gone"
  | "pid-reused"
  | "no-pid";

/**
 * Compose the §9.4 escalation `broke` / `tried` lines for a `stalled` run
 * (spec §9.3): the stall duration plus what became of the recorded pid.
 * `stalled` never retries — no `recoverable` signal exists.
 */
export const stalledEscalation = (
  durationText: string,
  outcome: StalledKillOutcome,
): { broke: string; tried: string } => {
  const clause = {
    killed: "process killed",
    "already-gone": "process already gone — nothing to kill",
    "pid-reused":
      "recorded pid now belongs to a non-yak process — left alone (pid-reuse guard)",
    "no-pid": "no pid on record — nothing to kill",
  }[outcome];
  return {
    broke: `run stalled — no journal activity for ${durationText}, ${clause}`,
    tried:
      "not retried — a stall is genuine wedging, not a transient failure (spec §9.3)",
  };
};

/**
 * The one escalation comment posted on every transition into `yak:failed`
 * (spec §9.4): what broke, what the harness tried, what the human does —
 * plus the {@link failedMarker} that makes the post idempotent. `broke`
 * and `tried` are composed by `plan` (a pure function of the
 * `Observation`); this builder owns only the fixed prose + layout.
 */
export const failedComment = (args: {
  run: string;
  broke: string;
  tried: string;
}): string =>
  [
    `🛑 **yak run \`${args.run}\` needs a human — moved to \`${YAK_STATUS_PREFIX}failed\`.**`,
    "",
    `**What broke:** ${args.broke}`,
    `**What was tried:** ${args.tried}`,
    `**What to do:** inspect \`.runs/${args.run}/journal\`, then either fix the cause and relabel \`yak\` (drop \`${YAK_STATUS_PREFIX}failed\`) for a clean relaunch, or close the issue.`,
    "",
    failedMarker({ run: args.run }),
  ].join("\n");
