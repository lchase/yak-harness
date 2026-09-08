import { describe, expect, it } from "vitest";
import { buildWorkflowGraph, layoutWorkflow } from "./graph.js";

const wf = (steps: object[], name = "w") => JSON.stringify({ name, steps });

describe("buildWorkflowGraph", () => {
  it("returns null for unusable input", () => {
    expect(buildWorkflowGraph(null)).toBeNull();
    expect(buildWorkflowGraph("not json")).toBeNull();
    expect(buildWorkflowGraph('{"name":"w"}')).toBeNull();
  });

  it("builds nodes + edges and drops needs that point outside the graph", () => {
    const g = buildWorkflowGraph(
      wf([
        { id: "a", kind: "agent", needs: [] },
        { id: "b", kind: "gate", needs: ["a", "input"], skipIf: "x > 1" },
      ]),
    );
    expect(g?.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(g?.edges).toEqual([["a", "b"]]);
    expect(g?.nodes[1]?.needs).toEqual(["a"]);
    expect(g?.nodes[1]?.skippable).toBe(true);
    expect(g?.nodes[0]?.skippable).toBe(false);
  });

  it("skips steps with no id", () => {
    const g = buildWorkflowGraph(
      wf([{ kind: "agent" }, { id: "ok", needs: [] }]),
    );
    expect(g?.nodes.map((n) => n.id)).toEqual(["ok"]);
  });

  it("lays steps into dependency columns", () => {
    const g = buildWorkflowGraph(
      wf([
        { id: "a", needs: [] },
        { id: "b", needs: ["a"] },
        { id: "c", needs: ["b"] },
        { id: "d", needs: ["a"] },
      ]),
    );
    const col = Object.fromEntries(g!.nodes.map((n) => [n.id, n.column]));
    expect(col).toEqual({ a: 0, b: 1, c: 2, d: 1 });
    expect(g?.columns).toBe(3);
  });
});

describe("layoutWorkflow", () => {
  it("assigns distinct rows within a column", () => {
    const nodes = [
      { id: "a", kind: "s", needs: [], skippable: false, column: 0, row: 0 },
      { id: "b", kind: "s", needs: [], skippable: false, column: 0, row: 0 },
    ];
    layoutWorkflow(nodes);
    expect(nodes.map((n) => n.row)).toEqual([0, 1]);
  });
});
