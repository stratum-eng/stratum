import { defineConfig } from "vitest/config";

// Without a local config, vitest climbs to the repo root and loads the
// Worker's vitest.config.ts — which needs the root node_modules that the
// packages CI job doesn't install.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
