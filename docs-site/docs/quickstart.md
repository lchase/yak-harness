---
sidebar_position: 3
title: Quickstart
---

# Quickstart

Point the harness at a repo, qualify one issue, and watch a single label
transition — first as a dry run that changes nothing, then for real.
This spends **no API budget** if you stop before the launch; the moment
you let a `launch-run` action through, a real `yak run` starts and costs
real tokens.

## Prerequisites

```bash
npm install -g @lchase/yak @lchase/yak-harness
```

A box that then passes [`yak-harness doctor`](./install#yak-harness-doctor)
and a git repo you have push access to. The examples use
`lchase/my-project`. Full setup and the box preconditions are on the
[Install](./install) page.

## 1. Write a config

```json title="/srv/harness.config.json"
{
  "repo": "lchase/my-project",
  "yakRepoPath": "/srv/my-project",
  "stalledAfterMinutes": 45
}
```

## 2. Qualify an issue

On any issue that describes **already-scoped** work an agent could
finish in one run, add the `yak` label — nothing else. In the state
machine that issue is now "qualified, not yet launched."

## 3. Dry-run the tick

```bash
yak-harness tick --config /srv/harness.config.json --dry-run
```

```
tick: 1 issue(s), 0 run(s) [none], 1 action(s)
  would launch-run   #42 → yak:running
```

`--dry-run` does `observe` + `plan` and prints the actions it *would*
take. It takes no lock and writes no log. Nothing changed on GitHub.

## 4. Run it for real

```bash
yak-harness tick --config /srv/harness.config.json
```

```
tick: 1 issue(s), 0 run(s) [none], 1 action(s)
  launched run 2026-09-06T09-12-44Z-a1b2 for #42 (pid 48210), set yak:running
```

Now look at issue #42: it carries `yak:running`, and there is a new
comment —

```
🐂 yak run started: `2026-09-06T09-12-44Z-a1b2`
```

— with a hidden `<!-- yak-harness run=… -->` marker under it. A
`yak run` is executing in a worktree on branch
`yak/2026-09-06T09-12-44Z-a1b2`; your `/srv/my-project` checkout has not
moved.

## 5. Tick again

Run the same command a few minutes later. Depending on where the run
is:

- still working → `yak:running`, no action, `0 action(s)`
- hit a gate → `yak:waiting` and a gate comment appears (see
  [The gate bridge](./gate-bridge))
- finished with a PR → `yak:pr-open`
- finished, no PR, or failed → `yak:failed` with an explanation comment

Every real tick also appends one JSON line to
`/srv/my-project/.harness/tick.log`.

## Next

- [Tutorial](./tutorial) — a full loop end to end against a sandbox,
  including answering a gate and merging the PR. Spends real API budget.
- [Monitoring](./monitoring) — `yak-harness dashboard --serve` for a
  live picture of every run on its workflow.
- [Operations](./operations) — put the tick on cron and leave it.
