// Render the dashboard model to one self-contained HTML page. No
// dependencies, no local assets — inline CSS + a CSS-grid pipeline so the
// output file opens anywhere and carries no runtime
// (docs/design/dashboard.md).
//
// Visual design: "Yak Harness Monitor v2" (claude.ai/design project
// e5ae1991). Dark-only, Geist / Geist Mono (Google Fonts, with a system
// fallback stack), one panel per section, a state palette shared by the
// run pills and the per-step pipeline boxes.

import type { DashboardModel, RunView } from "../dashboard.js";
import type { WorkflowGraph } from "./graph.js";
import type { RunReplay, StepStatus } from "./replay.js";

const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function ageText(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

const tokens = (n: number): string => n.toLocaleString("en-US");

// ── state palette ────────────────────────────────────────────────────
// One vocabulary for run-state pills and pipeline step boxes.

type StateKey = "ok" | "run" | "gate" | "fail" | "skip" | "idle";

/** Map a per-step journal status to a palette key. */
function stepStateKey(status: StepStatus | undefined): StateKey {
  switch (status) {
    case "done":
    case "cached":
      return "ok";
    case "running":
      return "run";
    case "gate-open":
      return "gate";
    case "failed":
      return "fail";
    case "skipped":
      return "skip";
    default:
      return "idle";
  }
}

function stepWord(status: StepStatus | undefined): string {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "cached":
      return "done (cached)";
    case "skipped":
      return "skipped — not applicable to this change";
    case "failed":
      return "failed";
    case "gate-open":
      return "waiting on a human at this gate";
    default:
      return "not started";
  }
}

// ── pipeline (CSS grid, no edges — same layout graph.ts computes) ─────

function renderPipeline(
  runId: string,
  graph: WorkflowGraph,
  replay: RunReplay,
): string {
  const boxes = graph.nodes
    .map((n) => {
      const view = replay.steps.get(n.id);
      const key = stepStateKey(view?.status);
      const here = replay.currentStepId === n.id;
      const iter =
        view?.iteration !== undefined
          ? ` <span class="p-iter">#${view.iteration}</span>`
          : "";
      const kind = here ? "now" : esc(n.kind);
      return `<div class="pstep s-${key}${here ? " here" : ""}" style="grid-column:${n.column + 1};grid-row:${n.row + 1}" title="${esc(n.id)} — ${esc(stepWord(view?.status))}">
    <span class="p-dot"></span>
    <span class="p-body"><span class="p-name">${esc(n.id)}</span><span class="p-kind">${kind}${iter}</span></span>
  </div>`;
    })
    .join("\n");

  return `<div class="pipe">
  <div class="pipe-id">${esc(runId)}</div>
  <div class="pipe-grid" style="grid-template-columns:repeat(${graph.columns},minmax(84px,1fr))">
${boxes}
  </div>
</div>`;
}

// ── run card ─────────────────────────────────────────────────────────

function runState(view: RunView): { label: string; key: StateKey } {
  const r = view.replay;
  if (r.finished) {
    const key: StateKey = r.finished.status === "ok" ? "ok" : "fail";
    return { label: `finished ${r.finished.status}`, key };
  }
  if (r.suspend)
    return { label: `suspended (${r.suspend.reason})`, key: "gate" };
  if (view.runClass === "stalled") return { label: "stalled", key: "fail" };
  if (r.currentStepId)
    return { label: `running: ${r.currentStepId}`, key: "run" };
  return { label: view.runClass, key: "run" };
}

function pill(key: StateKey, text: string): string {
  return `<span class="pill s-${key}"><span class="p-dot"></span>${esc(text)}</span>`;
}

