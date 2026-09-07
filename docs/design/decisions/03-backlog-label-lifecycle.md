# 03 — Backlog label lifecycle state machine

Type: grilling
Status: resolved
Blocked by: 01

## Question

dark-factory ticket 02 (an event-driven GitHub Action) got away with
two labels: `dark-factory` to qualify, `dark-factory-in-progress` for
idempotency. A cron reconciler has states that an event Action never
had to model — a run can be alive, suspended on a gate, crashed,
stalled, or finished with a PR open — and each tick must decide what to
do from labels + observed run state alone.

Decide:

1. **The label set and what each means** — qualifying filter,
   in-progress, gate-waiting (human action needed), PR-open,
   failed / needs-human, done. Which are harness-managed vs
   human-managed.
2. **The transition table** — for every (label state, observed run
   state) pair, the target label state and the action. Include the
   terminal cases: PR merged → clean up; PR closed unmerged → ?;
   issue un-qualified mid-run → ?
3. **Who sets what.** The human adds the qualifying label; everything
   else the harness drives. Any human overrides (e.g. a "hold" label
   that parks an issue)?
4. **Relationship to dark-factory ticket 01** — that ticket made the
   label filter the primary defence against bad scope, with
   `confirm-scope`'s gate as a backstop. This lifecycle must not
   undermine that.
5. **Failure states feed "Not yet specified: failure / retry policy"**
   — this ticket defines the *failed* state and how you enter it; the
   retry behaviour from that state graduates separately.

Recommendation going in: model it explicitly as a small state machine
in the spec (a table, not prose), with the harness only ever
transitioning on evidence from `yak`'s journal, never on a timer alone.

## Answer

### 1. Label set

**One harness-owned status label, single-valued**, `yak:` prefix.
`(current yak:<status>, runClass) -> (next yak:<status>, action)` is the
whole state machine. The observation must read exactly one `yak:<status>`
per issue; two is a harness fault → flag, act on nothing.

Six states:

| Status | Meaning | Run class behind it | Owner |
|---|---|---|---|
| `yak` only, no `yak:<status>` | qualified, not yet launched | no run | human adds `yak` |
| `yak:running` | run launched, working | `alive` | harness |
| `yak:waiting` | suspended on a gate — **human reply needed** | `suspended` | harness |
| `yak:pr-open` | run finished ok, PR opened | `ok` + PR open | harness |
| `yak:failed` | failed / stalled / orphan / stale marker — **needs human** | `failed`, `stalled`, orphan, stale | harness |
| `yak:done` | PR merged — terminal, inert | `ok` + PR merged | harness |

Human-owned extras:

- **`yak`** — the qualifying filter (dark-factory ticket 01's primary
  scope defence). A human only labels issues they already believe are
  well-scoped. Stays on for the whole lifecycle, including `yak:done`
  (history: "went through yak and shipped").
- **`yak:hold`** — park override. While present the harness skips the
  issue **entirely**: no observation contribution, no gate post, no
  relabel, no resume, at any status. It does **not** pause a live
  `yak run` (the harness has no such power — the run keeps going);
  it only freezes the harness's own reactions. Remove it to resume
  normal reconciliation.

No `yak:queued` (qualified-not-launched = `yak` with no status label).
No separate `yak:stalled` (folded into `yak:failed`; the retry-policy
fog may split it out later).

### 2. Transition table

`∅` = no `yak:<status>` label. Columns are the observed `runClass`
from ticket 02 plus PR state. Cell = `(next status, action)`;
`—` = no change.

| current \ observed | `none` | `alive` | `suspended` | `ok` no PR | `ok`+PR open | `ok`+PR merged | `ok`+PR closed-unmerged | `failed`/`stalled`/orphan/stale |
|---|---|---|---|---|---|---|---|---|
| **`yak`, ∅** | launch → `yak:running` | recover marker → `yak:running` | `yak:waiting` + post gate | `yak:failed` | `yak:pr-open` | `yak:done` | `yak:failed` | `yak:failed` + flag |
| **`yak:running`** | `yak:failed` (stale marker, ticket 01 §5 — never auto-relaunch) | — | `yak:waiting` + post gate | `yak:failed` (ok but no PR = workflow bug) | `yak:pr-open` | `yak:done` | `yak:failed` | `yak:failed` + flag |
| **`yak:waiting`** | `yak:failed` | `yak:running` (resumed, working) | — (re-prompt logic is ticket 04) | `yak:failed` | `yak:pr-open` | `yak:done` | `yak:failed` | `yak:failed` + flag |
| **`yak:pr-open`** | `yak:failed` | `yak:running` | `yak:waiting` | `yak:failed` | — | `yak:done` | `yak:failed` (human closed PR unmerged) | `yak:failed` |
| **`yak:failed`** | — | — | — | — | — | — | — | — |
| **`yak:done`** | — | — | — | — | — | — | — | — |

