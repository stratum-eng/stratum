import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// A local config, so vitest does not climb to the repo root and load the main
// Worker's — this package installs and tests by itself, like `cli/` and `agent/`.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // `cloudflare:workers` exists only inside workerd.
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/helpers/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
});
