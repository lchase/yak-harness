// The tick's read phase (spec §6.2, §5.3).
//
// `observe()` does *every* read a tick needs — GitHub issues + comments,
// `yak pending`, the `runsDir` listing and each run's journal — and hands
// `plan` a complete `Observation` snapshot with zero further I/O. `plan`
// is then a pure function of that value (spec §6.1).
//
// The shape here is deliberate (CLAUDE.md invariant 4):
//
//   - **Pure classifiers** (`parseMarkers`, `readLabels`, `parseJournal`,
//     `classifyRun`, `prStateFrom`) and **pure combiners** (`linkMarkers`,
//     `findOrphans`, `findStaleMarkers`) — data-in / data-out, each
//     unit-tested directly with no fixtures.
//   - **`observe()`** — thin orchestration: call each `ObserveDeps` method
//     to gather raw inputs, then hand them to the pure combiners.
//   - **`realObserveDeps`** (in `observe-deps.ts`) — the only place that
//     shells out to `gh` / `yak` and touches the filesystem.

import type { Config } from "./config.js";
import {
  HOLD_LABEL,
  YAK_STATUS_NAMES,
  YAK_STATUS_PREFIX,
  type YakStatus,
} from "./constants.js";
import {
  JournalEventSchema,
  StepFailureSchema,
  type JournalEvent,
  type StepFailure,
} from "./yak-schemas.js";

// ── Observation shape ──────────────────────────────────────────────────

/** How a run's journal tail classifies it (spec §6.2). */
export type RunClass = "alive" | "suspended" | "ok" | "failed" | "stalled";

/**
 * PR disposition for an `ok` run (spec §8.3). `missing` = finished `ok`
 * but no PR could be found by *either* probe — a workflow bug the human
 * must see (spec §8.2). A transient `gh` failure does **not** land here:
 * `realObserveDeps.prForRun` falls back to the branch probe first.
 */
export type PrState = "open" | "merged" | "closed-unmerged" | "missing";

/** One `<!-- yak-harness run=… branch=… launched=… -->` marker comment (spec §5.2). */
export interface RunMarker {
  runId: string;
  branch: string;
  launched: string;
}

/** Everything the tick knows about one harness-relevant issue. */
export interface IssueObservation {
  number: number;
  title: string;
  /** Carries the `qualifyingLabel`. */
  qualifying: boolean;
  /** The single `yak:<status>` label, or `null` for the pre-launch `∅` state. */
  status: YakStatus | null;
  /**
   * Set when the issue is unsafe for `plan` to act on: two+ `yak:<status>`
   * labels (spec §8.1), a run id this issue shares with another (spec
   * §5.5, invariant 9), or comments that could not be read this tick.
   * `plan` must act on nothing for a faulted issue.
   */
  fault: string | null;
  /** Every marker comment, in comment order. */
  markers: RunMarker[];
  /** Last marker's run id — the issue's current run (spec §5.3). */
  currentRunId: string | null;
  /**
   * Distinct run ids across the markers = distinct `yak run` launches =
   * the attempt counter (spec §9.2, invariant 7). Counting distinct ids
   * rather than raw marker comments makes it robust to a re-posted marker
   * or a human quoting one in a reply.
   */
  attemptCount: number;
}

/** One open gate step from `yak pending` (spec §6.2). */
export interface PendingStep {
  stepId: string;
  kind: string;
  /** First line of the step's `.rendered` prose — enough for `plan` to route; not parsed here. */
  renderedFirstLine: string;
}

export interface PendingRun {
  runId: string;
  steps: PendingStep[];
}

export interface RunObservation {
  id: string;
  class: RunClass;
  /** `at` of the journal's last event, or `null` for an empty/absent journal. */
  lastEventAt: string | null;
  /**
   * Journal file mtime (ms), or — when the journal file is absent — the
   * run directory's own mtime, so a run dir that never got a journal
   * still ages into `stalled` rather than being `alive` forever
   * (spec §6.2). `null` only when neither could be stat'd.
   */
  journalMtimeMs: number | null;
  /** Typed failure for a `failed` run, pulled from the journal (spec §9.4). `null` otherwise. */
  terminalFailure: StepFailure | null;
  /** PR disposition — set only for `class: 'ok'` (spec §8.3). */
  pr: PrState | null;
}

