// `yak-harness doctor --config <path>` (spec §3, §10.2).
//
// Checks box preconditions 1–5 on demand. Every check runs; each failure
// is reported individually; any failure forces a non-zero exit and
// nothing partial happens (doctor is read-only besides a write probe it
// cleans up after itself).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { harnessDir } from "./constants.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
}

/** Injectable seams so the checks are unit-testable without a real box. */
export interface DoctorDeps {
  /** Run a command; return stdout, throw on non-zero exit (message carries stderr). */
  run(cmd: string, args: string[]): string;
  nodeVersion: string;
  fileExists(path: string): boolean;
  /** Create `dir` if needed, write then delete a probe file. Throws on failure. */
  probeWrite(dir: string): void;
}

export const realDoctorDeps: DoctorDeps = {
  run: (cmd, args) => {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // execFileSync's own message is terse ("Command failed: …"); fold in
      // stderr so a doctor failure explains itself.
      const e = err as { message: string; stderr?: string };
      const stderr = e.stderr?.trim();
      throw new Error(stderr ? `${e.message.trim()}: ${stderr}` : e.message);
    }
  },
  nodeVersion: process.versions.node,
  fileExists: existsSync,
  probeWrite: (dir) => {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, ".yak-harness-doctor-probe");
    writeFileSync(probe, "");
    rmSync(probe);
  },
};

function check(name: string, fn: () => string): CheckResult {
  try {
    return { name, ok: true, detail: fn() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

function requireGitRepo(deps: DoctorDeps, path: string): string {
  if (!deps.fileExists(path)) throw new Error(`${path} does not exist`);
  deps.run("git", ["-C", path, "rev-parse", "--is-inside-work-tree"]);

  // Spec §3.3: the checkout must sit on its default branch — the harness
  // never pulls it, so a stale feature branch means every run branches
  // off the wrong base. Tolerated only when origin/HEAD is unset (can't
  // tell), which is itself worth surfacing.
  const current = deps
    .run("git", ["-C", path, "branch", "--show-current"])
    .trim();
  let defaultBranch: string;
  try {
    defaultBranch = deps
      .run("git", [
        "-C",
        path,
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ])
      .trim()
      .replace(/^origin\//, "");
  } catch {
    return `${path} is a git repo on "${current}" (origin/HEAD unset — cannot verify it is the default branch)`;
  }
  if (current !== defaultBranch) {
    throw new Error(
      `${path} is on "${current}", not the default branch "${defaultBranch}"`,
    );
  }
  return `${path} is a git repo on the default branch "${defaultBranch}"`;
}

function requireNode22(version: string): string {
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`Node ${version} < 22 (required)`);
  }
  return `Node ${version}`;
}

export function runDoctor(
  config: Config,
  deps: DoctorDeps = realDoctorDeps,
): DoctorReport {
  const checks: CheckResult[] = [
    check("gh authenticated", () => {
      deps.run("gh", ["auth", "status"]);
      return "gh auth status ok";
    }),
    check("yak on PATH", () => {
      const out = deps.run("yak", ["--version"]).trim();
      return out || "yak --version ok";
    }),
    check("yakRepoPath is a checked-out git repo", () =>
      requireGitRepo(deps, config.yakRepoPath),
    ),
    check("Node 22+", () => requireNode22(deps.nodeVersion)),
    check("write access to .runs/ and .harness/", () => {
      deps.probeWrite(config.runsDir);
      deps.probeWrite(harnessDir(config.yakRepoPath));
      return "both writable";
    }),
  ];

  return { ok: checks.every((c) => c.ok), checks };
}

/** Render a report for the terminal. */
export function formatReport(report: DoctorReport): string {
  const lines = report.checks.map(
    (c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`,
  );
  lines.push("", report.ok ? "doctor: all checks passed" : "doctor: FAILED");
  return lines.join("\n");
}
