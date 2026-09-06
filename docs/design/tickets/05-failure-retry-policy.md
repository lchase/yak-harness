# 05 — Failure / retry policy

Type: grilling
Status: resolved
Blocked by: —

## Question

Ticket 03 defines `yak:failed` as a trap state and every edge into it
(`failed` / `stalled` / orphan / stale marker, `ok`-without-PR, PR
closed-unmerged). What it deliberately left open: whether the harness
does anything **before** landing an issue in `yak:failed`, and what
`yak:failed` looks like to a human beyond the bare label.

Decide:

1. **Auto-retry on run failure.** When a `yak run` ends `failed`
   (non-gate `StepFailure`, process death), does the harness relaunch
   it? How many times? Same workflow/input, or is a failed run always
   a human's problem? Note: a relaunch is a fresh run id + fresh
   marker (ticket 01 last-marker-wins already supports this).
2. **Back-off.** If retries happen, how are they spaced — next tick,
   N ticks, wall-clock? Where is the attempt count durably kept (it
   can't be harness memory — stateless; candidates: count `yak-harness
   run=` markers on the issue, or a new `yak-attempt` marker).
3. **`stalled` runs.** Ticket 02 classifies a run `stalled` (alive +
   journal mtime past threshold). Does the harness kill the process
   (how — it only has the run id, not a pid; is there a `yak` command
   for this or does it `pkill` by worktree path?), just relabel to
   `yak:failed` and leave the process, or something else?
3. **`yak:failed` escalation.** Beyond the label: does the harness post
   a comment on the issue explaining what broke (last `StepFailure`
   reason from the journal, or the stall)? @-mention anyone? This is
   the "does a `yak:failed` issue get more than a label" piece pulled
   from the observability fog.
4. **Interaction with cap=1.** A run stuck retrying holds the slot.
   Does a retrying issue still count as in-flight? Does repeated
   failure eventually free the slot by giving up?

Recommendation going in: small fixed retry count (1-2) for transient-
looking failures only, attempt count read from marker history, no
process-killing (relabel stalled runs and let yak/the box reap the
process), one explanatory comment on entering `yak:failed`. Keep it
minimal — this is a reconciler, not an orchestration platform.

## Answer

### Ground fact that shaped this

yak's `StepFailure` (`src/ir/types.ts`) is `{ reason, detail,
recoverable: boolean }` over 9 reasons (`needs-decision`,
`needs-context`, `schema-invalid`, `budget-exhausted`, `tool-denied`,
`adapter-error`, `command-failed`, `timeout`, `sandbox-error`). The
**`recoverable` flag is yak's own call on whether a retry could help** —
the harness keys off it rather than maintaining its own reason
allowlist. yak has no `cancel` command and writes no pidfile.

### 1. Auto-retry on `failed`

Retry **iff** `terminalFailure.recoverable === true` AND
`attemptCount < 2`. Otherwise → `yak:failed` immediately.

- `recoverable: false` (`tool-denied`, `needs-decision`,
  `needs-context`, …) → straight to `yak:failed`; retrying is
  pointless by yak's own assessment.
- `schema-invalid` and friends: trust whatever `recoverable` yak set.
- A retry is a **fresh `yak run`** (new run id, new
  `yak-harness run=` marker — ticket 01 last-marker-wins). Never
  `yak resume` — a failed run is not suspended.
- Hard cap **2 attempts total** (original + 1 retry). Second failure
  → `yak:failed` regardless of `recoverable`.

### 2. Attempt count + back-off

- **Attempt count = the number of `yak-harness run=` marker comments
  on the issue.** No new marker type. Ticket 02 §3 already scans every
  marker each tick; `markers.length` is the count. `plan` schedules a
  retry when: active run observed `failed`, its terminal failure
  `recoverable`, `markers.length < 2`, and no live orphan / free cap
  slot (normal launch-precedence rules — retry is just a launch).
- **No explicit back-off.** The retry fires on the next tick that has
  a free cap=1 slot. The cron interval (minutes) *is* the spacing; a
  `recoverable` failure is transient and clears fast. Tick-counting or
  wall-clock delay would be state for a 1-retry policy — not worth it.

### 3. `stalled` runs — harness kills them

The harness launches `yak run` **detached** (a tick cannot block for a
multi-hour AI run), so a stalled run is otherwise an un-killable zombie
burning tokens. Mechanism:

- **Promote** ticket 02's `.harness/launching` breadcrumb instead of
  deleting it: on successful detached launch write
  `.harness/runs/<run-id>.json` = `{ pid, issue, launchedAt }`.
- `stalled` (ticket 02: `alive` + journal mtime past the configured
  threshold): read the pid file, verify the pid is alive and is a
  `yak` process (guard against pid reuse — check the process command),
  `kill` it, then relabel the issue `yak:failed`.
- Harness-local operational state, **non-load-bearing**: a stale pid
  file → the kill no-ops; the full issue+`.runs/` scan remains
  authoritative for everything else. The harness may delete
  `.harness/runs/*` at any time.
- **`stalled` never retries** — no `recoverable` signal exists (the run
  never produced a terminal `StepFailure`), and a stall means
  genuinely wedged, not transient. Straight to `yak:failed`.

### 4. `yak:failed` escalation — one comment

On every transition into `yak:failed`, post **one** comment guarded by
a `<!-- yak-failed run=<id> -->` marker (idempotency), containing:

- **What broke:** the terminal `StepFailure` `reason` + `detail` (via
  yak's `failedStepsFromJournal` over `.runs/<id>/journal`); or
  `"run stalled — no journal activity for <duration>, process killed"`;
  or `"run finished ok but produced no PR"`.
- **What was tried:** `"attempt 2 of 2"` / `"not retried — tool-denied
  is not recoverable"`.
- **What the human does:** inspect `.runs/<run-id>/journal`, then
  either fix and relabel `yak` for a clean relaunch, or close the
  issue.

No `@`-mention in v1 — the label plus a comment on an issue the human
already curated is signal enough, and there is no notify-list in
config yet. An assignee / mention list can graduate into ticket 06.

### 5. Interaction with cap=1

- A run mid-retry counts as in-flight exactly like any launch — it
  holds the one slot while `alive`/`suspended`.
- Repeated failure **does** eventually free the slot: attempt 2 fails
  → `yak:failed` → the run is terminal (`failed`), no longer counted
  in-flight, slot released next tick.
- A `stalled` run holds the slot only until the tick that kills it and
  sets `yak:failed`.

### Candidate yak tickets — noted, not depended on

- **`yak cancel <run-id>`** — clean engine-side termination of a live
  run (SIGTERM the process tree, journal a terminal
  `run.finished{status:'failed', reason:'cancelled'}`, release the
  worktree lock). Removes the harness's need to track pids and
  `kill(2)` yak's process directly. The harness ships with the pid-file
  workaround; this is the clean fix.
- (Plus ticket 01's existing `yak run --tag` and run-id-to-stderr
  candidates.)