/**
 * A `.runs/` dir or `yak pending` entry with no marker on any scanned
 * issue (spec §5.5). A `live` orphan wedges new launches this tick
 * (spec §6.3).
 */
export interface Orphan {
  runId: string;
  class: RunClass | "pending-only";
  live: boolean;
}

/** An issue whose last marker points at a run id with no `.runs/` dir (spec §5.5). */
export interface StaleMarker {
  issueNumber: number;
  runId: string;
  /** The issue's observed status, so `plan` can filter to in-progress issues (spec §5.5). */
  status: YakStatus | null;
}

/** A run id claimed by more than one issue's markers — `plan` must not guess (spec §5.5). */
export interface LinkageFault {
  runId: string;
  issues: number[];
}

/**
 * A valid, schema-checked human reply to a bridged gate, ready to
 * resume (spec §7). Produced by the gate bridge (ticket #6); `plan`
 * consumes it as data. Empty until then.
 */
export interface GateReply {
  issue: number;
  runId: string;
  stepId: string;
  answer: Record<string, unknown>;
}

export interface Observation {
  issues: IssueObservation[];
  runs: RunObservation[];
  pending: PendingRun[];
  /**
   * The `maxConcurrent` cap (spec §4), carried on the `Observation` so
   * `plan` stays a pure function of a single value (spec §6.1).
   */
  maxConcurrent: number;
  /**
   * Issue numbers with an in-progress `.harness/runs/*` launch
   * breadcrumb — a spawn that has not yet posted its marker (spec §5.4).
   * `plan` treats one as "launch already under way". Empty until the
   * detached-launch work (ticket #7); a missing breadcrumb only ever
   * risks a duplicate launch, never a lost one.
   */
  launchBreadcrumbs: number[];
  /**
   * `${runId}\t${stepId}` for gate steps whose prompt comment the
   * harness has already posted (spec §7.1). Populated by the gate
   * bridge (ticket #6); empty until then.
   */
  gatesPosted: string[];
  /** Valid, unanswered gate replies ready to resume (spec §7). Empty until ticket #6. */
  gateReplies: GateReply[];
  /** `runId → issueNumber`, rebuilt from marker comments every tick (spec §5.3). First-seen wins. */
  runToIssue: Record<string, number>;
  /** `issueNumber → currentRunId` — the inverse, last-marker-wins, held issues excluded. */
  issueToRun: Record<number, string>;
  orphans: Orphan[];
  stale: StaleMarker[];
  /** Run ids shared by two+ issues (spec §5.5). Each involved issue also carries a `fault`. */
  linkageFaults: LinkageFault[];
}

// ── Injected reads ────────────────────────────────────────────────────

export interface RawIssue {
  number: number;
  title: string;
  labels: string[];
}

export interface RawComment {
  body: string;
  authorAssociation: string;
  createdAt: string;
}

export interface RawPendingRun {
  runId: string;
  steps: { stepId: string; kind: string; rendered: string }[];
}

export interface RawPr {
  /** GitHub's `OPEN` / `MERGED` / `CLOSED`. */
  state: string;
  mergedAt: string | null;
}

/**
 * Every read `observe` performs, behind one interface so the whole read
 * phase is testable with no network and no live yak.
 */
