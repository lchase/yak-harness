---
sidebar_position: -1
title: Why yak-harness
---

# A backlog label goes in. A merged PR comes out.

[yak](https://lchase.github.io/yak/) runs one agent workflow to
completion: `yak run <workflow>`, answer a gate or two, get a branch and
a PR. It has no idea what a GitHub issue is, and that is deliberate —
yak's job stops at the edge of your repo.

`yak-harness` is the piece that stands at that edge. Put a label on an
issue; the harness launches a `yak run` for it, watches the run's
journal, moves a status label as the run progresses, relays yak's gate
prompts into issue comments so you can answer them from GitHub, and
marks the issue done when the PR merges. It is the difference between
"I run yak by hand for each task" and "my backlog drains itself."

## The shape of it

The harness is a **stateless cron reconciler** — the same mental model
as yak itself: a build system whose compilers are nondeterministic.
Every five minutes (or whatever your crontab says) it wakes up and runs
one **tick**:

1. **observe** — read what you want (issues carrying the `yak` label and
   their status labels) and what is true (yak runs on disk, PRs on
   GitHub).
2. **plan** — a pure function from that observation to a list of
   actions. No I/O, no clock.
3. **apply** — carry out the actions: launch a run, post a gate comment,
   move a label, resume a suspended run.

Then it exits. Nothing runs between ticks. There is no daemon, no queue,
no database.

## Where the state lives

Durable state lives in exactly **two** places, neither of them the
harness:

- **GitHub** — the issue's status label, and hidden marker comments that
  link an issue to its run.
- **yak's `.runs/` journal** — the authoritative record of what a run
  did.

The harness keeps only throwaway scratch in `.harness/` (a lock file,
per-run pid files). Delete that directory between ticks and nothing
breaks — the next tick rebuilds every fact it needs by rescanning
GitHub and `.runs/`. That property is the whole design: a tick can die
at any point, half-done, and the next one recovers.

## What it deliberately does not do

- **It never patches yak or reaches past yak's documented CLI.** yak's
  engine stays entirely ignorant that GitHub exists. See
  [How yak works](./how-yak-works) for the exact contract.
- **It performs zero destructive cleanup** — never closes an issue,
  deletes a branch, or touches a `.runs/` directory. Those are yours or
  GitHub's to do.
- **It has no LLM in the loop.** Gate replies are parsed with
  line-based `key: value` matching, not a model. The harness is plumbing.
- **It runs one workflow per deployment.** Label-routing to different
  workflows per issue is out of scope for v1.

## Read next

- [How yak works](./how-yak-works) — the parts of yak you need to
  understand to operate the harness: runs, the journal, gates,
  worktree isolation, `StepFailure`.
- [Install & setup](./install) — the box preconditions and
  `yak-harness doctor`.
- [Concepts](./concepts) — the tick, the label state machine, marker
  comments.
- [Quickstart](./quickstart) — point it at a repo and watch one label
  move, no real run required.
