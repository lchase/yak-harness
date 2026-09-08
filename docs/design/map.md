# yak factory harness — map

> **STATUS: complete (2026-09-06).** Design tickets 01–07 resolved; [the
> spec](../spec.md) is assembled and shipped as v1. Decision 08
> (workflow routing) is a resolved **post-v1** addition — spec §4.2,
> `decisions/08-workflow-routing.md` — not part of the v1 build.

## Destination

A `spec.md` for a **new, standalone, GitHub-only package** that sits
around yak and owns "which ticket tracker" as its whole job: a
stateless cron reconciler, co-located with yak on a persistent box,
that (1) fetches a GitHub Issues backlog by label and manages status
labels, and (2) bridges yak's suspend/resume gate protocol
(`pending/<step>.request.json` / `answer.json`, spec §4.5) into a
comment-and-reply on the originating issue. yak's engine stays entirely
ignorant that GitHub exists. The spec is ready to hand to an
implementation effort; writing the harness code is a later, separate
effort.

## Notes

- **Separate codebase.** This is not a yak engine change. The harness
  drives yak purely through its documented CLI (`yak run`, `yak
  resume`, `yak pending`) and its on-disk journal / `pending/`
  contract. Any change the harness would *like* in yak (e.g. a
  caller-supplied run id) is out of scope here — note it as a
  candidate yak ticket, don't depend on it.
- **Domain:** yak spec.md §4.5 (suspend/resume), §7 (reference
  workflow). yak CLI as built: `src/cli/index.ts`,
  `src/cli/commands/{run,resume,pending}.ts`, `src/engine/run.ts`.
  Ground facts already established (2026-09-05 code read):
  - Run ids are engine-generated `ISO-time-with-colons-stripped +
    4 hex` (`engine/run.ts` `generateRunId`). **No `yak run --id`.**
    Worktree branch is `yak/<run-id>`.
  - `run.started` is journalled immediately at launch; `yak run`
    prints the run id only on its final line (`finished` / `suspended`
    / `failed`).
  - `yak pending` already scans **all** runs under `.runs/`, and is
    journal-authoritative (last event `run.finished` +
    `status: 'suspended'`). `pending/*.request.json` has `.rendered`
    (gate) ready to post; `writeAnswer(runDir, stepId, answer)` +
    `yak resume <run-id>` closes the loop.
  - No issue ↔ run linkage exists anywhere in yak — the harness must
    own it.
- **Standing scope decisions (from the destination grill, 2026-09-05):**
  - Spec covers **both** jobs (backlog + gate-bridge) — they collapse
    into one tracker-boundary owner; splitting them defeats the concept.
    Gate-bridge may be spec'd now and built later (no current
    consumer — dark-factory stripped its gates).
  - **GitHub Issues only.** Spec names it as the sole backend; code
    structured however is simplest. Multi-provider adapter interface is
    out of scope until a second real tracker exists.
  - **Stateless cron reconciler**, not a daemon or webhook service.
  - **Co-located** with yak on a persistent-filesystem box; harness is
    a smart local launcher + GitHub API client. Not ephemeral CI.
  - Concurrency: **`maxConcurrent` config, default 2** (ticket 06;
    cap=1 at charting was test-conservatism). One launch per tick
    regardless, so idle ramps to cap over a few ticks.
  - Harness GitHub auth: shell out to the already-authed `gh` CLI on
    the box (spec-note, not a ticket).
