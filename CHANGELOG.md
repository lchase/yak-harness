# Changelog

All notable changes to this project are documented here. The project
uses [Conventional Commits](https://www.conventionalcommits.org/); this
file is maintained by hand until a release-please pipeline lands
(spec §10.4).

## [Unreleased]

### Added

- Repo scaffold: TypeScript + ESM + Node 22 toolchain, `tsup` build,
  `vitest`, `zod` + `ajv` dependencies, `CLAUDE.md` invariants.
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
