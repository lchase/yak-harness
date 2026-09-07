// yak-harness CLI entry (spec §10.2).
//
//   yak-harness tick   --config <path> [--dry-run]
//   yak-harness doctor --config <path>
//
// `doctor` is implemented (ticket #2). `tick` is still a scaffold.

import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { realApplyDeps } from "./apply.js";
import { ConfigError, loadConfig } from "./config.js";
import { formatReport, runDoctor } from "./doctor.js";
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

    let config;
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

    try {
      return runTick(
        config,
        {
          observe: realObserveDeps(config),
          apply: realApplyDeps(config),
        },
        { io, dryRun },
      );
    } catch (err) {
      if (err instanceof ObserveError) throw new CliExit(1, err.message);
      throw err;
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
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  process.exit(
    cli(argv.slice(2), {
      out: (t) => console.log(t),
      err: (t) => console.error(t),
    }),
  );
}
