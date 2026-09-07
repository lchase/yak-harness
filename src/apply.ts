// The tick's write phase (spec §6.1) — the only place, alongside
// `observe-deps.ts`, that touches GitHub / yak / the filesystem.
//
// This wires **C** (relabel, incl. the §9.4 escalation comment and the
// §9.3 stalled kill), **D** (launch), **E** (orphan / stale flagging) and
// the §9.1 auto-retry (a fresh `yak run` off a `recoverable` failure).
// A / B (gate bridge, ticket #6) are recorded as skipped, not silently
// dropped.
//
// Every action is idempotent and guarded by a predicate `plan` already
// evaluated from the `Observation` (spec §6.4). `apply` re-checks nothing
// against GitHub: it performs the move, and each move is a no-op when
// already done (`gh` label add/remove; an overwrite-safe breadcrumb).
//
// Shape mirrors `observe`: an injected {@link ApplyDeps} holds the raw
// side effects; this module holds the harness logic — most importantly
// the §5.1 snapshot-and-diff of `runsDir` that resolves a launch's run id.

import type { Config } from "./config.js";
import {
  failedComment,
  LAUNCH_POLL_INTERVAL_MS,
  LAUNCH_POLL_TIMEOUT_MS,
  launchingBreadcrumbName,
  pidFileName,
  runMarkerComment,
  type StalledKillOutcome,
  stalledEscalation,
  YAK_STATUS_PREFIX,
} from "./constants.js";
import { parseJournal } from "./observe.js";
import { runIdIsSafe } from "./observe-deps.js";
import type {
  Action,
  FlagOrphanAction,
  LaunchRunAction,
  RelabelAction,
} from "./plan.js";
import { RunStartedEventSchema } from "./yak-schemas.js";

/** A harness fault during `apply` — aborts the tick, leaves state for a human. */
export class ApplyError extends Error {
  override name = "ApplyError";
}

/** The detached child of a `yak run` spawn (spec §5.4). */
export interface SpawnedRun {
  pid: number;
}

/** Every side effect `apply` performs, behind one interface for testing. */
export interface ApplyDeps {
  now(): Date;
  /** Directory names directly under `runsDir` — the §5.1 snapshot probe. */
  listRunDirs(): string[];
  /**
   * Spawn `yak run <workflow> --isolation worktree --input <input>`
   * **detached** in `yakRepoPath` (spec §5.4) and return its pid. Does not
   * wait — the run outlives the tick.
   */
  spawnRun(input: { workflow: string; input: string }): SpawnedRun;
  /** A run's journal text, or `null` if it cannot be read yet. */
  readJournal(runId: string): string | null;
  /** Block the tick for `ms` (the launch poll needs a real pause). */
  sleep(ms: number): void;
  /** Write `.harness/runs/<name>` as JSON (overwrite-safe). */
  writeBreadcrumb(name: string, data: unknown): void;
  /** Delete `.harness/runs/<name>` if present (no error when absent). */
  removeBreadcrumb(name: string): void;
  /** Post a comment on an issue. */
  postComment(issue: number, body: string): void;
  /** Add a label to an issue (no-op when already present). */
  addLabel(issue: number, label: string): void;
  /** Remove a label from an issue (no-op when absent). */
  removeLabel(issue: number, label: string): void;
  /**
   * Look up a live process by pid for the §9.3 stalled kill. `null` when
   * no process holds that pid. `isYak` guards pid reuse — only a `yak`
   * process is ever killed.
   */
  processInfo(pid: number): { isYak: boolean } | null;
  /** Send SIGTERM to `pid` (spec §9.3). Swallows "already gone". */
  killProcess(pid: number): void;
}

export interface ApplyResult {
  /** One human-readable line per side effect performed (spec §10.5). */
  applied: string[];
  /** Non-fatal problems — the tick still exits 0 unless `aborted` is set. */
  errors: string[];
  /** Actions this ticket does not yet handle (A / B / escalation). */
  skipped: string[];
  /**
   * Informational lines that are neither a side effect nor a problem —
   * e.g. an already-terminal orphan logged once and left alone (spec
   * §5.5). Printed by the tick; they never change the exit code.
   */
  notes: string[];
  /** A harness fault stopped the tick partway (spec §5.1). */
  aborted: boolean;
}

