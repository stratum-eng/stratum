/// <reference types="vite/client" />

/**
 * Guard: every queue `wrangler.toml` binds is one CI will provision.
 *
 * `wrangler deploy` fails outright on a bound queue that does not exist, and it
 * fails at deploy time — after migrations have already been applied. That is
 * how post-merge deployments broke production: `stratum-deploys` was bound in
 * `wrangler.toml`, the staging job's hardcoded list was updated, and the
 * production job had no such list at all because its queues predated CI.
 *
 * The fix made `scripts/wrangler-queues.mjs` the single source, reading the
 * TOML the deploy itself reads. This asserts the reader actually sees what is
 * bound — a silent miss would restore the original failure, and nothing else
 * notices until a deploy dies.
 */

import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs helper shared with CI; no types, and adding a
// .d.ts for one exported function would be more indirection than it saves.
import { queueNamesFor } from "../scripts/wrangler-queues.mjs";
// Raw import rather than node:fs, so the guard type-checks under the Workers
// tsconfig — the same trick tests/wrangler-migration-chain.test.ts uses.
import wranglerToml from "../wrangler.toml?raw";

const namesFor = (env: string): string[] => queueNamesFor(wranglerToml, env) as string[];

/**
 * Every queue name mentioned anywhere in the file, found without the section
 * tracking the extractor uses. If the extractor's per-env results don't add up
 * to this, it is skipping a block shape.
 */
function everyQueueNameInFile(): Set<string> {
  const names = new Set<string>();
  for (const line of wranglerToml.split("\n")) {
    const match = line.match(/^\s*(?:queue|dead_letter_queue)\s*=\s*"([^"]+)"/);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

describe("wrangler.toml queue provisioning", () => {
  it("finds the production queues, including the deploy DLQ", () => {
    const production = namesFor("production");

    // The DLQ is named only by a consumer's `dead_letter_queue`, never by its
    // own block, so an extractor that reads `queue = ` alone would miss it and
    // the deploy would fail on exactly that one.
    expect(production).toContain("stratum-deploys");
    expect(production).toContain("stratum-deploys-dlq");
    expect(production).toContain("stratum-events");
    expect(production).toContain("stratum-imports");
  });

  it("keeps environments separate", () => {
    const production = namesFor("production");
    const staging = namesFor("staging");

    // Queue names are account-level: staging and production sharing one
    // delivered staging's messages to the production consumer (see the comment
    // in wrangler.toml). Provisioning must not blur them either.
    expect(staging.every((name) => name.endsWith("-staging"))).toBe(true);
    expect(production.some((name) => name.endsWith("-staging"))).toBe(false);
    expect(production).not.toEqual(staging);
  });

  it("attributes every queue in the file to some environment", () => {
    const seen = new Set([...namesFor(""), ...namesFor("production"), ...namesFor("staging")]);

    // The real assertion: nothing bound anywhere is invisible to the reader.
    // A new `[[env.<name>.queues.*]]` block that CI never provisions would
    // otherwise ship silently and break that environment's next deploy.
    expect([...everyQueueNameInFile()].sort()).toEqual([...seen].sort());
  });

  it("returns nothing for an unknown environment rather than guessing", () => {
    // The CLI turns this into a hard failure. Silence would mean "provision
    // nothing", and the deploy right after would fail on the first bound queue.
    expect(namesFor("nonexistent")).toEqual([]);
  });
});
