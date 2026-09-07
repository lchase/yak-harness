// The spec §8.2 label transition table, as a pure lookup.
//
// `plan` calls `transition(current, observed)` and never names a
// `yak:<status>` string itself (CLAUDE.md invariant 4). The table is the
// *only* place the label state machine lives: one harness-owned,
// single-valued `yak:<status>` label, plus the pre-launch `∅` state
// (the issue carries the bare qualifying label and no `yak:<status>`).
//
// `observed` is the run behind the issue's current marker, widened to
// the eight columns of the §8.2 table: the five `RunClass` values with
// `failed`/`stalled` (and a stale marker — a marker whose run dir is
// gone) collapsed to `terminal-bad`, and `ok` split by PR disposition.

import { YAK_STATUS_NAMES, type YakStatus } from "./constants.js";

/** The §8.2 "observed" columns — the run state behind an issue's marker. */
export type Observed =
  | "none"
  | "alive"
  | "suspended"
  | "ok-no-pr"
  | "ok-pr-open"
  | "ok-pr-merged"
  | "ok-pr-closed"
  | "terminal-bad";

export const OBSERVED_VALUES: readonly Observed[] = [
  "none",
  "alive",
  "suspended",
  "ok-no-pr",
  "ok-pr-open",
  "ok-pr-merged",
  "ok-pr-closed",
  "terminal-bad",
];

/** The §8.2 rows — a `yak:<status>` label, or `"none"` for the `∅` state. */
export type CurrentStatus = YakStatus | "none";

export const CURRENT_STATUS_VALUES: readonly CurrentStatus[] = [
  "none",
  ...YAK_STATUS_NAMES,
];

export interface Transition {
  /** Resulting label. Equals the current status when `kind === "noop"`. */
  next: YakStatus;
  /**
   * `launch`  — start a fresh `yak run` (only from `∅` / `none`; spec D).
   * `relabel` — move the `yak:<status>` label to `next` (spec C).
   * `noop`    — the label already matches the observation.
   */
  kind: "launch" | "relabel" | "noop";
  /** The move also opens a gate the harness must bridge (§8.2 "+ post gate"). */
  postGate: boolean;
}

const launch = (next: YakStatus): Transition => ({
  next,
  kind: "launch",
  postGate: false,
});
const relabel = (next: YakStatus): Transition => ({
  next,
  kind: "relabel",
  postGate: false,
});
const gate = (next: YakStatus): Transition => ({
  next,
  kind: "relabel",
  postGate: true,
});
const noop = (next: YakStatus): Transition => ({
  next,
  kind: "noop",
  postGate: false,
});

/** Every column of a terminal row maps to the same inert cell. */
const trapRow = (status: YakStatus): Record<Observed, Transition> =>
  Object.fromEntries(OBSERVED_VALUES.map((o) => [o, noop(status)])) as Record<
    Observed,
    Transition
  >;

// The table verbatim from spec §8.2. `terminal-bad` covers the table's
// "failed / stalled / orphan / stale" column (the "+ flag" there is the
// §9.4 escalation comment, folded into `apply` for a relabel into
// `failed` — see `plan`).
const TABLE: Record<CurrentStatus, Record<Observed, Transition>> = {
  none: {
    none: launch("running"),
    alive: relabel("running"), // recover the lost marker in `apply`
    suspended: gate("waiting"),
    "ok-no-pr": relabel("failed"),
    "ok-pr-open": relabel("pr-open"),
    "ok-pr-merged": relabel("done"),
    "ok-pr-closed": relabel("failed"),
    "terminal-bad": relabel("failed"),
  },
  running: {
    none: relabel("failed"), // stale marker — never auto-relaunch
    alive: noop("running"),
    suspended: gate("waiting"),
    "ok-no-pr": relabel("failed"), // ok but no PR = workflow bug
    "ok-pr-open": relabel("pr-open"),
    "ok-pr-merged": relabel("done"),
    "ok-pr-closed": relabel("failed"),
    "terminal-bad": relabel("failed"),
  },
  waiting: {
    none: relabel("failed"),
    alive: relabel("running"), // resumed, working
    suspended: noop("waiting"), // re-prompt logic is §7.3, not here
    "ok-no-pr": relabel("failed"),
    "ok-pr-open": relabel("pr-open"),
    "ok-pr-merged": relabel("done"),
    "ok-pr-closed": relabel("failed"),
    "terminal-bad": relabel("failed"),
  },
  "pr-open": {
    none: relabel("failed"),
    alive: relabel("running"),
    suspended: relabel("waiting"),
    "ok-no-pr": relabel("failed"),
    "ok-pr-open": noop("pr-open"),
    "ok-pr-merged": relabel("done"),
    "ok-pr-closed": relabel("failed"), // human closed PR unmerged
    "terminal-bad": relabel("failed"),
  },
  failed: trapRow("failed"), // trap — the harness never auto-leaves it
  done: trapRow("done"), // terminal, inert
};

/** Pure §8.2 lookup. No I/O, no label strings leak to the caller's body. */
export function transition(
  current: CurrentStatus,
  observed: Observed,
): Transition {
  return TABLE[current][observed];
}

/**
 * The `yak:<status>` a fresh `yak run` resolves to (§8.2, the `∅ / none`
 * launch cell). Used for a backlog launch (D) and — since it is a fresh
 * `yak run` too — a §9.1 retry, so neither `plan` nor `apply` names the
 * label string directly (CLAUDE.md invariant 4).
 */
export const launchTarget = (): YakStatus => TABLE.none.none.next;
