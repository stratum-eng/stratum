/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// Read via Vite's raw import rather than node:fs, so the guard type-checks under
// the Workers tsconfig (the same trick tests/wrangler-migration-chain.test.ts uses).
import eventsSource from "../src/queue/events.ts?raw";
import { SUBSCRIBABLE_EVENTS } from "../src/routes/webhooks";

/**
 * Webhook event-coverage drift guard.
 *
 * `SUBSCRIBABLE_EVENTS` is derived from a `Record<StratumEvent["type"], true>`,
 * so the compiler already refuses a list that omits an event or names one that
 * does not exist. This is the runtime half of the same guarantee: it reads the
 * event union out of its source of truth and asserts the exported list matches
 * exactly, so the check still fires for anyone reading test output rather than
 * a `tsc` diagnostic — and it names the drifting event, which the type error
 * does only obliquely.
 */
function eventTypesInUnion(): string[] {
  const source: string = eventsSource;
  const start = source.indexOf("export type StratumEvent =");
  expect(start).toBeGreaterThanOrEqual(0);
  // The union ends at the first blank line followed by a new top-level
  // declaration; every variant before that opens with `type: "…"`.
  const end = source.indexOf("\n\nexport ", start);
  expect(end).toBeGreaterThan(start);

  const union = source.slice(start, end);
  return [...union.matchAll(/\btype:\s*"([^"]+)"/g)].map((match) => match[1] as string);
}

describe("subscribable webhook events", () => {
  const unionTypes = eventTypesInUnion();

  it("finds the event union to compare against", () => {
    expect(unionTypes.length).toBeGreaterThan(10);
  });

  it("offers every StratumEvent type as a webhook subscription", () => {
    const missing = unionTypes.filter((type) => !SUBSCRIBABLE_EVENTS.includes(type));
    expect(missing).toEqual([]);
  });

  it("does not advertise an event that can never fire", () => {
    const phantom = SUBSCRIBABLE_EVENTS.filter((type) => !unionTypes.includes(type));
    expect(phantom).toEqual([]);
  });

  it("lists each event exactly once", () => {
    expect(new Set(SUBSCRIBABLE_EVENTS).size).toBe(SUBSCRIBABLE_EVENTS.length);
  });

  it("includes the deployment events, which are the newest additions", () => {
    expect(SUBSCRIBABLE_EVENTS).toEqual(
      expect.arrayContaining(["deployment.requested", "deployment.succeeded", "deployment.failed"]),
    );
  });
});
