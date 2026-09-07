// The production {@link ApplyDeps} — the write-side twin of
// `realObserveDeps` (spec §10.1). The only place `apply` shells out to
// `gh` / `yak` or writes the filesystem.
//
// Boundary rules:
//   - `yak run` is spawned **detached** and `unref`'d so the tick exits
//     while the run continues (spec §5.4).
//   - `gh` label edits are made idempotent here: removing an absent label
//     is swallowed, so a re-run after a mid-`apply` death is safe.
//   - Breadcrumbs are plain JSON under `.harness/runs/`; losing any of
//     them only ever risks a duplicate launch, never a lost run.

import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ApplyDeps, SpawnedRun } from "./apply.js";
import type { Config } from "./config.js";
import { harnessRunsDir } from "./constants.js";

const MAX_BUFFER = 8 * 1024 * 1024;

function gh(args: string[]): void {
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_BUFFER,
  });
}

/** Production {@link ApplyDeps}. */
export function realApplyDeps(config: Config): ApplyDeps {
  const runsScratch = harnessRunsDir(config.yakRepoPath);
  const scratchPath = (name: string) => join(runsScratch, name);
  const sharedBuf = new Int32Array(new SharedArrayBuffer(4));

  return {
    now: () => new Date(),

    listRunDirs: () => {
      try {
        return readdirSync(config.runsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },

    spawnRun: ({ workflow, input }): SpawnedRun => {
      const child = spawn(
        "yak",
        ["run", workflow, "--isolation", "worktree", "--input", input],
        { cwd: config.yakRepoPath, detached: true, stdio: "ignore" },
      );
      child.unref();
      if (typeof child.pid !== "number") {
        throw new Error("yak run spawn produced no pid");
      }
      return { pid: child.pid };
    },

    readJournal: (runId) => {
      try {
        return readFileSync(join(config.runsDir, runId, "journal"), "utf8");
      } catch {
        return null;
      }
    },

    sleep: (ms) => {
      // Synchronous pause — the tick is a single straight-line pass.
      Atomics.wait(sharedBuf, 0, 0, Math.max(0, ms));
    },

    writeBreadcrumb: (name, data) => {
      mkdirSync(runsScratch, { recursive: true });
      writeFileSync(scratchPath(name), `${JSON.stringify(data, null, 2)}\n`);
    },

    removeBreadcrumb: (name) => {
      rmSync(scratchPath(name), { force: true });
    },

    postComment: (issue, body) => {
      gh([
        "issue",
        "comment",
        String(issue),
        "--repo",
        config.repo,
        "--body",
        body,
      ]);
    },

    addLabel: (issue, label) => {
      gh([
        "issue",
        "edit",
        String(issue),
        "--repo",
        config.repo,
        "--add-label",
        label,
      ]);
    },

    removeLabel: (issue, label) => {
      try {
        gh([
          "issue",
          "edit",
          String(issue),
          "--repo",
          config.repo,
          "--remove-label",
          label,
        ]);
      } catch {
        // Label already absent (or removed by a prior partial tick) — the
        // target state is reached either way (spec §6.4).
      }
    },
  };
}
