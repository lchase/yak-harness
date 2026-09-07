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
  type GateFailure,
  type GateField,
  type GateReply,
  type GateReprompt,
  readFields,
  resolveGates,
  schemaSha,
} from "./gate-bridge.js";
import {
  GatePendingRequestSchema,
  type JournalEvent,
  JournalEventSchema,
  type StepFailure,
  StepFailureSchema,
} from "./yak-schemas.js";

export type { GateFailure, GateReply, GateReprompt } from "./gate-bridge.js";

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

/**
 * The bridged gate's `pending/<stepId>.request.json`, read + boundary-
 * validated (spec §7.1). `null` on {@link PendingStep} for a non-gate step
 * or an unreadable / invalid file — the latter routes the issue to
 * `yak:failed` (spec §7.1).
 */
export interface GateRequest {
  /** Freeform prose the harness posts verbatim (CLAUDE.md invariant 1). */
  rendered: string;
  /** JSON Schema object; walked to build the reply contract (spec §7.1). */
  answerSchema: Record<string, unknown>;
  /** Short digest of `answerSchema` — the `schema-sha` marker field. */
  schemaSha: string;
  /**
   * `answerSchema` walked into contract fields (spec §7.1), computed once
   * here so `plan` and `resolveGates` never re-derive it. `null` when the
   * schema is not a flat scalar/enum object — then `bridgeError` says why
   * and the issue routes to `yak:failed`.
   */
  fields: GateField[] | null;
  bridgeError: string | null;
}

/** One open gate step from `yak pending` (spec §6.2). */
export interface PendingStep {
  stepId: string;
  kind: string;
  /** First line of the step's `.rendered` prose — enough for `plan` to route; not parsed here. */
  renderedFirstLine: string;
  /** The gate request, when `kind === "gate"` and the file is readable + valid (spec §7). */
  gate: GateRequest | null;
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
  /**
   * `now - journalMtimeMs` in ms — how long the run has been quiet. Feeds
   * the §9.4 escalation text for a `stalled` run ("no journal activity for
   * <duration>"). Computed in `observe` so `plan` stays clock-free (spec
   * §6.1). `null` when the mtime is unknown.
   */
  mtimeAgeMs: number | null;
  /**
   * pid recorded in the durable `.harness/runs/<id>.json` file (spec §5.4),
   * kept for the §9.3 stalled kill. `null` when no pid file survives for
   * this run.
   */
  recordedPid: number | null;
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
  /**
   * When a durable `.harness/runs/<run-id>.json` pid file survives for
   * this run, the issue + launch time it recorded — the *only* basis on
   * which `apply` may repost the lost marker and restore the linkage
   * (spec §5.5). `null` → not recoverable; a live one then wedges new
   * launches until a human clears it. The harness never guesses an issue.
   */
  recovery: { issue: number; launchedAt: string } | null;
}

/**
 * A durable `.harness/runs/<run-id>.json` pid file (spec §5.4) — dropped
 * once a launch has resolved its run id, kept for the §9.3 stalled kill
 * and, here, for orphan recovery (spec §5.5).
 */
