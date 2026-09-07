// yak-harness CLI entry (spec §10.2).
//
//   yak-harness tick   --config <path> [--dry-run]
//   yak-harness doctor --config <path>
//
// `doctor` is implemented (ticket #2). `tick` is still a scaffold.

import { realpathSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realApplyDeps } from "./apply.js";
import { ConfigError, loadConfig } from "./config.js";
import { harnessDir } from "./constants.js";
import { formatReport, runDoctor } from "./doctor.js";
import { acquireTickLock, LockHeld } from "./lock.js";
import { ObserveError, realObserveDeps } from "./observe.js";
import { runTick } from "./tick.js";

const USAGE = "usage: yak-harness <tick|doctor> --config <path> [--dry-run]";

/** Thrown to unwind to {@link cli} with a chosen exit code and message. */
class CliExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function parseArgs(argv: string[]): {
  command: string | undefined;
  configPath: string | undefined;
  dryRun: boolean;
} {
  const [command, ...rest] = argv;
  let configPath: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config") {
      configPath = rest[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new CliExit(2, `unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return { command, configPath, dryRun };
}

interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** `runTick` with `ObserveError` mapped to a clean exit-1 (spec §10.5). */
function runTickGuarded(
  config: ReturnType<typeof loadConfig>,
  io: CliIo,
  dryRun: boolean,
  dir: string,
): number {
  try {
    return runTick(
      config,
      { observe: realObserveDeps(config), apply: realApplyDeps(config) },
      { io, dryRun, harnessDir: dir },
    );
  } catch (err) {
    if (err instanceof ObserveError) throw new CliExit(1, err.message);
    throw err;
  }
}

/** Run one CLI invocation. Returns the process exit code; performs no `process.exit`. */
export function cli(argv: string[], io: CliIo): number {
  try {
    const { command, configPath, dryRun } = parseArgs(argv);

    if (command !== "tick" && command !== "doctor") {
      throw new CliExit(2, USAGE);
    }
    if (!configPath) {
      throw new CliExit(2, `--config <path> is required\n${USAGE}`);
    }

    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig(configPath);
    } catch (err) {
      if (err instanceof ConfigError) throw new CliExit(1, err.message);
      throw err;
    }

    if (command === "doctor") {
      const report = runDoctor(config);
      io.out(formatReport(report));
      return report.ok ? 0 : 1;
    }

    const dir = harnessDir(config.yakRepoPath);

    // A `--dry-run` changes nothing, so it neither takes the overlap lock
    // (spec §6.6) nor writes `tick.log` (spec §10.5).
    if (dryRun) {
      return runTickGuarded(config, io, true, dir);
    }

    let lock: ReturnType<typeof acquireTickLock>;
    try {
      lock = acquireTickLock(dir);
    } catch (err) {
      if (err instanceof LockHeld) {
        io.err(`${err.message} — exiting (overlap is safe)`);
        return 0;
      }
      throw err;
    }
    try {
      return runTickGuarded(config, io, false, dir);
    } finally {
      lock.release();
    }
  } catch (err) {
    if (err instanceof CliExit) {
      io.err(err.message);
      return err.code;
    }
    throw err;
  }
}

// Only run when invoked as a script, not when imported by a test.
// `argv[1]` may be a symlink (npm's `bin` shim, `npm link`), so compare
// both sides after resolving symlinks rather than matching the raw path.
function invokedAsScript(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  if (entry === self) return true;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  process.exit(
    cli(argv.slice(2), {
      out: (t) => console.log(t),
      err: (t) => console.error(t),
    }),
  );
}