/** Fill `{{repo}}` / `{{number}}` in the configured `inputTemplate` (spec §4). */
export function renderInput(
  template: string,
  repo: string,
  issue: number,
): string {
  return template
    .replace(/\{\{\s*repo\s*\}\}/g, repo)
    .replace(/\{\{\s*number\s*\}\}/g, String(issue));
}

/** The deterministic worktree branch for a run id (spec §5.2, §8.3). */
export const branchForRun = (runId: string): string => `yak/${runId}`;

// ── C — relabel ──────────────────────────────────────────────────────

/**
 * §9.3 — kill the pid recorded for a stalled run, guarding against pid
 * reuse (verify it is alive **and** a `yak` process). Returns what
 * happened, for the §9.4 comment. A dead pid or a reused pid is not an
 * error: the run is wedged either way and the label still moves.
 */
function killStalledRun(
  stall: NonNullable<RelabelAction["stall"]>,
  runId: string | null,
  deps: ApplyDeps,
  result: ApplyResult,
): StalledKillOutcome {
  const tag = runId ?? "unknown";
  // Defence in depth: only a positive integer pid ever reaches `ps` /
  // `process.kill` — a negative value would signal a process group.
  if (stall.pid === null || !Number.isInteger(stall.pid) || stall.pid <= 0) {
    return "no-pid";
  }

  const info = deps.processInfo(stall.pid);
  if (info === null) {
    result.notes.push(
      `stalled run ${tag}: recorded pid ${stall.pid} is not alive — no kill needed`,
    );
    return "already-gone";
  }
  if (!info.isYak) {
    result.notes.push(
      `stalled run ${tag}: pid ${stall.pid} is not a yak process — not killing (pid-reuse guard)`,
    );
    return "pid-reused";
  }
  deps.killProcess(stall.pid);
  result.applied.push(`killed stalled run ${tag} (pid ${stall.pid})`);
  return "killed";
}

function applyRelabel(
  action: RelabelAction,
  deps: ApplyDeps,
  result: ApplyResult,
): void {
  const target = `${YAK_STATUS_PREFIX}${action.to}`;

  // §9.3 — a stalled run: kill the recorded pid *before* the label moves,
  // so a tick that dies mid-kill retries the whole transition next tick
  // rather than stranding a live wedged process under `yak:failed` (a
  // trap row — no further relabel action would ever revisit it).
  let stallDetail: { broke: string; tried: string } | undefined;
  if (action.stall) {
    const outcome = killStalledRun(action.stall, action.runId, deps, result);
    stallDetail = stalledEscalation(action.stall.durationText, outcome);
  }

  if (action.escalate) {
    // The one §9.4 escalation comment, guarded by its `<!-- yak-failed
    // run=<id> -->` marker (which `plan` already checked was absent).
    // Posted before the label moves: a crash between the two leaves the
    // issue still `yak:running` with the comment up, and next tick's
    // `plan` sees the marker and moves the label without re-posting.
    const run = action.runId ?? "unknown";
    const detail = stallDetail ??
      action.escalation ?? {
        broke: "the run needs a human",
        tried: "see the run journal",
      };
    deps.postComment(
      action.issue,
      failedComment({ run, broke: detail.broke, tried: detail.tried }),
    );
    result.applied.push(
      `posted §9.4 escalation comment on #${action.issue} for run ${run}`,
    );
  }

  if (action.from !== "none") {
    deps.removeLabel(action.issue, `${YAK_STATUS_PREFIX}${action.from}`);
  }
  deps.addLabel(action.issue, target);
  result.applied.push(
    `relabelled #${action.issue}: ${action.from} → ${action.to}`,
  );
}

// ── D — launch ───────────────────────────────────────────────────────

/**
 * Snapshot `runsDir`, spawn the detached run, then poll until exactly one
 * new dir appears — that name is the run id (spec §5.1). Zero after the
 * timeout, or two+ at once, is a harness fault: abort, launch nothing
 * further.
 */
