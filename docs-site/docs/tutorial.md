---
sidebar_position: 4
title: "Tutorial: a full loop"
---

# Tutorial: a full loop

This walks one issue from `yak` to `yak:done` — launch, answer a gate in
a comment, PR opens, merge, terminal — then resets so you can do it
again.

:::caution Spends real API budget
Every `yak run` here is a real `claude-code` adapter run. The
[quickstart](./quickstart) proves the mechanics for free; this page is
the one that costs money.
:::

## The sandbox

[`lchase/yak-kanban-sandbox`](https://github.com/lchase/yak-kanban-sandbox)
is a deliberately small repo — a static kanban board with a handful of
planted bugs — plus scripts to seed a backlog and reset it. Its
`RUNBOOK.md` is the canonical version of this walkthrough; the shape
below is the same.

```bash
git clone git@github.com:lchase/yak-kanban-sandbox.git
cd yak-kanban-sandbox
npm install
```

The pristine state is the `seed` git tag. `npm test` is green on `seed`
(it is the workflow's `verify` gate); `npm run test:bugs` is red by
design (the planted-bug pins).

## 1. Seed the backlog

```bash
scripts/seed-issues.sh lchase/yak-kanban-sandbox
```

Creates the `yak` label and five issues, each labelled `yak` and
nothing else. In the state machine every one is "qualified, not yet
launched."

## 2. Point the harness at the checkout

```json title="harness.config.json"
{
  "repo": "lchase/yak-kanban-sandbox",
  "yakRepoPath": "/ABS/PATH/TO/yak-kanban-sandbox",
  "stalledAfterMinutes": 30,
  "workflow": "implement-change"
}
```

`implement-change` is the workflow the harness bundles — see
[Configuration reference](./configuration#workflow). The harness
resolves the bare name to its own `workflows/implement-change.yaml`.

## 3. Drive ticks

Run a tick, wait a few minutes, run another:

```bash
yak-harness tick --config harness.config.json
```

Because the harness launches **one run per tick**, the first few ticks
ramp the backlog up to `maxConcurrent` (default 2). Watch the labels
move:

```
yak  →  yak:running  →  (yak:waiting on a gate)  →  yak:pr-open  →  yak:done
```

:::tip Watch it happen
In another terminal, leave the [dashboard](./monitoring) running:

```bash
yak-harness dashboard --config harness.config.json --serve
```

Open `http://127.0.0.1:8787`. Each run shows up on its workflow — which
step it is on, what `assess` decided, the gate prompt when it suspends.
It refreshes itself; you never touch it.
:::

Expected paths differ by issue — a localised bug with high `assess`
confidence runs hands-free to `yak:pr-open`; one where `assess` is
unsure stops at a `confirm-scope` gate; a feature fires the design and
design-review steps.

## 4. Answer a gate

When an issue lands in `yak:waiting`, the harness has posted a comment
like:

~~~text
🐂 **yak needs a decision — `confirm-scope`**

<the workflow author's prompt, verbatim>

---
**To answer, reply to this comment with:**
```
decision: proceed | narrow | abort
notes: <optional …>
```
Run `2026-09-07T15-04-11Z-9c2a` · step `confirm-scope`
~~~

Reply in a **new issue comment** following that `key: value` contract,
from an account whose `author_association` is `OWNER`, `MEMBER`, or
`COLLABORATOR`:

```
decision: proceed
notes: scope looks right, go ahead
```

The next tick parses the reply, validates it against the gate's schema,
writes `pending/confirm-scope.answer.json`, and runs `yak resume`. The
label moves back to `yak:running`.

Get the format wrong and the harness posts **one** re-prompt naming
exactly what was wrong. A second bad reply sends the issue to
`yak:failed`. A gate you never answer just sits in `yak:waiting`
forever, holding its concurrency slot — that visible stall is the
signal, by design. Full details in [The gate bridge](./gate-bridge).

## 5. Review and merge the PR

Each finished run opens a PR against `main` from its `yak/<run-id>`
branch, and the issue is `yak:pr-open`. Review it. Then:

- **merge** → the next tick sees the merged PR and moves the issue to
  `yak:done`.
- **close unmerged** → the next tick moves it to `yak:failed` (the
  harness runs no PR-revision loop).

The harness does **not** close the issue or delete the branch — a
`Closes #N` in the PR body closes the issue on merge; branch deletion is
GitHub's auto-delete setting or yours.

## 6. Reset and go again

```bash
scripts/reset.sh
```

Resets the sandbox repo to `seed`, prunes the `yak/*` worktrees and
branches the runs created (which also closes their PRs), and is
re-runnable any number of times. The seeded issues stay open — the
harness never closes issues — so close or delete them by hand for a
fully clean slate, then re-seed.

## What you just exercised

- `yak` → `yak:running` with a marker comment and worktree isolation
- one launch per tick honouring `maxConcurrent`
- the gate bridge round-trip: verbatim prompt + generated contract →
  parsed `key: value` reply → `writeAnswer` → `yak resume`
- `yak:pr-open` → `yak:done` on merge
- `.harness/tick.log`, one JSON line per tick
- the [dashboard](./monitoring) showing each run on its workflow as it moved
- `reset.sh` making the whole thing repeatable
