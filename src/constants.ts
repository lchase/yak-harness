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

// Marker-comment formats (spec §5.2, §7, §9.4). `{...}` are substituted.
// Kept as builder functions so the exact string lives in exactly one place.

/** One per launch; its count across a thread is the attempt counter (spec §5.2, §9.2). */
export const runMarker = (args: {
  run: string;
  branch: string;
  launched: string;
}): string =>
  `<!-- yak-harness run=${args.run} branch=${args.branch} launched=${args.launched} -->`;

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
export const gateAnsweredMarker = (args: { run: string; step: string }): string =>
  `<!-- yak-answered run=${args.run} step=${args.step} -->`;

/** Guards the single escalation comment on entry to `yak:failed` (spec §9.4). */
export const failedMarker = (args: { run: string }): string =>
  `<!-- yak-failed run=${args.run} -->`;