function resolveRunId(before: Set<string>, deps: ApplyDeps): string {
  const deadline = deps.now().getTime() + LAUNCH_POLL_TIMEOUT_MS;
  for (;;) {
    const isNew = deps.listRunDirs().filter((d) => !before.has(d));
    if (isNew.length === 1) return isNew[0]!;
    if (isNew.length > 1) {
      throw new ApplyError(
        `launch: ${isNew.length} new run dirs after spawn (${isNew.join(", ")}) — cannot disambiguate`,
      );
    }
    if (deps.now().getTime() >= deadline) {
      throw new ApplyError(
        "launch: no new run dir appeared within the poll window — spawn may have failed",
      );
    }
    deps.sleep(LAUNCH_POLL_INTERVAL_MS);
  }
}

/** Assert the journal's first event is our `run.started` (spec §5.1 step 4). */
function assertStarted(
  runId: string,
  workflow: string,
  tickStartMs: number,
  deps: ApplyDeps,
): void {
  const raw = parseJournal(deps.readJournal(runId))[0];
  const parsed = RunStartedEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApplyError(
      `launch: run ${runId} journal has no run.started first event`,
    );
  }
  const first = parsed.data;
  if (first.workflow !== workflow) {
    throw new ApplyError(
      `launch: run ${runId} started workflow ${first.workflow}, expected ${workflow}`,
    );
  }
  // Lenient window (5 min back for box/yak clock skew): guards against
  // diffing in a pre-existing dir, not against precise timing.
  const at = Date.parse(first.at);
  if (Number.isNaN(at) || at < tickStartMs - 300_000) {
    throw new ApplyError(
      `launch: run ${runId} run.started at ${first.at} is outside the tick window`,
    );
  }
}

function applyLaunch(
  action: LaunchRunAction,
  config: Config,
  deps: ApplyDeps,
  result: ApplyResult,
): void {
  const tickStart = deps.now();
  const launchedAt = tickStart.toISOString();
  const launching = launchingBreadcrumbName(action.issue);

  // Pre-spawn breadcrumb: if the tick dies before the marker is posted,
  // the next tick sees this and holds D off the issue (spec §5.4).
  deps.writeBreadcrumb(launching, { issue: action.issue, launchedAt });

  const before = new Set(deps.listRunDirs());
  const spawned = deps.spawnRun({
    workflow: config.workflow,
    input: renderInput(config.inputTemplate, config.repo, action.issue),
  });

  const runId = resolveRunId(before, deps);
  if (!runIdIsSafe(runId)) {
    // yak's own run ids are timestamp + hex; anything that would walk a
    // path or inject a marker is a fault, not something to launch off.
    throw new ApplyError(`launch: resolved run id ${runId} is not a safe id`);
  }
  assertStarted(runId, config.workflow, tickStart.getTime(), deps);

  const branch = branchForRun(runId);

  // Durable pid file, kept for the §9.3 stalled kill.
  deps.writeBreadcrumb(pidFileName(runId), {
    pid: spawned.pid,
    issue: action.issue,
    launchedAt,
  });

  // The sole durable run ↔ issue linkage (spec §5.2). Last marker wins.
  // Posted *before* the pre-spawn breadcrumb is cleared: a crash between
  // the two must leave the launch still guarded — by the breadcrumb if
  // the comment never landed, by the marker if it did. Clearing first
  // would open a window where a later `ok`/`failed` orphan un-wedges D
  // and the issue is launched twice.
  deps.postComment(
    action.issue,
    runMarkerComment({ run: runId, branch, launched: launchedAt }),
  );
  deps.removeBreadcrumb(launching);

  // §8.2: a launch resolves straight to `yak:running`. A backlog launch
  // has no prior status; a §9.1 retry moves off the failed run's label
  // (usually `yak:running` already — then the remove is a no-op).
  deps.addLabel(action.issue, `${YAK_STATUS_PREFIX}${action.to}`);
  const retryFrom = action.retry?.from;
  if (retryFrom && retryFrom !== "none" && retryFrom !== action.to) {
    deps.removeLabel(action.issue, `${YAK_STATUS_PREFIX}${retryFrom}`);
  }

  const how = action.retry
    ? `retry attempt ${action.retry.attempt} (was ${action.retry.failedRunId})`
    : "launched";
  result.applied.push(
    `${how} run ${runId} for #${action.issue} (pid ${spawned.pid}), set ${YAK_STATUS_PREFIX}${action.to}`,
  );
}

