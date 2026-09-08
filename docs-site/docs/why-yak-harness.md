---
sidebar_position: 1
---

# Why yak-harness

:::info Placeholder
This page is a scaffold stub. The full zero-to-hero documentation is
tracked in [issue #29](https://github.com/lchase/yak-harness/issues/29).
:::

`yak-harness` is a **stateless cron reconciler** that sits between a
GitHub Issues backlog and [yak](https://github.com/lchase/yak). Each run
("tick") it wakes, reads desired state (qualifying issues + their status
labels) and observed state (yak runs on disk, PRs on GitHub), computes
the diff, applies **one step** toward closing it, and exits. No daemon;
nothing runs between ticks.

Two jobs:

1. **Manage a GitHub Issues backlog by label** — launch a `yak run` per
   qualifying issue and drive a status-label state machine.
2. **Bridge yak's gate protocol** — post the rendered prompt as an issue
   comment, parse a human's reply into a schema-valid answer, resume the
   run.

Durable state lives in exactly two places, neither of them the harness:
GitHub (issue labels + hidden marker comments) and yak's `.runs/`
journal. Delete `.harness/` between ticks and a full rescan reconstructs
the truth.

See [`docs/spec.md`](https://github.com/lchase/yak-harness/blob/main/docs/spec.md)
for the full design.
