---
sidebar_position: 4
title: Orphan run recovery
---

# Orphan run recovery

An **orphan** is a run — a `.runs/` directory, possibly with an open
gate — that no issue's marker comment points at. It happens when a tick
crashes between spawning `yak run` and posting the marker, or when a
human deletes a marker or un-qualifies an issue mid-run.

## What the harness does

- **Run already `ok` / `failed`.** Nothing to bridge. Logged once, the
  tick continues.
- **Run `alive` or `suspended`, and recoverable.** Before it spawns,
  the harness writes `.harness/runs/launching-<issue>.json`. If that
  breadcrumb survived the crash, the next tick reads the issue number
  from it and **reposts the marker comment** — the run is re-linked and
  is no longer an orphan.
- **Run `alive` or `suspended`, not recoverable** (no breadcrumb). The
  harness logs it loudly, counts it against `maxConcurrent`, and
  **launches nothing new** until a human clears it. It will **never
  guess** which issue the run belongs to — mislinking a gate comment to
  the wrong issue is worse than stalling.

## Clearing a non-recoverable orphan

You have the run id from the tick's log output. Decide what the run is:

```bash
cat <yakRepoPath>/.runs/<run-id>/journal.jsonl | head -1   # workflow + input
```

The `run.started` event's `input` usually carries the `issueRef`. Then
either:

- **Re-link it** — post the marker comment yourself on the right issue:

  ```
  🐂 yak run started: `<run-id>`
  <!-- yak-harness run=<run-id> branch=yak/<run-id> launched=<iso-ts> -->
  ```

  Next tick treats it as a normal in-flight run.

- **Abandon it** — there is no `yak cancel`. Let the run finish or
  stall on its own; once it is terminal the harness logs it once and
  moves on. The worktree and branch are yak's to clean.
