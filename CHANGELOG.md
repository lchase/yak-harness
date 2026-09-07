# Changelog

All notable changes to this project are documented here. The project
uses [Conventional Commits](https://www.conventionalcommits.org/); this
file is maintained by hand until a release-please pipeline lands
(spec §10.4).

## [Unreleased]

### Added

- Repo scaffold: TypeScript + ESM + Node 22 toolchain, `tsup` build,
  `vitest`, `zod` + `ajv` dependencies, `CLAUDE.md` invariants.
- Config schema (`src/config.ts`, spec §4): `zod`-parsed JSON, strict
  keys, `runsDir` defaulted from `yakRepoPath`, `stalledAfterMinutes`
  with no default, friendly `ConfigError` messages.
- Locked constants (`src/constants.ts`, spec §4): retry / re-prompt
  limits, accepted `author_association` set, `yak:` status names,
  `.harness/` location, all marker-comment formats — each flagged
  `// config candidate if a real need appears`.
- `yak-harness doctor --config <path>` (spec §3, §10.2): checks box
  preconditions 1–5 (gh auth, yak on PATH, yakRepoPath git repo,
  Node 22+, write access to `.runs/` + `.harness/`); every check runs,
  each failure reported, any failure exits non-zero.
- `observe()` — the tick's read phase (`src/observe.ts`, spec §6.2,
  §5.3): one pass over GitHub issues + comments, `yak pending`, and the
  `runsDir` journals that returns a fully-typed `Observation` for `plan`
  to consume with zero further I/O. Pure classifiers + combiners
  (`classifyRun`, `parseMarkers`, `parseJournal`, `readLabels`,
  `prStateFrom`, `linkMarkers`, `findOrphans`, `findStaleMarkers`) are
  each unit-tested directly; `observe()` is thin orchestration over an
  injectable `ObserveDeps`. Reconstructs the run ↔ issue linkage from
  marker comments every tick (first-seen wins for `runId → issue`,
  last-marker for the inverse, distinct run ids = the attempt counter),
  and records a run id shared by two issues as a `linkageFault`.
  Classifies each run `alive` / `suspended` / `ok` / `failed` /
  `stalled` from its journal tail, with `stalled` a pure function of
  journal mtime (falling back to run-dir mtime) vs `stalledAfterMinutes`.
  Derives orphans, stale markers (carrying the issue's status), and PR
  state for `ok` runs. Flags a two-`yak:<status>` issue as a fault;
  drops `yak:hold` issues from `issues[]` while still counting their
  markers so a parked-but-running job is not mistaken for an orphan.
- `plan()` — the tick's decision phase (`src/plan.ts`, spec §6.1, §6.3):
  a pure function of the `Observation` (no I/O, no clock, tests are plain
  literals) that emits the five action kinds — A `post-gate-comment`,
  B `write-answer-and-resume`, C `relabel`, D `launch-run`,
  E `flag-orphan` — each carrying the idempotency guard it was planned
  under. Precedence within a tick is E → B → A → C → D; a live orphan
  suppresses D that tick; D is the only cap-consuming action and at most
  one launch fires per tick even with several free slots. Every label
  decision comes from the §8.2 transition table; no `yak:<status>`
  string appears in `plan`'s body.
- `apply()` — the tick's write phase (`src/apply.ts`, spec §6.1, §13
  step 4): wires actions **C** (relabel) and **D** (launch) against an
  injectable `ApplyDeps`. D drops a pre-spawn `launching-<issue>.json`
  breadcrumb, snapshots `runsDir`, spawns `yak run … --isolation
  worktree` detached, then polls the listing until exactly one new dir
  appears — that name is the run id (zero after the timeout or two+ at
  once aborts the tick, spec §5.1); asserts the journal's first event is
  our `run.started`; writes the durable `<run-id>.json` pid file, clears
  the breadcrumb, posts the sole linkage marker comment, and sets
  `yak:running`. C moves the single `yak:<status>` label (remove old,
  add new — both idempotent). A/B and the §9.4 escalation comment are
  recorded as `skipped`, not dropped. At most one launch per tick; an
  `ApplyError` aborts the remaining actions and leaves state for a human.
