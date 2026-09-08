# Design note — the monitor dashboard

> **STATUS: accepted; built 2026-09-07.** Not in the v1 spec's
> implementation order. This note records the decision to allow a
> read-only dashboard, the hard constraints on it, and what it renders.
> Shipped as `yak-harness dashboard` (`src/dashboard/`): run replay,
> workflow-graph layout, HTML/CSS render, the `detectDrift` join, and a
> `--serve` loopback HTTP server that re-runs the whole pass per
> request. Not yet built: completed-run history, a `tick.log` tail pane.

## The tension it resolves

The destination grill (2026-09-05) landed on: **if you need a website
to know what the harness is doing, the harness is opaque, and that is a
bug.** The truth must be legible from GitHub labels + marker comments +
yak's `.runs/` journal alone. `yak-harness doctor` and `tick.log` are
the sanctioned windows.

That still holds. What this note adds: a **read-only projection** of
that same truth is not a crutch as long as it never becomes a second
source of truth and the tick never depends on it. During bring-up and
incident triage, seeing every live run positioned on the workflow it is
running is worth more than reading `tick.log` line by line.

Framing: this is `doctor` + `tick.log` rendered as an interactive
picture. An investigation aid. **Not infrastructure.**

## Hard constraints

1. **Zero durable state.** The dashboard reads GitHub (issues, labels,
   marker comments), the yak `.runs/` journals, and `.harness/` scratch.
   It reconstructs everything on each load. Deleting it loses nothing —
   same rule as `.harness/` (spec §2).

2. **The tick never depends on it.** No write path to GitHub, yak, or
   `.harness/`. The harness does not know it exists. Pure spectator. If
   the dashboard is down, every tick still runs identically.

   `--serve` does not weaken this. It is a loopback HTTP server
   (`127.0.0.1` by default) that runs the **entire** `observe → build →
   render` pass on every request and holds nothing between them — a
   restart, or hitting it after an hour, reconstructs the identical
   view from GitHub + `.runs/` alone. The page carries one small poll
   script: every N seconds it re-fetches `/fragment` (the body HTML)
   and swaps it into `.wrap` so the numbers update without the scroll
   jumping. Every fetch is still a full rescan on the server — the
   client just holds the view still while it happens. It is still
   `doctor` + `tick.log`, now on a timer.

3. **No new source of truth.** Every value on screen traces to a label,
   a marker comment, a journal event, or a pid file. If the dashboard
   can show something those cannot, that is the opacity bug resurfacing
   — fix the harness, not the dashboard.

4. **It earns removal by going quiet, not by teardown.** When trust is
   high you stop opening it. It is cheap to keep and cheap to ignore.
   The harness performs zero destructive cleanup (spec §8.4); the
   dashboard gets the same treatment.

5. **Deeper yak coupling stays quarantined here.** See below.

## What it renders

Two inputs, joined:

- **Workflow definition** — read from `.runs/<id>/workflow.json`, the
  fully-compiled step list yak snapshotted for that run (`id`, `needs`,
  `kind`, `skipIf`). **Not** the yaml in `yakRepoPath`: the compiled
  JSON is stable and each run keeps its own copy, so the graph always
  matches the run drawn on it even if the repo's workflow has since
  changed. Longest-path layering off `needs` gives the columns.

- **Per-run timeline** — read from each `.runs/<id>/` journal: which
  step the run currently sits on, gate suspensions, `deliver`-loop
  iteration count, which step a `StepFailure` fired on, event mtimes
  (for the `stalled` fact).

- **Run context** — so a card is never just "workflow X, run N": the
  linked GitHub issue #/title, the `assess` artifact
  (`.runs/<id>/artifacts/assessment.json` — kind, confidence, and the
  run's own paragraph on what the change is and where it goes), the
  `plan` artifact's checklist, and the verbatim gate `rendered` prose
  when the run is suspended (freeform text the harness posts as-is —
  spec §7 — shown here for the same reason).

Render (visual design: "Yak Harness Monitor v2", claude.ai/design
`e5ae1991` — dark, Geist / Geist Mono, one panel per section):

- A stat row — issues, active runs (with summed token/$ spend), label
  drift, problems — then one card per run.
- Per card: the run's step **pipeline** as a CSS grid of state boxes
  (`graph.ts` still computes the column/row layout off `needs`; the
  render just drops the edges). A box's colour is this run's state for
  that step — done / running / gate / failed / skipped (dashed) / not
  started. The box the run is on **now** carries a ring and a `now`
  label. A legend keys the palette, which the run-state pills reuse.
- The **run-state pill** and the harness's **`yak:<status>` label**
  sit side by side on the card. Where they **disagree** is exactly the
  drift bring-up needs to catch (e.g. `yak:running` on a run whose
  journal has been silent past `stalledAfterMinutes`); that gets its
  own `label drift` inset.
- Per run: attempt count (spec §9.2), last-event age, token/$ spend,
  workflow name.
- Optionally (not built): a `tick.log` tail pane, unparsed.

## The coupling caveat

To get the per-step timeline the dashboard parses yak's journal
**deeper than the harness does**. Invariant 2 holds the harness to three
re-declared on-disk shapes (`GatePendingRequest`, `run.started` /
`run.finished`, `StepFailure`). The dashboard additionally reads
`step.started` / `step.completed` / `step.failed` / `gate.opened` /
`gate.answered` / `run.suspended` / `run.resumed` / `loop.iteration` /
`budget.consumed`.

That is allowed **because the dashboard is a spectator, not a driver** —
but it means the dashboard couples to yak's journal event format, which
the harness deliberately does not. Contained as built:

- All journal-shape knowledge lives in `src/dashboard/replay.ts` — one
  module, not shared with the tick.
- Tolerant parsing: a non-JSON line or an unrecognised event `t` is
  skipped, never fatal. A journal `replayRun` cannot fully read
  degrades to the coarse started / finished / failed view — the same
  view the harness has.
- No zod at this boundary: the dashboard reads fields defensively
  (`str()` / `num()` helpers) rather than validating a re-declared
  shape, precisely so a new yak event never breaks it.
- The harness code never imports from `src/dashboard/` and stays
  ignorant.

## Not deciding now

- Framework, hosting, whether it polls or renders once per hit.
- Whether it reads GitHub live or piggybacks on a tick's fetch.
- Historical / completed runs vs live-only.

These are build-time calls, made when the dashboard is actually built.
