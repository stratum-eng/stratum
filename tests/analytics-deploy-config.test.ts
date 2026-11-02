/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// Raw imports rather than node:fs, matching tests/wrangler-telemetry-config.test.ts.
import ciWorkflow from "../.github/workflows/ci.yml?raw";
import deployDocsWorkflow from "../.github/workflows/deploy-docs.yml?raw";
import deployProductionWorkflow from "../.github/workflows/deploy-production.yml?raw";
import prPreviewWorkflow from "../.github/workflows/pr-preview.yml?raw";
import wranglerToml from "../wrangler.toml?raw";

/**
 * Browser analytics is off unless `POSTHOG_PUBLIC_KEY` reaches the Worker, and
 * nothing in `src/` can tell the difference between "the operator chose not to
 * enable it" and "the deploy forgot to pass it". Both produce pages with no
 * SDK, no error, and no event — which is exactly how the application ran with
 * zero browser events while the documentation site, whose workflow did pass the
 * variable, reported them normally.
 *
 * The key cannot live in `wrangler.toml`: that file ships to self-hosters, and
 * a token committed there would send THEIR users' events to OUR project. So the
 * deploy workflow is the only place the value can come from, and this is what
 * keeps it there.
 */

const KEY = "POSTHOG_PUBLIC_KEY";
const FROM_REPOSITORY_VARIABLE = `${KEY}: \${{ vars.${KEY} }}`;

/** Every line that actually runs `wrangler deploy`, not the ones discussing it. */
function deployCommands(workflow: string): string[] {
  return workflow
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(run: )?npx wrangler deploy\b/.test(line));
}

describe("browser analytics deploy wiring", () => {
  it.each([
    ["ci.yml", ciWorkflow],
    ["deploy-production.yml", deployProductionWorkflow],
    ["deploy-docs.yml", deployDocsWorkflow],
  ])("passes the project key on every deploy in %s", (_name, workflow) => {
    const commands = deployCommands(workflow);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command, `\`${command}\` deploys without ${KEY}`).toContain(`--var ${KEY}:`);
    }
    // The flag is only half of it: without the step-level `env:` entry the
    // shell expands `"$POSTHOG_PUBLIC_KEY"` to the empty string and the deploy
    // succeeds with analytics off — the same silent failure, one layer down.
    expect(workflow).toContain(FROM_REPOSITORY_VARIABLE);
  });

  it("leaves PR previews uninstrumented", () => {
    // Previews run contributor branches on a real subdomain. Their traffic is
    // not product usage, and `STRATUM_ENVIRONMENT = "preview"` in the generated
    // config only labels it — this is what keeps there being nothing to label.
    for (const command of deployCommands(prPreviewWorkflow)) {
      expect(command).not.toContain(KEY);
    }
    expect(prPreviewWorkflow).not.toContain(FROM_REPOSITORY_VARIABLE);
  });

  it("keeps the key out of the config file self-hosters deploy", () => {
    // An uncommented token here would be published in every page of every
    // instance built from this repo, all of them reporting to us.
    for (const line of wranglerToml.split("\n")) {
      if (!line.includes(KEY)) continue;
      expect(line.trimStart().startsWith("#"), `${KEY} is set in wrangler.toml`).toBe(true);
    }
  });
});
