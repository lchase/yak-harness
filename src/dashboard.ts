// `yak-harness dashboard` — a read-only monitor (docs/design/dashboard.md).
//
// One shot: `observe()` the same truth the tick reads (GitHub labels +
// markers + run journals), replay each run onto its snapshotted workflow
// graph, render one static HTML page, exit. Re-run to refresh. No server,
// no daemon, no durable state — deleting the output file loses nothing.
//
// The harness never imports from here and never learns this exists
// (docs/design/dashboard.md constraint 2). This is a spectator.

import type { Config } from "./config.js";
import type { YakStatus } from "./constants.js";
import {
  type Assessment,
  parseAssessment,
  parsePlanSteps,
} from "./dashboard/artifacts.js";
import { buildWorkflowGraph, type WorkflowGraph } from "./dashboard/graph.js";
import { type RenderOptions, renderDashboard } from "./dashboard/render.js";
import { type RunReplay, replayRun } from "./dashboard/replay.js";
import {
  type IssueObservation,
  type LinkageFault,
  type Observation,
  type ObserveDeps,
  type Orphan,
  observe,
  type RunClass,
  type RunObservation,
  type StaleMarker,
} from "./observe.js";

/** Per-run disk reads the dashboard needs on top of {@link ObserveDeps}. */
export interface DashboardDeps {
  now(): Date;
  /** `<runsDir>/<runId>/journal.jsonl` text, or `null`. */
  readJournal(runId: string): string | null;
  /** `<runsDir>/<runId>/workflow.json` text, or `null`. */
  readWorkflowJson(runId: string): string | null;
  /** `<runsDir>/<runId>/artifacts/<name>.json` text, or `null`. */
  readArtifact(runId: string, name: string): string | null;
}

/** One run drawn on the dashboard. */
export interface RunView {
  runId: string;
  /** Owning issue from the marker linkage, or `null` for an orphan. */
  issue: number | null;
  /** The owning issue's single `yak:<status>` label (the harness view). */
  status: YakStatus | null;
  /** `observe`'s journal-tail classification (spec §6.2). */
  runClass: RunClass;
  attemptCount: number;
  mtimeAgeMs: number | null;
  replay: RunReplay;
  graph: WorkflowGraph | null;
  /** One-line note when the harness view and the yak view disagree. */
  drift: string | null;
  /** Owning issue's title — the first line of run context. `null` for an orphan. */
  issueTitle: string | null;
  /** `https://github.com/<repo>/issues/<n>`, or `null` for an orphan. */
  issueUrl: string | null;
  /** The `assess` step's artifact: what the run understood the task to be. */
  assessment: Assessment | null;
  /** The `plan` step's checklist of concrete edits, if it has run. */
  planSteps: string[] | null;
  /** Verbatim prose of the gate this run is suspended on (spec §7 — posted as-is). */
  gatePrompt: { stepId: string; rendered: string } | null;
}

export interface DashboardModel {
  generatedAt: string;
  repo: string;
  issues: IssueObservation[];
  runs: RunView[];
  orphans: Orphan[];
  stale: StaleMarker[];
  linkageFaults: LinkageFault[];
}

/**
 * Where the harness label and the run's journal disagree — the signal
 * bring-up is looking for (docs/design/dashboard.md "what it renders").
 * Pure.
 */
export function detectDrift(
  status: YakStatus | null,
  runClass: RunClass,
  replay: RunReplay,
): string | null {
  const suspended = runClass === "suspended" || replay.suspend !== null;
  const finishedOk = replay.finished?.status === "ok";

  switch (status) {
    case "running":
      if (finishedOk) return "labelled yak:running — run has finished ok";
      if (runClass === "failed") return "labelled yak:running — run has failed";
      if (runClass === "stalled")
        return "labelled yak:running — journal is stalled";
      if (suspended) return "labelled yak:running — run is suspended on a gate";
      return null;
    case "waiting":
      if (!suspended) return "labelled yak:waiting — run is not suspended";
      return null;
    case "pr-open":
      if (!finishedOk && replay.finished)
        return `labelled yak:pr-open — run finished ${replay.finished.status}`;
      return null;
    case "failed":
    case "done":
      return null;
    case null:
      if (runClass !== "ok" && runClass !== "failed")
        return "no yak:<status> label — a live run is unlabelled";
      return null;
    default:
      return null;
  }
}

/** Build the render model from an {@link Observation} plus per-run reads. Pure. */
export function buildDashboardModel(
  repo: string,
  now: Date,
  obs: Observation,
  reads: (runId: string) => {
    journal: string | null;
    workflowJson: string | null;
    assessment: string | null;
    plan: string | null;
  },
): DashboardModel {
  const statusByIssue = new Map<number, YakStatus | null>(
    obs.issues.map((i) => [i.number, i.status]),
  );
  const titleByIssue = new Map<number, string>(
    obs.issues.map((i) => [i.number, i.title]),
  );
  const attemptByIssue = new Map<number, number>(
    obs.issues.map((i) => [i.number, i.attemptCount]),
  );

  const runs: RunView[] = obs.runs.map((run: RunObservation) => {
    const issue = obs.runToIssue[run.id] ?? null;
    const status = issue === null ? null : (statusByIssue.get(issue) ?? null);
    const { journal, workflowJson, assessment, plan } = reads(run.id);
    const replay = replayRun(journal);

    // The gate prose a suspended run is parked on — freeform text the
    // harness posts verbatim (spec §7); shown here for the same reason.
    const openGate = obs.pending
      .find((p) => p.runId === run.id)
      ?.steps.find((s) => s.kind === "gate" && s.gate?.rendered);
    const gatePrompt =
      openGate?.gate?.rendered != null
        ? { stepId: openGate.stepId, rendered: openGate.gate.rendered }
        : null;

    return {
      runId: run.id,
      issue,
      status,
      runClass: run.class,
      attemptCount: issue === null ? 0 : (attemptByIssue.get(issue) ?? 0),
      mtimeAgeMs: run.mtimeAgeMs,
      replay,
      graph: buildWorkflowGraph(workflowJson),
      drift: detectDrift(status, run.class, replay),
      issueTitle: issue === null ? null : (titleByIssue.get(issue) ?? null),
      issueUrl:
        issue === null ? null : `https://github.com/${repo}/issues/${issue}`,
      assessment: parseAssessment(assessment),
      planSteps: parsePlanSteps(plan),
      gatePrompt,
    };
  });

  return {
    generatedAt: now.toISOString(),
    repo,
    issues: obs.issues,
    runs,
    orphans: obs.orphans,
    stale: obs.stale,
    linkageFaults: obs.linkageFaults,
  };
}

/** Run the whole dashboard pass and return the HTML page. */
export function runDashboard(
  config: Config,
  deps: { observe: ObserveDeps; dashboard: DashboardDeps },
  renderOpts: RenderOptions = {},
): string {
  const obs = observe(config, deps.observe);
  const model = buildDashboardModel(
    config.repo,
    deps.dashboard.now(),
    obs,
    (runId) => ({
      journal: deps.dashboard.readJournal(runId),
      workflowJson: deps.dashboard.readWorkflowJson(runId),
      assessment: deps.dashboard.readArtifact(runId, "assessment"),
      plan: deps.dashboard.readArtifact(runId, "plan"),
    }),
  );
  return renderDashboard(model, renderOpts);
}

export { realDashboardDeps } from "./dashboard/deps.js";
export type { RenderOptions } from "./dashboard/render.js";
