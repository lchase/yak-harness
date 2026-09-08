---
sidebar_position: 5
title: The gate bridge
---

# The gate bridge

When a `yak run` suspends on a `gate` step, someone has to answer it.
The gate bridge is how that someone answers from a GitHub issue comment
instead of by hand-writing a JSON file on the box. It has **no LLM in
it** — the parsing is line-based `key: value` matching.

## What yak hands over

A suspended run leaves `pending/<step>.request.json` with two fields the
bridge uses:

- **`rendered`** — a freeform prose string the workflow author wrote.
  The harness has no semantic understanding of it and **posts it
  verbatim**.
- **`answerSchema`** — a JSON Schema for the answer.

## The contract is generated, not hand-written

The harness does not know anything about `confirm-scope` vs
`design-review` vs `approve-pr`. It walks `answerSchema`'s properties
and emits one contract line per property:

| property | contract line | accepted input |
|---|---|---|
| enum string | `field: a \| b \| c` | any member, case-insensitive, quotes stripped |
| required string | `field: <text>` | the rest of the line (the last field may absorb trailing lines) |
| optional string | `field: <optional …>` | omit the line to omit the field — never sent as `""` |
| boolean | `field: yes \| no` | `yes`/`y`/`true`, `no`/`n`/`false`, case-insensitive |
| number | `field: <number>` | `Number()`, must be finite |

:::caution Workflow authors: keep `answerSchema` flat
A gate meant to be harness-bridged must have an `answerSchema` that is a
**flat object of scalar / enum properties**. A nested object or an
array cannot be expressed as `key: value` lines — the harness routes
the issue straight to `yak:failed` with a "hand-write the answer file"
comment and stops.
:::

## The posted comment

~~~text
🐂 **yak needs a decision — `confirm-scope`**

<the rendered string, verbatim>

---
**To answer, reply to this comment with:**
```
decision: proceed | narrow | abort
notes: <optional …>
```
Run `<run-id>` · step `<step-id>`

<!-- yak-gate run=<run-id> step=<step-id> schema-sha=<hash> -->
~~~

The hidden `<!-- yak-gate … -->` marker is the idempotency guard — the
harness posts this comment once per `(run, step)` and never again.

## How a reply is read

GitHub issue comments are a flat list with no API threading, so the
rules are positional:

- Only comments posted **after** the harness's gate comment count.
- **Author filter:** `author_association` must be `OWNER`, `MEMBER`, or
  `COLLABORATOR`, read straight off the comments payload — no extra API
  calls. `CONTRIBUTOR` and `NONE` are ignored silently.
- The **first** qualifying comment with at least one `field:` line
  matching a schema property is the answer attempt.
- Parsing is line-based: trim key and value, flexible spacing around
  the `:`, surrounding quotes stripped, enum match case-insensitive.
  The last recognised field absorbs trailing plain lines, so a
  multi-line `notes:` works.
- The parsed answer is validated against `answerSchema` with `ajv`
  **before** anything is written. yak re-validates again on `resume`,
  so a bug that slips a bad answer through fails loudly rather than
  corrupting the run.

## Malformed, and never-answered

**Malformed** = no matching `field:` line, an invalid enum value, a
field given twice (never disambiguated), or a wrong type.

- The harness posts **one** re-prompt naming exactly what was wrong and
  repeating the contract. Marker
  `<!-- yak-gate-reprompt … attempt=1 -->`.
- A **second** bad attempt → the issue goes to `yak:failed` with a
  comment saying a human must hand-write
  `pending/<step>.answer.json` and run `yak resume`. No third attempt.
- Chatter that does not look like an attempt at all (no `:` plus a
  field name) is ignored and does **not** cost the re-prompt budget.

**A gate that is never answered has no timeout.** The issue sits in
`yak:waiting` indefinitely, and the run keeps its concurrency slot. That
visible stall in the queue *is* the signal. The lever for gate backlog
is a higher `maxConcurrent`, not a gate timeout — auto-failing a gate
to reclaim the slot would throw away the run's work.

## What happens on a good reply

In one `apply`, in order: `writeAnswer(runDir, step, answer)` → post the
`<!-- yak-answered … -->` marker → `yak resume <run-id>`. If the tick
dies between the write and the resume, the next tick sees no
answered-marker and redoes both — both are idempotent.

`yak resume` may then suspend on the *next* gate, finish, or fail — the
harness trusts the journal, not the resume exit code, so a run that
re-parks on a later gate is a success, not an error.
