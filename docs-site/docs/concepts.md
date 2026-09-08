---
sidebar_position: 2
title: Concepts
---

# Concepts

Four ideas carry the whole harness: the tick, the label state machine,
marker comments, and the two human-owned labels.

## The tick

One `yak-harness tick` is `observe → plan → apply`.

**observe** does every read and produces one `Observation` value:
issues carrying any harness-relevant label and their comments; the
`.runs/` listing classified by journal tail; open gates from the
`pending/` scan; PR state for finished runs.

**plan** is a **pure function** of that `Observation` — no I/O, no
clock, no network. It returns an ordered `Action[]`. Because it is
pure, its behaviour is fully determined by the observation you pass it,
which is why the transition logic can be exhaustively tested without
mocking anything.

**apply** carries out the actions against GitHub and yak, each one
guarded by a predicate that `plan` already evaluated from the
observation. Every action is idempotent: a tick can die halfway through
`apply` and the next tick re-plans from a fresh observation and
re-attempts safely.

### The five actions

| | action | trigger |
|---|---|---|
| A | post a gate comment | a suspended run has an open gate with no gate-comment marker yet |
| B | write answer + `yak resume` | a valid human reply is in, no answered-marker yet |
| C | relabel | the observed run class implies a different `yak:<status>` than the issue currently carries |
| D | launch a run | a qualifying issue with no marker comment, and the concurrency cap has room |
| E | flag an orphan | a `.runs/` dir or open gate with no marker on any issue |

Only **D** consumes a concurrency slot, and **the harness launches at
most one run per tick** even when several slots are free. An idle
harness ramps up to `maxConcurrent` over successive ticks. This keeps
the snapshot-and-diff that identifies a new run id unambiguous.

Precedence within a tick: E, then B (resuming may free a slot the same
tick), then A, then C, then D. A live un-recoverable orphan suppresses
D entirely until a human clears it — the harness will not launch new
work while it has a run it cannot account for.

## The label state machine

One harness-owned, single-valued `yak:<status>` label **is** the state
machine. Exactly one `yak:<status>` per issue; two is a harness fault,
and the harness responds by flagging it and acting on nothing for that
issue.

| status | meaning |
|---|---|
| `yak` only (no `yak:<status>`) | qualified by a human, not yet launched |
| `yak:running` | run launched and `alive` |
| `yak:waiting` | suspended on a gate — a human reply is needed |
| `yak:pr-open` | run finished ok, PR opened |
| `yak:failed` | failed / stalled / orphan / stale — **needs a human** (a trap) |
| `yak:done` | PR merged — terminal, inert |

The harness moves this label **only on evidence from yak's journal or
on-disk state**, never on a timer. Even `stalled` is a journal fact:
the last journal event's mtime is older than `stalledAfterMinutes`.

Two rules worth internalising:

- **`yak:failed` is a trap.** The harness never auto-leaves it. A human
  investigates and either fixes the cause and resets the label (to
  `yak` for a clean relaunch), or closes the issue. See
  [Operations](./operations#the-yakfailed-trap).
- **A finished run with no PR lands in `yak:failed`.** A successful yak
  run is supposed to produce a `pr-url` artifact. If it did not, that
  is a workflow bug a human must see — the harness cannot tell it apart
  from a deliberately-aborted PR.

The full `(current, observed) → (next, action)` table is in
[spec §8.2](https://github.com/lchase/yak-harness/blob/main/docs/spec.md).

## Marker comments

The link between an issue and its run lives **only in the tracker**, as
one hidden comment per launch:

```
🐂 yak run started: `2026-09-06T09-12-44Z-a1b2`
<!-- yak-harness run=2026-09-06T09-12-44Z-a1b2 branch=yak/2026-09-06T09-12-44Z-a1b2 launched=2026-09-06T09:12:45Z -->
```

The machine reads only the HTML comment; the prose line is for you.
Every tick reconstructs the `run ↔ issue` mapping from scratch by
scanning these. **The last marker on an issue wins**; earlier markers
are kept as history, and **their count is the retry attempt counter**.

The harness never edits, deletes, or strikes through a marker comment —
they are permanent history.

## The two human-owned labels

- **`yak`** (the `qualifyingLabel`) — the scope defence. A human applies
  it only to work they have already scoped down to something an agent
  can finish. It stays on for the entire lifecycle, including
  `yak:done`, as a record.
- **`yak:hold`** — a park override. While it is present the harness
  skips the issue **entirely**: no observation contribution, no gate
  post, no relabel. It does **not** pause a running `yak run` (the
  harness has no such power) — it only freezes the harness's reactions
  to that issue.

## Read next

- [Quickstart](./quickstart) — see a label move, no real run.
- [Tutorial](./tutorial) — drive a full loop against a sandbox.
- [Operations](./operations) — cron, recovery, the failure trap.
