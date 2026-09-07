# 04 — Gate-bridge interaction design

Type: prototype
Status: resolved
Blocked by: 01

## Question

yak's gate protocol is a plain file interface and the spec explicitly
invites "any frontend" to satisfy it. When a run suspends,
`pending/<step>.request.json` carries `kind: 'gate'` and a `.rendered`
string (the human-facing prompt). The harness posts that as a comment
on the originating issue (ticket 01 gives the issue), waits for a
reply, turns the reply into a schema-valid `answer.json` via
`writeAnswer(runDir, stepId, answer)`, and calls `yak resume <run-id>`.

The open question is the **human-facing interaction** — what the
comment looks like and how a prose reply becomes a validated answer.
This is a prototype ticket: build a throwaway mock of the
comment + reply exchange (a couple of example gate schemas, the
rendered comment, a good reply, a malformed reply, the re-prompt) and
react to it.

Decide:

1. **Comment format.** How the harness renders `.rendered` plus an
   explicit reply contract — e.g. "reply with a line `answer: <X|Y|Z>`"
   for a choice gate, structured fields for a structured gate.
2. **Reply parsing.** Deterministic parse of the reply line(s); no LLM
   in the harness. What counts as a match, how whitespace / quoting /
   casing are handled, how a threaded reply vs a new comment is
   detected.
3. **Malformed / ambiguous replies.** Re-prompt with what was wrong;
   how many attempts; what happens if the human never replies (ties
   into ticket 03's gate-waiting state).
4. **Answer construction.** Mapping the parsed reply to the gate's
   actual output schema; validation before `writeAnswer`; behaviour on
   a schema mismatch the parser didn't catch.
5. **Resume trigger.** Whether the same tick that writes the answer
   also runs `yak resume`, or the next tick picks it up (idempotency).

Prototype asset: link the mock from this issue on resolution.

Recommendation going in: baseline is an explicit `answer:`-line
contract per gate kind, deterministic parse, one re-prompt on
malformed, gate-waiting label held until resolved.

## Answer

Prototype asset:
[`prototype-04-gate-bridge.md`](../prototype-gate-bridge.md) — the
reacted-to mock (both example gates, rendered comment, good reply,
normalisation table, malformed → re-prompt, ambiguous, Example B).

### 1. Comment format — contract generated generically from `answerSchema`

The harness has only two things from `pending/<step>.request.json`:
`rendered` (freeform prose the workflow author wrote — passed through
**verbatim**, no harness understanding of it) and `answerSchema` (a
JSON Schema object — the only machine-readable part, in practice always
a flat object).

Rejected the ticket's "explicit contract per gate kind" — instead a
**generic renderer** walks `answerSchema`'s properties and emits one
contract line each:

| property type | contract line | accepted values |
|---|---|---|
| `enum` string | `field: a \| b \| c` | any member, case-insensitive, quotes stripped |
| required `string` | `field: <text>` | rest of line (last field may absorb trailing lines) |
| optional `string` | `field: <optional …>` | omit the line to omit the field (never sent as `""`) |
| `boolean` | `field: yes \| no` | yes/y/true, no/n/false (ci) |
| `number` | `field: <number>` | `Number()`, must be finite |

No per-gate code, no gate-kind registry: a new gate in any workflow
works as long as its schema is flat. **Nested objects / arrays are out
of scope** — the harness re-prompts "this gate needs a hand-written
answer file" and routes the issue to `yak:failed`. Spec constraint:
harness-bridged gates keep `answerSchema` a flat object.

Posted comment = `🐂 yak needs a decision — <stepId>` header, the
verbatim `rendered` body, a `---`, the generated fenced contract
block, a run/step footer, and a hidden marker
`<!-- yak-gate run=<id> step=<stepId> schema-sha=<hash> -->`.

### 2. Reply parsing — which comment, from whom

GitHub issue comments are a flat list (no API threading), so:

- Consider only comments posted **after** the harness's gate comment.
- **Author filter:** `author_association` ∈ {`OWNER`, `MEMBER`,
  `COLLABORATOR`} — i.e. write access. Read straight off the comments
  payload, zero extra API calls. `CONTRIBUTOR` / `NONE` ignored. A
  username allowlist can graduate into the config fog later if needed.
- The **first** qualifying comment containing ≥1 `field:` line matching
  a schema property is the answer attempt.
- Parsing is line-based `key: value`: trim key and value, flexible `:`
  spacing, strip surrounding quotes, enum match case-insensitive.
- Chatter that doesn't match is ignored — **unless** it contains a `:`
  and a schema field name (a botched attempt), which counts against
  the re-prompt budget.
- After the `<!-- yak-answered run=<id> step=<stepId> -->` marker, all
  further comments on that step are ignored.
- No LLM anywhere in this path.

### 3. Malformed / ambiguous / never-reply

Malformed = no matching `field:` line, invalid enum value, duplicate
field, or wrong type. Ambiguous (e.g. `decision` given twice) is
treated as malformed — the harness never picks one.

- **One** re-prompt, as a threaded comment naming exactly what was
  wrong and repeating the required line(s). Marker
  `<!-- yak-gate-reprompt run=<id> step=<stepId> attempt=1 -->`.
- Second bad attempt → stop. Transition the issue to `yak:failed`
  (ticket 03), comment that a human must hand-write
  `pending/<stepId>.answer.json` and `yak resume`. No third attempt.
- **Never replies at all → no timeout.** The issue sits in
  `yak:waiting` indefinitely and the run holds the cap=1 slot — that
  backpressure (the visible queue stall) *is* the signal. Consistent
  with dark-factory ticket 01 ("most issues need zero touch, not a
  guarantee none stall"). Auto-failing a gate to reclaim the slot
  would throw away the run's work and still leave the human to deal
  with it. If gate backlog becomes real pain the lever is cap > 1
  (already in the config fog), not a gate timeout.

### 4. Answer construction + validation

Parser output → validate against `answerSchema` with a real JSON
Schema validator (e.g. `ajv`) **before** `writeAnswer`. A validation
failure the line-parser didn't catch is handled exactly like a
malformed reply (re-prompt, then `yak:failed`). Belt and braces: yak's
own `completeGate` re-runs `schema.safeParse` on `yak resume`, so a
harness bug that writes a bad answer fails loudly at resume rather than
corrupting the run.

### 5. Resume trigger — same tick

The `apply` that parses a valid reply does all three in order:
`writeAnswer(runDir, stepId, answer)` → post the `yak-answered` marker
→ `yak resume <run-id>`. Not deferred to the next tick. Crash between
`writeAnswer` and `yak resume` → next tick sees no `yak-answered`
marker → redoes both; both idempotent (`writeAnswer` overwrites
identically, `yak resume` re-derives state from the journal). Whatever
`yak resume` does next (suspend on the next gate, finish, fail) is just
the next tick's normal observation. Matches ticket 02 action B.

### Candidate yak tickets — noted, not depended on

- **Spec note (not a yak-engine change):** workflows whose gates are
  meant to be harness-bridged should keep `answerSchema` a flat object
  of scalar / enum properties. Nested shapes force a hand-written
  answer file. Worth stating in the harness spec and cross-referencing
  from yak's reference-workflow docs.
