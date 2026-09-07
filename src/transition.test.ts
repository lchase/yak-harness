import { describe, expect, test } from "vitest";
import {
  CURRENT_STATUS_VALUES,
  OBSERVED_VALUES,
  transition,
  type CurrentStatus,
  type Observed,
  type Transition,
} from "./transition.js";

// The spec §8.2 table, transcribed cell-for-cell as the source of
// truth. `[next, kind, postGate]`.
type Cell = [Transition["next"], Transition["kind"], boolean];

const TABLE: Record<CurrentStatus, Record<Observed, Cell>> = {
  none: {
    none: ["running", "launch", false],
    alive: ["running", "relabel", false],
    suspended: ["waiting", "relabel", true],
    "ok-no-pr": ["failed", "relabel", false],
    "ok-pr-open": ["pr-open", "relabel", false],
    "ok-pr-merged": ["done", "relabel", false],
    "ok-pr-closed": ["failed", "relabel", false],
    "terminal-bad": ["failed", "relabel", false],
  },
  running: {
    none: ["failed", "relabel", false],
    alive: ["running", "noop", false],
    suspended: ["waiting", "relabel", true],
    "ok-no-pr": ["failed", "relabel", false],
    "ok-pr-open": ["pr-open", "relabel", false],
    "ok-pr-merged": ["done", "relabel", false],
    "ok-pr-closed": ["failed", "relabel", false],
    "terminal-bad": ["failed", "relabel", false],
  },
  waiting: {
    none: ["failed", "relabel", false],
    alive: ["running", "relabel", false],
    suspended: ["waiting", "noop", false],
    "ok-no-pr": ["failed", "relabel", false],
    "ok-pr-open": ["pr-open", "relabel", false],
    "ok-pr-merged": ["done", "relabel", false],
    "ok-pr-closed": ["failed", "relabel", false],
    "terminal-bad": ["failed", "relabel", false],
  },
  "pr-open": {
    none: ["failed", "relabel", false],
    alive: ["running", "relabel", false],
    suspended: ["waiting", "relabel", false],
    "ok-no-pr": ["failed", "relabel", false],
    "ok-pr-open": ["pr-open", "noop", false],
    "ok-pr-merged": ["done", "relabel", false],
    "ok-pr-closed": ["failed", "relabel", false],
    "terminal-bad": ["failed", "relabel", false],
  },
  failed: Object.fromEntries(
    OBSERVED_VALUES.map((o) => [o, ["failed", "noop", false] as Cell]),
  ) as Record<Observed, Cell>,
  done: Object.fromEntries(
    OBSERVED_VALUES.map((o) => [o, ["done", "noop", false] as Cell]),
  ) as Record<Observed, Cell>,
};

describe("transition — every §8.2 cell", () => {
  for (const current of CURRENT_STATUS_VALUES) {
    for (const observed of OBSERVED_VALUES) {
      const [next, kind, postGate] = TABLE[current][observed];
      test(`(${current} × ${observed}) → ${next} / ${kind}${postGate ? " + gate" : ""}`, () => {
        expect(transition(current, observed)).toEqual({ next, kind, postGate });
      });
    }
  }
});

describe("transition — invariants", () => {
  test("`yak:failed` and `yak:done` are traps — every column is a noop", () => {
    for (const observed of OBSERVED_VALUES) {
      expect(transition("failed", observed)).toEqual({
        next: "failed",
        kind: "noop",
        postGate: false,
      });
      expect(transition("done", observed)).toEqual({
        next: "done",
        kind: "noop",
        postGate: false,
      });
    }
  });

  test("`launch` is only ever reachable from the ∅ state on `none`", () => {
    for (const current of CURRENT_STATUS_VALUES) {
      for (const observed of OBSERVED_VALUES) {
        const isLaunchCell = current === "none" && observed === "none";
        expect(transition(current, observed).kind === "launch").toBe(
          isLaunchCell,
        );
      }
    }
  });

  test("`ok` with no PR and PR-closed-unmerged both route to `yak:failed`", () => {
    for (const current of CURRENT_STATUS_VALUES) {
      if (current === "failed" || current === "done") continue;
      expect(transition(current, "ok-no-pr").next).toBe("failed");
      expect(transition(current, "ok-pr-closed").next).toBe("failed");
    }
  });

  test("a stale marker (`terminal-bad`) while in-progress never relaunches", () => {
    for (const current of ["running", "waiting", "pr-open"] as const) {
      const t = transition(current, "terminal-bad");
      expect(t.kind).toBe("relabel");
      expect(t.next).toBe("failed");
    }
  });
});
