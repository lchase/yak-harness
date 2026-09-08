# 08 — Workflow routing

Type: grilling
Status: resolved
Blocked by: —

Resolves the [§11](../../spec.md#11-out-of-scope-for-v1) "Label-routing
to multiple workflows" row and supersedes the "**Why one workflow**"
paragraph in [§4.1](../../spec.md#41-the-reference-workflow--implement-change).
Post-v1 — the v1 spec ships one workflow per deployment.

## Question

v1 fixes `config.workflow` to a single value per deployment.
`implement-change` (§4.1) spans bug / feature / chore by classifying the
change in its first step and self-skipping the feature-only steps via
`skipIf`. Two forces push back on that being the whole story:

1. **Some work needs a genuinely different graph**, not a subset of the
   same one. A **spike** produces a findings document and *never opens a
   PR*. A **dependency bump** has *no gates* and merges nothing but the
   version change. A **periodic architecture review** is not even
   issue-triggered. `implement-change` cannot express "no PR" or "no
   gates" by skipping steps — those are structural.

2. The operator's mental model was: workflow is config → config is one
   file per invocation → invocation is one cron line → **different
   workflows must mean different crons**. If true, routing is a
   deployment-topology problem, not a harness feature.

Decide: does the harness route work to workflows, and if so, keyed on
what, computed where, and does it change the tick topology?

## Decision

### 1. One tick, one cron, one lock — always

Routing does **not** fork the deployment. The tick already reads *every*
harness-relevant issue each run (§5.3). Choosing a workflow per issue is
a pure function of that scan, evaluated in `plan` (§6.1) — it needs no
second invocation, no second config, no second `.harness/tick.lock`.

The "different workflows = different crons" model is rejected. Two crons
on one `yakRepoPath` would contend the same lock and serialise anyway
(§6.6), and each would need a disjoint `qualifyingLabel` to avoid
double-launching — strictly worse than routing inside one tick.

### 2. `config.workflow` stays; add `config.workflowByLabel`

```jsonc
{
  "workflow": "implement-change",        // unchanged — the default / fallback
  "workflowByLabel": {                   // optional; omitted = v1 behaviour
    "spike":       "spike",
    "dependency":  "dependency-bump",
    "review":      "review"
  }
}
```

- Keys are **label strings the operator chooses**. The harness matches
  them literally against the issue's labels; it does not mandate a
  prefix. (`yak:bug` would technically work — `readLabels` ignores any
  `yak:` suffix outside the six status names — but reusing the status
  prefix for routing is confusing. Recommend a distinct namespace:
  bare `spike` / `review`, or `wf:spike`.)
- Values are workflow names or paths, resolved exactly as `config.workflow`
  is today (`src/workflow-path.ts`).
- `qualifyingLabel` (`yak`) is unchanged and still required — it is the
  scope defence. A routing label is a **companion** a human adds
  alongside `yak` when the default is wrong; most issues carry only
  `yak` and get `config.workflow`.

### 3. `pickWorkflow(issue, config)` — pure, in `plan`

```
matches = keys of config.workflowByLabel present on the issue's labels
matches.length == 0  -> config.workflow
matches.length == 1  -> config.workflowByLabel[match]
matches.length >  1  -> issue fault: flag, launch nothing
```

Two routing labels on one issue is ambiguous and is treated exactly like
two `yak:<status>` labels (§8.1) — a fault the harness surfaces and acts
on nothing, rather than guessing precedence. No config-order tie-break;
the human removes one label.

The `launch-run` action (§8.2 action D) carries the resolved workflow.
`plan` stays a pure function of the `Observation`; `pickWorkflow` reads
only `issue.labels` + `config`.

### 4. Journal assertion recomputes, holds no state

§5.1 step 4 asserts the launched run's `run.started.workflow` matches
what was launched. With routing, "what was launched" is
`pickWorkflow(issue, config)` — recomputed from the issue's current
labels every tick, never stored. Consistent with invariant 3 (durable
state lives only in GitHub + yak's journal).

If a human changes the routing label mid-run, later ticks still read the
run's *actual* workflow from its journal for every decision; the
assertion is a launch-window check only and does not re-fire.

### 5. `maxConcurrent` stays one global cap

One launch per tick (§6.3), one `maxConcurrent` ceiling across all
workflows. A spike and a feature share the same slots. Per-workflow caps
are a later refinement if a real need appears — not v1-of-routing.

### 6. Specialised workflows are separate files; the monolith stays the default

`implement-change` remains `config.workflow` and keeps doing bug /
feature / chore via `skipIf` — that variation is *shape*, and the
monolith handles it well (the §4.1 "70% shared structure" argument still
holds for those three). A separate workflow file earns its place only
when the graph **structurally** diverges:

| workflow | why it can't be `implement-change` + `skipIf` | design |
|---|---|---|
| `implement-change` | — (the default) | shipped (§4.1) |
| `fix-defect` | maybe leaner gating / regression-test-first — open question | [#37](https://github.com/lchase/yak-harness/issues/37) |
| `spike` / `research` | deliverable is a findings doc + pre-scoped follow-up issues, not a code change | [#38](https://github.com/lchase/yak-harness/issues/38) |
| `dependency-bump` | **zero gates**; PR straight from a deterministic command | [#39](https://github.com/lchase/yak-harness/issues/39) |

A workflow ending in `gh issue create` is exactly symmetric with
`implement-change`'s `gh pr create` — yak is a workflow engine, no
engine change. If such a workflow *also* opens a doc PR (variant A in
#38) the harness is untouched. Only a workflow that makes **no repo
change at all** (variant B) needs one bit — an `opensPR` flag on the
routing-map value so §8.2's "ok, no PR" cell does not read it as a
workflow bug.

### 7. Periodic / non-issue work stays out

The harness is purely issue-backlog-reactive (§11, "Idea-to-qualified-issue
refinement" row). A periodic architecture review is **not** a harness
feature. The seam: a separate one-line cron runs
`gh issue create --label yak --label review …` on its own schedule; the
harness then picks that issue up and routes it to the `review` workflow
like any other. The harness never creates issues and never schedules
work — it only ever answers "what is labelled `yak` right now."

## Scope of the implementation

Small, self-contained:

- `config.ts` — optional `workflowByLabel: z.record(z.string())`.
- `pickWorkflow(issue, config)` — pure, unit-tested exhaustively
  (0 / 1 / many matches, path vs name values).
- `plan.ts` — the `launch-run` action carries the resolved workflow;
  the many-match case produces an issue fault.
- `apply.ts` / `observe.ts` — launch spawns the carried workflow; the
  §5.1 step-4 assertion compares against it.
- A `RawIssue` already carries `labels` — no new read.

## Out of scope for this ticket

- Per-workflow `maxConcurrent`.
- Selecting a workflow by anything other than a label — issue body
  parsing, GitHub's native issue types, the assignee, etc.
- The harness creating issues or running anything on a timer of its own.
- Designing or shipping the `fix-defect` / `spike` / `dependency-bump`
  workflow files — each is its own design ticket (#37, #38, #39). #38's
  variant B optionally adds an `opensPR` flag to the routing-map value
  (default `true`) so §8.2 does not flag a deliberately-no-PR run as a
  workflow bug — small, and out of this ticket.