Rules the table encodes:

- **`yak:failed` is a trap.** The harness never auto-leaves it. A human
  investigates and either fixes + manually resets the label (to `yak`
  for a clean relaunch, or `yak:running` if the existing run is
  salvageable), or closes the issue. This is the single "needs-human"
  bucket that the deferred *failure / retry policy* fog will later
  refine (auto-retry N times before landing here, etc.).
- **`ok` with no PR** → `yak:failed`. Success exit but `open-pr`
  produced nothing = a workflow bug a human must see.
- **PR closed unmerged** → `yak:failed`. Consistent with the map's
  Out-of-scope call on the PR-revision loop — the harness does not
  reopen or re-drive.
- **Stale marker while `yak:running`** (observed `none`) → `yak:failed`,
  never a silent relaunch (ticket 01 §5).
- The harness only ever transitions on **evidence from yak's journal /
  on-disk state**, never on a timer alone (`stalled` itself is a
  journal-mtime fact from ticket 02, not a harness clock).

### 3. Who sets what

Human: `yak` (gate in), `yak:hold` (park), and manual label edits to
climb out of `yak:failed` or to abandon (close the issue). Everything
else is harness-driven, and every harness transition is one
remove-old-status + add-new-status pair (idempotent — ticket 02's
action C guard is "current labels ≠ target").

### 4. Relationship to dark-factory ticket 01

Unchanged and reinforced: `yak` (the qualifying label) remains the
**primary** scope defence — a human curates what enters. `confirm-scope`'s
in-workflow gate is the backstop, and when it fires with nobody
answering, this lifecycle surfaces it as `yak:waiting` (ticket 04
renders the gate) rather than leaving it invisibly suspended in
`yak pending` the way bare dark-factory did. The lifecycle adds
visibility; it does not widen what qualifies.

### 5. Failure states feed "Not yet specified: failure / retry policy"

This ticket defines the `yak:failed` state and every edge into it. It
deliberately does **not** define: how many auto-retries precede
`yak:failed`, back-off, whether a `stalled` run is killed or just
relabelled, or how `yak:failed` issues are surfaced to a human beyond
the label itself (that overlaps the *observability / human escalation*
fog). Those graduate separately.

### 6. PR state detection (surfaced while resolving)

The reference workflow's `open-pr` is a `command` step:
`produces: 'pr-url'`, `run: 'gh pr create --fill'`. When a run is
`ok`, the harness reads the **`pr-url` artifact** from the run dir
(a declared run output — as much a contract as `pending/`), then
`gh pr view <url> --json state,mergedAt` for open / merged / closed.
Fallback if the artifact is missing: `gh pr list --head yak/<run-id>`
(exact branch match — the worktree branch is deterministic, ticket 01
Notes). No dependence on the PR body mentioning the issue.

### 7. Cleanup

`yak:done` costs the harness exactly one relabel, then the issue is
inert. The harness performs **zero destructive cleanup**:

- Does not close issues (a `Closes #N` in the merged PR does it; if
  absent, a human closes — harness doesn't care).
- Does not delete the `yak/<run-id>` branch (GitHub auto-delete setting
  or a human — deleting git refs escapes the sandbox).
- Does not touch `.runs/` dirs or worktrees — the journal is yak's;
  yak cleans (ticket 01 §5).
- Never deletes or strikes through its marker comments
  (`yak-harness run=`, `yak-gate`, `yak-answered`, `yak-pr`) — they
  are permanent history.

### Candidate yak tickets

None new. (`open-pr` optionally posting its own `yak-pr` marker was
considered and rejected in favour of reading the `pr-url` artifact —
would have been workflow authoring, not an engine change, anyway.)
