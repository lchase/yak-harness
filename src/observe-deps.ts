// The production {@link ObserveDeps} — the *only* module that shells out
// to `gh` / `yak` or touches the filesystem (spec §10.1). Everything it
// hands back is plain data the pure layer in `observe.ts` can reason
// about.
//
// Boundary rules it enforces:
//   - Every `JSON.parse` of external output is guarded; a garbled `gh` /
//     `yak` response raises a typed {@link ObserveError} with a readable
//     cause, never an anonymous `SyntaxError` that aborts the tick blind.
//   - Each on-disk `pending/*.request.json` gate request is validated
//     against a local zod schema (CLAUDE.md invariant 2); malformed
//     entries are dropped with a stderr note, not coerced.
//   - Run ids that reach a filesystem path are checked (`runIdIsSafe`)
//     and PR URLs that reach `gh` are checked (`prUrlLooksValid`) so a
//     value from a marker comment or a run artifact cannot walk the path
//     or inject a `gh` flag.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import {
  harnessRunsDir,
  YAK_STATUS_NAMES,
  YAK_STATUS_PREFIX,
} from "./constants.js";
import type {
  ObserveDeps,
  RawComment,
  RawIssue,
  RawPendingRun,
  RawPr,
  RunBreadcrumb,
} from "./observe.js";

/** Any failure reading the outside world during `observe` (spec §10.5). */
export class ObserveError extends Error {
  override name = "ObserveError";
}

const MAX_BUFFER = 64 * 1024 * 1024; // gate threads + failure comments add up

function run(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
      ...(cwd ? { cwd } : {}),
    });
  } catch (err) {
    const e = err as { message: string; stderr?: string };
    const detail = (e.stderr?.toString().trim() || e.message).slice(0, 200);
    throw new ObserveError(`\`${cmd} ${args.join(" ")}\` failed: ${detail}`);
  }
}

function tryRun(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return run(cmd, args, cwd);
  } catch {
    return null;
  }
}

function parseJson<T>(label: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ObserveError(
      `${label}: expected JSON, got ${text.trim().slice(0, 120) || "(empty)"}`,
    );
  }
}

// ── Pure helpers (exported for direct unit tests) ────────────────────

/** A run id safe to interpolate into a filesystem path — no separators, no `..`. */
export function runIdIsSafe(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}

/** A branch name safe to pass as a `gh --head` value — no leading `-`, no shell-ish chars. */
export function branchIsSafe(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch);
}

/** A PR URL that is unambiguously a PR on the configured repo (spec §8.3). */
export function prUrlLooksValid(url: string, repo: string): boolean {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^https://github\\.com/${escaped}/pull/\\d+$`).test(
    url.trim(),
  );
}

/** The `gh issue list --search` term: qualifying label OR any status label (spec §5.3). */
export function issueLabelSearch(qualifyingLabel: string): string {
  const labels = [
    qualifyingLabel,
    ...YAK_STATUS_NAMES.map((s) => `${YAK_STATUS_PREFIX}${s}`),
  ];
  return `label:${labels.map((l) => `"${l}"`).join(",")}`;
}

const RunBreadcrumbFileSchema = z.object({
  // Positive int only — a negative pid would signal a whole process group
  // if it ever reached `process.kill` (spec §9.3 stalled kill).
  pid: z.number().int().positive(),
  issue: z.number().int().positive(),
  launchedAt: z.string().min(1),
});

/**
 * Parse one `.harness/runs/<run-id>.json` pid file (spec §5.4). `runId`
 * comes from the filename, not the body, and must be a safe id; a
 * half-written or shape-wrong file yields `null` (a missing breadcrumb
 * only ever costs a recovery, never correctness — spec §5.5).
 */
export function parseRunBreadcrumb(
  fileName: string,
  text: string,
): RunBreadcrumb | null {
  const m = /^(.+)\.json$/.exec(fileName);
  if (!m || fileName.startsWith("launching-")) return null;
  const runId = m[1]!;
  if (!runIdIsSafe(runId)) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const res = RunBreadcrumbFileSchema.safeParse(json);
  return res.success
    ? {
        runId,
        issue: res.data.issue,
        launchedAt: res.data.launchedAt,
        pid: res.data.pid,
      }
    : null;
}

const GhIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  labels: z.array(z.object({ name: z.string() })),
});

/** `gh issue list --json number,title,labels` → {@link RawIssue}[]. */
export function parseIssueListJson(text: string): RawIssue[] {
  const rows = z
    .array(GhIssueSchema)
    .parse(parseJson<unknown>("gh issue list", text));
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    labels: r.labels.map((l) => l.name),
  }));
}