export interface ObserveDeps {
  now(): Date;
  /** Issues carrying any harness-relevant label (spec §5.3). Throws to abort the tick. */
  listIssues(): RawIssue[];
  /**
   * One issue's comments, chronological — or `null` if they could not be
   * read (issue closed/deleted mid-tick, transient `gh` failure). A
   * `null` degrades that one issue to a fault; it never aborts the tick.
   */
  listComments(issueNumber: number): RawComment[] | null;
  /** Parsed + boundary-validated `yak pending`; malformed entries dropped. */
  yakPending(): RawPendingRun[];
  /** Directory names directly under `runsDir`. */
  listRunDirs(): string[];
  /**
   * Issue numbers with an in-progress `.harness/runs/launching-<issue>.json`
   * breadcrumb — a spawn that has begun but not yet posted its marker
   * (spec §5.4). `plan` treats one as "a launch is already under way for
   * this issue" and holds action D off it. A missing breadcrumb only ever
   * risks a duplicate launch, never a lost one.
   */
  listLaunchBreadcrumbs(): number[];
  /** A run's journal text (or `null`) plus a stalled-clock mtime (journal file, else run dir). */
  readRun(runId: string): { journal: string | null; mtimeMs: number | null };
  /**
   * The raw PR record for an `ok` run (spec §8.3): reads the `pr-url`
   * artifact and `gh pr view`s it, falling back to a `--head` branch
   * probe (using the marker's `branch` when known). `null` only when
   * *both* probes come up empty.
   */
  prForRun(runId: string, branch: string | null): RawPr | null;
}

// ── Pure classifiers ──────────────────────────────────────────────────

const MARKER_RE =
  /<!--\s*yak-harness\s+run=(\S+)\s+branch=(\S+)\s+launched=(\S+)\s*-->/g;

/** Extract every run marker from a comment thread, in comment order (spec §5.3). */
export function parseMarkers(comments: RawComment[]): RunMarker[] {
  const markers: RunMarker[] = [];
  for (const comment of comments) {
    for (const m of comment.body.matchAll(MARKER_RE)) {
      markers.push({ runId: m[1]!, branch: m[2]!, launched: m[3]! });
    }
  }
  return markers;
}

export interface LabelReading {
  qualifying: boolean;
  /** `true` when `yak:hold` is present — the issue is skipped entirely (spec §8.1). */
  held: boolean;
  status: YakStatus | null;
  fault: string | null;
}

/** Read the harness-relevant meaning out of an issue's raw label list (spec §8.1). */
export function readLabels(
  labels: string[],
  qualifyingLabel: string,
): LabelReading {
  const statuses = labels
    .filter((l) => l.startsWith(YAK_STATUS_PREFIX))
    .map((l) => l.slice(YAK_STATUS_PREFIX.length))
    .filter((s): s is YakStatus =>
      (YAK_STATUS_NAMES as readonly string[]).includes(s),
    );

  return {
    qualifying: labels.includes(qualifyingLabel),
    held: labels.includes(HOLD_LABEL),
    status: statuses.length === 1 ? statuses[0]! : null,
    fault:
      statuses.length > 1
        ? `two yak:<status> labels (${statuses.join(", ")}) — harness fault`
        : null,
  };
}

/** Parse a raw JSONL journal into the events the harness understands, in order. */
export function parseJournal(text: string | null): JournalEvent[] {
  if (!text) return [];
  const events: JournalEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      // A half-written trailing line is normal while tailing a live run's
      // journal — skip it rather than failing the whole observation.
      continue;
    }
    const parsed = JournalEventSchema.safeParse(json);
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

/** Most recent typed `StepFailure` in the journal, if any (spec §9.4). */
function terminalFailureFrom(events: JournalEvent[]): StepFailure | null {
  // Scan newest-first for an event carrying a `StepFailure`-shaped
  // `failure`: the re-declared `step.failed` event (yak spec §9.4), or —
  // as a fallback — a `run.finished` that inlines the failure or a future
  // event name the harness has not re-declared.
  for (let i = events.length - 1; i >= 0; i--) {
    const loose = (events[i] as { failure?: unknown }).failure;
    if (loose === undefined) continue;
    const parsed = StepFailureSchema.safeParse(loose);
    if (parsed.success) return parsed.data;
  }
  return null;
}

export interface ClassifyInput {
  journal: string | null;
  mtimeMs: number | null;
  now: Date;
  stalledAfterMinutes: number;
}

export interface ClassifyResult {
  runClass: RunClass;
  lastEventAt: string | null;
  terminalFailure: StepFailure | null;
}

/**
 * Classify a run purely from its journal tail + mtime (spec §6.2). No
 * harness clock or counter: `stalled` is `alive` plus a journal-mtime
 * fact.
 */