- `apply` action **E** — orphan + stale-marker flagging (`src/apply.ts`,
  spec §5.5, §6.3). A `.harness/runs/<run-id>.json` breadcrumb naming
  the issue re-links an orphan run: `apply` reposts the lost marker
  comment (`branch` = deterministic `yak/<runId>`), so it is no longer
  an orphan next tick — the only sanctioned re-link, never a guess. A
  live orphan with no breadcrumb is logged loudly (`errors`) and, per
  `plan`, counted against the cap and left to wedge new launches until a
  human clears it. An already-terminal (`ok` / `failed`) orphan gets one
  `notes` line and the tick carries on. `observe` gains
  `ObserveDeps.listRunBreadcrumbs()` and `parseRunBreadcrumb`; `Orphan`
  and `FlagOrphanAction` carry a `recovery` field; `ApplyResult` gains a
  non-load-bearing `notes` channel. The §9.4 escalation comment on a
  relabel into `yak:failed` stays deferred to the failure/retry work.
- Failure retry policy + `yak:failed` escalation comment (`src/plan.ts`,
  `src/apply.ts`, spec §9.1, §9.2, §9.4). A move into `yak:failed` off a
  run whose terminal `StepFailure` yak marked `recoverable: true`, while
  the issue's marker-count attempt counter is `< 2`, is pre-empted by an
  **auto-retry** — a fresh `yak run` (new id, new marker, last-wins),
  never `yak resume`. The retry is a launch like any other: cap-consuming,
  at most one per tick, retries ordered before backlog launches.
  `recoverable: false`, a stale marker, a stalled run, `ok`-no-PR and
  `ok`-PR-closed all route straight to `yak:failed`; a second failure
  does too regardless of `recoverable` (hard cap 2). On every transition
  into `yak:failed` `apply` posts **one** escalation comment — what
  broke (`reason: detail`, or "produced no PR", …), what was tried
  ("attempt 2 of 2" / "not retried — `tool-denied` not recoverable"),
  what the human does — guarded by a `<!-- yak-failed run=<id> -->`
  marker that `observe` now parses (`parseFailedMarkers`,
  `Observation.escalated`) so the post is idempotent across ticks.
  `LaunchRunAction` gains an optional `retry`; `RelabelAction` gains
  `escalation`; `transition.launchTarget()` names the post-launch label
  so neither `plan` nor `apply` hard-codes it.
- Stalled-run detection + kill (`src/apply.ts`, `src/apply-deps.ts`,
  spec §6.2, §9.3). A run classified `stalled` (`alive` + journal mtime
  older than `stalledAfterMinutes` — already a pure function of the
  journal in `observe`) now drives an `apply`-side kill: read the pid
  from the durable `.harness/runs/<id>.json` file, verify it is alive
  **and** a `yak` process (pid-reuse guard via `ps`), `SIGTERM` it, then
  relabel `yak:failed` and post the one §9.4 escalation comment carrying
  the stall duration and the kill outcome ("process killed" /
  "process already gone" / "non-yak process — left alone" /
  "no pid on record"). The kill runs **before** the label moves so a
  tick dying mid-kill retries the whole transition rather than stranding
  a live process under the `yak:failed` trap row. `stalled` never
  retries. `RunObservation` gains `mtimeAgeMs` + `recordedPid`;
  `RunBreadcrumb` gains `pid`; `RelabelAction` gains `stall`; `ApplyDeps`
  gains `processInfo` + `killProcess`.
- `realApplyDeps` (`src/apply-deps.ts`) — the write-side `gh` / `yak` /
  filesystem boundary: detached `spawn` + `unref`, idempotent `gh issue
  edit` label ops (absent-label removal swallowed), JSON breadcrumbs
  under `.harness/runs/`.
- `runTick()` (`src/tick.ts`) and the `yak-harness tick --config <path>
  [--dry-run]` CLI command (spec §6.1, §10.2): `observe → plan → apply`,
  a one-line-per-action summary to stdout, `--dry-run` stops after
  `plan`. The `tick.lock` file (§6.6) and `tick.log` (§10.5) arrive
  with #7.
