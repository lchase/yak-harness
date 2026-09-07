// Harness configuration (spec §4).
//
// One plain-JSON file, path passed as `--config <path>` to every
// invocation, zod-parsed before any observation. A violation prints the
// zod error and exits non-zero — see `loadConfig`.

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const RepoSlug = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be "owner/name"');

/**
 * Raw config shape — exactly the keys an operator writes. `.strict()` so
 * a typo'd key is a loud error, not a silently-ignored field.
 */
const RawConfigSchema = z
  .object({
    repo: RepoSlug,
    yakRepoPath: z.string().min(1),
    runsDir: z.string().min(1).optional(),
    qualifyingLabel: z.string().min(1).default("yak"),
    // No default: a healthy agent step legitimately runs a long time and
    // the right threshold is workflow-specific. The operator must set it.
    stalledAfterMinutes: z.number().positive(),
    maxConcurrent: z.number().int().positive().default(2),
    workflow: z.string().min(1).default("implement-change"),
    inputTemplate: z.string().min(1).default("issueRef={{repo}}#{{number}}"),
  })
  .strict();

/**
 * Resolved config — `runsDir` defaulted from `yakRepoPath`. This is what
 * the rest of the harness consumes.
 */
export const ConfigSchema = RawConfigSchema.transform((c) => ({
  ...c,
  runsDir: c.runsDir ?? join(c.yakRepoPath, ".runs"),
}));

export type Config = z.infer<typeof ConfigSchema>;

/** Thrown for any config problem — bad path, bad JSON, or a schema violation. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Read and validate the config file. Throws {@link ConfigError} with a
 * human-readable message on any failure; the CLI prints it to stderr and
 * exits non-zero.
 */
export function loadConfig(configPath: string): Config {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new ConfigError(
      `cannot read config at ${configPath}: ${(err as Error).message}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(
      `config at ${configPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new ConfigError(
      `config at ${configPath} is invalid:\n${lines.join("\n")}`,
    );
  }

  const config = parsed.data;
  const absViolations = [
    ["yakRepoPath", config.yakRepoPath] as const,
    ["runsDir", config.runsDir] as const,
  ].filter(([, value]) => !isAbsolute(value));
  if (absViolations.length > 0) {
    const lines = absViolations.map(
      ([key]) => `  ${key}: must be an absolute path`,
    );
    throw new ConfigError(
      `config at ${configPath} is invalid:\n${lines.join("\n")}`,
    );
  }
  return config;
}
