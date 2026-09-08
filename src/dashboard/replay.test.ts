import { describe, expect, it } from "vitest";
import { parseEnvelopes, replayRun } from "./replay.js";

const jsonl = (...events: object[]) =>
  events.map((e) => JSON.stringify(e)).join("\n");

describe("parseEnvelopes", () => {
  it("skips blank and non-JSON lines instead of throwing", () => {
    const text = ['{"t":"run.started","at":"t1"}', "", "{ not json", "  "].join(
      "\n",
    );
    expect(parseEnvelopes(text)).toEqual([{ t: "run.started", at: "t1" }]);
  });

  it("is empty for null / empty input", () => {
    expect(parseEnvelopes(null)).toEqual([]);
    expect(parseEnvelopes("")).toEqual([]);
  });
});

describe("replayRun", () => {
  it("tracks the current step and workflow name", () => {
    const r = replayRun(
      jsonl(
        { t: "run.started", at: "1", workflow: "implement-change" },
        { t: "step.started", at: "2", stepId: "assess" },
        { t: "step.completed", at: "3", stepId: "assess", cached: false },
        { t: "step.started", at: "4", stepId: "build" },
      ),
    );
    expect(r.workflow).toBe("implement-change");
    expect(r.currentStepId).toBe("build");
    expect(r.steps.get("assess")?.status).toBe("done");
    expect(r.steps.get("build")?.status).toBe("running");
    expect(r.lastEventAt).toBe("4");
  });

  it("distinguishes skipped and cached completions", () => {
    const r = replayRun(
      jsonl(
        { t: "step.started", at: "1", stepId: "design" },
        { t: "step.completed", at: "2", stepId: "design", skipped: true },
        { t: "step.started", at: "3", stepId: "plan" },
        { t: "step.completed", at: "4", stepId: "plan", cached: true },
      ),
    );
    expect(r.steps.get("design")?.status).toBe("skipped");
    expect(r.steps.get("plan")?.status).toBe("cached");
    expect(r.currentStepId).toBeNull();
  });

  it("captures a step failure payload and clears the current step", () => {
    const r = replayRun(
      jsonl(
        { t: "step.started", at: "1", stepId: "verify" },
        {
          t: "step.failed",
          at: "2",
          stepId: "verify",
          failure: {
            reason: "command-failed",
            detail: "npm test red",
            recoverable: true,
          },
        },
      ),
    );
    expect(r.currentStepId).toBeNull();
    expect(r.steps.get("verify")).toMatchObject({
      status: "failed",
      failure: { reason: "command-failed", recoverable: true },
    });
  });

  it("tracks gate open then suspend, and clears suspend on resume", () => {
    const open = replayRun(
      jsonl(
        { t: "step.started", at: "1", stepId: "checkpoint" },
        { t: "gate.opened", at: "2", stepId: "checkpoint" },
        { t: "run.suspended", at: "3", reason: "gate" },
      ),
    );
    expect(open.steps.get("checkpoint")?.status).toBe("gate-open");
    expect(open.suspend).toEqual({ reason: "gate" });

    const resumed = replayRun(
      jsonl(
        { t: "run.suspended", at: "1", reason: "gate" },
        { t: "run.resumed", at: "2", pid: 5 },
        { t: "gate.answered", at: "3", stepId: "checkpoint" },
      ),
    );
    expect(resumed.suspend).toBeNull();
  });

  it("sums budget and records loop iteration", () => {
    const r = replayRun(
      jsonl(
        {
          t: "budget.consumed",
          at: "1",
          stepId: "build",
          tokens: 1000,
          usd: 0.02,
        },
        { t: "budget.consumed", at: "2", stepId: "build", tokens: 500 },
        { t: "loop.iteration", at: "3", stepId: "deliver", n: 2 },
      ),
    );
    expect(r.tokens).toBe(1500);
    expect(r.usd).toBeCloseTo(0.02);
    expect(r.steps.get("deliver")?.iteration).toBe(2);
  });

  it("records run.finished status", () => {
    const r = replayRun(jsonl({ t: "run.finished", at: "1", status: "ok" }));
    expect(r.finished).toEqual({ status: "ok" });
  });

  it("ignores unknown event types (tolerant coupling)", () => {
    const r = replayRun(
      jsonl(
        { t: "artifact.written", at: "1", name: "plan", hash: "x", bytes: 3 },
        { t: "some.future.event", at: "2", weird: true },
        { t: "run.started", at: "3", workflow: "w" },
      ),
    );
    expect(r.workflow).toBe("w");
    expect(r.steps.size).toBe(0);
  });
});
