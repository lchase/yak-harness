---
sidebar_position: 8
title: Monitoring
---

# Monitoring

`yak-harness dashboard` renders the harness's whole view as one page:
every run positioned on its workflow, the issue it is working, the gate
it is stuck on, and — the point of it — anywhere the `yak:<status>`
label and yak's own journal **disagree**.

It is a read-only projection. It holds no state, it never writes
anything, and the tick neither knows nor cares that it exists. Deleting
it loses nothing; a rescan rebuilds the same page. Full rationale and
constraints: [`docs/design/dashboard.md`](https://github.com/lchase/yak-harness/blob/main/docs/design/dashboard.md).

:::note Not a substitute for the labels
If you *need* this page to know what the harness is doing, that is a bug
in the harness, not a missing feature. The GitHub labels plus
[`tick.log`](./operations#ticklog) are the source of truth. The
dashboard is `doctor` + `tick.log` drawn as a picture — an aid for
bring-up and incident triage, nothing runs on it.
:::

## Run it

Same config file as [`tick`](./configuration). One static snapshot:

```bash
yak-harness dashboard --config /srv/harness.config.json --out monitor.html
```

Or a live local server:

```bash
yak-harness dashboard --config /srv/harness.config.json --serve
```

```
yak-harness monitor on http://127.0.0.1:8787  (refresh 10s, Ctrl-C to stop)
```

| flag | default | |
|---|---|---|
| `--out <file>` | — | write one snapshot and exit (omit for stdout) |
| `--serve` | — | run the HTTP server instead |
| `--port <n>` | `8787` | |
| `--host <h>` | `127.0.0.1` | loopback only unless you change it |
| `--interval <s>` | `10` | poll cadence, seconds (floor 2) |

Every request — the first load and every poll — reruns the **entire**
pass: `gh` for issues and labels, `.runs/` off disk for journals,
`workflow.json` and artifacts, then render. Nothing is cached. Restart
the server, open it an hour later — identical view, rebuilt from
scratch. The page carries a small script that re-fetches the body every
`--interval` seconds and swaps it in without moving your scroll
position; five failed polls in a row trigger one full reload.

Each `gh` round-trip is a second or two, so `--interval 5` on a slow
network is effectively continuous polling. The default `10` is usually
right; raise it if the harness backlog is large.

## Reading the page

**Stat row** — issues tracked, active runs (with summed token/$ spend),
label drift, problems. A red count means something needs a human.

**Run cards**, one per `.runs/` directory:

- the linked issue number and title
- the `assess` artifact — `kind`, `confidence`, and the run's own
  one-paragraph summary of what the change is and where it goes
- a **state pill** and the issue's **`yak:<status>` label** side by
  side; when they disagree the card also gets a `label drift` inset
  (`labelled yak:running — journal is stalled`, etc.)
- the verbatim gate prompt when the run is suspended
- a collapsible `plan` checklist
- token/$ spend, workflow name, attempt count, last-event age
- the **pipeline**: one box per workflow step, laid out by dependency,
  coloured by this run's state —

  | box | meaning |
  |---|---|
  | green | done |
  | blue, ringed, `NOW` | the step the run is on right now |
  | amber | a gate waiting on a human |
  | red | failed |
  | dashed, struck through | skipped — not applicable to this change |
  | faint dashed | not started yet |

**Backlog** — every harness-relevant issue with its status and run.

**Orphan runs / Stale markers / Linkage faults** — only shown when
non-empty; see [Recovering an orphan run](./patterns/orphan-recovery)
and the other Patterns pages.

## What it will not show you

Anything that is not already a label, a marker comment, a journal
event, or a pid file. If a number on this page can't be traced back to
one of those, that is the opacity bug resurfacing — the fix is in the
harness, not here.
