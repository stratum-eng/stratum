/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// Loaded via Vite's raw import (not node:fs) so this type-checks under the
// Workers tsconfig, matching tests/wrangler-telemetry-config.test.ts.
import wranglerToml from "../wrangler.toml?raw";

/**
 * Guards the UsageMeter's configuration against the two wrangler footguns that
 * make a binding look configured and behave as absent.
 *
 * 1. **Named environments inherit nothing.** A `[[durable_objects.bindings]]`
 *    or a `[vars]` entry declared only at the top level never reaches
 *    `wrangler deploy --env production` — the failure that made the telemetry
 *    kill switch inert (#257, and the sibling guard in
 *    `wrangler-telemetry-config.test.ts`). An unbound `USAGE_METER` is worse
 *    than a wrong value: `env.USAGE_METER` is optional, so every counter would
 *    silently no-op forever with nothing in the logs.
 * 2. **`script_name` is per environment.** Staging's classes live on
 *    `stratum-staging`; pointing its binding at `stratum` aims the staging
 *    Worker at production's Durable Objects.
 *
 * The migration tag is checked here only for presence and uniqueness — the
 * append-only rule that actually matters lives in
 * `tests/wrangler-migration-chain.test.ts`, which compares against main.
 */

interface TomlSection {
  name: string;
  body: string;
}

/** Split into `[section]` / `[[array]]` blocks, keeping each raw body. */
function splitSections(toml: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection = { name: "", body: "" };
  for (const line of toml.split("\n")) {
    const header = /^\s*\[{1,2}([^\]]+)\]{1,2}\s*$/.exec(line);
    if (header?.[1]) {
      sections.push(current);
      current = { name: header[1], body: "" };
      continue;
    }
    current.body += `${line}\n`;
  }
  sections.push(current);
  return sections;
}

const sections = splitSections(wranglerToml);

function bodiesOf(name: string): string[] {
  return sections.filter((section) => section.name === name).map((section) => section.body);
}

/** The value of `key` where it is set for real (a commented line is not set). */
function settingValue(body: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(body);
  return match?.[1] ?? null;
}

/** Every environment that declares Durable Object bindings, and its script name. */
const DO_SCOPES: readonly [scope: string, scriptName: string][] = [
  ["durable_objects.bindings", "stratum"],
  ["env.production.durable_objects.bindings", "stratum"],
  ["env.staging.durable_objects.bindings", "stratum-staging"],
];

describe("wrangler.toml UsageMeter configuration", () => {
  it("declares the class in exactly one migration tag", () => {
    const declaring = bodiesOf("migrations").filter((body) => body.includes('"UsageMeter"'));
    expect(declaring).toHaveLength(1);
    // SQLite-backed like RepoDO and MagicLinkRateLimiter; `new_classes` would
    // create a key-value object the storage code here does not target.
    expect(declaring[0]).toMatch(/new_sqlite_classes\s*=\s*\[[^\]]*"UsageMeter"/);
  });

  it.each(DO_SCOPES)("binds USAGE_METER in [%s] with script_name %s", (scope, scriptName) => {
    const binding = bodiesOf(scope).find((body) => settingValue(body, "name") === "USAGE_METER");
    expect(binding, `no USAGE_METER binding in [[${scope}]]`).toBeDefined();
    expect(settingValue(binding as string, "class_name")).toBe("UsageMeter");
    expect(settingValue(binding as string, "script_name")).toBe(scriptName);
  });

  it.each(["vars", "env.production.vars", "env.staging.vars"])(
    "declares the entitlements switch and documents its companions in [%s]",
    (scope) => {
      const body = bodiesOf(scope)[0];
      expect(body, `no [${scope}] block`).toBeDefined();
      // Spelled out rather than left unset, so the enforcement switch is
      // visible in every environment instead of inferred from an absence.
      expect(settingValue(body as string, "ENTITLEMENTS_ENFORCE")).toBe("0");
      // The other three ship commented (a URL, a secret's name, an operator
      // allowlist), so what is asserted is that each block documents them —
      // the same shape-based assertion the telemetry guard makes. This checks
      // presence only: it deliberately does NOT assert what the prose says,
      // because LLM_PROVIDERS is reserved and unread until Task 7, and a test
      // that pinned its description would lock a false claim into place.
      for (const key of ["BILLING_SERVICE_URL", "BILLING_SERVICE_SECRET", "LLM_PROVIDERS"]) {
        expect(body as string, `${key} undocumented in [${scope}]`).toContain(key);
      }
    },
  );
});
