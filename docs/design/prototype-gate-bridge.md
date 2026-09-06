# Prototype — gate-bridge comment/reply exchange

Throwaway mock for ticket 04. Reacted-to artifact, not a spec. Shows
what the harness posts, what a human types back, and the deterministic
(no-LLM) path from prose reply to a schema-valid `answer.json`.

## What the harness actually has to work with

From `pending/<step>.request.json` (yak `GatePendingRequest`):

- `rendered` — a **freeform prose string** the workflow author wrote.
  The harness has zero semantic understanding of it. Passed through
  verbatim.
- `answerSchema` — a **JSON Schema object**. This is the only
  machine-readable thing. Always (in practice) a flat object: a few
  required properties, each an `enum` / `string` / `boolean` / `number`,
  maybe one optional `string` ("notes").
- `stepId`, `runId`, `context.artifacts`.

So the reply contract is **generated from `answerSchema`**, generically,
per property. No per-gate-kind special-casing in the harness.

---

## Example A — `confirm-scope`

### request.json (excerpt)

```json
{
  "kind": "gate",
  "stepId": "confirm-scope",
  "runId": "2026-09-06T09-12-44Z-b3d1",
  "rendered": "Triage thinks this is a bug in the retry backoff (confidence 0.71).\nProposed scope: fix the exponential backoff cap in src/engine/retry.ts,\nadd a regression test. Out of scope: the surrounding queue refactor.\n\nProceed with this scope, narrow it, or abort?",
  "answerSchema": {
    "type": "object",
    "properties": {
      "decision": { "type": "string", "enum": ["proceed", "narrow", "abort"] },
      "notes": { "type": "string" }
    },
    "required": ["decision"]
  },
  "context": { "artifacts": ["triage"] }
}
```

### Comment the harness posts on the issue

> 🐂 **yak needs a decision — `confirm-scope`**
>
> Triage thinks this is a bug in the retry backoff (confidence 0.71).
> Proposed scope: fix the exponential backoff cap in src/engine/retry.ts,
> add a regression test. Out of scope: the surrounding queue refactor.
>
> Proceed with this scope, narrow it, or abort?
>
> ---
> **To answer, reply to this comment with:**
> ```
> decision: proceed | narrow | abort
> notes: <optional free text>
> ```
> Run `2026-09-06T09-12-44Z-b3d1` · step `confirm-scope` · [`triage` artifact](…)
>
> <!-- yak-gate run=2026-09-06T09-12-44Z-b3d1 step=confirm-scope schema-sha=1f4b2c -->

The fenced block is **generated from `answerSchema`**:
- `decision` is required, enum → `decision: proceed | narrow | abort`
- `notes` is optional string → `notes: <optional free text>`

### Good reply (threaded reply to the comment)

```
decision: narrow
notes: skip the regression test, just cap the backoff
```

Parser →

```json
{ "decision": "narrow", "notes": "skip the regression test, just cap the backoff" }
```

Validates against `answerSchema`. Harness: `writeAnswer(runDir,
"confirm-scope", …)`, post the `yak-answered` marker, `yak resume`.

### Also-accepted replies (deterministic normalisation)

| Reply | Parsed | Why |
|---|---|---|
| `decision: Proceed` | `{decision:"proceed"}` | enum match is case-insensitive |
| `  decision:proceed  ` | `{decision:"proceed"}` | trim key, value, flexible `:` spacing |
| `decision: "abort"` | `{decision:"abort"}` | surrounding quotes stripped |
| `decision: proceed` (no `notes:` line) | `{decision:"proceed"}` | optional field omitted, not sent as "" |
| a `notes:` line spanning to end of comment | multi-line notes | last field may absorb trailing lines |

### Malformed reply → one re-prompt

Reply:

```
yeah go for it
```

No `key: value` line matching a schema property. Harness posts **one**
re-prompt as a threaded reply:

> ⚠️ Couldn't read that answer for `confirm-scope`. I need a line like:
> ```
> decision: proceed | narrow | abort
> ```
> `decision` is required. Reply again with that line. (I'll try once
> more, then flag this for a human.)
>
> <!-- yak-gate-reprompt run=2026-09-06T09-12-44Z-b3d1 step=confirm-scope attempt=1 -->