- **Related prior work:** `.scratch/yak-dark-factory/map.md` — its
  ticket 02 (GitHub Action `on: issues: labeled` shelling to `yak run`)
  is the throwaway trigger this harness replaces; its ticket 01
  (label-filter as primary defence) and ticket 03 (`.env` secrets
  scoping for yak's own runs — a *different* concern from harness auth)
  inform tickets here. Memory: `yak-dark-factory-harness-idea`.
- **Tracker:** local-markdown convention (no native blocking) — each
  ticket states its own `Blocked by:` line.
- Use `/grilling` and `/domain-modeling` for each ticket unless its
  type says otherwise; `/prototype` for ticket 04.

## Decisions so far

<!-- one line per closed ticket -->

- [01 — Run ↔ issue linkage](decisions/01-run-issue-linkage.md) — harness
  owns the mapping, keeps it in the tracker only: capture the run id by
  snapshot-diffing `.runs/` around a serial `yak run` (cap=1), then post
  an HTML-comment marker on the originating issue; each tick rebuilds
  `runId ↔ issue` both ways from one scan of all harness-labelled
  issues (last marker wins). Orphan run with no marker wedges the
  harness until a human clears it; stale marker → no active run → route
  to failed/needs-human. `.harness/runs.json` cache deferred until API
  volume hurts. Two candidate yak tickets noted, not depended on:
  `yak run --tag <str>` (journal + `yak pending`), and run id to stderr
  at launch.

- [02 — Reconciler tick algorithm](decisions/02-reconciler-tick-algorithm.md)
  — one `observe() -> plan(observation) -> apply(actions)` function per
  tick; `plan` pure (zero I/O, no-mock testable). `observe` does all
  reads in one shot: one `gh` issue query (+ marker parse both ways),
  `yak pending`, one `.runs/` listing classified by journal tail
  (`alive`/`suspended`/`ok`/`failed`/`stalled` = alive + stale journal
  mtime), derived orphans/stale. Five actions — post-gate (A),
  answer+resume (B), relabel-finished (C), launch (D), flag
  orphan/stale (E); only D consumes cap=1; `in_flight` counts
  `alive`+`suspended`. Precedence E→B→A→C→D, one launch/tick. Every
  action guarded by an idempotency predicate read from the
  observation. Launch-window crash contained by a `.harness/launching`
  breadcrumb (issue# + `.runs/` snapshot; recovered/flagged next tick)
  instead of wedging the whole harness. Seam with 03: `plan` calls
  03's pure transition table `(labelState, runClass) ->
  (target, action)`; no label strings in 02.

- [03 — Backlog label lifecycle state machine](decisions/03-backlog-label-lifecycle.md)
  — one harness-owned single-valued `yak:<status>` label = the whole
  state machine. Six states: `yak`-only/∅ (qualified, not launched),
  `yak:running`, `yak:waiting` (gate, human reply needed),
  `yak:pr-open`, `yak:failed` (failed/stalled/orphan/stale — **trap
  state, harness never auto-leaves**), `yak:done` (merged, inert).
  Human owns `yak` (qualify — dark-factory's primary scope defence,
  unchanged) and `yak:hold` (harness skips the issue entirely; does
  not pause a live run). Full `(status, runClass) -> (status, action)`
  table in the ticket; harness transitions only on journal / on-disk
  evidence, never a bare timer. `ok`-without-PR and closed-unmerged-PR
  both route to `yak:failed`. PR state read from the `pr-url` artifact
  (fallback `gh pr list --head yak/<run-id>`). Zero destructive
  cleanup — no issue-close, no branch/`.runs` deletion, markers are
  permanent. Consumed by ticket 02's `plan` as the pure transition
  table.

- [04 — Gate-bridge interaction design](decisions/04-gate-bridge-interaction.md)
  — harness renders the reply contract **generically from
  `answerSchema`** (flat scalar/enum objects only; nested → hand-write
  + `yak:failed`), never per-gate-kind. Posts `rendered` verbatim +
  a generated `field: a | b | c` fenced block + `yak-gate` marker.
  Reply parse: line-based `key: value`, first qualifying comment after
  the gate comment from an author with write access
  (`author_association` ∈ OWNER/MEMBER/COLLABORATOR), case-insensitive
  enum match, no LLM. Malformed/ambiguous → **one** re-prompt naming
  the fault, then `yak:failed`. Never-reply → **no timeout**, sits in
  `yak:waiting` holding the cap slot (that stall is the signal;
  cap > 1 is the lever, not a timeout). Validate with `ajv` before
  `writeAnswer`; yak re-validates on resume (belt and braces). Resume
  same tick: `writeAnswer` → `yak-answered` marker → `yak resume`, all
  idempotent. Prototype:
  [`prototype-gate-bridge.md`](prototype-gate-bridge.md).

- [05 — Failure / retry policy](decisions/05-failure-retry-policy.md) —
  retry **iff yak's own `StepFailure.recoverable === true`** and
  `attempt < 2` (attempt count = number of `yak-harness run=` markers
  on the issue; no new marker). Retry = fresh `yak run`, next free
  cap slot, no explicit back-off (cron interval is the spacing).
  `recoverable:false` / second failure → `yak:failed`. `stalled` runs:
  harness launches `yak run` **detached**, records
  `.harness/runs/<run-id>.json = {pid,issue,launchedAt}` (promoted
  from ticket 02's `launching` breadcrumb), and on stall verifies +
  `kill`s the pid then sets `yak:failed` — never retried. Entering
  `yak:failed` posts one `yak-failed` marker comment: what broke
  (`reason`+`detail` / stall / no-PR), attempts tried, recovery steps.
  No `@`-mention v1. Candidate yak ticket: `yak cancel <run-id>`.

- [06 — Config surface](decisions/06-config-surface.md) — one plain-JSON
  file, `--config <path>` on `harness tick`, **zod-parsed at startup**
  (bad config / no `gh` auth / no yak → non-zero exit, no partial
  tick). Configurable: `repo`, `yakRepoPath`, `runsDir?`,
  `qualifyingLabel` (default `yak`), `stalledAfterMinutes` (required,
  no safe default), `maxConcurrent` (default 2), `workflow` (default
  `fix-defect`) + `inputTemplate` (`issueRef={{repo}}#{{number}}`).
  Locked as source consts: re-prompt limit 1, max attempts 2,
  `author_association` set, `yak:` status names, `.harness/` path,
  marker formats. Cron interval is **not** harness config (lives in
  the timer entry). `.harness/runs.json` scan cache — not built, not
  in schema (~5–10 API calls/tick vs 5000/hr limit); one spec
  sentence noting it as a future pure-cache optimisation. Amended
  tickets 01 + 02 for cap=1 → cap=`maxConcurrent`.

- [07 — Deployment & packaging shape](decisions/07-deployment-packaging.md)
  — standalone **`yak-harness`** GitHub repo, **fully decoupled** from
  yak (re-declares the 3 on-disk shapes as zod schemas; `yak` is a
  PATH runtime requirement, not a build dep). TS/ESM/Node22, tsup,
  `bin: yak-harness`. Scheduled by **plain cron** (one crontab line;
  systemd timer optional); overlap guarded by a harness-owned
  `.harness/tick.lock`. Box preconditions (gh authed, yak on PATH,
  repo checked out at `yakRepoPath`, persistent FS) stated in the
  spec, checked by `yak-harness doctor`. Deploy = `git pull && npm run
  build`; conventional commits + CHANGELOG but **npm publish
  deferred**. Logging: one self-rotating JSON-lines `.harness/tick.log`
  + stderr for fatals, nothing remote; `tick --dry-run` for
  observe+plan preview.

- [08 — Workflow routing](decisions/08-workflow-routing.md) — **post-v1**.
  One tick / one cron / one lock, always: routing is a pure
  `pickWorkflow(issue, config)` in `plan`, not a second invocation.
  `config.workflow` stays the default; optional `workflowByLabel` maps a
  companion label → a structurally different workflow (`spike` with no
  PR, `dependency-bump` with no gates). Two routing labels = an issue
  fault. Periodic/non-issue work stays out — a separate cron files the
  issue. Spec §4.2.

## Not yet specified

- *(empty — v1 destination reached; see [the spec](../spec.md). Decision
  08 is specified but deliberately outside the v1 build.)*

## Out of scope

- **Idea-to-qualified-issue refinement.** The adversarial grilling that
  turns a loose idea into well-scoped, ready-to-build issue(s) —
  `/grill-me`-style back-and-forth, a Jira/Linear grooming sync, a
  triage meeting, hand-authoring. All external. The harness starts at
  an issue a human has already qualified by applying the `yak` label
  (dark-factory ticket 01: the label filter is the primary scope
  defence *because* a human only applies it to work they believe is
  scoped). The harness runs no open-ended "what should this issue be"
  dialogue. Its only in-workflow human touchpoints are (a) the gate
  bridge — bounded, schema-valid decisions mid-run, ticket 04 — and
  (b) the PR itself. Both are unavoidable: after a long AI run the
  first natural checkpoint is the PR, with many tokens already spent
  if the run went down the wrong path, so `confirm-scope` early and the
  gate bridge exist to catch that before the spend, not to converse.
  Minimise these; don't try to eliminate them.
- **Multi-provider adapter interface** (Jira / Linear / local
  markdown). One provider's semantics isn't enough signal to guess a
  good cross-provider seam; extract after a second real tracker exists.
  Returns as a fresh effort if that happens.
- **Patching yak's engine** — including adding `yak run --id` or a
  stable run handle. The harness must work against yak as documented.
  Any such change is a separate yak ticket, noted not depended on.
- **PR-revision loop** (human requests changes on an already-open PR,
  harness resumes the implement loop). Inherited from dark-factory's
  out-of-scope list; not part of reaching a first PR unattended.
- **Refactoring the yak repo into packages** (`yak-core` engine +
  `yak-cli` + a `yak-factory` sibling that encapsulates dark-factory
  concepts). A real future direction, but a redraw of the yak repo's
  architecture with its own tradeoffs (workspace tooling,
  multi-package release-please, independent versioning) — none of which
  this destination needs resolved. The harness consumes yak through
  the CLI + on-disk contract regardless of how yak is packaged; the
  spec states that assumption in one line (see "Not yet specified:
  deployment & packaging shape"). Building this harness as a clean
  standalone package first gives that later effort one concrete
  external consumer to design the package boundary against. Its own
  wayfinder effort if/when a monorepo is on the table.
