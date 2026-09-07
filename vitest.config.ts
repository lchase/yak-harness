import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Excluded: tests; the CLI wiring (`cli.ts`); the barrel (`index.ts`);
      // and the `*-deps.ts` shell-out boundary — by design the boundary is
      // integration-only and the logic layer that consumes it is injected
      // with fakes (spec §6.1). The thresholds below therefore bite on the
      // pure layer, which is meant to stay near-total.
      exclude: [
        "src/**/*.test.ts",
        "src/cli.ts",
        "src/index.ts",
        "src/**/*-deps.ts",
      ],
      thresholds: {
        statements: 90,
        lines: 90,
        // Sub-90 only because a few marker-builder constants land with the
        // gate-bridge / escalation tickets (#6, #5b) and have no caller yet.
        functions: 85,
        branches: 85,
      },
    },
  },
});
