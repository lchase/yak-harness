// Production {@link DashboardDeps} — the only filesystem reads the
// dashboard adds on top of `realObserveDeps`. Both are per-run and
// tolerant: a missing file is `null`, never a throw.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { DashboardDeps } from "../dashboard.js";

export function realDashboardDeps(config: Config): DashboardDeps {
  const readOrNull = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  return {
    now: () => new Date(),
    readJournal: (runId) =>
      readOrNull(join(config.runsDir, runId, "journal.jsonl")),
    readWorkflowJson: (runId) =>
      readOrNull(join(config.runsDir, runId, "workflow.json")),
    readArtifact: (runId, name) =>
      readOrNull(join(config.runsDir, runId, "artifacts", `${name}.json`)) ??
      readOrNull(join(config.runsDir, runId, "artifacts", name)),
  };
}
