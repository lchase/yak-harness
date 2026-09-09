# Releasing

`@lchase/yak-harness` publishes to npm through
[release-please](https://github.com/googleapis/release-please) + OIDC
trusted publishing. Mirrors yak.

## The flow

1. Land `feat:` / `fix:` commits on `main` (Conventional Commits — the
   PR title becomes the squash subject, linted by the `pr-title` CI
   job).
2. `.github/workflows/release-please.yml` runs on every push to `main`
   and maintains a **release PR** — it bumps the version, regenerates
   the `CHANGELOG.md` section, and updates
   `.release-please-manifest.json`.
3. Merging the release PR tags the release (`yak-harness-v<version>`)
   and dispatches `.github/workflows/publish.yml`, which runs the gate
   (`typecheck`, `test`, `build`) and `npm publish --provenance`.

`bump-minor-pre-major` is set, so while below `1.0.0` a `feat:` bumps
the minor and a `fix:` the patch. Nothing between releases is manual.

## `CHANGELOG.md`

Generated from v0.1.0 on — **do not hand-edit it**. Pre-pipeline
history lives in `CHANGELOG.pre-0.1.0.md` (frozen).

## One-time setup (already done, recorded here)

- **npm trusted publisher**: npmjs.com → `@lchase` org → the
  `yak-harness` package → add a trusted publisher pointing at
  `lchase/yak-harness` and `.github/workflows/publish.yml`.
- **Repo setting**: Settings → Actions → General → Workflow permissions
  → *Allow GitHub Actions to create and approve pull requests* (needed
  for release-please to open its PR).

## Forcing a specific version

Add a `Release-As: <version>` footer to a commit on `main` (or a squash
body). release-please then cuts exactly that version on its next run,
regardless of the commit types since the last release.
