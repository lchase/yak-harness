import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ApplyDeps } from "./apply.js";
import type { Config } from "./config.js";
import { TICK_LOG_NAME } from "./constants.js";
import type { ObserveDeps } from "./observe.js";
import { runTick } from "./tick.js";

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

/** ObserveDeps with one bare-`yak` issue and nothing else → plan yields one launch. */
function observeOneBacklogIssue(): ObserveDeps {
  return {
    now: () => new Date("2026-09-06T09:00:00Z"),
    listIssues: () => [{ number: 1, title: "do a thing", labels: ["yak"] }],
    listComments: () => [],
    listLaunchBreadcrumbs: () => [],
    listRunBreadcrumbs: () => [],
    yakPending: () => [],
    listRunDirs: () => [],
    readRun: () => ({ journal: null, mtimeMs: null }),
    readGateRequest: () => null,
    prForRun: () => null,
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    out,
    err,
  };
}

const recordingApplyDeps = (): { deps: ApplyDeps; calls: string[] } => {
  const calls: string[] = [];
  let dirs: string[] = [];
  let nowMs = Date.parse("2026-09-06T09:00:00Z");
  return {
    calls,
    deps: {
      now: () => new Date(nowMs),
      listRunDirs: () => [...dirs],
      spawnRun: () => {
        calls.push("spawn");
        dirs = ["run-x"];
        return { pid: 99 };
      },
      readJournal: () =>
        JSON.stringify({
          t: "run.started",
          at: "2026-09-06T09:00:01Z",
          runId: "run-x",
          workflow: "implement-change",
          inputHash: "h",
          adapter: "claude",
          isolation: "worktree",
        }),
      sleep: (ms) => {
        nowMs += ms;
      },
      writeBreadcrumb: (n) => calls.push(`write ${n}`),
      removeBreadcrumb: (n) => calls.push(`remove ${n}`),
      writeAnswer: (r, s) => calls.push(`answer ${r} ${s}`),
      resumeRun: (r) => calls.push(`resume ${r}`),
      postComment: () => calls.push("comment"),
      addLabel: (_i, l) => calls.push(`+label ${l}`),
      removeLabel: () => calls.push("-label"),
      processInfo: () => null,
      killProcess: (pid) => calls.push(`kill ${pid}`),
    },
  };
};

describe("runTick", () => {
  test("--dry-run prints the planned actions and applies nothing", () => {
    const c = capture();
    const apply = recordingApplyDeps();
    const code = runTick(
      CONFIG,
      { observe: observeOneBacklogIssue(), apply: apply.deps },
      { io: c.io, dryRun: true },
    );
    expect(code).toBe(0);
    expect(c.out.join("\n")).toContain("would launch-run   #1 → yak:running");
    expect(apply.calls).toEqual([]);
  });

  test("a live run applies the plan and returns 0", () => {
    const c = capture();
    const apply = recordingApplyDeps();
    const code = runTick(
      CONFIG,
      { observe: observeOneBacklogIssue(), apply: apply.deps },
      { io: c.io },
    );
    expect(code).toBe(0);
    expect(apply.calls).toContain("spawn");
    expect(apply.calls).toContain("+label yak:running");
    expect(c.out.join("\n")).toMatch(/launched run run-x for #1/);
  });

  test("an apply abort surfaces as exit 1", () => {
    const c = capture();
    const apply = recordingApplyDeps();
    // spawn produces no new dir → resolveRunId times out → abort
    apply.deps.spawnRun = () => ({ pid: 1 });
    const code = runTick(
      CONFIG,
      { observe: observeOneBacklogIssue(), apply: apply.deps },
      { io: c.io },
    );
    expect(code).toBe(1);
    expect(c.err.join("\n")).toMatch(/aborted/);
  });

  test("harnessDir set → one well-formed JSON line with counts + actions", () => {
    const c = capture();
    const apply = recordingApplyDeps();
    const dir = mkdtempSync(join(tmpdir(), "yh-tick-"));
    runTick(
      CONFIG,
      { observe: observeOneBacklogIssue(), apply: apply.deps },
      { io: c.io, harnessDir: dir },
    );
    const lines = readFileSync(join(dir, TICK_LOG_NAME), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? "");
    expect(rec.counts.issues).toBe(1);
    expect(typeof rec.durationMs).toBe("number");
    expect(rec.actions.join("\n")).toMatch(/launched run run-x for #1/);
    expect(rec.errors).toEqual([]);
  });

  test("--dry-run does not write tick.log even when harnessDir is set", () => {
    const c = capture();
    const apply = recordingApplyDeps();
    const dir = mkdtempSync(join(tmpdir(), "yh-tick-"));
    runTick(
      CONFIG,
      { observe: observeOneBacklogIssue(), apply: apply.deps },
      { io: c.io, dryRun: true, harnessDir: dir },
    );
    expect(() => readFileSync(join(dir, TICK_LOG_NAME), "utf8")).toThrow();
  });

  test("a quiet backlog → no actions, exit 0", () => {
    const c = capture();
    const apply = recordingApplyDeps();
    const empty: ObserveDeps = {
      ...observeOneBacklogIssue(),
      listIssues: () => [],
    };
    const code = runTick(
      CONFIG,
      { observe: empty, apply: apply.deps },
      { io: c.io },
    );
    expect(code).toBe(0);
    expect(c.out.join("\n")).toContain("0 action(s)");
    expect(apply.calls).toEqual([]);
  });
});
