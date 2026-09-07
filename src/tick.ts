// One reconcile pass — `observe → plan → apply` (spec §6.1).
//
// The lock file (spec §6.6) and the `tick.log` JSON-lines file (spec
// §10.5) arrive with ticket #7; for now the tick writes a plain summary
// to stdout and non-fatal errors to stderr.

import { type ApplyDeps, type ApplyResult, apply } from "./apply.js";
import type { Config } from "./config.js";
import { type ObserveDeps, observe } from "./observe.js";
import { type Action, plan } from "./plan.js";

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
}

/** One-line-per-action rendering for `--dry-run` and the applied summary. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case "launch-run":
      return `launch-run   #${a.issue} → yak:${a.to}`;
    case "relabel":
      return `relabel      #${a.issue} ${a.from} → yak:${a.to}${a.escalate ? " (escalate)" : ""}`;
    case "post-gate-comment":
      return `post-gate    #${a.issue} run=${a.runId} step=${a.stepId}`;
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
  const observation = observe(config, deps.observe);
  const actions = plan(observation);

  const runCounts = tallyRuns(observation.runs.map((r) => r.class));
  opts.io.out(
    `tick: ${observation.issues.length} issue(s), ${observation.runs.length} run(s) [${runCounts}], ${actions.length} action(s)`,
  );

  if (opts.dryRun) {
    for (const a of actions) opts.io.out(`  would ${describeAction(a)}`);
    return 0;
  }

  const result = apply(actions, config, deps.apply);
  reportApply(result, opts.io);
  return result.aborted || result.errors.length > 0 ? 1 : 0;
}

function tallyRuns(classes: string[]): string {
  const counts = new Map<string, number>();
  for (const c of classes) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `${c}:${n}`).join(" ") || "none";
}

function reportApply(result: ApplyResult, io: TickIo): void {
  for (const line of result.applied) io.out(`  ${line}`);
  for (const line of result.notes) io.out(`  note: ${line}`);
  for (const line of result.skipped) io.out(`  skipped: ${line}`);
  for (const line of result.errors) io.err(`  error: ${line}`);
  if (result.aborted)
    io.err("  tick aborted — state left for a human (spec §5.1)");
}
