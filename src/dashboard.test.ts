import { describe, expect, it } from "vitest";
import { renderDashboard } from "./dashboard/render.js";
import { replayRun } from "./dashboard/replay.js";
import {
  buildDashboardModel,
  type DashboardModel,
  detectDrift,
} from "./dashboard.js";
import type {
  IssueObservation,
  Observation,
  RunObservation,
} from "./observe.js";

const issue = (
  o: Partial<IssueObservation> & { number: number },
): IssueObservation => ({
  title: `issue ${o.number}`,
  qualifying: true,
  status: null,
  fault: null,
  markers: [],
  currentRunId: null,
  attemptCount: 0,
  ...o,
});

const run = (
  o: Partial<RunObservation> & { id: string; class: RunObservation["class"] },
): RunObservation => ({
  lastEventAt: null,
  journalMtimeMs: null,
  mtimeAgeMs: null,
  recordedPid: null,
  terminalFailure: null,
  pr: null,
  ...o,
});

const obs = (o: Partial<Observation>): Observation => ({
  issues: [],
  runs: [],
  pending: [],
  maxConcurrent: 2,
  launchBreadcrumbs: [],
  gatesPosted: [],
  gateReplies: [],
  gateReprompts: [],
  gateFailures: [],
  runToIssue: {},
  issueToRun: {},
  orphans: [],
  stale: [],
  linkageFaults: [],
  escalated: [],
  ...o,
});

const jsonl = (...e: object[]) => e.map((x) => JSON.stringify(x)).join("\n");

describe("detectDrift", () => {
  it("flags yak:running when the journal says the run finished", () => {
    const r = replayRun(jsonl({ t: "run.finished", at: "1", status: "ok" }));
    expect(detectDrift("running", "ok", r)).toMatch(/finished ok/);
  });

  it("flags yak:running when the run is suspended on a gate", () => {
    const r = replayRun(jsonl({ t: "run.suspended", at: "1", reason: "gate" }));
    expect(detectDrift("running", "suspended", r)).toMatch(
      /suspended on a gate/,
    );
  });

  it("flags yak:waiting when nothing is suspended", () => {
    const r = replayRun(jsonl({ t: "step.started", at: "1", stepId: "build" }));
    expect(detectDrift("waiting", "alive", r)).toMatch(/not suspended/);
  });

  it("flags an unlabelled live run", () => {
    const r = replayRun(jsonl({ t: "step.started", at: "1", stepId: "build" }));
    expect(detectDrift(null, "alive", r)).toMatch(/unlabelled/);
  });

  it("is quiet when the views agree", () => {
    const r = replayRun(jsonl({ t: "step.started", at: "1", stepId: "build" }));
    expect(detectDrift("running", "alive", r)).toBeNull();
  });

  it("flags yak:running when the run has failed", () => {
    const r = replayRun(
      jsonl({ t: "run.finished", at: "1", status: "failed" }),
    );
    expect(detectDrift("running", "failed", r)).toMatch(/has failed/);
  });

  it("flags yak:running when the journal is stalled", () => {
    const r = replayRun(jsonl({ t: "step.started", at: "1", stepId: "build" }));
    expect(detectDrift("running", "stalled", r)).toMatch(/stalled/);
  });

  it("flags yak:pr-open when the run did not finish ok", () => {
    const r = replayRun(
      jsonl({ t: "run.finished", at: "1", status: "failed" }),
    );
    expect(detectDrift("pr-open", "failed", r)).toMatch(/finished failed/);
  });

  it("is quiet on yak:failed / yak:done and on a finished orphan", () => {
    const done = replayRun(jsonl({ t: "run.finished", at: "1", status: "ok" }));
    expect(detectDrift("failed", "failed", done)).toBeNull();
    expect(detectDrift("done", "ok", done)).toBeNull();
    expect(detectDrift(null, "ok", done)).toBeNull();
  });
});

