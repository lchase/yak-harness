# 02 — Reconciler tick algorithm

Type: grilling
Status: resolved
Blocked by: 01

## Question

The harness is a stateless cron job: each tick it wakes, reconciles
observed state against desired state, acts, and exits — no daemon, no
in-memory state between ticks (the yak/archon "Make-like rebuild"
mental model). Pin the actual tick algorithm.

Decide:

1. **What each tick reads**, in what order: GitHub issues by label
   filter; `yak pending` output (suspended runs across all `.runs/`);
   the run ↔ issue mapping from ticket 01; per-run journal tails for
   liveness / failure detection.
2. **What actions a tick takes and their precedence** when several are
   eligible under the cap=1 constraint — e.g. is answering a pending
   gate always ahead of launching a new backlog run? What about
   cleaning up labels for a finished run?
3. **Idempotency / crash-safety.** A tick can die at any point. Every
   action must be safe to re-attempt next tick (posting the same gate
   comment twice, launching a second run for an issue that already has
   one, double-labelling). Which check guards each action.
4. **"Nothing to do" vs "blocked".** How a tick distinguishes a quiet
   backlog from a wedged run it shouldn't keep poking.
5. **Interaction with the label lifecycle (ticket 03)** — this ticket
   defines the *loop*; ticket 03 defines the *states* it drives. Keep
   the seam clean.

Recommendation going in: a single reconcile function —
`observe() -> plan(actions[]) -> apply()` — where `plan` is pure and
testable, `apply` does the GitHub / `yak` side effects, and every
action carries its own idempotency predicate.

## Answer