// ── E — orphan / stale-marker flagging (spec §5.5) ───────────────────

/**
 * Handle one orphan run (a `.runs/` dir or `yak pending` entry with no
 * marker on any scanned issue, spec §5.5):
 *
 *   - **recoverable** — a `.harness/runs/<run-id>.json` breadcrumb names
 *     the issue. Repost the lost marker there (`branch` is the
 *     deterministic `yak/<runId>`); that re-links the run, so it is not
 *     an orphan next tick. The only sanctioned re-link — never a guess.
 *   - **live, not recoverable** — log loudly. `plan` already counted it
 *     against the cap and suppressed D this tick; it stays wedged until a
 *     human clears it. Strictly safer than mislinking a gate comment.
 *   - **already terminal (`ok` / `failed`)** — nothing to bridge. One
 *     note, then the tick carries on.
 *
 * Idempotent: a recovered orphan stops being an orphan, and the
 * non-recoverable branches only log.
 */
function applyFlagOrphan(
  action: FlagOrphanAction,
  deps: ApplyDeps,
  result: ApplyResult,
): void {
  const { runId, orphanClass, recovery } = action;

  if (recovery) {
    if (!runIdIsSafe(runId)) {
      result.errors.push(
        `orphan run ${runId} has a recovery breadcrumb but an unsafe run id — not re-linking`,
      );
      return;
    }
    const branch = branchForRun(runId);
    deps.postComment(
      recovery.issue,
      runMarkerComment({ run: runId, branch, launched: recovery.launchedAt }),
    );
    result.applied.push(
      `recovered orphan run ${runId} → #${recovery.issue}: marker comment reposted`,
    );
    return;
  }

  if (action.live) {
    result.errors.push(
      `LIVE ORPHAN run=${runId} (${orphanClass}) — no marker on any issue and no recovery breadcrumb; ` +
        `counted against the cap, new launches wedged until a human clears it (spec §5.5)`,
    );
    return;
  }

  result.notes.push(
    `orphan run ${runId} (${orphanClass}) is already terminal — nothing to bridge, ignoring (spec §5.5)`,
  );
}

// ── apply ────────────────────────────────────────────────────────────

/**
 * Perform the planned actions in order. **At most one launch per tick**
 * (spec §6.3) — `plan` already guarantees this; `apply` enforces it too.
 * An {@link ApplyError} from a launch aborts the remaining actions.
 */
export function apply(
  actions: Action[],
  config: Config,
  deps: ApplyDeps,
): ApplyResult {
  const result: ApplyResult = {
    applied: [],
    errors: [],
    skipped: [],
    notes: [],
    aborted: false,
  };
  let launched = false;

  for (const action of actions) {
    try {
      switch (action.kind) {
        case "relabel":
          applyRelabel(action, deps, result);
          break;
        case "launch-run":
          if (launched) {
            result.errors.push(
              `#${action.issue}: a second launch in one tick was refused (spec §6.3)`,
            );
            break;
          }
          applyLaunch(action, config, deps, result);
          launched = true;
          break;
        case "post-gate-comment":
        case "write-answer-and-resume":
          result.skipped.push(`${action.kind} on #${action.issue} (ticket #6)`);
          break;
        case "flag-orphan":
          applyFlagOrphan(action, deps, result);
          break;
      }
    } catch (err) {
      if (err instanceof ApplyError) {
        result.errors.push(err.message);
        result.aborted = true;
        return result;
      }
      throw err;
    }
  }

  return result;
}

export { realApplyDeps } from "./apply-deps.js";
