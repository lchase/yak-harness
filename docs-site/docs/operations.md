---
sidebar_position: 9
title: Operations
---

# Operations

Running the harness unattended: scheduling, logs, recovery, and the
things it deliberately will not do for you.

## Scheduling

Plain system `cron`, one line:

```cron
*/5 * * * * yak-harness tick --config /srv/harness.config.json
```

That is the whole deployment. There is no service to keep alive.

Overlap is the harness's problem, not yours: `tick` takes an exclusive
lock on `.harness/tick.lock` at startup and exits 0 immediately if
another tick still holds it. A slow tick that runs past the next cron
fire is safe with no setup.

A `systemd` timer is a supported alternative — a `.timer` +
`.service` pair calling the same command. No unit files are shipped;
the `OnCalendar=*:0/5` equivalent of the crontab line is all it needs.

Keep the interval short enough that gates feel responsive (a reply is
picked up on the next tick) and long enough that a `recoverable`
failure has cleared before the retry fires. Five minutes is a fine
default.

## `tick.log`

Every real tick appends one JSON line to
`<yakRepoPath>/.harness/tick.log`:

```json
{"ts":"2026-09-07T14:02:09.114Z","durationMs":1840,"counts":{"issues":3,"runs":{"alive":1,"suspended":1}},"actions":["posted gate prompt on #7 …","relabelled #7: running → waiting"],"errors":[]}
```

The harness rotates the file itself at 2 MiB — `tick.log` →
`tick.log.1`, one generation kept, no `logrotate`. Fatal preconditions
(bad config, failed precondition) go to stderr with a non-zero exit,
not into the log. Nothing is sent anywhere remote; the durable
human-facing record is the GitHub issues themselves.

## Recovery

The harness holds no load-bearing state, so recovery is automatic:

- **A tick killed mid-`apply`.** The next tick re-observes and
  re-plans. Every action is idempotent and guarded — a half-posted
  transition is completed, not duplicated.
- **`.harness/` deleted.** A full rescan of GitHub + `.runs/`
  reconstructs every fact. You lose only the pid files (a stalled-run
  kill becomes a no-op until the run is re-observed) and the log.
- **A stale lock file** (tick died without releasing it) is stolen once
  by the next tick after it verifies the recorded pid is dead.
- **The box replaced**, `.runs/` gone. Issues whose marker points at a
  now-missing run become "stale marker" — if their label says
  in-progress the harness moves them to `yak:failed`. It **never**
  auto-relaunches off a marker alone.

## The `yak:failed` trap

`yak:failed` means *a human is needed*. The harness never auto-leaves
it. Every transition into it posts **one** comment (guarded by a
`<!-- yak-failed run=<id> -->` marker) explaining what broke, what was
tried, and what to do.

Causes and recovery:

| cause | comment says | you do |
|---|---|---|
| terminal `failed`, not `recoverable` | the `StepFailure` reason + detail | fix the cause, then set the label back to `yak` for a clean relaunch, or close the issue |
| terminal `failed`, `recoverable`, retry cap spent | "attempt 2 of 2 — cap spent" | same |
| `stalled` | stall duration + what became of the killed pid | inspect `.runs/<id>/journal`, decide whether to relaunch |
| `ok` but no PR | "open-pr produced nothing (workflow bug)" | fix the workflow |
| PR closed unmerged | "no PR-revision loop" | reopen/remake the PR yourself, or close the issue |
| gate the bridge can't handle | "hand-write `pending/<step>.answer.json`" | write the answer file, `yak resume <id>`, drop the label |

Resetting the label to `yak` posts a fresh marker on the next launch —
the retry counter is the marker count, so a manual reset does not
bypass the 2-attempt cap unless you also remove earlier markers.

## Retry vs stalled

- **Retry** happens automatically: only when yak marked the failure
  `recoverable` **and** there have been fewer than 2 attempts. A retry
  is a fresh `yak run` (new id, new marker), never `yak resume`. No
  back-off — the cron interval is the spacing.
- **Stalled** never retries. A stall (no journal activity within
  `stalledAfterMinutes`) means genuinely wedged, and there is no
  `recoverable` signal to key off. The harness kills the recorded pid
  (after checking it is alive *and* a `yak` process — pid-reuse guard)
  and moves the issue to `yak:failed`.

## What the harness never does

- Close an issue (a `Closes #N` in the merged PR does that; otherwise a
  human).
- Delete a `yak/<run-id>` branch (GitHub auto-delete, or a human).
- Touch `.runs/` directories or worktrees — yak owns and cleans that
  tree.
- Delete or strike through its own marker comments — permanent history.
- Pause or cancel a live run — it has no such power over yak.

## Repeatability

For a sandbox loop you want to run more than once, keep a pristine tag
(the `yak-kanban-sandbox` uses `seed`) and a `scripts/reset.sh` that
resets to it and prunes the `yak/*` worktrees and branches the runs
left behind. See the [tutorial](./tutorial#6-reset-and-go-again).
