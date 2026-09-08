---
sidebar_position: 3
title: Two yak:status labels on one issue
---

# Two `yak:<status>` labels on one issue

The state machine is one single-valued label. Exactly one `yak:<status>`
per issue. Two is a **harness fault** — something outside the harness
(a human, another tool, a bad manual edit) added a second one.

## What the harness does

Nothing, for that issue. `observe` records the fault on the issue and
`plan` skips it entirely — no relabel, no gate post, no launch, no
resume. It contributes zero actions, so a tick over an otherwise-quiet
backlog just shows `0 action(s)`. Every other issue is processed
normally.

This is intentional: the harness cannot know which of the two labels is
the truth, and guessing could drive a wrong transition (relaunch a
finished issue, mark a running one done).

## Fixing it

Look at the issue's marker comments and the run they point at:

```bash
cat <yakRepoPath>/.runs/<run-id>/journal.jsonl | tail -1
```

Then remove whichever `yak:<status>` label does **not** match the run's
real state, leaving exactly one. The next tick picks the issue back up.

If you genuinely do not know, set it to `yak:failed` and let the
escalation flow (read the journal, decide, reset) take over.
