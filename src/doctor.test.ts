import { expect, test } from "vitest";
import { ConfigSchema } from "./config.js";
import { type DoctorDeps, formatReport, runDoctor } from "./doctor.js";

const config = ConfigSchema.parse({
  repo: "lchase/yak",
  yakRepoPath: "/srv/yak",
  stalledAfterMinutes: 45,
});

function gitStub(branch = "main"): (cmd: string, args: string[]) => string {
  return (cmd, args) => {
    if (cmd === "yak") return "yak 1.2.3\n";
    if (cmd === "gh") return "";
    if (cmd === "git") {
      if (args.includes("--show-current")) return `${branch}\n`;
      if (args.includes("symbolic-ref")) return "origin/main\n";
      return "";
    }
    return "";
  };
}

function healthyDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    run: gitStub(),
    nodeVersion: "22.10.0",
    fileExists: () => true,
    probeWrite: () => {},
    ...overrides,
  };
}

test("all checks pass on a healthy box, exit ok", () => {
  const report = runDoctor(config, healthyDeps());
  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(5);
  expect(report.checks.every((c) => c.ok)).toBe(true);
});

test("gh auth failure is reported individually and fails the report", () => {
  const report = runDoctor(
    config,
    healthyDeps({
      run: (cmd) => {
        if (cmd === "gh") throw new Error("not logged in");
        if (cmd === "yak") return "yak 1.2.3";
        return "";
      },
    }),
  );
  expect(report.ok).toBe(false);
  const gh = report.checks.find((c) => c.name === "gh authenticated");
  expect(gh?.ok).toBe(false);
  expect(gh?.detail).toContain("not logged in");
  // other checks still ran and passed
  expect(report.checks.filter((c) => c.ok)).toHaveLength(4);
});

test("missing yak binary fails only its own check", () => {
  const report = runDoctor(
    config,
    healthyDeps({
      run: (cmd, args) => {
        if (cmd === "yak") throw new Error("command not found: yak");
        return "";
      },
    }),
  );
  expect(report.ok).toBe(false);
  expect(report.checks.find((c) => c.name === "yak on PATH")?.ok).toBe(false);
});

test("yakRepoPath missing directory fails the git-repo check", () => {
  const report = runDoctor(config, healthyDeps({ fileExists: () => false }));
  const c = report.checks.find((c) =>
    c.name.startsWith("yakRepoPath"),
  );
  expect(c?.ok).toBe(false);
  expect(c?.detail).toContain("does not exist");
});

test("yakRepoPath not a git repo fails the check", () => {
  const report = runDoctor(
    config,
    healthyDeps({
      run: (cmd, args) => {
        if (cmd === "git") throw new Error("not a git repository");
        if (cmd === "yak") return "yak 1";
        return "";
      },
    }),
  );
  expect(report.checks.find((c) => c.name.startsWith("yakRepoPath"))?.ok).toBe(
    false,
  );
});

test("yakRepoPath on a non-default branch fails the check", () => {
  const report = runDoctor(config, healthyDeps({ run: gitStub("feature/x") }));
  const c = report.checks.find((c) => c.name.startsWith("yakRepoPath"));
  expect(c?.ok).toBe(false);
  expect(c?.detail).toContain('not the default branch "main"');
});

test("unset origin/HEAD passes the git check with a caveat", () => {
  const report = runDoctor(
    config,
    healthyDeps({
      run: (cmd, args) => {
        if (cmd === "git" && args.includes("symbolic-ref")) {
          throw new Error("ref refs/remotes/origin/HEAD is not a symbolic ref");
        }
        if (cmd === "git" && args.includes("--show-current")) return "main\n";
        if (cmd === "yak") return "yak 1";
        return "";
      },
    }),
  );
  const c = report.checks.find((c) => c.name.startsWith("yakRepoPath"));
  expect(c?.ok).toBe(true);
  expect(c?.detail).toContain("origin/HEAD unset");
});

test("Node below 22 fails the version check", () => {
  const report = runDoctor(config, healthyDeps({ nodeVersion: "20.11.0" }));
  const c = report.checks.find((c) => c.name === "Node 22+");
  expect(c?.ok).toBe(false);
  expect(c?.detail).toContain("< 22");
});

test("formatReport marks each check and the overall result", () => {
  const pass = formatReport(runDoctor(config, healthyDeps()));
  expect(pass).toContain("PASS  gh authenticated");
  expect(pass).toContain("all checks passed");

  const fail = formatReport(
    runDoctor(config, healthyDeps({ nodeVersion: "18.0.0" })),
  );
  expect(fail).toContain("FAIL  Node 22+");
  expect(fail).toContain("doctor: FAILED");
});

test("unwritable .runs/ or .harness/ fails the write check", () => {
  const report = runDoctor(
    config,
    healthyDeps({
      probeWrite: (dir) => {
        throw new Error(`EACCES: permission denied, ${dir}`);
      },
    }),
  );
  expect(
    report.checks.find((c) => c.name.startsWith("write access"))?.ok,
  ).toBe(false);
});
