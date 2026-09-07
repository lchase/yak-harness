import { expect, test } from "vitest";
import {
  GatePendingRequestSchema,
  JournalEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  StepFailureSchema,
} from "./yak-schemas.js";

test("GatePendingRequest accepts a well-formed request", () => {
  const req = {
    stepId: "approve-plan",
    runId: "2026-08-08T14-03-11Z-a3f9",
    rendered: "Approve this plan?\n\n...",
    answerSchema: { type: "object", properties: { decision: { enum: ["a"] } } },
    context: { artifacts: ["plan"] },
    openedAt: "2026-08-08T14:09:02Z",
  };
  expect(GatePendingRequestSchema.parse(req)).toMatchObject({ stepId: "approve-plan" });
});

test("GatePendingRequest rejects a non-ISO openedAt and a missing rendered", () => {
  expect(
    GatePendingRequestSchema.safeParse({
      stepId: "s",
      runId: "r",
      answerSchema: {},
      openedAt: "not-a-date",
    }).success,
  ).toBe(false);
});

test("GatePendingRequest rejects a non-object answerSchema", () => {
  expect(
    GatePendingRequestSchema.safeParse({
      stepId: "s",
      runId: "r",
      rendered: "",
      answerSchema: "nope",
      openedAt: "2026-08-08T14:09:02Z",
    }).success,
  ).toBe(false);
});

test("StepFailure round-trips reason/detail/recoverable", () => {
  const f = StepFailureSchema.parse({
    reason: "needs-decision",
    detail: "which file?",
    recoverable: true,
  });
  expect(f.recoverable).toBe(true);
});

test("StepFailure rejects an undocumented reason and a non-boolean recoverable", () => {
  expect(
    StepFailureSchema.safeParse({ reason: "vibes", detail: "x", recoverable: true })
      .success,
  ).toBe(false);
  expect(
    StepFailureSchema.safeParse({
      reason: "adapter-error",
      detail: "x",
      recoverable: "yes",
    }).success,
  ).toBe(false);
});

test("run.started parses with all documented fields", () => {
  const ev = {
    t: "run.started",
    at: "2026-08-08T14:03:11Z",
    runId: "r1",
    workflow: "implement-change",
    inputHash: "abc",
    adapter: "claude",
    isolation: "worktree",
  };
  expect(RunStartedEventSchema.parse(ev).workflow).toBe("implement-change");
  expect(JournalEventSchema.parse(ev)).toMatchObject({ t: "run.started" });
});

test("run.started rejects a missing inputHash", () => {
  expect(
    RunStartedEventSchema.safeParse({
      t: "run.started",
      at: "2026-08-08T14:03:11Z",
      runId: "r1",
      workflow: "w",
      adapter: "claude",
      isolation: "worktree",
    }).success,
  ).toBe(false);
});

test("run.finished parses each valid status and rejects others", () => {
  for (const status of ["ok", "failed", "suspended"]) {
    expect(
      RunFinishedEventSchema.parse({
        t: "run.finished",
        at: "2026-08-08T15:00:00Z",
        runId: "r1",
        status,
      }).status,
    ).toBe(status);
  }
  expect(
    RunFinishedEventSchema.safeParse({
      t: "run.finished",
      at: "2026-08-08T15:00:00Z",
      runId: "r1",
      status: "cancelled",
    }).success,
  ).toBe(false);
});

test("a malformed run.started is rejected by the union, not absorbed as opaque", () => {
  expect(
    JournalEventSchema.safeParse({
      t: "run.started",
      at: "2026-08-08T14:03:11Z",
      runId: "r1",
      workflow: "w",
      adapter: "claude",
      isolation: "worktree",
      // inputHash missing
    }).success,
  ).toBe(false);
});

test("an unrelated journal line parses via the loose fallback", () => {
  const ev = JournalEventSchema.parse({
    t: "budget.consumed",
    at: "2026-08-08T14:05:00Z",
    runId: "r1",
    stepId: "build",
    tokens: 1234,
  });
  expect(ev.t).toBe("budget.consumed");
});

test("a journal line with no `t` is rejected", () => {
  expect(
    JournalEventSchema.safeParse({ at: "2026-08-08T14:05:00Z", runId: "r1" })
      .success,
  ).toBe(false);
});