export function classifyRun(input: ClassifyInput): ClassifyResult {
  const events = parseJournal(input.journal);
  const last = events.at(-1) ?? null;
  const lastEventAt = last?.at ?? null;

  if (last?.t === "run.finished") {
    if (last.status === "suspended")
      return { runClass: "suspended", lastEventAt, terminalFailure: null };
    if (last.status === "ok")
      return { runClass: "ok", lastEventAt, terminalFailure: null };
    // `failed`, or any status yak adds later that the harness cannot name:
    // a terminated run the human must look at (spec §6.2, §8.2).
    return {
      runClass: "failed",
      lastEventAt,
      terminalFailure: terminalFailureFrom(events),
    };
  }

  const stalled =
    input.mtimeMs !== null &&
    input.now.getTime() - input.mtimeMs >
      input.stalledAfterMinutes * 60_000;

  return {
    runClass: stalled ? "stalled" : "alive",
    lastEventAt,
    terminalFailure: null,
  };
}

/** Map a raw `gh` PR record to a {@link PrState} (spec §8.3). `null` → `missing`. */
export function prStateFrom(pr: RawPr | null): PrState {
  if (!pr) return "missing";
  if (pr.mergedAt || pr.state.toUpperCase() === "MERGED") return "merged";
  if (pr.state.toUpperCase() === "OPEN") return "open";
  return "closed-unmerged";
}

// ── Pure combiners ───────────────────────────────────────────────────

export interface MarkerScan {
  number: number;
  held: boolean;
  markers: RunMarker[];
}

export interface LinkageResult {
  runToIssue: Record<string, number>;
  issueToRun: Record<number, string>;
  /** `runId → branch` from the winning marker — the authoritative branch (spec §5.2). */
  runIdToBranch: Record<string, string>;
  faults: LinkageFault[];
}

/**
 * Rebuild the run ↔ issue linkage from every scanned issue's markers
 * (spec §5.3). Held issues contribute to `runToIssue` / `runIdToBranch`
 * (so their still-running run is not mistaken for an orphan — spec §8.1
 * says `yak:hold` does not stop a live run) but not to `issueToRun`.
 * First-seen wins for `runToIssue`; a run id on two issues is a fault.
 */
export function linkMarkers(scans: MarkerScan[]): LinkageResult {
  const runToIssue: Record<string, number> = {};
  const issueToRun: Record<number, string> = {};
  const runIdToBranch: Record<string, string> = {};
  const faults = new Map<string, LinkageFault>();

  for (const scan of scans) {
    for (const marker of scan.markers) {
      runIdToBranch[marker.runId] = marker.branch;
      const owner = runToIssue[marker.runId];
      if (owner === undefined) {
        runToIssue[marker.runId] = scan.number;
      } else if (owner !== scan.number) {
        let fault = faults.get(marker.runId);
        if (!fault) {
          fault = { runId: marker.runId, issues: [owner] };
          faults.set(marker.runId, fault);
        }
        if (!fault.issues.includes(scan.number)) fault.issues.push(scan.number);
      }
    }
    const current = scan.markers.at(-1)?.runId;
    if (current && !scan.held) issueToRun[scan.number] = current;
  }

  return { runToIssue, issueToRun, runIdToBranch, faults: [...faults.values()] };
}

/** Runs / pending entries with no marker on any scanned issue (spec §5.5). */
export function findOrphans(
  runs: RunObservation[],
  pending: PendingRun[],
  markedRunIds: Set<string>,
  runDirSet: Set<string>,
): Orphan[] {
  const orphans: Orphan[] = [];
  for (const run of runs) {
    if (markedRunIds.has(run.id)) continue;
    orphans.push({
      runId: run.id,
      class: run.class,
      live: run.class !== "ok" && run.class !== "failed",
    });
  }
  for (const p of pending) {
    if (markedRunIds.has(p.runId) || runDirSet.has(p.runId)) continue;
    orphans.push({ runId: p.runId, class: "pending-only", live: true });
  }
  return orphans;
}