const GhCommentSchema = z.object({
  body: z.string(),
  authorAssociation: z.string(),
  createdAt: z.string(),
});

/** `gh issue view <n> --json comments` → {@link RawComment}[]. */
export function parseCommentsJson(text: string): RawComment[] {
  const parsed = z
    .object({ comments: z.array(GhCommentSchema) })
    .parse(parseJson<unknown>("gh issue view", text));
  return parsed.comments;
}

const GhPrSchema = z.object({
  state: z.string(),
  mergedAt: z.string().nullable(),
});

/** `gh pr view --json state,mergedAt` → {@link RawPr} | null. */
export function parsePrViewJson(text: string): RawPr | null {
  const res = GhPrSchema.safeParse(parseJson<unknown>("gh pr view", text));
  return res.success ? res.data : null;
}

/** `gh pr list --head <b> --json state,mergedAt` → first {@link RawPr} | null. */
export function parsePrListJson(text: string): RawPr | null {
  const res = z
    .array(GhPrSchema)
    .safeParse(parseJson<unknown>("gh pr list", text));
  return res.success ? (res.data[0] ?? null) : null;
}

// The set of runs awaiting a human answer is derived from disk, not from
// a `yak` subcommand: yak 0.3.x has no machine-readable `yak pending`
// (the human-text `yak pending` is the only form). The on-disk contract
// is `<runDir>/pending/<stepId>.request.json` — yak writes one per open
// gate and removes it once answered (spec §7.1, CLAUDE.md invariant 2).
const PendingRequestFileSchema = z.object({
  stepId: z.string().min(1),
  kind: z.string().min(1),
  runId: z.string().min(1),
  rendered: z.string().default(""),
});

/**
 * Scan `runsDir` for open gate requests: every
 * `<runId>/pending/*.request.json` that parses and validates. Malformed
 * files are dropped loudly (invariant 2). Grouped by run id.
 */
export function scanPendingRuns(
  runsDir: string,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): RawPendingRun[] {
  let runDirs: string[];
  try {
    runDirs = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: RawPendingRun[] = [];
  for (const runId of runDirs) {
    if (!runIdIsSafe(runId)) continue;
    const pendingDir = join(runsDir, runId, "pending");
    let files: string[];
    try {
      files = readdirSync(pendingDir).filter((n) =>
        n.endsWith(".request.json"),
      );
    } catch {
      continue; // no pending/ dir — this run has no open gate
    }
    const steps: RawPendingRun["steps"] = [];
    for (const file of files) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(pendingDir, file), "utf8"));
      } catch {
        warn(`yak-harness: dropping unreadable gate request ${runId}/${file}`);
        continue;
      }
      const res = PendingRequestFileSchema.safeParse(raw);
      if (!res.success) {
        warn(
          `yak-harness: dropping malformed gate request ${runId}/${file} (${
            res.error.issues[0]?.path.join(".") ?? "?"
          }: ${res.error.issues[0]?.message ?? "invalid"})`,
        );
        continue;
      }
      steps.push({
        stepId: res.data.stepId,
        kind: res.data.kind,
        rendered: res.data.rendered,
      });
    }
    if (steps.length > 0) out.push({ runId, steps });
  }
  return out;
}

// ── The real deps ────────────────────────────────────────────────────

/**
 * `pr-url` artifact locations tried, in order. yak's public docs do not
 * pin the run-dir layout, so this is best-effort; when none match, the
 * run reports `pr: 'missing'` and `plan` routes it to `yak:failed`
 * (spec §8.2, §8.3). Revisit against yak's actual layout in the
 * apply-phase integration work.
 */
function prUrlArtifactPaths(runsDir: string, runId: string): string[] {
  return [
    join(runsDir, runId, "artifacts", "pr-url"),
    join(runsDir, runId, "artifacts", "pr-url.json"),
    join(runsDir, runId, "pr-url"),
  ];
}

function readPrUrlArtifact(runsDir: string, runId: string): string | null {
  for (const path of prUrlArtifactPaths(runsDir, runId)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch {
      continue;
    }
    if (!text) continue;
    if (path.endsWith(".json")) {
      try {
        const v = JSON.parse(text) as unknown;
        return typeof v === "string"
          ? v
          : ((v as { url?: string }).url ?? null);
      } catch {
        return null;
      }
    }
    return text;
  }
  return null;
}