export interface RunBreadcrumb {
  runId: string;
  issue: number;
  launchedAt: string;
  /** The detached `yak run` pid — the target of the §9.3 stalled kill. */
  pid: number;
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
   * harness has already posted — a `<!-- yak-gate … -->` marker is on the
   * issue (spec §7.1).
   */
  gatesPosted: string[];
  /** Valid, unanswered gate replies ready to write + resume (spec §7.5). */
  gateReplies: GateReply[];
  /** First malformed replies awaiting the one re-prompt (spec §7.3). */
  gateReprompts: GateReprompt[];
  /** Gates the harness cannot bridge — `plan` routes the issue to `yak:failed` (spec §7.1, §7.3). */
  gateFailures: GateFailure[];
  /** `runId → issueNumber`, rebuilt from marker comments every tick (spec §5.3). First-seen wins. */
  runToIssue: Record<string, number>;
  /** `issueNumber → currentRunId` — the inverse, last-marker-wins, held issues excluded. */
  issueToRun: Record<number, string>;
  orphans: Orphan[];
  stale: StaleMarker[];
  /** Run ids shared by two+ issues (spec §5.5). Each involved issue also carries a `fault`. */
  linkageFaults: LinkageFault[];
  /**
   * Run ids that already carry a `<!-- yak-failed run=<id> -->` escalation
   * comment on their issue (spec §9.4). Makes the one escalation comment
   * idempotent across ticks.
   */
  escalated: string[];
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
  /**
   * Runs with an open gate, derived from the on-disk
   * `<runId>/pending/*.request.json` contract (spec §7.1). yak has no
   * machine-readable `yak pending`, so this is a disk scan, not a CLI
   * call; malformed request files are dropped loudly (invariant 2).
   */
  pendingRuns(): RawPendingRun[];
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
  /**
   * The durable `.harness/runs/<run-id>.json` pid files (spec §5.4) — one
   * per launch that got as far as resolving its run id. `plan` uses the
   * `issue` one records to recover an orphan whose marker never landed
   * (spec §5.5). The transient `launching-<issue>.json` breadcrumbs are
   * not included here.
   */
  listRunBreadcrumbs(): RunBreadcrumb[];
  /** A run's journal text (or `null`) plus a stalled-clock mtime (journal file, else run dir). */
  readRun(runId: string): { journal: string | null; mtimeMs: number | null };
  /**
   * Raw parsed JSON of `<runsDir>/<runId>/pending/<stepId>.request.json`
   * (spec §7.1) — the gate's `rendered` + `answerSchema`. `null` when the
   * file is absent or not JSON; the pure layer validates the shape with
   * {@link GatePendingRequestSchema} and routes a miss to `yak:failed`.
   */
  readGateRequest(runId: string, stepId: string): unknown | null;
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

const FAILED_MARKER_RE = /<!--\s*yak-failed\s+run=(\S+)\s*-->/g;

/**
 * Run ids that already carry a `<!-- yak-failed run=<id> -->` escalation
 * comment on this issue (spec §9.4). `plan` uses the set to make the one
 * escalation comment idempotent across ticks even if a tick dies between
 * posting it and moving the label.
 */
export function parseFailedMarkers(comments: RawComment[]): string[] {
  const runIds: string[] = [];
  for (const comment of comments) {
    for (const m of comment.body.matchAll(FAILED_MARKER_RE)) runIds.push(m[1]!);
  }
  return runIds;
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
    input.now.getTime() - input.mtimeMs > input.stalledAfterMinutes * 60_000;

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

  return {
    runToIssue,
    issueToRun,
    runIdToBranch,
    faults: [...faults.values()],
  };
}

/** Runs / pending entries with no marker on any scanned issue (spec §5.5). */
export function findOrphans(
  runs: RunObservation[],
  pending: PendingRun[],
  markedRunIds: Set<string>,
  runDirSet: Set<string>,
  breadcrumbs: Map<string, { issue: number; launchedAt: string }> = new Map(),
): Orphan[] {
  const orphans: Orphan[] = [];
  for (const run of runs) {
    if (markedRunIds.has(run.id)) continue;
    orphans.push({
      runId: run.id,
      class: run.class,
      live: run.class !== "ok" && run.class !== "failed",
      recovery: breadcrumbs.get(run.id) ?? null,
    });
  }
  for (const p of pending) {
    if (markedRunIds.has(p.runId) || runDirSet.has(p.runId)) continue;
    orphans.push({
      runId: p.runId,
      class: "pending-only",
      live: true,
      recovery: breadcrumbs.get(p.runId) ?? null,
    });
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

/**
 * Read + boundary-validate one gate step's `request.json` (spec §7.1,
 * §10.1). A missing / non-JSON / shape-wrong file yields `null`; `plan`
 * routes that gate to `yak:failed` rather than guessing a contract.
 */
function readGateRequest(
  deps: ObserveDeps,
  runId: string,
  stepId: string,
): GateRequest | null {
  const raw = deps.readGateRequest(runId, stepId);
  if (raw === null || raw === undefined) return null;
  const parsed = GatePendingRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const answerSchema = parsed.data.answerSchema as Record<string, unknown>;
  const walked = readFields(answerSchema);
  return {
    rendered: parsed.data.rendered,
    answerSchema,
    schemaSha: schemaSha(answerSchema),
    fields: walked.ok ? walked.fields : null,
    bridgeError: walked.ok ? null : walked.reason,
  };
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
      comments: comments ?? [],
      markers: comments ? parseMarkers(comments) : [],
      failedMarkers: comments ? parseFailedMarkers(comments) : [],
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
        (s.commentsUnreadable
          ? "issue comments could not be read this tick"
          : null) ??
        (shared
          ? `run ${shared.runId} is claimed by issues ${shared.issues.join(", ")}`
          : null),
      markers: s.markers,
      currentRunId: s.markers.at(-1)?.runId ?? null,
      attemptCount: new Set(s.markers.map((m) => m.runId)).size,
    });
  }

