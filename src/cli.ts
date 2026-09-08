// yak-harness CLI entry (spec §10.2).
//
//   yak-harness tick      --config <path> [--dry-run]
//   yak-harness doctor    --config <path>
//   yak-harness dashboard --config <path> [--out <file>]
//   yak-harness dashboard --config <path> --serve [--port N] [--host H] [--interval S]
//
// `dashboard` is a read-only monitor (docs/design/dashboard.md): it takes
// no lock, writes no `tick.log`, and mutates nothing. `--serve` runs a
// loopback HTTP server that re-renders the whole view on every request.

import { realpathSync, writeFileSync } from "node:fs";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realApplyDeps } from "./apply.js";
import { ConfigError, loadConfig } from "./config.js";
import { harnessDir } from "./constants.js";
import { serveDashboard } from "./dashboard/serve.js";
import { realDashboardDeps, runDashboard } from "./dashboard.js";
import { formatReport, runDoctor } from "./doctor.js";
import { acquireTickLock, LockHeld } from "./lock.js";
import { ObserveError, realObserveDeps } from "./observe.js";
import { runTick } from "./tick.js";

const USAGE =
  "usage: yak-harness <tick|doctor|dashboard> --config <path> [--dry-run] [--out <file>] [--serve [--port N] [--host H] [--interval S]]";

/** Thrown to unwind to {@link cli} with a chosen exit code and message. */
class CliExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface ParsedArgs {
  command: string | undefined;
  configPath: string | undefined;
  dryRun: boolean;
  out: string | undefined;
  serve: boolean;
  port: number;
  host: string;
  intervalSeconds: number;
}

function parseIntArg(raw: string | undefined, flag: string): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) {
    throw new CliExit(2, `${flag} needs a positive integer\n${USAGE}`);
  }
  return n;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const parsed: ParsedArgs = {
    command,
    configPath: undefined,
    dryRun: false,
    out: undefined,
    serve: false,
    port: 8787,
    host: "127.0.0.1",
    intervalSeconds: 10,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config") {
      parsed.configPath = rest[++i];
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--out") {
      parsed.out = rest[++i];
    } else if (arg === "--serve") {
      parsed.serve = true;
    } else if (arg === "--port") {
      parsed.port = parseIntArg(rest[++i], "--port");
    } else if (arg === "--host") {
      const h = rest[++i];
      if (!h) throw new CliExit(2, `--host needs a value\n${USAGE}`);
      parsed.host = h;
    } else if (arg === "--interval") {
      parsed.intervalSeconds = parseIntArg(rest[++i], "--interval");
    } else {
      throw new CliExit(2, `unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return parsed;
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

/**
 * Run one CLI invocation. Returns the process exit code, or a promise of
 * it for the long-lived `dashboard --serve` server (resolves on Ctrl-C).
 * Performs no `process.exit`.
 */
export function cli(argv: string[], io: CliIo): number | Promise<number> {
  try {
    const {
      command,
      configPath,
      dryRun,
      out,
      serve,
      port,
      host,
      intervalSeconds,
    } = parseArgs(argv);

    if (command !== "tick" && command !== "doctor" && command !== "dashboard") {
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

    if (command === "dashboard") {
      if (serve) {
        return serveDashboard(config, { port, host, intervalSeconds }, io);
      }
      let html: string;
      try {
        html = runDashboard(config, {
          observe: realObserveDeps(config),
          dashboard: realDashboardDeps(config),
        });
      } catch (err) {
        if (err instanceof ObserveError) throw new CliExit(1, err.message);
        throw err;
      }
      if (out) {
        writeFileSync(out, html, "utf8");
        io.err(`wrote ${out}`);
      } else {
        io.out(html);
      }
      return 0;
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
  const code = cli(argv.slice(2), {
    out: (t) => console.log(t),
    err: (t) => console.error(t),
  });
  // `dashboard --serve` returns a promise that resolves only on Ctrl-C;
  // every other command returns its exit code synchronously.
  Promise.resolve(code).then((c) => process.exit(c));
}
