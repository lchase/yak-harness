// Local re-declarations of the three on-disk yak shapes the harness reads
// (spec §10.1). yak is a *runtime* binary, never a build dependency, so
// there is no `@lchase/yak` import to borrow these types from — they are
// re-declared here as zod schemas and used to validate at the boundary:
// every yak file the harness parses goes through one of these, and a
// shape mismatch fails loudly rather than propagating a bad assumption.
//
// Mirrors yak spec §4.2 (journal events), §4.5 (gate protocol), and the
// `StepFailure` type. Fields the harness does not consume are still
// declared (and `.passthrough()` keeps unknown future fields) so that
// validation means "this really is the shape yak documents", not merely
// "the bits I care about are present".

import { z } from "zod";

const IsoTimestamp = z.string().datetime({ offset: true });

/**
 * `pending/<step-id>.request.json` — written when a run suspends on a
 * gate (yak spec §4.5). `rendered` is freeform prose the harness posts
 * verbatim; `answerSchema` is a JSON Schema object the harness walks to
 * build the reply contract (spec §7.1). The harness has no semantic
 * understanding of either.
 */
export const GatePendingRequestSchema = z
  .object({
    stepId: z.string().min(1),
    runId: z.string().min(1),
    rendered: z.string(),
    // A JSON Schema object. Validated as "an object" here; the flat
    // scalar/enum constraint (spec §7.1) is enforced by the gate renderer.
    answerSchema: z.record(z.unknown()),
    context: z.record(z.unknown()).optional(),
    openedAt: IsoTimestamp,
  })
  .passthrough();

export type GatePendingRequest = z.infer<typeof GatePendingRequestSchema>;

/**
 * The `StepFailure.reason` values yak documents today — kept for
 * reference and for humane log messages, **not** as a validation gate.
 * Spec §9.1: yak owns the failure taxonomy ("nine reasons" and growing)
 * and the harness keys its retry decision off `recoverable`, never off
 * its own reason allowlist. So {@link StepFailureSchema} accepts any
 * well-formed `reason` string and a new yak reason parses cleanly.
 */
export const KNOWN_STEP_FAILURE_REASONS = [
  "needs-decision",
  "needs-context",
  "schema-invalid",
  "budget-exhausted",
  "tool-denied",
  "adapter-error",
  "command-failed",
] as const;

export const StepFailureSchema = z
  .object({
    reason: z.string().min(1),
    detail: z.string(),
    recoverable: z.boolean(),
  })
  .passthrough();

export type StepFailure = z.infer<typeof StepFailureSchema>;

// Journal events (yak spec §4.2). Every event carries `{ at, runId }`.
// The harness re-declares the three it keys decisions off — `run.started`
// (linkage capture, spec §5.1), `run.finished` (run status, spec §6.2)
// and `step.failed` (the terminal `StepFailure` behind a `failed` run,
// spec §9.4) — plus a loose fallback so an unrelated line in the same
// JSONL file parses without error.

const JournalEventBase = z.object({
  at: IsoTimestamp,
  runId: z.string().min(1),
});

export const RunStartedEventSchema = JournalEventBase.extend({
  t: z.literal("run.started"),
  workflow: z.string().min(1),
  inputHash: z.string().min(1),
  adapter: z.string().min(1),
  isolation: z.string().min(1),
}).passthrough();

export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;

/**
 * `status` is left as a free string, not an enum: a `run.finished` the
 * harness cannot name is still a *terminal* fact it must act on (spec
 * §6.2), so it has to parse — dropping the line would leave a dead run
 * classified `alive`. `run.finished` statuses yak documents today are
 * `ok` / `failed` / `suspended`; {@link RUN_FINISHED_KNOWN_STATUSES}.
 */
export const RUN_FINISHED_KNOWN_STATUSES = [
  "ok",
  "failed",
  "suspended",
] as const;

export const RunFinishedEventSchema = JournalEventBase.extend({
  t: z.literal("run.finished"),
  status: z.string().min(1),
}).passthrough();

export type RunFinishedEvent = z.infer<typeof RunFinishedEventSchema>;

export const StepFailedEventSchema = JournalEventBase.extend({
  t: z.literal("step.failed"),
  stepId: z.string().min(1),
  failure: StepFailureSchema,
}).passthrough();

export type StepFailedEvent = z.infer<typeof StepFailedEventSchema>;

const REDECLARED_EVENT_TYPES = [
  "run.started",
  "run.finished",
  "step.failed",
] as const;

/**
 * Any journal line the harness does not re-declare — `t` present, base
 * fields present, rest opaque. It deliberately **excludes** the
 * re-declared types: a malformed `run.started` must fail
 * {@link JournalEventSchema} loudly, not fall through to here and parse
 * as an opaque event (which would then let a `.t` narrow lie about the
 * missing fields).
 */
export const OtherJournalEventSchema = JournalEventBase.extend({
  t: z
    .string()
    .min(1)
    .refine((t) => !(REDECLARED_EVENT_TYPES as readonly string[]).includes(t), {
      message: "use the dedicated schema for this event type",
    }),
}).passthrough();

export const JournalEventSchema = z.union([
  RunStartedEventSchema,
  RunFinishedEventSchema,
  StepFailedEventSchema,
  OtherJournalEventSchema,
]);

export type JournalEvent = z.infer<typeof JournalEventSchema>;
