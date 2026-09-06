# 07 — Deployment & packaging shape

Type: grilling
Status: resolved
Blocked by: 06

## Question

With the runtime behaviour pinned (tickets 02–06), decide how the
harness is packaged, installed, and released — the last design
question before `spec.md` can be assembled.

Decide:

1. **Repo.** Standalone repo vs a package inside the yak repo. Map
   Notes lean standalone ("new, standalone, GitHub-only package");
   the "refactor yak into packages" option is explicitly Out of scope.
   Confirm standalone and name it.
2. **Language / runtime.** Presumably TypeScript + Node 22 to match
   yak and reuse zod / the same toolchain — confirm, and whether it
   depends on any yak package (e.g. importing yak's `PendingRequest`
   types) or stays fully decoupled and re-declares the on-disk shapes
   it reads.
3. **The cron entry.** What actually runs each tick — a
   `harness tick` CLI command invoked by system `cron` / a systemd
   timer / a launchd plist on the box? How is it installed (a documented
   manual step, an install script, a container)?
4. **Auth on the box.** Map Notes: shell out to the already-authed
   `gh` CLI. Confirm and specify what the harness assumes about the
   box (gh installed + authed, yak installed, the yak repo checked out
   at a known path, write access to `.runs/`).
5. **Release.** How the harness is versioned and published — npm
   (matching yak's trusted-publishing + release-please setup) or just
   a repo you clone and `pnpm build` on the box? Does it need
   releasing at all for a single-box deployment?
6. **Harness logging** (pulled from the observability fog): does
   `harness tick` write a log anywhere (stdout captured by cron,
   a file under `.harness/`, nothing)? Minimal answer expected.

Recommendation going in: standalone TS/Node repo, fully decoupled
(re-declares the ~3 on-disk shapes it reads, no yak dependency),
`harness tick` run by plain system cron with a documented one-page
setup (gh authed, yak on PATH, repo path in config), stdout to a
rotating file under `.harness/`, released as a plain
`git pull && build` for now (npm later if a second box appears).

## Answer

### 1. Repo + coupling

- **New standalone GitHub repo, `yak-harness`.** Not `yak-factory` —
  the map's Out-of-scope reserves that name for the hypothetical
  future monorepo sibling.
- **Fully decoupled from yak.** No `@lchase/yak` dependency. The
  harness re-declares as local zod schemas the three on-disk yak
  shapes it reads — `GatePendingRequest` (`pending/<step>.request.json`,
  spec §4.5), the `run.started` / `run.finished` journal events, and
  `StepFailure` `{reason, detail, recoverable}` — and parses yak's
  files at the boundary. yak is a **runtime** requirement (the `yak`
  binary on PATH), never a build dependency. Rationale: yak exports no
  types entrypoint, the shapes are a small documented protocol, and
  independent versioning means a yak internal refactor that leaves the
  on-disk contract intact can't break the harness. The re-declared
  schemas double as boundary validation.
- Toolchain mirrors yak: TypeScript, ESM, Node 22, `tsup` build to
  `dist/`, `vitest`, `bin` entry `yak-harness`. `ajv` (ticket 04) and
  `zod` as deps.

### 2. Cron entry

- The harness is a CLI: `yak-harness tick --config <path>`.
- Scheduled by **plain system `cron`** — one documented crontab line,
  e.g.
  `*/5 * * * * yak-harness tick --config /srv/harness.config.json`.
  A `systemd` timer is a documented **alternative**, not a
  requirement; no unit files shipped.
- **Overlap guard is the harness's job**, not the operator's: at
  startup `tick` takes an exclusive lock on `.harness/tick.lock`
  (flock-style) and exits 0 immediately if another tick holds it. So a
  slow tick overlapping the next cron fire is safe with zero operator
  setup.
- Cron interval is **not** in the harness config (ticket 06) — it
  lives only in the crontab line.

### 3. Box preconditions (spec's "Requirements" section)

The harness assumes, and does **not** manage:

1. `gh` CLI installed + authenticated, `repo` scope, access to the
   target repo. Harness shells out to `gh`; never handles a token.
2. `yak` on `PATH` (e.g. `npm i -g @lchase/yak`). Run as subprocesses:
   `yak run` / `yak resume` / `yak pending`.
3. The target repo checked out at `yakRepoPath` (config), on its
   default branch. The harness does not clone or pull it — keeping it
   current is the operator's concern (or a separate cron).
4. Node 22+ to run `yak-harness`.
5. Write access to `<yakRepoPath>/.runs/` and `<yakRepoPath>/.harness/`
   as the cron user.
6. **Persistent filesystem** — `.runs/` journals and `.harness/` pid
   files survive between ticks and across reboots. Not ephemeral CI.

`yak-harness doctor` — a preflight subcommand that checks 1–5 on
demand (and is the natural thing to run once after setup).

### 4. Versioning + release

- **Deploy = `git pull && npm run build`** on the box; the next cron
  tick runs the new `dist/`. No restart (stateless process).
- Repo uses **conventional commits + a maintained CHANGELOG** (cheap,
  and makes a later release-please switch trivial) but **no npm
  publish pipeline** and no release-please wiring in v1.
- npm publish / release-please / trusted publishing (mirroring yak)
  is **explicitly deferred** until a second box or external consumer
  exists. Noted in the spec, not built.

### 5. Logging + observability

- **One self-rotating JSON-lines file, `.harness/tick.log`.** One line
  per tick: timestamp, duration, counts (issues scanned, runs by
  class), every action taken (`launched run X for #12`, `posted gate
  on #7`, `resumed X`, `killed stalled X`, `flagged #9 failed`), and
  any non-fatal errors. The harness rotates it itself at a size cap —
  no `logrotate` dependency.
- **stderr + non-zero exit** for fatal preconditions (bad config, no
  `gh` auth, lock held-and-stale) — cron captures it.
- **Nothing remote** — no metrics endpoint, no dashboard, no alert
  sink (map: aggregate observability is out of scope). The durable
  human-facing record is the GitHub issues themselves: labels, marker
  comments, and the `yak-failed` explanation comment (ticket 05).
- **`yak-harness tick --dry-run`** — observe + plan, print the planned
  actions, apply nothing. Covers "what would it do right now".

### Candidate yak tickets

None new.

### Consequences for spec assembly

Nothing left blocking. The spec (`spec.md` in this effort's directory,
per the local-markdown tracker) can now be assembled from tickets
01–07 + the prototype. Section shape: Overview / Mental model,
Requirements (§3 here), Config (ticket 06), The tick — observe/plan/
apply (ticket 02), Run↔issue linkage (ticket 01), Label lifecycle +
transition table (ticket 03), Gate bridge (ticket 04 + prototype),
Failure & retry (ticket 05), Deployment (this ticket), Candidate yak
changes (collected from all tickets), Out of scope (from the map).
