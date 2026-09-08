// Replay one run's journal into a per-step status view for the monitor
// dashboard (docs/design/dashboard.md).
//
// This is the *one* place the dashboard reads yak's journal deeper than
// the harness does. `src/yak-schemas.ts` re-declares only the three
// events the tick keys decisions off (`run.started` / `run.finished` /
// `step.failed`); the dashboard additionally walks `step.started`,
// `step.completed`, `gate.opened`, `run.suspended`, `loop.iteration` and
// `budget.consumed` to show where a run sits on its workflow.
//
// Deliberately tolerant (docs/design/dashboard.md "coupling caveat"): a
// line that is not JSON, or an event `t` this module does not handle, is
// skipped — never fatal. A journal the dashboard cannot fully read
// degrades to the coarse started / finished / failed view the harness
// itself has.

/** Per-step state, derived from the journal tail. */
export type StepStatus =
  | "running"
  | "done"
  | "cached"
  | "skipped"
  | "failed"
  | "gate-open";

export interface StepView {
  status: StepStatus;
  /** `loop` / `map` iteration the last event for this step carried, if any. */
  iteration?: number;
  /** `StepFailure`-shaped payload from `step.failed` (not schema-validated here). */
  failure?: { reason: string; detail: string; recoverable: boolean };
}

export interface RunReplay {
  /** `workflow` name off `run.started`, or `null` if that event was unreadable. */
  workflow: string | null;
  /** Per-step view, keyed by `stepId`, in first-seen order. */
  steps: Map<string, StepView>;
  /** Step with a `step.started` and no later terminal event — where the run is now. */
  currentStepId: string | null;
  /** Summed `budget.consumed` across the run. */
  tokens: number;
  usd: number;
  /** Last `run.suspended` not yet followed by `run.resumed`. */
  suspend: { reason: string; tripped?: string } | null;
  /** Last `run.finished`, if the run has ended. */
  finished: { status: string; reason?: string } | null;
  /** `at` of the last event of any kind. */
  lastEventAt: string | null;
}

type RawEvent = Record<string, unknown>;

/** Tolerant JSONL parse: bad lines skipped, never thrown (see module note). */
export function parseEnvelopes(text: string | null): RawEvent[] {
  if (!text) return [];
  const out: RawEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const json = JSON.parse(trimmed);
      if (json && typeof json === "object") out.push(json as RawEvent);
    } catch {
      // Half-written trailing line while tailing a live run — skip.
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Fold a run's journal text into a {@link RunReplay}. Pure. */
export function replayRun(journal: string | null): RunReplay {
  const events = parseEnvelopes(journal);

  const steps = new Map<string, StepView>();
  const replay: RunReplay = {
    workflow: null,
    steps,
    currentStepId: null,
    tokens: 0,
    usd: 0,
    suspend: null,
    finished: null,
    lastEventAt: null,
  };

  const set = (
    stepId: string,
    status: StepStatus,
    extra?: {
      iteration?: number | undefined;
      failure?: StepView["failure"] | undefined;
    },
  ) => {
    const prev = steps.get(stepId);
    const next: StepView = { ...prev, status };
    if (extra?.iteration !== undefined) next.iteration = extra.iteration;
    if (extra?.failure !== undefined) next.failure = extra.failure;
    steps.set(stepId, next);
  };

  for (const e of events) {
    const t = str(e.t);
    const at = str(e.at);
    if (at) replay.lastEventAt = at;
    if (!t) continue;

    switch (t) {
      case "run.started":
        replay.workflow = str(e.workflow) ?? replay.workflow;
        break;

      case "step.started": {
        const stepId = str(e.stepId);
        if (!stepId) break;
        set(stepId, "running", { iteration: num(e.iteration) });
        replay.currentStepId = stepId;
        break;
      }

      case "step.completed": {
        const stepId = str(e.stepId);
        if (!stepId) break;
        const status: StepStatus =
          e.skipped === true
            ? "skipped"
            : e.cached === true
              ? "cached"
              : "done";
        set(stepId, status, { iteration: num(e.iteration) });
        if (replay.currentStepId === stepId) replay.currentStepId = null;
        break;
      }

      case "step.failed": {
        const stepId = str(e.stepId);
        if (!stepId) break;
        const f = e.failure as RawEvent | undefined;
        set(stepId, "failed", {
          iteration: num(e.iteration),
          failure: f
            ? {
                reason: str(f.reason) ?? "unknown",
                detail: str(f.detail) ?? "",
                recoverable: f.recoverable === true,
              }
            : undefined,
        });
        if (replay.currentStepId === stepId) replay.currentStepId = null;
        break;
      }

      case "gate.opened": {
        const stepId = str(e.stepId);
        if (stepId) set(stepId, "gate-open");
        break;
      }

      case "gate.answered": {
        const stepId = str(e.stepId);
        if (!stepId) break;
        if (e.skipped === true) set(stepId, "skipped");
        else if (steps.get(stepId)?.status === "gate-open") set(stepId, "done");
        break;
      }

      case "loop.iteration": {
        const stepId = str(e.stepId);
        const n = num(e.n);
        if (stepId && n !== undefined)
          set(stepId, steps.get(stepId)?.status ?? "running", { iteration: n });
        break;
      }

      case "budget.consumed":
        replay.tokens += num(e.tokens) ?? 0;
        replay.usd += num(e.usd) ?? 0;
        break;

      case "run.suspended": {
        const tripped = str(e.tripped);
        replay.suspend = { reason: str(e.reason) ?? "unknown" };
        if (tripped) replay.suspend.tripped = tripped;
        break;
      }

      case "run.resumed":
        replay.suspend = null;
        break;

      case "run.finished": {
        const reason = str(e.reason);
        replay.finished = { status: str(e.status) ?? "unknown" };
        if (reason) replay.finished.reason = reason;
        replay.currentStepId = null;
        break;
      }

      // Any other event (`artifact.written`, `map.item.retried`, a future
      // yak event) — ignored by design.
    }
  }

  return replay;
}
