// Resolve `config.workflow` to a path `yak run` can execute (spec §4.1).
//
// `config.workflow` is a *name* everywhere else in the harness — the
// journal records it, `assertStarted` compares against it. Only the
// launch boundary needs a filesystem path, and that translation lives
// here.
//
//   - a bare name (`"implement-change"`)  → the workflow bundled with
//     the harness at `<package>/workflows/<name>.yaml`
//   - a value that looks like a path (has a `/` or a `.yaml`/`.yml`
//     extension) → used directly, resolved against `yakRepoPath` when
//     relative — the escape hatch for a repo that ships its own workflow

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `<package root>/workflows/` — one level up whether this runs from
 * `src/` (tests, tsx) or `dist/` (the built bundle). */
export const BUNDLED_WORKFLOWS_DIR = fileURLToPath(
  new URL("../workflows/", import.meta.url),
);

const LOOKS_LIKE_PATH = /[/\\]|\.ya?ml$/;

export class WorkflowResolutionError extends Error {
  override name = "WorkflowResolutionError";
}

/**
 * @param workflow  the `config.workflow` value
 * @param yakRepoPath  absolute path to the repo yak runs in — the base
 *   for a relative path value
 */
export function resolveWorkflowPath(
  workflow: string,
  yakRepoPath: string,
): string {
  if (LOOKS_LIKE_PATH.test(workflow)) {
    return isAbsolute(workflow) ? workflow : resolve(yakRepoPath, workflow);
  }

  const bundled = resolve(BUNDLED_WORKFLOWS_DIR, `${workflow}.yaml`);
  if (!existsSync(bundled)) {
    throw new WorkflowResolutionError(
      `no bundled workflow named "${workflow}" (looked in ${BUNDLED_WORKFLOWS_DIR}); ` +
        `pass a path ending in .yaml to use a repo-local workflow`,
    );
  }
  return bundled;
}