function renderRunContext(view: RunView): string {
  const parts: string[] = [];

  // 1. issue title
  if (view.issue === null) {
    parts.push('<span class="orphan">orphan — no linked issue</span>');
  } else {
    const label = `#${view.issue}${view.issueTitle ? ` — ${esc(view.issueTitle)}` : ""}`;
    parts.push(
      `<h2 class="ctx-title">${
        view.issueUrl ? `<a href="${esc(view.issueUrl)}">${label}</a>` : label
      }</h2>`,
    );
  }

  const state = runState(view);
  parts.push(
    `<div class="ctx-pills">${pill(state.key, state.label)}${
      view.status
        ? `<span class="pill neutral">yak:${esc(view.status)}</span>`
        : view.issue !== null
          ? '<span class="pill neutral">no status</span>'
          : ""
    }</div>`,
  );

  return `<div class="ctx-head">
  <div class="ctx-lead">${parts[0]}</div>
  ${parts[1]}
</div>`;
}

/** kind · confidence · needs-docs · ~N edits, mono. */
function renderAssessMeta(view: RunView): string {
  const a = view.assessment;
  if (!a) return "";
  const bits = [
    a.kind && `kind <span class="hi">${esc(a.kind)}</span>`,
    a.confidence !== undefined &&
      `confidence <span class="hi">${a.confidence.toFixed(2)}</span>`,
    a.needsDesign && "needs design",
    a.needsDocs && "needs docs",
    a.likelySubtasks !== undefined &&
      `~${a.likelySubtasks} edit${a.likelySubtasks === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return bits.length
    ? `<div class="meta">${bits.join('<span class="sep"></span>')}</div>`
    : "";
}

function renderInsets(view: RunView): string {
  const out: string[] = [];

  if (view.drift) {
    out.push(
      `<div class="inset fail"><div class="inset-head">${pill("fail", "label drift")}<span class="inset-title">${esc(view.drift)}</span></div></div>`,
    );
  }

  const failures = [...view.replay.steps.entries()].filter(
    ([, s]) => s.status === "failed" && s.failure,
  );
  if (failures.length > 0) {
    const rows = failures
      .map(
        ([id, s]) =>
          `<div class="fail-row"><span class="hi-amber">${esc(id)}</span><span>${esc(s.failure!.reason)}: ${esc(s.failure!.detail)}</span>${pill(
            s.failure!.recoverable ? "ok" : "fail",
            s.failure!.recoverable ? "recoverable" : "not recoverable",
          )}</div>`,
      )
      .join("");
    out.push(`<div class="inset fail">${rows}</div>`);
  }

  if (view.gatePrompt) {
    out.push(
      `<div class="inset gate">
  <div class="inset-head">${pill("gate", "needs a human")}<span class="inset-title">Gate at <code>${esc(view.gatePrompt.stepId)}</code></span></div>
  <pre class="gate-prose">${esc(view.gatePrompt.rendered)}</pre>
</div>`,
    );
  }

  if (view.planSteps) {
    out.push(
      `<details class="inset plain" open>
  <summary><span class="inset-title">Plan</span><span class="mono-faint">${view.planSteps.length} step${view.planSteps.length === 1 ? "" : "s"}</span></summary>
  <ol>${view.planSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
</details>`,
    );
  }

  return out.join("\n");
}

function renderRunCard(view: RunView): string {
  const spendBits = [
    view.replay.tokens > 0 &&
      `<span class="hi">${tokens(view.replay.tokens)} tok${view.replay.usd > 0 ? ` · $${view.replay.usd.toFixed(2)}` : ""}</span>`,
    esc(view.replay.workflow ?? view.graph?.name ?? "?"),
    `attempt ${view.attemptCount || 1}`,
    ageText(view.mtimeAgeMs),
  ].filter(Boolean);

  const summary = view.assessment?.summary
    ? `<p class="ctx-summary">${esc(view.assessment.summary)}</p>`
    : "";

  const pipeline = view.graph
    ? renderPipeline(view.runId, view.graph, view.replay)
    : '<div class="pipe-none">no workflow.json snapshot for this run</div>';

  return `<article class="run">
  ${renderRunContext(view)}
  ${renderAssessMeta(view)}
  ${summary}
  ${renderInsets(view)}
  <div class="meta">${spendBits.join('<span class="sep"></span>')}</div>
  ${pipeline}
</article>`;
}

function renderLegend(): string {
  const item = (k: StateKey, text: string) =>
    `<span class="leg-item"><span class="leg-dot s-${k}"></span>${text}</span>`;
  return `<div class="legend">
  ${item("ok", "done")}
  ${item("run", "running")}
  ${item("gate", "gate")}
  ${item("fail", "failed")}
  ${item("skip", "skipped / not started")}
</div>`;
}

// ── tables / panels ──────────────────────────────────────────────────

function statusPill(status: string | null): string {
  if (!status) return '<span class="pill neutral">not started</span>';
  const key: StateKey =
    status === "running"
      ? "run"
      : status === "waiting"
        ? "gate"
        : status === "failed"
          ? "fail"
          : status === "done" || status === "pr-open"
            ? "ok"
            : "idle";
  return pill(key, `yak:${status}`);
}

function renderBacklog(model: DashboardModel): string {
  const body =
    model.issues.length === 0
      ? '<tr><td colspan="6" class="empty">no harness-relevant issues</td></tr>'
      : model.issues
          .map((i) => {
            const run = model.runs.find((r) => r.issue === i.number);
            return `<tr>
  <td class="mono nowrap dim">#${i.number}</td>
  <td class="strong">${esc(i.title)}</td>
  <td>${statusPill(i.status)}</td>
  <td class="mono faint">${run ? esc(run.runId) : "—"}</td>
  <td class="num">${i.attemptCount || "—"}</td>
  <td class="num ${i.fault ? "hi-red" : "faintest"}">${i.fault ? esc(i.fault) : "—"}</td>
</tr>`;
          })
          .join("\n");

  return `<section class="panel">
  <div class="panel-head"><span class="panel-title">Backlog</span><span class="mono-faint">${model.issues.length} issue${model.issues.length === 1 ? "" : "s"}</span></div>
  <table>
    <thead><tr><th>Issue</th><th>Title</th><th>Status</th><th>Run</th><th class="num">Attempts</th><th class="num">Fault</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</section>`;
}

function miniPanel(title: string, count: number, body: string): string {
  return `<div class="panel">
  <div class="panel-head"><span class="panel-title">${esc(title)}</span><span class="mono-faint">${count}</span></div>
  <div class="mini-body">${body}</div>
</div>`;
}

function renderProblems(model: DashboardModel): string {
  const panels: string[] = [];

  if (model.orphans.length > 0) {
    panels.push(
      miniPanel(
        "Orphan runs",
        model.orphans.length,
        model.orphans
          .map(
            (o) =>
              `<div class="mini-row"><span class="mono">${esc(o.runId)}</span>${pill(
                o.live ? "gate" : "idle",
                `${o.class}${o.live ? " · live" : ""}${o.recovery ? ` · recoverable → #${o.recovery.issue}` : ""}`,
              )}</div>`,
          )
          .join(""),
      ),
    );
  }

  if (model.stale.length > 0) {
    panels.push(
      miniPanel(
        "Stale markers",
        model.stale.length,
        model.stale
          .map(
            (s) =>
              `<div class="mini-row"><span class="mono">#${s.issueNumber} → ${esc(s.runId)}</span><span class="mono-faint">no run dir</span>${
                s.status
                  ? `<span class="pill neutral">yak:${esc(s.status)}</span>`
                  : ""
              }</div>`,
          )
          .join(""),
      ),
    );
  }

  if (model.linkageFaults.length > 0) {
    panels.push(
      miniPanel(
        "Linkage faults",
        model.linkageFaults.length,
        model.linkageFaults
          .map(
            (f) =>
              `<div class="mini-row"><span class="mono">${esc(f.runId)}</span><span>claimed by ${f.issues
                .map((n) => `#${n}`)
                .join(", ")}</span></div>`,
          )
          .join(""),
      ),
    );
  }

  if (panels.length === 0) return "";
  return `<section class="mini-grid">${panels.join("\n")}</section>`;
}

// ── stat row ─────────────────────────────────────────────────────────

function statCell(
  label: string,
  value: number,
  sub: string,
  chip: { key: StateKey; text: string } | null,
): string {
  return `<div class="stat">
  <div class="stat-head"><span class="stat-label">${esc(label)}</span>${chip ? pill(chip.key, chip.text) : ""}</div>
  <div class="stat-n">${value}</div>
  <div class="mono-faint">${esc(sub)}</div>
</div>`;
}

function renderStats(model: DashboardModel): string {
  const idle = model.issues.filter((i) => i.status === null).length;
  const totalTok = model.runs.reduce((n, r) => n + r.replay.tokens, 0);
  const totalUsd = model.runs.reduce((n, r) => n + r.replay.usd, 0);
  const drifting = model.runs.filter((r) => r.drift);
  const problems =
    model.orphans.length + model.stale.length + model.linkageFaults.length;
  const anyLive = model.runs.some(
    (r) => !r.replay.finished && r.runClass !== "stalled",
  );

  return `<section class="stats">
${statCell(
  "Issues tracked",
  model.issues.length,
  idle > 0 ? `${idle} idle in backlog` : "all have a run",
  null,
)}
${statCell(
  "Active runs",
  model.runs.length,
  totalTok > 0
    ? `${tokens(totalTok)} tok · $${totalUsd.toFixed(2)}`
    : "no spend recorded",
  anyLive ? { key: "run", text: "live" } : null,
)}
${statCell(
  "Label drift",
  drifting.length,
  drifting[0]?.issue != null
    ? `#${drifting[0].issue} mislabelled`
    : "views agree",
  drifting.length > 0 ? { key: "gate", text: "drift" } : null,
)}
${statCell(
  "Problems",
  problems,
  problems > 0
    ? [
        model.orphans.length && `${model.orphans.length} orphan`,
        model.stale.length && `${model.stale.length} stale marker`,
        model.linkageFaults.length &&
          `${model.linkageFaults.length} linkage fault`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "nothing flagged",
  problems > 0 ? { key: "fail", text: "action" } : null,
)}
</section>`;
}

function headline(model: DashboardModel): string {
  if (model.runs.length === 0) return "No runs on disk.";
  const inFlight = model.runs.filter((r) => !r.replay.finished).length;
  const waiting = model.runs.filter(
    (r) => r.replay.suspend || r.runClass === "suspended",
  ).length;
  const failed = model.runs.filter(
    (r) => r.replay.finished?.status === "failed" || r.runClass === "failed",
  ).length;
  let s = `${inFlight || model.runs.length} run${(inFlight || model.runs.length) === 1 ? "" : "s"} in flight`;
  const tail: string[] = [];
  if (waiting) tail.push(`${waiting} waiting on you`);
  if (failed) tail.push(`${failed} failed`);
  if (tail.length) s += ` — ${tail.join(", ")}`;
  return `${s}.`;
}

// ── page ─────────────────────────────────────────────────────────────

const STYLE = `
:root{
  --bg:#0a0a0a; --panel:#161616; --inset:#1c1c1c; --inset2:#141414;
  --b1:rgba(255,255,255,0.07); --b2:rgba(255,255,255,0.06); --b3:rgba(255,255,255,0.05);
  --fg:#fafafa; --fg2:#e4e4e4; --fg3:#d4d4d4; --body:#b4b4b4;
  --mut:#8f8f8f; --mut2:#a1a1a1; --faint:#6f6f6f; --faint2:#4f4f4f; --faint3:#3d3d3d;
  --link:#7aa9ff; --link-h:#a6c4ff;
  --ok:#3f9d5f; --ok-fg:#7fcf9c; --run:#5b95ff; --run-fg:#8fb4ff;
  --gate:#d99f4a; --gate-fg:#e2b678; --fail:#e05a56; --fail-fg:#ef9b98; --skip:#4f4f4f;
  --mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg)}
body{color:var(--fg);font-family:Geist,system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;padding:36px 28px 72px}
a{color:var(--link);text-decoration:none}
a:hover{color:var(--link-h)}
code{font-family:var(--mono);font-size:.9em}
.wrap{max-width:1120px;margin:0 auto;display:grid;gap:20px}
.mono{font-family:var(--mono)}
.mono-faint{font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.hi{color:var(--fg3)}
.hi-amber{color:var(--gate-fg)}
.hi-red{color:var(--fail-fg)}
.dim{color:var(--mut)}
.faint{color:var(--faint)}
.faintest{color:var(--faint2)}
.nowrap{white-space:nowrap}
.strong{color:var(--fg2);font-weight:500}

.crumb{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--faint)}
.crumb .slash{color:var(--faint3)}
.crumb .here{color:var(--link)}

.head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px}
.head h1{margin:0;font-size:27px;font-weight:600;letter-spacing:-.02em}
.head .sub{font-size:13.5px;color:var(--mut)}
.stamp{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11.5px;color:var(--faint);background:var(--panel);border:1px solid var(--b1);border-radius:9px;padding:8px 12px}
.stamp .live{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(63,157,95,.18)}

.stats{background:var(--panel);border:1px solid var(--b1);border-radius:14px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));overflow:hidden}
.stat{padding:18px 20px;display:grid;gap:9px}
.stat + .stat{border-left:1px solid var(--b2)}
.stat-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.stat-label{font-size:13px;color:var(--mut2)}
.stat-n{font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums}
@media(max-width:760px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat:nth-child(3){border-left:none}.stat:nth-child(n+3){border-top:1px solid var(--b2)}}

