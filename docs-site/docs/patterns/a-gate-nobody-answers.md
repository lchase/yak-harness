---
sidebar_position: 2
title: A gate nobody answers
---

# A gate nobody answers

An issue in `yak:waiting` with a gate comment and no reply will stay
there **forever**. There is no timeout, and that is deliberate — the
run is suspended with its work intact, and auto-failing it to reclaim
the slot would throw that work away.

## What it costs

The suspended run keeps its concurrency slot the whole time. If enough
gates pile up unanswered, new launches stall because
`maxConcurrent` is full of waiting runs. That visible queue stall **is
the signal** that gates need attention.

## Options

- **Answer it.** Reply to the gate comment following the `key: value`
  contract, from an `OWNER` / `MEMBER` / `COLLABORATOR` account. Next
  tick resumes the run.
- **Park it.** Add `yak:hold`. The harness skips the issue entirely —
  it no longer counts toward anything the harness does. (It does *not*
  stop the suspended run existing; it just removes it from the
  harness's attention.)
- **Raise `maxConcurrent`.** If unanswered gates are a chronic drag on
  throughput, more slots is the intended lever — not a gate timeout.

## If your reply is not being picked up

- It must be posted **after** the harness's gate comment.
- Your `author_association` on that repo must be `OWNER`, `MEMBER`, or
  `COLLABORATOR` — `CONTRIBUTOR` and `NONE` are ignored silently.
- It needs at least one `field: value` line matching a schema property.
- After one malformed reply you get a single re-prompt; a second
  malformed reply sends the issue to `yak:failed`.