/** Issues whose current run id has no `.runs/` dir (spec §5.5). */
export function findStaleMarkers(
  issues: IssueObservation[],
  runDirSet: Set<string>,
): StaleMarker[] {
  const stale: StaleMarker[] = [];
  for (const issue of issues) {
    if (issue.currentRunId && !runDirSet.has(issue.currentRunId)) {
      stale.push({
        issueNumber: issue.number,
        runId: issue.currentRunId,
        status: issue.status,
      });
    }
  }
  return stale;
}

// ── Orchestration ────────────────────────────────────────────────────

/**
 * Run the whole read phase. Thin orchestration over {@link ObserveDeps};
 * the returned {@link Observation} is a complete snapshot `plan` consumes
 * with no further I/O (spec §6.1).
 */
export function observe(config: Config, deps: ObserveDeps): Observation {
  const now = deps.now();

  // 1. Scan every harness-relevant issue's labels + markers. Held issues
  //    are scanned here (their markers still count for linkage) and
  //    dropped from `issues[]` below (spec §8.1).
  const scanned = deps.listIssues().map((raw) => {
    const reading = readLabels(raw.labels, config.qualifyingLabel);
    const comments = deps.listComments(raw.number);
    return {
      raw,
      reading,
      markers: comments ? parseMarkers(comments) : [],
      commentsUnreadable: comments === null,
    };
  });

  const link = linkMarkers(
    scanned.map((s) => ({
      number: s.raw.number,
      held: s.reading.held,
      markers: s.markers,
    })),
  );

  const issues: IssueObservation[] = [];
  for (const s of scanned) {
    if (s.reading.held) continue;
    const shared = link.faults.find((f) => f.issues.includes(s.raw.number));
    issues.push({
      number: s.raw.number,
      title: s.raw.title,
      qualifying: s.reading.qualifying,
      status: s.reading.status,
      fault:
        s.reading.fault ??
        (s.commentsUnreadable ? "issue comments could not be read this tick" : null) ??
        (shared
          ? `run ${shared.runId} is claimed by issues ${shared.issues.join(", ")}`
          : null),
      markers: s.markers,
      currentRunId: s.markers.at(-1)?.runId ?? null,
      attemptCount: new Set(s.markers.map((m) => m.runId)).size,
    });
  }

  const markedRunIds = new Set(Object.keys(link.runToIssue));

  // 2. `yak pending` — run id, open steps, per-step kind + first rendered line.
  const pending: PendingRun[] = deps.yakPending().map((p) => ({
    runId: p.runId,
    steps: p.steps.map((step) => ({
      stepId: step.stepId,
      kind: step.kind,
      renderedFirstLine: step.rendered.split("\n", 1)[0] ?? "",
    })),
  }));

  // 3. Runs — one `runsDir` listing, each classified by journal tail.
  const runDirs = deps.listRunDirs();
  const runDirSet = new Set(runDirs);
  const runs: RunObservation[] = runDirs.map((id) => {
    const { journal, mtimeMs } = deps.readRun(id);
    const { runClass, lastEventAt, terminalFailure } = classifyRun({
      journal,
      mtimeMs,
      now,
      stalledAfterMinutes: config.stalledAfterMinutes,
    });
    return {
      id,
      class: runClass,
      lastEventAt,
      journalMtimeMs: mtimeMs,
      terminalFailure,
      pr:
        runClass === "ok"
          ? prStateFrom(deps.prForRun(id, link.runIdToBranch[id] ?? null))
          : null,
    };
  });

  // 4. Derived sets (spec §5.5).
  return {
    issues,
    runs,
    pending,
    maxConcurrent: config.maxConcurrent,
    launchBreadcrumbs: deps.listLaunchBreadcrumbs(),
    gatesPosted: [], // ticket #6 — gate bridge
    gateReplies: [], // ticket #6 — gate bridge
    runToIssue: link.runToIssue,
    issueToRun: link.issueToRun,
    orphans: findOrphans(runs, pending, markedRunIds, runDirSet),
    stale: findStaleMarkers(issues, runDirSet),
    linkageFaults: link.faults,
  };
}

export { realObserveDeps, ObserveError } from "./observe-deps.js";
