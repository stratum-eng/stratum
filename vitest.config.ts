import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The `cloudflare:workers` virtual module only exists inside workerd.
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/helpers/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      // Ratchet floor: set just below the current baseline so CI blocks
      // regressions without breaking on run-to-run noise. Raise these as
      // coverage improves; never lower them to make a red build pass.
      thresholds: {
        statements: 38,
        branches: 72,
        functions: 50,
        lines: 38,
      },
    },
  },
});
