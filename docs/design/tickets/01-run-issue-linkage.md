# 01 — Run ↔ issue linkage

Type: grilling
Status: resolved
Blocked by: —

## Question

The harness must know, at any moment, which GitHub issue a given yak
run serves — so it can comment on the right issue when that run
suspends on a gate, and set the right labels when it finishes. yak
provides no such linkage: run ids are engine-generated
(`engine/run.ts` `generateRunId`), there is no `yak run --id`, and the
engine must stay ignorant of GitHub. So the harness owns this mapping.
It is also **stateless** (cron reconciler) and must survive its own
restarts — a fresh harness process on the next tick has to reconstruct
the mapping from durable state it can read.

Decide:

1. **How the mapping is captured at launch.** Options on the table:
   (a) launch `yak run`, then read the newest directory under `.runs/`
   and pull its `run.started` journal event to learn the id (safe
   safe under the one-launch-per-tick sole-launcher rule, racy otherwise);
   (b) parse the run id off `yak run`'s stdout — but that line only
   prints at terminal state, not at launch, so the harness would have
   to wait for suspend/finish;
   (c) something else.
2. **Where the mapping durably lives** so a restarted harness rebuilds
   it: a harness-owned sidecar file (e.g. `.harness/runs.json` — the
   harness may keep its own state, it just isn't *yak's* journal); or
   the GitHub issue itself as source of truth (harness posts the run
   id as a comment / hidden marker when it launches, and rebuilds the
   map each tick by scanning issues); or both (sidecar as cache,
   issue-scan as the authoritative rebuild).
3. **Reverse lookup** — given a suspended run id from `yak pending`,
   how the harness resolves it back to an issue, including the case
   where the sidecar is missing/stale.
4. Whether to **note a yak ticket** proposing `yak run --id` /
   `--label` as the clean long-term fix (out of scope to depend on
   here — see map's Out of scope).

Recommendation going in: (a) for capture + (b-as-issue) source of
truth with a sidecar cache — encode nothing load-bearing in a place
that can't be rebuilt from the tracker.

## Answer

The harness owns the issue ↔ run mapping entirely, keeps it **in the
tracker** (no load-bearing local state), and reconstructs it from
scratch every tick.

### 1. Capture at launch — snapshot-and-diff `.runs/`

The harness is the sole launcher and does **one launch per tick**
(ticket 02 precedence D — unchanged by ticket 06 raising the in-flight
cap from 1 to `maxConcurrent`, default 2), so within any tick a single
`yak run` is launched serially:

1. `listdir(.runs/)` → `before` set.
2. `yak run <workflow> --isolation worktree` (the harness picks the
   workflow/issue per tickets 02/03).
3. `listdir(.runs/)` → `after` set. `after - before` must be exactly
   one dir; that name is the run id.
4. Assert before trusting: read `<runDir>/journal` first event, require
   `t: 'run.started'` with `workflow` matching what was launched and a
   `launched` timestamp within the tick window. A zero-diff or
   multi-diff result is a harness fault — abort the tick, log, do not
   launch again.

Rejected: parsing the id off `yak run` stdout (only printed at terminal
state — would block the tick until the run suspends/finishes, breaking
the wake/act/exit cron model); per-issue `--runs-dir` (splits yak's
journal across directories).

### 2. Durable linkage — marker comment on the issue, issue-only

Immediately after the id is resolved (step 1.3) and before the tick
exits, the harness posts one comment on the originating issue:

```
🐂 yak run started: `2026-09-05T14-03-11Z-a1b2`
<!-- yak-harness run=2026-09-05T14-03-11Z-a1b2 branch=yak/2026-09-05T14-03-11Z-a1b2 launched=2026-09-05T14:03:12Z -->
```

The machine reads only the HTML comment; the prose line is for humans
and is ignored by the parser. This is the **sole** durable linkage —
consistent with the map Note "encode nothing load-bearing in a place
that can't be rebuilt from the tracker".

A `.harness/runs.json` cache is **deferred** (see map "Not yet
specified: config surface") — added only if per-tick GitHub API volume
hurts. When added it is a pure cache: any miss or staleness falls back
to the full scan, and the harness may delete it at any time with no
correctness loss.

### 3. Reconstruction each tick — one scan, both directions

1. List issues carrying **any harness-relevant label** — the
   qualifying/backlog label *or* any harness-managed status label
   (ticket 03 defines the set). Widening past the backlog filter is
   required: an in-progress issue whose label has already moved off the
   backlog filter must still be scanned.
2. For each, read comments, extract every marker's `run=`. The **last**
   marker comment is the issue's current run; earlier markers are
   history (a legitimate re-run after a failure posts a fresh marker —
   last-wins, no strike-through of the old one).
3. Build `runId → issueNumber` and its inverse from that single scan.
   No extra API calls for the reverse direction.

### 4. Reverse lookup (`yak pending` run id → issue)

`yak pending` yields suspended run ids each tick; resolve each via the
inverted scan dict from §3. A run id with no entry is not silently
dropped — it is an orphan or stale case (§5).

### 5. Orphans and stale markers

**Orphan** — a `.runs/` dir or `yak pending` entry with no marker on
any scanned issue (crash between `yak run` and the marker post, or a
human deleted the marker / unqualified the issue):

- Run alive or suspended: the harness logs loudly, counts it against
  the in-flight budget (`maxConcurrent`), launches nothing new, and never guesses
  an issue. **One live orphan wedges the whole harness until a human
  clears it** — at this scale that is strictly safer than mislinking a
  gate comment to the wrong issue.
- Run already `ok`/`failed`: no gate to bridge, nothing to post. Log
  once, leave the dir for yak to clean up, continue.

**Stale marker** — an issue's last marker points at a run id with no
`.runs/` dir (box replaced, `.runs/` pruned, manual `rm`):

- Treat the issue as having no active run.
- If its labels say in-progress, transition it to the failed /
  needs-human state (ticket 03).
- Never auto-relaunch off a marker alone.

### 6. Candidate yak tickets — noted, not depended on

Per the map's Out of scope ("any such change is a separate yak ticket,
noted not depended on"):

- **`yak run --tag <string>`** — caller-supplied correlation tag,
  stored in the `run.started` journal event and echoed by
  `yak pending`. Collapses §1 + §2 + §5 into a direct lookup: the
  harness passes the issue number as the tag and reads it straight
  back. The clean long-term fix; the harness ships without it.
- **`yak run` prints the run id to stderr at launch** (not only at
  terminal state). Smaller change, no journal schema impact; makes §1
  capture exact instead of diff-based.
