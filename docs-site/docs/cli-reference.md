---
sidebar_position: 7
title: CLI reference
---

# CLI reference

Two commands. Both require `--config <path>`.

```
yak-harness tick   --config <path> [--dry-run]
yak-harness doctor --config <path>
```

## `tick`

One reconcile pass — `observe → plan → apply` — then exit. This is the
command cron runs.

```bash
yak-harness tick --config /srv/harness.config.json
```

```
tick: 3 issue(s), 2 run(s) [alive:1 suspended:1], 2 action(s)
  posted gate prompt on #7 (run 2026-09-07T14-02-09Z-1f3d, step confirm-scope)
  relabelled #7: running → waiting
```

The first line is always printed: issue count, run count broken down by
class, action count. Then one line per action `apply` carried out.

Exit codes:

- `0` — clean pass, including a completely quiet backlog (`0
  action(s)`).
- `0` — **another tick already holds the lock.** Overlap is safe; the
  second invocation prints `another tick holds … — exiting (overlap is
  safe)` to stderr and returns 0.
- `1` — `apply` hit a harness fault and aborted, leaving state for a
  human. Also `1` for a bad config or a failed precondition (printed to
  stderr).

Every real tick appends one JSON line to
`<yakRepoPath>/.harness/tick.log`.

### `--dry-run`

`observe` + `plan` only. Prints the actions it would take, applies
nothing, takes no lock, writes no log.

```bash
yak-harness tick --config /srv/harness.config.json --dry-run
```

```
tick: 3 issue(s), 2 run(s) [alive:1 suspended:1], 2 action(s)
  would post-gate    #7 run=2026-09-07T14-02-09Z-1f3d step=confirm-scope
  would relabel      #7 waiting → yak:waiting
```

Use it to see what a tick is about to do before letting cron do it —
especially the first tick against a fresh backlog, where every
qualifying issue is a pending `launch-run`.

## `doctor`

Checks the five box preconditions and exits non-zero if any fail. Every
check runs regardless of earlier failures. Read-only apart from a write
probe it cleans up.

```bash
yak-harness doctor --config /srv/harness.config.json
```

```
  PASS  gh authenticated: gh auth status ok
  PASS  yak on PATH: yak 0.3.1
  PASS  yakRepoPath is a checked-out git repo: /srv/my-project is a git repo on the default branch "main"
  PASS  Node 22+: Node v22.11.0
  PASS  write access to .runs/ and .harness/: both writable

doctor: all checks passed
```

Run it after box setup and after any yak / `gh` / Node upgrade.

## What there is no command for

By design — these are a human's job, not the harness's:

- cancelling or pausing a live run (`yak:hold` freezes the *harness*,
  not the run)
- leaving `yak:failed` (a trap — reset the label by hand)
- closing an issue, deleting a branch, cleaning `.runs/`
