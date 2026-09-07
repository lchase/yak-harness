// One reconcile pass — `observe → plan → apply` (spec §6.1).
//
// The tick writes a plain summary to stdout and non-fatal errors to
// stderr; when `harnessDir` is set it also appends one JSON line to
// `.harness/tick.log` (spec §10.5). The overlap-guard lock (spec §6.6)
// is taken by the CLI around this call, not here.

import { type ApplyDeps, type ApplyResult, apply } from "./apply.js";
import type { Config } from "./config.js";
import { MAX_RUN_ATTEMPTS } from "./constants.js";
import { type ObserveDeps, observe } from "./observe.js";
import { type Action, plan } from "./plan.js";
import { appendTickLog } from "./tick-log.js";

export interface TickIo {
  out(text: string): void;
  err(text: string): void;
}

export interface TickDeps {
  observe: ObserveDeps;
  apply: ApplyDeps;
}

export interface TickOptions {
  io: TickIo;
  /** `observe` + `plan` only — print the planned actions, apply nothing (spec §10.2). */
  dryRun?: boolean;
  /**
   * `.harness/` directory. When set, a real (non-`--dry-run`) tick
   * appends one JSON line to `tick.log` here (spec §10.5).
   */
  harnessDir?: string;
}

/** One-line-per-action rendering for `--dry-run` and the applied summary. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case "launch-run":
      return `launch-run   #${a.issue} → yak:${a.to}${a.retry ? ` (retry ${a.retry.attempt}/${MAX_RUN_ATTEMPTS})` : ""}`;
    case "relabel":
      return `relabel      #${a.issue} ${a.from} → yak:${a.to}${a.escalate ? " (escalate)" : ""}${a.stall ? ` (kill pid ${a.stall.pid ?? "none"})` : ""}`;
    case "post-gate-comment":
      return `post-gate    #${a.issue} run=${a.runId} step=${a.stepId}`;
    case "post-gate-reprompt":
      return `gate-reprompt #${a.issue} run=${a.runId} step=${a.stepId} attempt=${a.attempt}`;
    case "write-answer-and-resume":
      return `resume       #${a.issue} run=${a.runId} step=${a.stepId}`;
    case "flag-orphan":
      return `flag-orphan  run=${a.runId} (${a.orphanClass}${a.live ? ", live" : ""})`;
  }
}

/**
 * Run one tick. Returns the process exit code: `0` for a clean pass
 * (including a quiet backlog), `1` when `apply` hit a harness fault.
 */
export function runTick(
  config: Config,
  deps: TickDeps,
  opts: TickOptions,
): number {
  const startedAt = new Date();
  const observation = observe(config, deps.observe);
  const actions = plan(observation);

  const runCounts = tallyRuns(observation.runs.map((r) => r.class));
  opts.io.out(
    `tick: ${observation.issues.length} issue(s), ${observation.runs.length} run(s) [${countsText(runCounts)}], ${actions.length} action(s)`,
  );

  if (opts.dryRun) {
    for (const a of actions) opts.io.out(`  would ${describeAction(a)}`);
    return 0;
  }

  const result = apply(actions, config, deps.apply);
  reportApply(result, opts.io);

  if (opts.harnessDir) {
    writeTickLog(opts.harnessDir, {
      ts: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      counts: { issues: observation.issues.length, runs: runCounts },
      actions: result.applied,
      errors: result.errors,
      ...(result.aborted ? { aborted: true } : {}),
    });
  }

  return result.aborted || result.errors.length > 0 ? 1 : 0;
}

/** Rendering the tick.log write so a logging failure never fails the tick. */
function writeTickLog(
  dir: string,
  record: Parameters<typeof appendTickLog>[1],
) {
  try {
    appendTickLog(dir, record);
  } catch {
    // The log is a debugging aid, not durable state (CLAUDE.md invariant
    // 3) — a full disk or a bad path must not abort a reconcile.
  }
}

function tallyRuns(classes: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of classes) counts[c] = (counts[c] ?? 0) + 1;
  return counts;
}

function countsText(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([c, n]) => `${c}:${n}`);
  return parts.join(" ") || "none";
}

function reportApply(result: ApplyResult, io: TickIo): void {
  for (const line of result.applied) io.out(`  ${line}`);
  for (const line of result.notes) io.out(`  note: ${line}`);
  for (const line of result.skipped) io.out(`  skipped: ${line}`);
  for (const line of result.errors) io.err(`  error: ${line}`);
  if (result.aborted)
    io.err("  tick aborted — state left for a human (spec §5.1)");
}
