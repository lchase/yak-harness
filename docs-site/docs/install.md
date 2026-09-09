---
sidebar_position: 1
title: Install & setup
---

# Install & setup

The harness runs on a **persistent-filesystem box** — same machine,
same disk, tick after tick — co-located with a checkout of the repo yak
will work in.

## Install

Both are on npm:

```bash
npm install -g @lchase/yak @lchase/yak-harness
```

Check:

```bash
yak --version           # >= 0.3.0
yak-harness --help
```

## Upgrade to latest

```bash
npm install -g @lchase/yak@latest @lchase/yak-harness@latest
```

No restart — the tick is a stateless process, so the next run picks up
the new version. Run `yak-harness doctor` again afterwards.

### From a source checkout instead

To run an unreleased build (contributing, or testing `main`):

```bash
git clone git@github.com:lchase/yak-harness.git
cd yak-harness
npm ci && npm run build
npm link                # puts the `yak-harness` bin on PATH
```

Upgrades are `git pull && npm ci && npm run build`. Or skip `npm link`
and invoke `node /path/to/yak-harness/dist/cli.js tick --config …`
directly.

## Run

Write one JSON config file:

```json
{
  "repo": "lchase/my-backlog",
  "yakRepoPath": "/srv/my-project",
  "stalledAfterMinutes": 45
}
```

Then:

```bash
yak-harness doctor --config /srv/harness.config.json   # check the box
yak-harness tick   --config /srv/harness.config.json --dry-run   # plan only
yak-harness tick   --config /srv/harness.config.json   # one real pass
```

Schedule the real tick with cron — one line, no service:

```cron
*/5 * * * * yak-harness tick --config /srv/harness.config.json
```

Every config key is in the [Configuration reference](./configuration).
`stalledAfterMinutes` has **no default** — you must set it, and it must
exceed the longest single agent step your workflow runs.

---

## Box preconditions

`yak-harness doctor` checks all of these. The harness assumes them and
does **not** install or manage any:

1. **`gh` CLI installed and authenticated** for the target repo, with
   `repo` scope. The harness shells out to `gh` for every GitHub
   operation and never handles a token itself (`gh auth status`).
2. **`yak` on `PATH`**, ≥ 0.3.0 (for `yak run --input`) — a **runtime**
   requirement, there is no `@lchase/yak` build dependency.
3. **The target repo checked out** at `yakRepoPath`, on its default
   branch. The harness never clones or pulls it — keeping that checkout
   current is your job (usually a separate cron line).
4. **Node 22 or newer** to run `yak-harness` itself.
5. **Write access** to `<yakRepoPath>/.runs/` and
   `<yakRepoPath>/.harness/`.

## `yak-harness doctor`

```bash
yak-harness doctor --config /srv/harness.config.json
```

```
  PASS  gh authenticated: gh auth status ok
  PASS  yak on PATH: yak 0.3.1
  PASS  yakRepoPath is a checked-out git repo: /srv/my-project is a git repo on the default branch "main"
  PASS  Node 22+: Node v22.11.0
  PASS  write access to .runs/ and .harness/: both writable

doctor: all checks passed
```

Every check runs even when an earlier one fails, so one pass tells you
everything that is wrong. A `FAIL` line carries the underlying error
(the `gh` / `git` stderr, the Node version, the path that would not
accept a write probe). Run it after setup and after any upgrade.

## Read next

- [Concepts](./concepts) — the tick and the label state machine.
- [Quickstart](./quickstart) — a dry-run against a real repo, no budget
  spent.
