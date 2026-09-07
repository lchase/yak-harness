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