describe("buildDashboardModel", () => {
  const model = (): DashboardModel =>
    buildDashboardModel(
      "acme/widgets",
      new Date("2026-09-07T12:00:00Z"),
      obs({
        issues: [
          issue({
            number: 1,
            status: "running",
            currentRunId: "r1",
            attemptCount: 1,
          }),
          issue({ number: 2, status: null }),
        ],
        runs: [run({ id: "r1", class: "suspended", mtimeAgeMs: 60_000 })],
        runToIssue: { r1: 1 },
      }),
      () => ({
        journal: jsonl(
          { t: "run.started", at: "1", workflow: "implement-change" },
          { t: "step.started", at: "2", stepId: "assess" },
          { t: "run.suspended", at: "3", reason: "gate" },
        ),
        workflowJson: JSON.stringify({
          name: "implement-change",
          steps: [
            { id: "assess", kind: "agent", needs: [] },
            { id: "build", kind: "agent", needs: ["assess"] },
          ],
        }),
        assessment: null,
        plan: null,
      }),
    );

  it("joins runs to their issue and label, and computes drift", () => {
    const m = model();
    expect(m.runs).toHaveLength(1);
    const rv = m.runs[0]!;
    expect(rv.issue).toBe(1);
    expect(rv.status).toBe("running");
    expect(rv.graph?.nodes).toHaveLength(2);
    expect(rv.drift).toMatch(/suspended on a gate/);
  });

  it("renders to a self-contained HTML page", () => {
    const html = renderDashboard(model());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("acme/widgets");
    expect(html).toContain("implement-change");
    expect(html).not.toContain("<script");
    expect(html).toContain('class="pipe-grid"');
    expect(html).toContain('class="legend"');
    expect(html).toContain("Harness monitor");
  });

  it("marks the running step in the pipeline with the 'now' kind", () => {
    const m = buildDashboardModel(
      "a/b",
      new Date(),
      obs({
        issues: [issue({ number: 1, status: "running", currentRunId: "r" })],
        runs: [run({ id: "r", class: "alive" })],
        runToIssue: { r: 1 },
      }),
      () => ({
        journal: jsonl(
          { t: "run.started", at: "1", workflow: "w" },
          { t: "step.completed", at: "2", stepId: "assess" },
          { t: "step.started", at: "3", stepId: "build" },
        ),
        workflowJson: JSON.stringify({
          name: "w",
          steps: [
            { id: "assess", kind: "agent", needs: [] },
            { id: "build", kind: "agent", needs: ["assess"] },
          ],
        }),
        assessment: null,
        plan: null,
      }),
    );
    const html = renderDashboard(m);
    expect(html).toContain('class="pstep s-run here"');
    expect(html).toContain(">now<");
  });

  it("shows run context: issue title + link, assessment summary, and the gate prompt", () => {
    const m = buildDashboardModel(
      "acme/widgets",
      new Date(),
      obs({
        issues: [
          issue({
            number: 148,
            title: "Retry backoff cap is wrong",
            status: "waiting",
            currentRunId: "rc",
          }),
        ],
        runs: [run({ id: "rc", class: "suspended" })],
        runToIssue: { rc: 148 },
        pending: [
          {
            runId: "rc",
            steps: [
              {
                stepId: "confirm-scope",
                kind: "gate",
                renderedFirstLine: "Proceed with this scope?",
                gate: {
                  rendered: "Proceed with this scope, narrow it, or abort?",
                  answerSchema: {},
                  schemaSha: "x",
                  fields: [],
                  bridgeError: null,
                },
              },
            ],
          },
        ],
      }),
      () => ({
        journal: jsonl(
          { t: "run.started", at: "1", workflow: "implement-change" },
          { t: "run.suspended", at: "2", reason: "gate" },
        ),
        workflowJson: null,
        assessment: JSON.stringify({
          kind: "bug",
          confidence: 0.7,
          summary:
            "The exponential backoff cap is applied before the jitter, not after.",
        }),
        plan: JSON.stringify({
          steps: ["move the cap after jitter", "add a regression test"],
        }),
      }),
    );
    const rv = m.runs[0]!;
    expect(rv.issueTitle).toBe("Retry backoff cap is wrong");
    expect(rv.issueUrl).toBe("https://github.com/acme/widgets/issues/148");
    expect(rv.assessment?.summary).toMatch(/backoff cap/);
    expect(rv.gatePrompt).toEqual({
      stepId: "confirm-scope",
      rendered: "Proceed with this scope, narrow it, or abort?",
    });
    expect(rv.planSteps).toHaveLength(2);

    const html = renderDashboard(m);
    expect(html).toContain("#148 — Retry backoff cap is wrong");
    expect(html).toContain("https://github.com/acme/widgets/issues/148");
    expect(html).toContain("applied before the jitter");
    expect(html).toContain("needs a human");
    expect(html).toContain("Gate at <code>confirm-scope</code>");
    expect(html).toContain("narrow it, or abort?");
    expect(html).toContain("2 steps");
  });

  it("injects the poll script and a live stamp only when refreshSeconds is set", () => {
    const m = buildDashboardModel(
      "a/b",
      new Date("2026-09-07T12:00:00Z"),
      obs({}),
      () => ({
        journal: null,
        workflowJson: null,
        assessment: null,
        plan: null,
      }),
    );
    const stat = renderDashboard(m);
    expect(stat).not.toContain("<script");
    expect(stat).toContain("generated 2026-09-07T12:00:00.000Z");

    const live = renderDashboard(m, { refreshSeconds: 10 });
    expect(live).toContain("<script>");
    expect(live).toContain("fetch('/fragment'");
    expect(live).toContain("MS=10000");
    expect(live).toContain("live · updated 2026-09-07T12:00:00.000Z");

    const frag = renderDashboard(m, { refreshSeconds: 10, fragment: true });
    expect(frag).not.toContain("<!doctype");
    expect(frag).not.toContain("<script");
    expect(frag).toContain('class="crumb"');
  });

  it("marks a run with no owning issue as an orphan", () => {
    const m = buildDashboardModel(
      "a/b",
      new Date(),
      obs({
        runs: [run({ id: "lost", class: "alive" })],
      }),
      () => ({
        journal: null,
        workflowJson: null,
        assessment: null,
        plan: null,
      }),
    );
    expect(m.runs[0]?.issue).toBeNull();
    const html = renderDashboard(m);
    expect(html).toContain("orphan");
    expect(html).toContain("no workflow.json snapshot");
  });

  it("renders a legend, the current-step marker, and a finished run with spend + failure", () => {
    const m = buildDashboardModel(
      "a/b",
      new Date("2026-09-07T12:00:00Z"),
      obs({
        issues: [issue({ number: 9, status: "failed", currentRunId: "rf" })],
        runs: [run({ id: "rf", class: "failed", mtimeAgeMs: 7_200_000 })],
        runToIssue: { rf: 9 },
      }),
      () => ({
        journal: jsonl(
          { t: "run.started", at: "1", workflow: "implement-change" },
          {
            t: "budget.consumed",
            at: "2",
            stepId: "build",
            tokens: 4200,
            usd: 0.13,
          },
          { t: "loop.iteration", at: "3", stepId: "deliver", n: 3 },
          {
            t: "step.failed",
            at: "4",
            stepId: "verify",
            failure: {
              reason: "command-failed",
              detail: "tests red",
              recoverable: false,
            },
          },
          { t: "run.finished", at: "5", status: "failed" },
        ),
        workflowJson: JSON.stringify({
          name: "implement-change",
          steps: [
            { id: "build", kind: "agent", needs: [] },
            { id: "verify", kind: "command", needs: ["build"] },
            { id: "deliver", kind: "loop", needs: ["verify"], skipIf: "x" },
          ],
        }),
        assessment: null,
        plan: null,
      }),
    );
    const html = renderDashboard(m);
    expect(html).toContain("4,200 tok");
    expect(html).toContain("$0.13");
    expect(html).toContain("tests red");
    expect(html).toContain("not recoverable");
    expect(html).toContain("finished failed");
    expect(html).toContain("2h ago");
    expect(html).toContain("#3"); // loop iteration badge
  });

  it("renders the problems section for orphans, stale markers and linkage faults", () => {
    const m = buildDashboardModel(
      "a/b",
      new Date(),
      obs({
        orphans: [
          {
            runId: "o1",
            class: "alive",
            live: true,
            recovery: { issue: 5, launchedAt: "t" },
          },
        ],
        stale: [{ issueNumber: 7, runId: "s1", status: "running" }],
        linkageFaults: [{ runId: "x1", issues: [1, 2] }],
      }),
      () => ({
        journal: null,
        workflowJson: null,
        assessment: null,
        plan: null,
      }),
    );
    const html = renderDashboard(m);
    expect(html).toContain("Orphan runs");
    expect(html).toContain("recoverable → #5");
    expect(html).toContain("Stale markers");
    expect(html).toContain("Linkage faults");
    // Problems stat cell counts orphans + stale + linkage faults.
    expect(html).toContain('<div class="stat-n">3</div>');
    expect(html).toContain("1 orphan · 1 stale marker · 1 linkage fault");
  });

  it("shows a fault row in the backlog and an empty-state when there are no issues", () => {
    const withFault = buildDashboardModel(
      "a/b",
      new Date(),
      obs({
        issues: [issue({ number: 3, fault: "two yak:<status> labels" })],
      }),
      () => ({
        journal: null,
        workflowJson: null,
        assessment: null,
        plan: null,
      }),
    );
    expect(renderDashboard(withFault)).toContain(
      "two yak:&lt;status&gt; labels",
    );

    const empty = buildDashboardModel("a/b", new Date(), obs({}), () => ({
      journal: null,
      workflowJson: null,
      assessment: null,
      plan: null,
    }));
    const html = renderDashboard(empty);
    expect(html).toContain("no harness-relevant issues");
    expect(html).toContain("no runs on disk");
    // No problems section is emitted when there is nothing to flag.
    expect(html).not.toContain("Orphan runs");
    expect(html).toContain("nothing flagged");
  });
});