/** Production {@link ObserveDeps} — shells out to `gh` and `yak` (spec §10.1). */
export function realObserveDeps(config: Config): ObserveDeps {
  const journalPath = (runId: string) =>
    join(config.runsDir, runId, "journal.jsonl");

  const ghPrView = (url: string): RawPr | null => {
    const json = tryRun("gh", [
      "pr",
      "view",
      url,
      "--repo",
      config.repo,
      "--json",
      "state,mergedAt",
    ]);
    return json === null ? null : parsePrViewJson(json);
  };

  const ghPrListHead = (branch: string): RawPr | null => {
    if (!branchIsSafe(branch)) return null;
    const json = tryRun("gh", [
      "pr",
      "list",
      "--repo",
      config.repo,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "state,mergedAt",
    ]);
    return json === null ? null : parsePrListJson(json);
  };

  return {
    now: () => new Date(),

    listIssues: () =>
      parseIssueListJson(
        run("gh", [
          "issue",
          "list",
          "--repo",
          config.repo,
          "--state",
          "open",
          "--limit",
          "500",
          "--search",
          issueLabelSearch(config.qualifyingLabel),
          "--json",
          "number,title,labels",
        ]),
      ),

    listComments: (issueNumber) => {
      const json = tryRun("gh", [
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        config.repo,
        "--json",
        "comments",
      ]);
      if (json === null) return null;
      try {
        return parseCommentsJson(json);
      } catch {
        return null;
      }
    },

    pendingRuns: () => scanPendingRuns(config.runsDir),

    listRunDirs: () => {
      try {
        return readdirSync(config.runsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },

    listLaunchBreadcrumbs: () => {
      const dir = harnessRunsDir(config.yakRepoPath);
      let names: string[];
      try {
        names = readdirSync(dir).filter(
          (n) => n.startsWith("launching-") && n.endsWith(".json"),
        );
      } catch {
        return [];
      }
      const issues: number[] = [];
      for (const name of names) {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
            issue?: unknown;
          };
          if (typeof parsed.issue === "number") issues.push(parsed.issue);
        } catch {
          // A half-written breadcrumb from a tick that died mid-write:
          // fall back to the issue number in the filename so the launch is
          // still treated as in-progress (never risk a duplicate launch).
          const m = /^launching-(\d+)\.json$/.exec(name);
          if (m) issues.push(Number(m[1]));
        }
      }
      return issues;
    },

    listRunBreadcrumbs: () => {
      const dir = harnessRunsDir(config.yakRepoPath);
      let names: string[];
      try {
        names = readdirSync(dir).filter(
          (n) => n.endsWith(".json") && !n.startsWith("launching-"),
        );
      } catch {
        return [];
      }
      const crumbs: RunBreadcrumb[] = [];
      for (const name of names) {
        let text: string;
        try {
          text = readFileSync(join(dir, name), "utf8");
        } catch {
          continue;
        }
        const parsed = parseRunBreadcrumb(name, text);
        if (parsed) crumbs.push(parsed);
      }
      return crumbs;
    },

    readRun: (runId) => {
      if (!runIdIsSafe(runId)) return { journal: null, mtimeMs: null };
      let journal: string | null = null;
      try {
        journal = readFileSync(journalPath(runId), "utf8");
      } catch {
        journal = null;
      }
      let mtimeMs: number | null = null;
      try {
        mtimeMs = statSync(journalPath(runId)).mtimeMs;
      } catch {
        // No journal file — fall back to the run dir's own mtime so a
        // dir that never got a journal still ages into `stalled`.
        try {
          mtimeMs = statSync(join(config.runsDir, runId)).mtimeMs;
        } catch {
          mtimeMs = null;
        }
      }
      return { journal, mtimeMs };
    },

    readGateRequest: (runId, stepId) => {
      if (!runIdIsSafe(runId) || !runIdIsSafe(stepId)) return null;
      let text: string;
      try {
        text = readFileSync(
          join(config.runsDir, runId, "pending", `${stepId}.request.json`),
          "utf8",
        );
      } catch {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },

    prForRun: (runId, branch) => {
      const url = runIdIsSafe(runId)
        ? readPrUrlArtifact(config.runsDir, runId)
        : null;
      if (url && prUrlLooksValid(url, config.repo)) {
        const viewed = ghPrView(url);
        if (viewed) return viewed;
      }
      // Transient `gh pr view` failure, or no usable artifact: fall back
      // to the deterministic worktree branch before concluding "no PR"
      // (spec §8.3).
      const head = branch && branchIsSafe(branch) ? branch : `yak/${runId}`;
      return ghPrListHead(head);
    },
  };
}
