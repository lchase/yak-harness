# 06 — Config surface

Type: grilling
Status: resolved
Blocked by: —

## Question

Tickets 01–04 have pinned the tick algorithm, the label lifecycle, and
the gate bridge, each surfacing knobs. Enumerate the harness's full
configuration surface and decide its shape.

Knobs surfaced so far:

- GitHub repo (owner/name); the qualifying label name (default `yak`)
  and whether the `yak:*` status prefix is configurable at all
  (ticket 03 fixed the set — is the prefix locked too?).
- Poll / cron interval (this is set in the cron entry itself, not the
  harness — does the harness need to know it? e.g. for the `stalled`
  threshold default).
- Concurrency cap (ticket 02: hardcoded 1 initially, "trivially
  configurable later" per map Notes — make it config now or leave the
  constant?).
- Path to `.runs/` (and the yak repo working directory the harness
  launches `yak run` in).
- `stalled` staleness threshold (ticket 02).
- Gate re-prompt limit (ticket 04: fixed at 1 — config or constant?).
- Retry policy knobs (whatever ticket 05 lands).
- `.harness/` directory location — holds the `launching` breadcrumb
  (ticket 02) and, if ever added, the `runs.json` scan cache
  (deferred from ticket 01).

Decide:

1. **Config mechanism.** A file (`harness.config.json` / TOML / a
   `[harness]` block somewhere), env vars, CLI flags, or a mix. Where
   does it live relative to the yak repo and the cron entry?
2. **What is configurable vs a locked constant** for the first
   version. Bias: lock everything that has one obviously-right value,
   expose only repo + label + paths.
3. **The `.harness/runs.json` scan-cache decision** (deferred from
   ticket 01): specify it now as an optional pure cache, or leave it
   entirely to a future ticket when API volume actually hurts?
4. **Defaults and validation.** Does the harness zod-parse its config
   at startup (matches yak's "parse at the boundary" convention) and
   refuse to run on a bad config?

Recommendation going in: one `harness.config.json` next to the cron
entry, zod-parsed at startup, minimal surface (repo, qualifying label,
yak repo path, `.runs/` path), everything else a documented constant
until a real need to change it. Defer `runs.json` cache to its own
future ticket — note it, don't build it.

## Answer

### 1. Mechanism

One plain-JSON config file, path passed as `--config <path>` to
`harness tick` (the cron entry names it explicitly — no fixed
conventional path, so the box can run the harness against more than one
repo later without a v1 feature for it). **Zod schema at startup**
(matches yak's "parse at the boundary with zod, then trust the types");
a schema violation exits non-zero before any observation. Not env vars
(a cron environment is a poor place to manage a dozen), not flags
(a committed file is greppable and reviewable). Field docs live in a
sibling `harness.config.md` or `// `-style comment convention.

### 2. Configurable fields

```jsonc
{
  "repo": "owner/name",              // required
  "yakRepoPath": "/srv/yak",         // required — where `yak run` is invoked
  "runsDir": "/srv/yak/.runs",       // optional, default `<yakRepoPath>/.runs`
  "qualifyingLabel": "yak",          // default "yak"
  "stalledAfterMinutes": 45,         // required — no safe default; agent step
                                     //   length varies wildly by workflow
  "maxConcurrent": 2,                // default 2
  "workflow": "fix-defect",          // default "fix-defect"
  "inputTemplate": "issueRef={{repo}}#{{number}}"
                                     // default as shown; {{repo}} {{number}}
                                     //   {{title}} substitution
}
```

- **`maxConcurrent`** — the number of `yak run`s in flight at once
  (cap=1 in charting was pure test-conservatism, not a constraint).
  Default 2. **One launch per tick is unchanged** (ticket 02
  precedence D), so idle → full cap takes a few ticks; this keeps
  ticket 01's snapshot-diff capture unambiguous (exactly one new
  `.runs/` dir per tick, harness is sole launcher).
- **`workflow` + `inputTemplate`** — one workflow per harness
  deployment. Label-routing to multiple workflows
  (`yak:bug` → `fix-defect`, …) is a future ticket, not v1.

### 3. Locked constants (a `const` in source + `// config candidate if
a real need appears`)

| constant | value | source |
|---|---|---|
| gate re-prompt limit | `1` | ticket 04 |
| max run attempts | `2` | ticket 05 |
| accepted `author_association` | `{OWNER, MEMBER, COLLABORATOR}` | ticket 04 |
| `yak:` status prefix + the 6 status names | fixed | ticket 03 (state-machine code hardcodes them) |
| `.harness/` location | `<yakRepoPath>/.harness` | operational scratch |
| all marker comment formats | fixed strings | machine contract |

**Cron interval is not harness config** — it lives in the cron / timer
/ launchd entry (ticket 07). The tick is stateless and idempotent; it
does not need to know its own cadence.

### 4. `.harness/runs.json` scan cache — not built, not in the schema

Per-tick GitHub cost: one `gh` issue-list query, one comments fetch per
mid-flight issue (bounded by `maxConcurrent`), one `gh pr view` per
`yak:pr-open` issue — ~5–10 calls/tick. Against GitHub's 5,000/hr
authenticated limit at a 5-min cron (~12 ticks/hr) that is two orders
of magnitude of headroom. Spec carries one sentence: *the harness
re-scans every tick; a result cache is a future optimisation only if
API volume approaches the rate limit, and would be a pure cache with
full-scan fallback and no correctness impact.* The only thing in
`.harness/` for v1 is the ticket-05 pid files
`.harness/runs/<run-id>.json`.

### 5. Startup validation

`harness tick` zod-parses `--config` before anything else. Invalid
config, unreadable file, or missing required field → print the zod
error, exit non-zero, do nothing. Also checked at startup (fail fast,
not mid-tick): `yakRepoPath` exists and is a git repo, `gh auth status`
succeeds, `yak --version` runs. Any failure → non-zero exit, no
partial tick.

### Amendments to resolved tickets

- **Ticket 01 §1** — "serial launches under cap=1" → the guarantee it
  relies on is "harness is the sole launcher + one launch per tick,"
  which holds for any `maxConcurrent`. Wording updated cap=1 → cap=N.
- **Ticket 02** — in-flight test `in_flight_count == 0` →
  `in_flight_count < maxConcurrent`; one-launch-per-tick unchanged.

### Candidate yak tickets

None new.
