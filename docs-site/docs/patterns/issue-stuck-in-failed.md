---
sidebar_position: 1
title: An issue stuck in yak:failed
---

# An issue stuck in `yak:failed`

`yak:failed` is a trap — the harness put the issue there and will never
take it out. That is the design: it means a human decision is required.

## Find out why

There is exactly one escalation comment on the issue, guarded by a
`<!-- yak-failed run=<id> -->` marker. It names what broke, what the
harness tried, and what to do. If you want more, read the run journal:

```bash
cat <yakRepoPath>/.runs/<run-id>/journal.jsonl | tail
```

The last `run.finished` event carries the terminal status; a
`StepFailure` before it carries `{ reason, detail, recoverable }`.

## Get it moving again

Once the cause is fixed:

- **Relaunch from scratch** — set the label back to `yak` (remove
  `yak:failed`). The next tick with a free slot launches a fresh
  `yak run`.
- **Salvage the existing run** — if the run is actually resumable, set
  the label to `yak:running` and let the harness observe it.
- **Give up** — close the issue. The harness does not close it for you.

## The attempt cap still applies

The retry counter is the number of `yak-harness run=` marker comments on
the issue. Resetting to `yak` after two attempts and letting it relaunch
gets you a third marker — the cap is 2, so the harness will send it
straight back to `yak:failed` unless you also delete the earlier
markers. If you genuinely want a clean third attempt, delete the old
markers by hand first.
