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
- `transition()` (`src/transition.ts`, spec §8.2) — the label state
  machine as a pure lookup `(currentStatus, observed) -> { next, kind,
  postGate }`, transcribed cell-for-cell from §8.2 and exhaustively
  unit-tested against an independent transcription. `observed` widens
  the run class to the table's eight columns (`ok` split by PR
  disposition; `failed` / `stalled` / stale marker collapsed to
  `terminal-bad`). `yak:failed` and `yak:done` are traps — every column
  is a noop.
- `Observation` gains `maxConcurrent` (so `plan` stays a pure function
  of one value), plus `launchBreadcrumbs`, `gatesPosted`, and
  `gateReplies` — empty until the detached-launch (#7) and gate-bridge
  (#6) work populates them.
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
