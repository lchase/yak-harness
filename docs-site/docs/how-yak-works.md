---
sidebar_position: 0
title: How yak works (under the hood)
---

# How yak works, for harness operators

You do not need to be a yak expert to run the harness, but you do need
a working model of what yak puts on disk and how it behaves, because
**the harness reads yak's files directly** and every label the harness
sets is a reaction to something in yak's journal. This page is the
subset of yak that matters. The full engine is documented at
[lchase.github.io/yak](https://lchase.github.io/yak/).

## Steps are build targets

A yak workflow is a DAG of steps. yak treats each step like a build
target: its inputs are hashed, its output ("artifact") is a file on
disk, and a step whose inputs have not changed is served from cache
instead of re-run. When a step fails four steps into a five-step run,
`yak resume` re-runs exactly that one step, not the whole run. That
incremental-rebuild property is why the harness can retry cheaply and
why a stalled run is worth killing rather than waiting out.

Step kinds you will see referenced:

| kind | what it does |
|---|---|
| `agent` | one Claude Agent SDK call (the `claude-code` adapter) |
| `command` | a shell command; its stdout or a named file becomes the artifact |
| `transform` | a pure JS function over prior artifacts |
| `gate` | **suspends the run** and waits for a human answer |
| `map` | fans a step out over a list, one child per item |
| `loop` | repeats a sub-graph up to a bound |

## The run directory

Every `yak run` creates `.runs/<run-id>/`. The run id is yak's own —
ISO timestamp with the colons stripped, plus four hex characters, e.g.
`2026-09-06T09-12-44Z-a1b2`. **There is no `yak run --id`**; you cannot
choose it. The harness learns the id by snapshotting `.runs/` right
before it spawns `yak run` and diffing right after — which is why the
harness launches **at most one run per tick**.

Inside `.runs/<run-id>/`:

```
journal.jsonl              append-only event log — the source of truth
artifacts/<name>.json      one file per completed step's output
pending/<step>.request.json   written when the run suspends on a gate
pending/<step>.answer.json    you (or the harness) write this to resume
```

### The journal

`journal.jsonl` is newline-delimited JSON, one event per line. The
harness cares about three shapes, which it re-declares as its own
`zod` schemas and validates at the boundary (it never imports yak):

- **`run.started`** — first line of every journal. Carries the workflow
  name and a `launched` timestamp. The harness asserts this line exists
  and matches what it launched before it trusts a run dir at all.
- **`run.finished`** — last line of a terminal run. `status` is one of
  `ok`, `failed`, or `suspended`.
- **`StepFailure`** — `{ reason, detail, recoverable }`. `recoverable`
  is **yak's own call** on whether a retry could possibly help. The
  harness keys its retry decision off that boolean rather than keeping
  its own list of which failures are transient.

The harness classifies a run purely from the journal tail:

| journal tail | run class | harness reading |
|---|---|---|
| last line is not `run.finished` | `alive` | still working |
| `run.finished` + `status: suspended` | `suspended` | waiting on a gate |
| `run.finished` + `status: ok` | `ok` | finished — check for a PR |
| `run.finished` + `status: failed` | `failed` | terminal failure |
| `alive`, but last event's mtime is older than `stalledAfterMinutes` | `stalled` | wedged — kill it |

`stalled` is a pure function of the journal file's modification time.
The harness keeps no timer of its own.

## Gates and the `pending/` contract

When a run hits a `gate` step it writes `pending/<step>.request.json`
and suspends. That file has two fields the harness uses:

- **`rendered`** — a freeform prose string the workflow author wrote.
  The harness has **no semantic understanding of it** and posts it to
  the issue verbatim.
- **`answerSchema`** — a JSON Schema for the answer. For a gate the
  harness can bridge, this must be a **flat object of scalar / enum
  properties** (string, number, boolean, enum). The harness generates
  the reply contract by walking those properties. A nested object or
  array means the harness cannot bridge it — it routes the issue to
  `yak:failed` and asks for a hand-written answer file.

To resume, someone writes `pending/<step>.answer.json` and runs
`yak resume <run-id>`. yak re-validates the answer against
`answerSchema` on resume, so a bad answer fails loudly rather than
corrupting the run.

:::info yak 0.3.x has no machine-readable `yak pending`
The design assumed a `yak pending --json`. It does not exist, so the
harness scans `<run-id>/pending/*.request.json` on disk instead. A
request file with a sibling `.answer.json` is already answered and
skipped. yak leaves the request file in place after an answer — its
presence alone does not mean "still waiting."
:::

## Worktree isolation

The harness always launches with `yak run <workflow> --isolation
worktree`. yak creates a fresh git worktree on a branch named
`yak/<run-id>`, runs the whole workflow there, and your main checkout
never moves. The deterministic branch name is how the harness finds the
run's PR later (`gh pr list --head yak/<run-id>`) even if the `pr-url`
artifact is missing.

## The `--input` dependency

The harness passes the issue reference into the workflow with
`yak run ... --input issueRef=owner/name#123`. This needs **yak ≥
0.3.0**. It is the one hard version dependency
([yak#27](https://github.com/lchase/yak/issues/27)).

## What the harness never does to yak

- Never patches yak or assumes an undocumented flag (`yak run --id`,
  `yak cancel` — neither exists).
- Never imports `@lchase/yak`. yak is a binary on `PATH`, not a build
  dependency.
- Never touches `.runs/` directories or worktrees. yak owns that tree;
  yak cleans it.

## Read next

- [Concepts](./concepts) — how the harness turns these facts into label
  transitions.
- [The gate bridge](./gate-bridge) — the `rendered` / `answerSchema`
  round-trip in full.