  const markedRunIds = new Set(Object.keys(link.runToIssue));

  // Pre-spawn recovery breadcrumbs (spec §5.5): the only sanctioned way
  // to re-link an orphan run to an issue — never a guess.
  const recovery = new Map<string, { issue: number; launchedAt: string }>();
  const recordedPids = new Map<string, number>();
  for (const b of deps.listRunBreadcrumbs()) {
    recovery.set(b.runId, { issue: b.issue, launchedAt: b.launchedAt });
    recordedPids.set(b.runId, b.pid);
  }

  // 2. Open gates from disk (`pending/*.request.json`) — run id, open
  //    steps, per-step kind + rendered prose, plus the full gate request
  //    for `kind: "gate"` steps (spec §7).
  const pending: PendingRun[] = deps.pendingRuns().map((p) => ({
    runId: p.runId,
    steps: p.steps.map((step) => ({
      stepId: step.stepId,
      kind: step.kind,
      renderedFirstLine: step.rendered.split("\n", 1)[0] ?? "",
      gate:
        step.kind === "gate"
          ? readGateRequest(deps, p.runId, step.stepId)
          : null,
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
      mtimeAgeMs: mtimeMs === null ? null : now.getTime() - mtimeMs,
      recordedPid: recordedPids.get(id) ?? null,
      terminalFailure,
      pr:
        runClass === "ok"
          ? prStateFrom(deps.prForRun(id, link.runIdToBranch[id] ?? null))
          : null,
    };
  });

  // 4. Gate bridge (spec §7) — resolve every suspended run's open gate
  //    steps against its issue's comments. Pure once `observe` has the
  //    request file + comments in hand.
  const suspendedRunIds = new Set(
    runs.filter((r) => r.class === "suspended").map((r) => r.id),
  );
  const commentsByIssue = new Map(
    scanned.map((s) => [s.raw.number, s.comments]),
  );
  const gateStepInputs = issues
    .filter(
      (i) =>
        !i.fault &&
        i.currentRunId !== null &&
        suspendedRunIds.has(i.currentRunId),
    )
    .flatMap((i) => {
      const steps =
        pending.find((p) => p.runId === i.currentRunId)?.steps ?? [];
      const comments = commentsByIssue.get(i.number) ?? [];
      return steps
        .filter((s) => s.kind === "gate")
        .map((s) => ({
          issue: i.number,
          runId: i.currentRunId as string,
          stepId: s.stepId,
          request: s.gate
            ? {
                answerSchema: s.gate.answerSchema,
                fields: s.gate.fields,
                bridgeError: s.gate.bridgeError,
              }
            : null,
          comments,
        }));
    });
  const gates = resolveGates(gateStepInputs);

  // 5. Derived sets (spec §5.5).
  return {
    issues,
    runs,
    pending,
    maxConcurrent: config.maxConcurrent,
    launchBreadcrumbs: deps.listLaunchBreadcrumbs(),
    gatesPosted: gates.gatesPosted,
    gateReplies: gates.gateReplies,
    gateReprompts: gates.gateReprompts,
    gateFailures: gates.gateFailures,
    runToIssue: link.runToIssue,
    issueToRun: link.issueToRun,
    orphans: findOrphans(runs, pending, markedRunIds, runDirSet, recovery),
    stale: findStaleMarkers(issues, runDirSet),
    linkageFaults: link.faults,
    escalated: [...new Set(scanned.flatMap((s) => s.failedMarkers))],
  };
}

export { ObserveError, realObserveDeps } from "./observe-deps.js";