One reconcile function per tick: `observe() -> plan(observation) ->
apply(actions)`. `plan` is **pure** (data in, `Action[]` out — zero
I/O, testable with no mocks, matching yak's own engine-test rule).
`observe` does every read; `apply` does every GitHub / `yak` side
effect.

### 1. What `observe` reads (all reads live here)

Returns an `Observation`:

1. `issues[]` — **one** `gh` query for issues carrying any
   harness-relevant label (backlog label OR any harness status label —
   ticket 03 defines the set; must widen past the backlog filter so an
   in-progress issue is still seen). Parse marker comments (ticket 01)
   into `runId ↔ issueNumber` both ways.
2. `pending[]` — parsed `yak pending`: run id, open step ids, per-step
   `kind` + first line of `.rendered`.
3. `runs[]` — **one** `.runs/` listing; classify each by journal tail:
   - `alive` — last event is not `run.finished`
   - `suspended` — last event `run.finished` + `status: 'suspended'`
   - `ok` / `failed` — last event `run.finished`, that status
   - `stalled` — `alive` AND last journal event's mtime older than
     the configured staleness threshold (pure function of the
     journal; no harness state). The *action* on `stalled` belongs to
     ticket 03 + the deferred retry-policy fog — this ticket only
     defines the classification.
4. Derived: `orphans[]` (run dir / `pending` entry with no marker on
   any scanned issue), `stale[]` (issue marker whose `run=` has no
   `.runs/` dir).

The launch-time `.runs/` before-snapshot (ticket 01 §1) is **not**
part of `observe` — it is taken inside `apply` immediately before
`yak run`, or a run finishing mid-tick pollutes the diff.

### 2. Action set + precedence (cap = `maxConcurrent`, default 2 — ticket 06; was 1 at charting)

| # | Action | Trigger |
|---|--------|---------|
| A | Post gate comment | suspended run, no gate marker for this (run, step) |
| B | Write answer + `yak resume` | valid parsed reply (ticket 04), no answered-marker yet |
| C | Relabel finished run | current labels ≠ target for observed run class |
| D | Launch new backlog run | qualifying issue, no marker comment at all, **cap has room** |
| E | Flag orphan / stale | ticket 01 §5 cases |

Only **D** consumes the cap. A/B/C/E are bookkeeping on runs that
already exist and run **every tick regardless of in-flight count**.

`in_flight_count` = runs classified `alive` or `suspended` (a
suspended run still owns the slot — unfinished workflow).

Precedence within a tick:

1. **E first.** Any *live* orphan → plan E only, skip D this tick (a
   live orphan wedges new launches — ticket 01).
2. **B** — resuming may free the cap slot the same tick.
3. **A** — surface new gates.
4. **C** — clean up terminals.
5. **D** — at most **one launch per tick**, only if: no live orphan,
   `in_flight_count < maxConcurrent`, backlog non-empty, no
   `.harness/launching` breadcrumb present. **Still at most one launch
   per tick** even when several slots are free — idle ramps to full
   cap over a few ticks, keeping ticket 01's snapshot-diff capture
   unambiguous.

### 3. Idempotency predicate per action

All predicates are evaluated in `plan` from the `Observation` — no
action fires without its guard being clear.

| Action | Guard |
|---|---|
| A | no comment carrying `<!-- yak-gate run=<id> step=<stepId> -->` |
| B | reply present + parses valid + no `<!-- yak-answered run=<id> step=<stepId> -->` marker AND run still observed `suspended`. `apply`: `writeAnswer` (overwrite-safe), post answered-marker, `yak resume`. Tick death after `writeAnswer`/before resume → next tick redoes both (writeAnswer idempotent; resume re-derives from journal). |
| C | current labels ≠ target labels (label add/remove is idempotent in `gh`) |
| D | `in_flight_count < maxConcurrent` AND no launch already planned this tick AND issue has **no** marker comment AND no `.harness/launching` breadcrumb |
| E | needs-human label / marker not already present |

### 4. Launch-window crash — `.harness/launching` breadcrumb

The gap between `yak run` (dir + `run.started` created) and the marker
post: a crash there leaves an **orphan** run. Rather than let that
wedge the whole harness (ticket 01's default), contain the blast
radius:

- `apply`, before `yak run`: write `.harness/launching` containing the
  target issue number + timestamp + `.runs/` before-snapshot.
- `apply`, after the marker is posted: **promote** `.harness/launching`
  to `.harness/runs/<run-id>.json` = `{ pid, issue, launchedAt }`
  (ticket 05 — the detached-launch pid, used to kill a `stalled` run).
  The transient `launching` name is gone once promoted.
- `observe`, at tick start: if `.harness/launching` exists, a prior
  launch crashed mid-window. Diff `.runs/` against its recorded
  snapshot to find the orphan dir, post the marker for **that** issue
  now (recovering the link), then delete the breadcrumb. If the diff
  is ambiguous, flag **that one issue** for a human and delete the
  breadcrumb — the rest of the harness keeps running.

This is harness-local operational state, not load-bearing: worst case
it is a stale flag a human deletes, and the full issue-scan remains
the authority on linkage.

### 5. Quiet vs wedged

`observe` classifies a run `stalled` when it is `alive` and its
journal's last-event mtime is older than a configured threshold
(hours — a healthy agent step legitimately runs long). Pure, stateless,
no tick-counter. A quiet backlog (no issues, no runs) simply produces
an empty `Action[]` and the tick exits cheap. What to *do* with a
`stalled` run (kill / relabel / escalate) is ticket 03 + the deferred
"failure / retry policy" and "observability / human escalation" fog —
not this ticket.

### 6. Seam with ticket 03

- **02 owns:** the `observe/plan/apply` loop, the `Observation` type,
  run classification, action set + precedence, the in-flight cap
  (`maxConcurrent`), idempotency
  predicates, the `.harness/launching` breadcrumb.
- **03 owns:** the label set and a **pure transition table**
  `(labelState, runClass) -> (targetLabelState, actionKind)`.

`plan` **calls** 03's transition table as a pure function: for each
issue it looks up `(current label state, run class) -> target` and
emits the relabel + side-effect actions. No label strings appear
anywhere in 02 — they live only in 03. 03's table has no I/O and no
knowledge of the loop. Neither spec section restates the other; 02
names "the transition table (ticket 03)" as an input to `plan`.

### Candidate yak tickets — noted, not depended on

None new beyond ticket 01's (`yak run --tag`, run id to stderr at
launch).
