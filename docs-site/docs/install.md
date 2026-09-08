---
sidebar_position: 1
title: Install & setup
---

# Install & setup

The harness runs on a **persistent-filesystem box** — the same machine,
with the same disk, tick after tick. It co-locates with a checkout of
the repo yak will work in. This page covers what that box needs and how
to check it.

## Box preconditions

The harness assumes all of the following and does **not** install or
manage any of it:

1. **`gh` CLI installed and authenticated** for the target repo, with
   `repo` scope. The harness shells out to `gh` for every GitHub
   operation and never handles a token itself. Check with
   `gh auth status`.
2. **`yak` on `PATH`**, yak ≥ 0.3.0 (for `yak run --input`). A
   **runtime** requirement — there is no `@lchase/yak` build
   dependency. Check with `yak --version`.
3. **The target repo checked out** at `yakRepoPath`, on its default
   branch. The harness never clones or pulls it — keeping that checkout
   current is your job (a separate cron line, usually).
4. **Node 22 or newer** to run `yak-harness` itself.
5. **Write access** to `<yakRepoPath>/.runs/` and
   `<yakRepoPath>/.harness/`.

## Install

Not published to npm in v1. Deploy is a source checkout plus a build:

```bash
git clone git@github.com:lchase/yak-harness.git
cd yak-harness
npm ci
npm run build        # tsup → dist/, with the `yak-harness` bin entry
npm link             # or add dist/cli.js to PATH yourself
```

Upgrades are `git pull && npm ci && npm run build` on the box. The next
cron tick runs the new `dist/` — no restart, because the process is
stateless.

## Configuration

Every invocation takes `--config <path>` pointing at one plain-JSON
file. Minimum:

```json
{
  "repo": "lchase/my-backlog",
  "yakRepoPath": "/srv/my-project",
  "stalledAfterMinutes": 45
}
```

`stalledAfterMinutes` has **no default** — you must set it, and it must
exceed the longest single agent step your workflow runs (see
[Configuration reference](./configuration) for why and for every other
key).

## `yak-harness doctor`

`doctor` checks preconditions 1–5 and exits non-zero if any fail. Every
check runs; every failure is reported.

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
accept a write probe).

Run it once after setting up the box, and again after any upgrade to
yak or `gh`.

## Read next

- [Concepts](./concepts) — the tick and the label state machine.
- [Quickstart](./quickstart) — a dry-run against a real repo, no budget
  spent.
