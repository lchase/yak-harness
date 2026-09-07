// CLAUDE.md: the CHANGELOG is maintained by hand. This fails a PR that
// changes production source under src/ (tests excluded) without touching
// CHANGELOG.md, so the "[Unreleased]" section never drifts behind.
//
// Base ref: $1, else $BASE_REF, else origin/main. Skips silently when the
// base ref is not present (e.g. a shallow local checkout) — CI fetches it.

import { execFileSync } from "node:child_process";

const base = process.argv[2] || process.env.BASE_REF || "origin/main";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let mergeBase;
try {
  mergeBase = git(["merge-base", base, "HEAD"]);
} catch {
  console.log(`guard:changelog skipped — base ref '${base}' not available`);
  process.exit(0);
}

const changed = git(["diff", "--name-only", `${mergeBase}...HEAD`])
  .split("\n")
  .filter(Boolean);

if (changed.length === 0) {
  console.log("guard:changelog ok — no changes");
  process.exit(0);
}

const touchedSource = changed.filter(
  (f) => f.startsWith("src/") && f.endsWith(".ts") && !f.endsWith(".test.ts"),
);
const touchedChangelog = changed.includes("CHANGELOG.md");

if (touchedSource.length > 0 && !touchedChangelog) {
  console.error("guard:changelog FAILED");
  console.error(
    "  production source changed but CHANGELOG.md was not updated:",
  );
  for (const f of touchedSource) console.error(`    ${f}`);
  console.error("  add an entry under ## [Unreleased].");
  process.exit(1);
}

console.log("guard:changelog ok");
