// Turn a run's snapshotted `workflow.json` into a laid-out node graph for
// the dashboard (docs/design/dashboard.md).
//
// Every `.runs/<id>/` dir carries `workflow.json` — the fully-compiled
// step list yak executed. The dashboard reads *that*, never the yaml in
// `yakRepoPath`: the compiled shape is stable JSON and each run keeps its
// own copy, so the graph always matches the run drawn on it even if the
// repo's workflow has since changed.
//
// Tolerant, like replay.ts: an unparseable file yields `null`, a step
// missing `id` is dropped, an unknown `kind` renders as a plain box.

export type StepKind =
  | "agent"
  | "command"
  | "gate"
  | "transform"
  | "map"
  | "loop";

export interface WorkflowNode {
  id: string;
  kind: string;
  needs: string[];
  /** Present when the step can self-skip (`skipIf` expression). */
  skippable: boolean;
  /** Assigned by {@link layoutWorkflow}: 0-based dependency depth. */
  column: number;
  /** Assigned by {@link layoutWorkflow}: row within the column. */
  row: number;
}

export interface WorkflowGraph {
  name: string;
  nodes: WorkflowNode[];
  /** `[from, to]` pairs — `from` is a `needs` entry of `to`. */
  edges: [string, string][];
  columns: number;
}

interface RawStep {
  id?: unknown;
  kind?: unknown;
  needs?: unknown;
  skipIf?: unknown;
}

/** Parse + lay out a `workflow.json` text. `null` if it is not usable. */
export function buildWorkflowGraph(text: string | null): WorkflowGraph | null {
  if (!text) return null;
  let raw: { name?: unknown; steps?: unknown };
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || !Array.isArray(raw.steps)) return null;

  const stepIds = new Set<string>();
  for (const s of raw.steps as RawStep[]) {
    if (typeof s?.id === "string" && s.id) stepIds.add(s.id);
  }

  const nodes: WorkflowNode[] = [];
  const edges: [string, string][] = [];
  for (const s of raw.steps as RawStep[]) {
    if (typeof s?.id !== "string" || !s.id) continue;
    const needs = Array.isArray(s.needs)
      ? s.needs.filter(
          (n): n is string => typeof n === "string" && stepIds.has(n),
        )
      : [];
    nodes.push({
      id: s.id,
      kind: typeof s.kind === "string" ? s.kind : "step",
      needs,
      skippable: s.skipIf !== undefined && s.skipIf !== null,
      column: 0,
      row: 0,
    });
    for (const n of needs) edges.push([n, s.id]);
  }

  layoutWorkflow(nodes);
  const columns = nodes.reduce((max, n) => Math.max(max, n.column + 1), 0);

  return {
    name: typeof raw.name === "string" ? raw.name : "workflow",
    nodes,
    edges,
    columns,
  };
}

/**
 * Longest-path layering: a node's column is 1 + the max column of its
 * (in-graph) `needs`. Cycles cannot occur — yak compiles a DAG — but a
 * visited guard keeps a malformed file from looping forever. Rows are
 * assigned per column in declaration order.
 */
export function layoutWorkflow(nodes: WorkflowNode[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthCache = new Map<string, number>();

  const depth = (id: string, seen: Set<string>): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (!node || node.needs.length === 0 || seen.has(id)) {
      depthCache.set(id, 0);
      return 0;
    }
    seen.add(id);
    const d = 1 + Math.max(...node.needs.map((n) => depth(n, seen)));
    seen.delete(id);
    depthCache.set(id, d);
    return d;
  };

  for (const node of nodes) node.column = depth(node.id, new Set());

  const rowCursor = new Map<number, number>();
  for (const node of nodes) {
    const r = rowCursor.get(node.column) ?? 0;
    node.row = r;
    rowCursor.set(node.column, r + 1);
  }
}
