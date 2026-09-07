// Enforces CLAUDE.md invariant 2 + the toolchain rule (spec §10.1):
// runtime `dependencies` stay exactly {zod, ajv}, and `@lchase/yak` is
// never a dependency of any kind — yak is a runtime binary on PATH, not
// a build dependency.

import { readFileSync } from "node:fs";

const ALLOWED_RUNTIME_DEPS = ["ajv", "zod"];
const BANNED = "@lchase/yak";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
);
const problems = [];

const runtime = Object.keys(pkg.dependencies ?? {}).sort();
const extra = runtime.filter((d) => !ALLOWED_RUNTIME_DEPS.includes(d));
if (extra.length > 0) {
  problems.push(
    `runtime dependencies must be exactly {${ALLOWED_RUNTIME_DEPS.join(", ")}}; found extra: ${extra.join(", ")}`,
  );
}

for (const field of [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]) {
  if (pkg[field]?.[BANNED]) {
    problems.push(`${BANNED} must never appear in ${field} (spec §10.1)`);
  }
}

if (problems.length > 0) {
  console.error("guard:deps FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("guard:deps ok");
