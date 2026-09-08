---
sidebar_position: 6
title: Configuration reference
---

# Configuration reference

One plain-JSON file, passed as `--config <path>` to **every**
invocation. It is `zod`-parsed at startup, before any observation — a
bad key or a missing required field prints the error and exits non-zero.
Unknown keys are a loud error, not silently ignored.

## Keys

| key | required | default | notes |
|---|---|---|---|
| `repo` | yes | — | `owner/name` of the **tracker** repo (where the issues and labels live) |
| `yakRepoPath` | yes | — | absolute path to the git checkout `yak run` is invoked in |
| `stalledAfterMinutes` | yes | — | journal-mtime age past which a live run is classed `stalled`. **No default** |
| `runsDir` | no | `<yakRepoPath>/.runs` | absolute path to yak's runs journal tree |
| `qualifyingLabel` | no | `"yak"` | the human-applied scope-defence label |
| `maxConcurrent` | no | `2` | cap on concurrent `yak run`s (positive integer) |
| `workflow` | no | `"implement-change"` | yak workflow to launch per issue |
| `inputTemplate` | no | `"issueRef={{repo}}#{{number}}"` | the `--input` string; `{{repo}}` and `{{number}}` are substituted |

`yakRepoPath` and `runsDir` **must be absolute** — the harness runs
from cron with an unpredictable working directory.

### `stalledAfterMinutes`

No default on purpose. A healthy agent step legitimately runs a long
time, and the right threshold depends entirely on the workflow. Set it
**above the slowest single agent step** your workflow runs — for
`implement-change`, that is `build`, which on a feature can fan out to
several sub-agents. Too low and you kill live runs; too high and a
genuinely wedged run sits burning a slot for longer than it should.

### `workflow`

A bare name (no `/`) is resolved to a workflow the harness bundles —
`"implement-change"` maps to its own
`workflows/implement-change.yaml`, one workflow spanning bug / feature /
chore. A value that looks like a path is used as-is, resolved against
`yakRepoPath`, for a repo that ships its own workflow.

The v1 `implement-change` `deliver` phase is **linear** (`build →
verify → checkpoint`); the full bounded review/rank loop from the spec
sketch waits on
[yak#35](https://github.com/lchase/yak/issues/35). See
[spec §4.1](https://github.com/lchase/yak-harness/blob/main/docs/spec.md).

### `maxConcurrent`

How many runs may be in flight at once. The harness still launches only
**one per tick**, so an idle harness ramps to this number over several
ticks. Raise it if a gate backlog is starving new work — that is the
intended lever, not a gate timeout.

## Locked constants — not configurable

These live as `const` in source. Each carries a
`// config candidate if a real need appears` comment; none is tunable
per box, because letting them drift would break the durable state other
ticks reconstruct.

| constant | value |
|---|---|
| gate re-prompt limit | `1` |
| max run attempts (original + retries) | `2` |
| accepted `author_association` | `OWNER`, `MEMBER`, `COLLABORATOR` |
| `yak:` status prefix + the six status names | fixed |
| `.harness/` location | `<yakRepoPath>/.harness` |
| every marker-comment format | fixed strings (a machine contract) |
| `tick.log` rotation size | 2 MiB, one generation kept |

## The cron interval is not config

It lives only in the crontab line. The tick is stateless and
idempotent; it does not know, or need to know, its own cadence. See
[Operations](./operations).

## Example

```json title="/srv/harness.config.json"
{
  "repo": "lchase/my-backlog",
  "yakRepoPath": "/srv/my-project",
  "stalledAfterMinutes": 45,
  "maxConcurrent": 3
}
```
