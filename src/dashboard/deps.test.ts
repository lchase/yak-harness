import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { realDashboardDeps } from "./deps.js";

const cfg = (runsDir: string): Config => ({ runsDir }) as unknown as Config;

describe("realDashboardDeps", () => {
  it("reads journal + workflow.json, and returns null for a missing run", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "dash-deps-"));
    mkdirSync(join(runsDir, "r1", "artifacts"), { recursive: true });
    writeFileSync(join(runsDir, "r1", "journal.jsonl"), "{}\n");
    writeFileSync(join(runsDir, "r1", "workflow.json"), '{"steps":[]}');
    writeFileSync(
      join(runsDir, "r1", "artifacts", "assessment.json"),
      '{"kind":"bug"}',
    );

    const deps = realDashboardDeps(cfg(runsDir));
    expect(deps.readJournal("r1")).toBe("{}\n");
    expect(deps.readWorkflowJson("r1")).toBe('{"steps":[]}');
    expect(deps.readArtifact("r1", "assessment")).toBe('{"kind":"bug"}');
    expect(deps.readArtifact("r1", "plan")).toBeNull();
    expect(deps.readJournal("missing")).toBeNull();
    expect(deps.readWorkflowJson("missing")).toBeNull();
    expect(deps.now()).toBeInstanceOf(Date);
  });
});
