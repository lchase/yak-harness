# yak workflows the harness drives

The harness (`docs/spec.md`) launches one `yak run <workflow>` per qualifying
issue. This directory is the design trail for that workflow.

## Files

| file | what it is |
|---|---|
| `fix-defect.{tldr,png}` | yak's own **reference workflow**, drawn verbatim from yak `spec.md` §7. The baseline — a bug that needs no design and no docs runs this shape. |
| `implement-change.{tldr,png}` | **The harness reference workflow** (`workflow` config default — spec §4.1). One workflow covering bug / feature / chore. `fix-defect` is this with the feature-only steps skipped. |

`.tldr` files open at [tldraw.com](https://tldraw.com) (File → Open) or in any
tldraw editor.

## Shape

Not linear, not a free graph — a **DAG** (yak rejects cycles at load;
iteration only via the bounded `loop` combinator). A linear backbone with two
shaped regions:

```
assess → confirm-scope (gate) → design ★ → design-review ★ (gate) → plan
  → deliver  (LOOP, ≤ 3 rounds, no-progress 2, onExhausted: suspend)
       build → integrate → review (map, fan-out) → rank (transform, fan-in)
       rank ──blocking findings ∨ verify red──▶ build     next round
       rank ──budget exhausted──────────────▶ suspend     → human (gate protocol)
       rank ──clean────────────────────────▶ exit
  → docs ★ → approve-pr (gate) → open-pr (command) → PR
```

## Decisions

- **One workflow, not two (bug vs feature).** ~70% shared. `assess` (first
  step, one agent) classifies the change and emits
  `{ kind, confidence, needsDesign, likelySubtasks, needsDocs }`. The
  feature-only steps (★ — `design`, `design-review`, `docs`) `skipIf` off that.
  Splits the "trivial vs substantial" axis as a spectrum, not a binary. Keeps
  the harness one-workflow-per-deployment with no label-routing (spec §11).

- **Review findings loop back via a bounded outer `loop`, not a back-edge.**
  yak has no raw back-edge (cycle → load error). `deliver` wraps
  `build → integrate → review → rank`; `rank`'s blocking findings (or a red
  `verify`) start another round, capped at 3, `noProgress` 2. Exhaustion →
  `suspend` → the same gate protocol the harness already bridges. The
  reference `fix-defect` omits this loop (MVP); the harness needs it because
  its value is *unattended* runs reaching a good PR.

- **`build` round 2+ is one agent over the whole diff**, not a re-map over
  touched subtasks. Round 1's `map` over `subtasks[]` does the parallel
  lifting; revisions are smaller and usually cross-cutting (naming, an edge
  case, a missed test) and don't partition by subtask. A revision that
  genuinely needs parallel work is the exhaustion signal — suspend and let a
  human re-scope. `map` over a 1-element `subtasks[]` just runs once, so a
  single-task change needs no special-casing.

- **`docs` runs once, after the loop settles** — never mid-revision, so it
  never re-does work when `deliver` iterates.

- **Acceptance check folded into `approve-pr`** — its `render` includes the
  acceptance criteria plus `ranked-findings`. No separate gate (avoids gate
  fatigue: a feature already stops at `confirm-scope`, `design-review`,
  `approve-pr`).

- **`review` / `rank` carry `skipIf verify not green`** — no reviewing code
  that doesn't compile; early loop rounds stay cheap.

## Open

- `deliver` budget: 3 rounds — revisit if real runs routinely exhaust it.
- `assess` as one agent doing classify + locate — split only if it proves too
  much for one step.

## Acceptance sandbox

`yak-kanban-sandbox` (harness issue #11) — a standalone throwaway repo: a
deliberately-broken kanban board plus five qualified issues, one per shape in
this workflow (hands-free bug, investigation bug, design+docs feature,
design-fork feature, chore). Pristine state is a `seed` tag; `scripts/reset.sh`
reverts. This is where `implement-change` gets run end to end.
