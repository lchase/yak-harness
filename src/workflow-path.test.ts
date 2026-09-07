import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { expect, test } from "vitest";
import {
  BUNDLED_WORKFLOWS_DIR,
  resolveWorkflowPath,
  WorkflowResolutionError,
} from "./workflow-path.js";

test("a bare name resolves to the bundled workflow file", () => {
  const p = resolveWorkflowPath("implement-change", "/srv/repo");
  expect(p).toBe(`${BUNDLED_WORKFLOWS_DIR}implement-change.yaml`);
  expect(existsSync(p)).toBe(true); // the file actually ships
});

test("an unknown bare name throws", () => {
  expect(() => resolveWorkflowPath("no-such-workflow", "/srv/repo")).toThrow(
    WorkflowResolutionError,
  );
});

test("an absolute path is used as-is", () => {
  const p = resolveWorkflowPath("/etc/yak/custom.yaml", "/srv/repo");
  expect(p).toBe("/etc/yak/custom.yaml");
});

test("a relative path resolves against yakRepoPath", () => {
  const p = resolveWorkflowPath(".yak/workflows/mine.yaml", "/srv/repo");
  expect(p).toBe("/srv/repo/.yak/workflows/mine.yaml");
  expect(isAbsolute(p)).toBe(true);
});

test("a bare name with a .yml extension is treated as a path, not a bundled name", () => {
  const p = resolveWorkflowPath("weird.yml", "/srv/repo");
  expect(p).toBe("/srv/repo/weird.yml");
});