.panel{background:var(--panel);border:1px solid var(--b1);border-radius:14px;overflow:hidden}
.panel-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:15px 20px;border-bottom:1px solid var(--b2)}
.panel-title{font-size:15px;font-weight:600;letter-spacing:-.01em}

.pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:500;white-space:nowrap;border:1px solid transparent}
.pill .p-dot{width:5px;height:5px;border-radius:50%;flex:none}
.pill.neutral{background:#1f1f1f;border-color:rgba(255,255,255,.08);color:var(--mut2);font-family:var(--mono)}
.pill.s-ok{background:rgba(63,157,95,.14);border-color:rgba(63,157,95,.3);color:var(--ok-fg)}
.pill.s-ok .p-dot{background:var(--ok)}
.pill.s-run{background:rgba(47,123,255,.14);border-color:rgba(47,123,255,.28);color:var(--run-fg)}
.pill.s-run .p-dot{background:var(--run)}
.pill.s-gate{background:rgba(217,159,74,.14);border-color:rgba(217,159,74,.3);color:var(--gate-fg)}
.pill.s-gate .p-dot{background:var(--gate)}
.pill.s-fail{background:rgba(224,90,86,.14);border-color:rgba(224,90,86,.3);color:var(--fail-fg)}
.pill.s-fail .p-dot{background:var(--fail)}
.pill.s-idle{background:#1f1f1f;border-color:var(--b1);color:var(--mut)}
.pill.s-idle .p-dot{background:var(--faint3)}

.legend{display:flex;flex-wrap:wrap;gap:8px 14px;font-size:11.5px;color:var(--mut)}
.leg-item{display:inline-flex;align-items:center;gap:6px}
.leg-dot{width:6px;height:6px;border-radius:50%}
.leg-dot.s-ok{background:var(--ok)} .leg-dot.s-run{background:var(--run)}
.leg-dot.s-gate{background:var(--gate)} .leg-dot.s-fail{background:var(--fail)}
.leg-dot.s-skip{background:var(--faint3)}

.runs{display:grid}
.run{padding:20px;display:grid;gap:14px}
.run + .run{border-top:1px solid var(--b2)}
.ctx-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.ctx-title{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
.ctx-title a{color:inherit}
.ctx-pills{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.orphan{color:var(--fail-fg);font-weight:600}
.ctx-summary{margin:0;font-size:14px;line-height:1.65;color:var(--body);max-width:80ch;text-wrap:pretty}
.ctx-summary code,.inset code{font-family:var(--mono);font-size:12.5px;background:#1f1f1f;border:1px solid var(--b1);border-radius:5px;padding:1px 5px;color:var(--fg2)}

.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.meta .sep{width:1px;height:10px;background:var(--faint3)}
.meta .hi{color:var(--mut2)}

.inset{background:var(--inset);border:1px solid var(--b2);border-radius:11px;padding:15px 17px;display:grid;gap:10px}
.inset.gate{border-color:rgba(217,159,74,.22)}
.inset.fail{border-color:rgba(224,90,86,.22)}
.inset-head{display:flex;flex-wrap:wrap;align-items:center;gap:9px}
.inset-title{font-size:13.5px;font-weight:500;color:#f0f0f0}
.inset code{background:transparent;border:none;padding:0}
.gate-prose{margin:0;white-space:pre-wrap;font-family:var(--mono);font-size:12px;line-height:1.6;color:var(--body);background:var(--inset2);border:1px solid var(--b2);border-radius:9px;padding:12px 14px;overflow-x:auto}
.fail-row{display:flex;flex-wrap:wrap;align-items:center;gap:9px;font-family:var(--mono);font-size:12.5px;color:var(--body)}
.inset.plain{background:var(--inset);border-color:var(--b2)}
.inset.plain summary{display:flex;align-items:baseline;gap:9px;cursor:pointer;list-style:none}
.inset.plain summary::-webkit-details-marker{display:none}
.inset.plain ol{margin:10px 0 0;padding-left:19px;display:grid;gap:6px;font-size:13.5px;line-height:1.5;color:var(--body)}

.pipe{display:grid;gap:10px;border-top:1px solid var(--b2);padding-top:15px}
.pipe-id{font-family:var(--mono);font-size:11px;color:#5f5f5f}
.pipe-none{border-top:1px solid var(--b2);padding-top:15px;font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.pipe-grid{display:grid;gap:8px;overflow-x:auto;padding-bottom:2px}
.pstep{border:1px solid var(--b1);background:var(--inset2);border-radius:9px;padding:8px 9px;min-height:52px;display:flex;align-items:flex-start;gap:7px}
.pstep .p-dot{flex:none;width:6px;height:6px;border-radius:50%;margin-top:4px;background:var(--faint3)}
.pstep .p-body{display:grid;gap:2px;min-width:0}
.pstep .p-name{font-family:var(--mono);font-size:11px;font-weight:500;line-height:1.25;color:#949494;overflow-wrap:anywhere}
.pstep .p-kind{font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:#7d7d7d;overflow-wrap:anywhere}
.pstep .p-iter{color:var(--run-fg)}
.pstep.s-ok{border-color:rgba(255,255,255,.08);background:var(--inset)}
.pstep.s-ok .p-dot{background:var(--ok)} .pstep.s-ok .p-name{color:var(--fg3)}
.pstep.s-run{border-color:rgba(47,123,255,.35);background:rgba(47,123,255,.1)}
.pstep.s-run .p-dot{background:var(--run)} .pstep.s-run .p-name{color:#dce8ff}
.pstep.s-gate{border-color:rgba(217,159,74,.38);background:rgba(217,159,74,.1)}
.pstep.s-gate .p-dot{background:var(--gate)} .pstep.s-gate .p-name{color:#f2e0c6}
.pstep.s-fail{border-color:rgba(224,90,86,.38);background:rgba(224,90,86,.1)}
.pstep.s-fail .p-dot{background:var(--fail)} .pstep.s-fail .p-name{color:#f6d7d6}
.pstep.s-skip{border-style:dashed;background:transparent}
.pstep.s-skip .p-name{text-decoration:line-through}
.pstep.here{box-shadow:0 0 0 3px rgba(47,123,255,.1)}
.pstep.here .p-kind{color:var(--run)}

table{width:100%;border-collapse:collapse;font-size:13.5px}
thead tr{background:rgba(255,255,255,.02);font-size:11.5px;color:var(--mut)}
th{text-align:left;font-weight:500;padding:10px 14px;border-bottom:1px solid var(--b2)}
th:first-child,td:first-child{padding-left:20px}
th:last-child,td:last-child{padding-right:20px}
td{padding:13px 14px;border-bottom:1px solid var(--b3)}
tbody tr:last-child td{border-bottom:none}
.num{text-align:right;font-variant-numeric:tabular-nums;color:var(--mut2)}
td.empty{text-align:center;color:var(--faint);padding:24px}

.mini-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.mini-body{padding:16px 20px;display:grid;gap:10px}
.mini-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-family:var(--mono);font-size:12.5px;color:var(--fg2)}

footer{font-size:12.5px;line-height:1.6;color:var(--faint);max-width:82ch}
footer code{font-size:11.5px;color:var(--mut)}
.empty-note{padding:20px;color:var(--faint);font-family:var(--mono);font-size:12px}
`;

/** Optional render knobs. Both are set only by `--serve`. */
export interface RenderOptions {
  /** When set, the live server injects a poll script that re-fetches every N seconds. */
  refreshSeconds?: number;
  /**
   * Return only the `.wrap` inner HTML, no document shell — what the
   * poll script fetches from `/fragment` and swaps in without touching
   * scroll position.
   */
  fragment?: boolean;
}

/** The contents of `<div class="wrap">` — everything the fragment endpoint returns. */
function renderBody(model: DashboardModel, live: boolean): string {
  const runs =
    model.runs.length === 0
      ? '<div class="empty-note">no runs on disk</div>'
      : `<div class="runs">${model.runs.map(renderRunCard).join("\n")}</div>`;

  const stamp = live
    ? `<span class="live"></span>live · updated ${esc(model.generatedAt)}`
    : `<span class="live"></span>generated ${esc(model.generatedAt)}`;
  const footerRefresh = live
    ? "Each refresh is a full rescan &mdash; the page mirrors the reconciler's own statelessness."
    : "Holds no state; re-run <code>yak-harness dashboard</code> to refresh.";

  return `
  <div class="crumb">
    <span>${esc(model.repo)}</span><span class="slash">/</span>
    <span>yak-harness</span><span class="slash">/</span>
    <span class="here">monitor</span>
  </div>

  <header class="head">
    <div>
      <h1>Harness monitor</h1>
      <div class="sub">${esc(headline(model))}</div>
    </div>
    <div class="stamp">${stamp}</div>
  </header>

  ${renderStats(model)}

  <section class="panel">
    <div class="panel-head">
      <div style="display:flex;align-items:baseline;gap:9px">
        <span class="panel-title">Runs</span>
        <span class="mono-faint">${model.runs.length} in flight</span>
      </div>
      ${model.runs.some((r) => r.graph) ? renderLegend() : ""}
    </div>
    ${runs}
  </section>

  ${renderBacklog(model)}

  ${renderProblems(model)}

  <footer>Read-only projection of GitHub labels + marker comments + yak&rsquo;s <code>.runs/</code> journals. ${footerRefresh} See <code>docs/design/dashboard.md</code>.</footer>
`;
}

/**
 * The `/fragment` poll: every N seconds, fetch the body and swap it into
 * `.wrap`. `document` scroll is untouched, so the view holds still while
 * the numbers update. Kept tiny and defensive — a failed fetch is
 * ignored and retried; a run of failures (server restart) triggers one
 * full reload to recover.
 */
function pollScript(seconds: number): string {
  return `<script>
(function(){
  var MS=${seconds * 1000}, fails=0;
  async function tick(){
    try{
      var r=await fetch('/fragment',{cache:'no-store'});
      if(r.ok){
        var w=document.querySelector('.wrap');
        if(w) w.innerHTML=await r.text();
        fails=0;
      } else { fails++; }
    }catch(e){ fails++; }
    if(fails>=5){ location.reload(); return; }
    setTimeout(tick,MS);
  }
  setTimeout(tick,MS);
})();
</script>`;
}

/** Render the page (or, with `opts.fragment`, just the `.wrap` inner). Pure. */
export function renderDashboard(
  model: DashboardModel,
  opts: RenderOptions = {},
): string {
  const live = opts.refreshSeconds !== undefined && opts.refreshSeconds > 0;
  const body = renderBody(model, live);
  if (opts.fragment) return body;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>yak-harness monitor — ${esc(model.repo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">${body}</div>
${live ? pollScript(opts.refreshSeconds as number) : ""}
</body>
</html>`;
}