- `observe` now populates `launchBreadcrumbs` from
  `.harness/runs/launching-*.json` (new `ObserveDeps.listLaunchBreadcrumbs`),
  so `plan`'s D guard sees an in-progress launch.
- `transition()` (`src/transition.ts`, spec §8.2) — the label state
  machine as a pure lookup `(currentStatus, observed) -> { next, kind,
  postGate }`, transcribed cell-for-cell from §8.2 and exhaustively
  unit-tested against an independent transcription. `observed` widens
  the run class to the table's eight columns (`ok` split by PR
  disposition; `failed` / `stalled` / stale marker collapsed to
  `terminal-bad`). `yak:failed` and `yak:done` are traps — every column
  is a noop.
- `Observation` gains `maxConcurrent` (so `plan` stays a pure function
  of one value), plus `launchBreadcrumbs` (now populated from
  `.harness/runs/launching-*.json`), and `gatesPosted` / `gateReplies` —
  empty until the gate-bridge (#6) work populates them.
- `realObserveDeps` (`src/observe-deps.ts`) — the sole `gh` / `yak` /
  filesystem boundary. Guards every `JSON.parse` of external output
  behind a typed `ObserveError`; boundary-validates `yak pending` with a
  local zod schema and drops malformed entries; a per-issue comment-read
  failure faults just that issue instead of aborting the tick; the `ok`
  PR probe falls back to a `--head` branch lookup (using the marker's
  recorded branch) before reporting "no PR", so a transient `gh` blip
  can't route a healthy run to `yak:failed`. Run ids that reach a path
  (`runIdIsSafe`) and PR URLs that reach `gh` (`prUrlLooksValid`,
  pinned to `config.repo`) are validated first.
- Local `zod` re-declarations of the three on-disk yak shapes
  (`src/yak-schemas.ts`, spec §10.1): `GatePendingRequest`, the
  `run.started` / `run.finished` journal events, and `StepFailure` —
  used to validate at the boundary. No `@lchase/yak` build dependency.
- Spec §4.1: `implement-change` as the reference workflow the harness
  drives — one yak workflow spanning bug / feature / chore, with
  feature-only steps (`design`, `design-review`, `docs`) self-skipping
  via `skipIf` off an `assess` step, and a bounded `deliver` loop
  bridging review findings back to `build` before suspending.
- `docs/design/workflows/`: decision trail and tldraw diagrams for
  `fix-defect` (yak's own reference) and `implement-change`.
- `docs/design/yak-harness-and-yak-engine.*`: layered system diagram
  (Human → GitHub → yak-harness → yak engine).

### Tooling

- PR pre-checks: `.github/workflows/ci.yml` runs `typecheck`, Biome
  lint+format, `vitest` with coverage thresholds (90% lines/statements,
  85% branches/functions on the pure layer; the `*-deps.ts` shell-out
  boundary + `cli.ts` are excluded by design), `build`, and two repo
  guards — `guard:deps` (runtime deps stay `{zod, ajv}`, no `@lchase/yak`
  anywhere) and `guard:changelog` (source change ⇒ CHANGELOG touched).
  A `pr-title` job lints the PR title as a Conventional Commit (it
  becomes the squash-merge subject).
- Biome adopted as the single formatter + linter (`biome.json`); repo
  reformatted once to its style. `npm run check` runs the whole gate
  locally; a `pre-push` hook (via `.githooks/`, wired by `prepare`)
  mirrors CI.

### Changed

- Config default `workflow` is now `implement-change` (was `fix-defect`).
- `StepFailureSchema.reason` widened from a 7-value enum to any non-empty
  string (spec §9.1 — yak owns the failure taxonomy; the harness keys
  retry off `recoverable`, not its own allowlist). Known values kept as
  `KNOWN_STEP_FAILURE_REASONS` for reference.
- `RunFinishedEventSchema.status` widened to any non-empty string so a
  terminal `run.finished` yak adds later still parses (and classifies as
  `failed` / needs-human) instead of being silently dropped.
- New `StepFailedEventSchema` (`t: "step.failed"`) added to
  `JournalEventSchema` — the third re-declared yak on-disk shape,
  carrying the validated `StepFailure` behind a `failed` run (spec §9.4).
