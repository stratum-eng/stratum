/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// Loaded via Vite's raw import (not node:fs) so this type-checks under the
// Workers tsconfig, matching tests/helpers/sqlite-d1.ts.
import wranglerToml from "../wrangler.toml?raw";

/**
 * Guards the telemetry kill switch against the wrangler footgun that made it
 * inert in production (#257): named environments do NOT inherit top-level
 * `[vars]` — they replace them. `STRATUM_TELEMETRY_DISABLED` lived only under
 * top-level `[vars]`, so `wrangler deploy --env=production` (what
 * `npm run deploy:production` runs) shipped with telemetry on no matter what a
 * self-hoster uncommented.
 *
 * The assertion is deliberately shape-based rather than value-based: the switch
 * ships commented out, so what matters is that every environment that turns
 * telemetry ON also *documents the way to turn it off in that same block*.
 */

const TELEMETRY_SWITCH = "STRATUM_TELEMETRY_DISABLED";
const TELEMETRY_ENABLER = "POSTHOG_HOST";

interface TomlSection {
  name: string;
  body: string;
}

/**
 * Split a TOML file into `[section]` / `[[array]]` blocks, keeping each block's
 * raw body (comments included — the switch ships commented out by design).
 * Sufficient for a structural assertion; not a general TOML parser.
 */
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

/** True when the section sets the switch for real, rather than only sampling it in a comment. */
function activatesSwitch(section: TomlSection): boolean {
  return section.body
    .split("\n")
    .some((line) => line.includes(TELEMETRY_SWITCH) && !line.trimStart().startsWith("#"));
}

function varsSectionsEnablingTelemetry(toml: string): TomlSection[] {
  return splitSections(toml).filter(
    (section) =>
      (section.name === "vars" || /^env\.[^.]+\.vars$/.test(section.name)) &&
      section.body.includes(TELEMETRY_ENABLER),
  );
}

describe("wrangler.toml telemetry configuration", () => {
  const toml = wranglerToml;

  it("declares a vars block for the top level and both deployed environments", () => {
    const names = varsSectionsEnablingTelemetry(toml).map((section) => section.name);

    expect(names).toContain("vars");
    expect(names).toContain("env.production.vars");
    expect(names).toContain("env.staging.vars");
  });

  it("offers the kill switch in every vars block that configures PostHog", () => {
    const missing = varsSectionsEnablingTelemetry(toml)
      .filter((section) => !section.body.includes(TELEMETRY_SWITCH))
      .map((section) => section.name);

    expect(missing).toEqual([]);
  });

  it("ships the switch commented out so telemetry stays on by default", () => {
    const active = varsSectionsEnablingTelemetry(toml)
      .filter((section) => activatesSwitch(section))
      .map((section) => section.name);

    expect(active).toEqual([]);
  });

  it("never activates the switch in only some of the deployed environments", () => {
    // The regression this file exists for: a real (uncommented) setting placed
    // only at top level is INERT under `wrangler deploy --env=production`,
    // because named environments replace `vars` rather than inheriting it. The
    // assertions above are shape-based and would not catch that on their own —
    // this one fails the moment someone activates the switch unevenly.
    const sections = varsSectionsEnablingTelemetry(toml);
    const active = sections.filter(activatesSwitch);

    if (active.length > 0) {
      expect(active.map((s) => s.name).sort()).toEqual(sections.map((s) => s.name).sort());
    }
  });

  it("splits sections without swallowing the block a key belongs to", () => {
    const sections = splitSections('[vars]\nA = "1"\n\n[env.staging.vars]\nB = "2"\n');

    expect(sections.map((s) => s.name)).toEqual(["", "vars", "env.staging.vars"]);
    expect(sections.find((s) => s.name === "vars")?.body).toContain('A = "1"');
    expect(sections.find((s) => s.name === "vars")?.body).not.toContain('B = "2"');
  });
});