Second malformed (or ambiguous — see below) reply → harness stops,
transitions the issue to `yak:failed` (ticket 03), leaves a comment
saying a human needs to write `pending/confirm-scope.answer.json` and
`yak resume` by hand. No third attempt.

### Ambiguous reply → treated as malformed

```
decision: proceed
decision: abort
```

Two values for one field → malformed (don't pick one). Re-prompt with
"you gave `decision` twice".

Invalid enum value:

```
decision: maybe
```

`maybe` ∉ enum → malformed. Re-prompt lists the allowed values.

---

## Example B — `approve-pr` (`ApprovalSchema = { decision: enum['approve','reject'] }`)

### request.json (excerpt)

```json
{
  "kind": "gate",
  "stepId": "approve-pr",
  "runId": "2026-09-06T09-12-44Z-b3d1",
  "rendered": "Implement loop passed on iteration 3/5. Review found 2 low-severity findings (see ranked-findings). Diff touches 3 files, +47 −12.\n\nApprove opening the PR?",
  "answerSchema": {
    "type": "object",
    "properties": { "decision": { "type": "string", "enum": ["approve", "reject"] } },
    "required": ["decision"]
  }
}
```

### Comment

> 🐂 **yak needs a decision — `approve-pr`**
>
> Implement loop passed on iteration 3/5. Review found 2 low-severity
> findings (see ranked-findings). Diff touches 3 files, +47 −12.
>
> Approve opening the PR?
>
> ---
> **Reply with:**
> ```
> decision: approve | reject
> ```
> <!-- yak-gate run=2026-09-06T09-12-44Z-b3d1 step=approve-pr schema-sha=88a1e0 -->

### Good reply

```
decision: approve
```

→ `{ "decision": "approve" }` → validates → resume. (`open-pr` then
fires or self-skips via its own `skipIf` on `pr-decision.decision`.)

---

## The generic schema → contract renderer

For a flat-object `answerSchema`:

| property type | contract line | accepted values |
|---|---|---|
| `enum` (string) | `field: a \| b \| c` | any enum member, case-insensitive, quotes stripped |
| `string` (required) | `field: <text>` | rest of line (or to end of comment if last field) |
| `string` (optional) | `field: <optional …>` | same; omit line to omit field |
| `boolean` | `field: yes \| no` | yes/y/true → true, no/n/false → false (ci) |
| `number` | `field: <number>` | parsed with `Number()`, must be finite |

Nested objects / arrays in an `answerSchema`: **out of prototype
scope** — no reference-workflow gate uses one. If one ever appears the
harness re-prompts "this gate needs a hand-written answer file" and
routes to `yak:failed`. (Candidate: note in the spec that harness-
bridged gates should keep `answerSchema` flat.)

---

## Threaded reply vs new comment

- The harness watches for **comments posted after** its gate comment,
  by **anyone with write access** (a config'd allowlist later; for now:
  any non-bot commenter).
- A GitHub reply-in-thread and a plain new comment are the same to the
  Issues API (issues have a flat comment list, no threading). So:
  **the first qualifying comment after the gate comment that contains
  at least one `field:` line matching a schema property** is taken as
  the answer.
- Comments between the gate comment and a valid answer that *don't*
  parse are ignored as chatter **unless** they look like a failed
  attempt (contain a `:` and a schema field name) — those count against
  the 1 re-prompt budget.
- Once `yak-answered` is posted, later comments on that step are
  ignored.

---

## Resume trigger — same tick or next?

`apply` in the tick that parses a valid reply does all three:
`writeAnswer` → post `yak-answered` marker → `yak resume <run-id>`.
Not deferred to the next tick. Rationale: `yak resume` may itself
suspend again (next gate) or finish — handling that is just the next
tick's normal observation. If the tick dies between `writeAnswer` and
`yak resume`, the next tick sees no `yak-answered` marker → redoes both
(both idempotent: `writeAnswer` overwrites identically, `yak resume`
re-derives from the journal).
