/// <reference types="vite/client" />
/**
 * The two numeric bounds a post-merge deployment runs inside, asserted against
 * the config that actually ships.
 *
 * Both were wrong in a way no unit test could see, because each is a
 * relationship between a constant in `src/` and a knob in `wrangler.toml`:
 *
 * 1. **Isolate memory.** Concurrent queue invocations share one isolate's
 *    128 MiB. A Vercel deploy inlines the whole tree in its request body, so
 *    one peaks near 92 MiB — and `max_concurrency = 2` let two of them run at
 *    once. The isolate is killed on OOM *before* the runner's `finally` can
 *    write a terminal status, which strands rows at `running` with no lease.
 * 2. **Lease ordering.** The runner's own deadline has to be shorter than the
 *    storage lease, which has to fit inside the queue's visibility timeout,
 *    which has to fit inside the consumer's wall-clock limit. Break the first
 *    `<` and a lease can expire while its runner is still uploading, so
 *    `claimDeployment` hands a genuinely-running row to a second consumer and
 *    the same commit deploys twice.
 *
 * These assertions are the reason those relationships cannot be re-broken by
 * editing one side of them.
 */
import { describe, expect, it } from "vitest";
// Loaded via Vite's raw import (not node:fs) so this type-checks under the
// Workers tsconfig, matching tests/wrangler-telemetry-config.test.ts.
import wranglerToml from "../wrangler.toml?raw";

import {
  DEPLOY_ATTEMPT_DEADLINE_MS,
  ISOLATE_MEMORY_BYTES,
  MAX_DEPLOY_CONCURRENCY,
  QUEUE_CONSUMER_WALL_MS,
} from "../src/deploy/limits";
import { MAX_PEAK_DEPLOY_BYTES } from "../src/deploy/targets/vercel";
import { DEFAULT_DEPLOY_LEASE_MS } from "../src/storage/deployments";

interface TomlSection {
  name: string;
  body: string;
}

/** Split a TOML file into `[section]` / `[[array]]` blocks. Not a general parser. */
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

/** The value of an uncommented `key = <number>` line, or undefined. */
function numberSetting(section: TomlSection, key: string): number | undefined {
  for (const line of section.body.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) continue;
    const match = new RegExp(`^${key}\\s*=\\s*(\\d+)`).exec(trimmed);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

/** Every `stratum-deploys` consumer block: top level, production, and staging. */
function deployConsumers(): TomlSection[] {
  return splitSections(wranglerToml).filter(
    (section) =>
      section.name.endsWith("queues.consumers") &&
      /^queue\s*=\s*"stratum-deploys(-staging)?"/m.test(section.body),
  );
}

describe("the isolate-memory bound on concurrent deploys", () => {
  it("declares a concurrency every environment's consumer actually uses", () => {
    const consumers = deployConsumers();
    // Top level (self-hosting template), production, and staging. A new
    // environment that forgets the knob has to fail here.
    expect(consumers).toHaveLength(3);

    for (const consumer of consumers) {
      expect(numberSetting(consumer, "max_concurrency")).toBe(MAX_DEPLOY_CONCURRENCY);
    }
  });

  it("fits the declared concurrency inside one isolate", () => {
    expect(MAX_DEPLOY_CONCURRENCY * MAX_PEAK_DEPLOY_BYTES).toBeLessThanOrEqual(
      ISOLATE_MEMORY_BYTES,
    );
  });

  // The regression itself: `max_concurrency = 2` put ~183 MiB of peak into a
  // 128 MiB isolate. An OOM kill is not catchable, so the deployment rows those
  // two runs were holding never reached a terminal status.
  it("would not fit one more concurrent deploy, which is why the knob is 1", () => {
    expect((MAX_DEPLOY_CONCURRENCY + 1) * MAX_PEAK_DEPLOY_BYTES).toBeGreaterThan(
      ISOLATE_MEMORY_BYTES,
    );
  });
});

describe("the lease ordering", () => {
  // The `<` that stops a lease expiring under a live runner. Everything else in
  // this ordering is about redelivery timing; only this one is about two
  // consumers publishing the same commit.
  it("gives up on an attempt strictly before its lease can expire", () => {
    expect(DEPLOY_ATTEMPT_DEADLINE_MS).toBeLessThan(DEFAULT_DEPLOY_LEASE_MS);
  });

  it("keeps the lease inside every consumer's visibility timeout", () => {
    for (const consumer of deployConsumers()) {
      const visibility = numberSetting(consumer, "visibility_timeout_ms");
      expect(visibility).toBeDefined();
      expect(visibility as number).toBeGreaterThanOrEqual(DEFAULT_DEPLOY_LEASE_MS);
      expect(visibility as number).toBeLessThanOrEqual(QUEUE_CONSUMER_WALL_MS);
    }
  });
});
