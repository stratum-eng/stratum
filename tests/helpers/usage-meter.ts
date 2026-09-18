import { UsageMeter } from "../../src/queue/usage-meter";
import type { Env } from "../../src/types";
import { type FakeDurableObjectStorage, makeFakeDurableObjects } from "./fake-durable-object";

export interface FakeUsageMeters {
  /** Typed exactly as `Env` declares the binding, so no call site casts. */
  namespace: NonNullable<Env["USAGE_METER"]>;
  instances: Map<string, UsageMeter>;
  storages: Map<string, FakeDurableObjectStorage>;
  calls: string[];
}

/**
 * A fake namespace backed by real {@link UsageMeter} instances.
 *
 * The one cast lives here rather than at each call site, for the reason
 * `makeMagicLinkLimiters` gives: `makeFakeDurableObjects` cannot know the RPC
 * brand of whichever class it constructs, and asserting it once means a
 * signature change on the Durable Object is a compile error in the tests
 * instead of being absorbed by hand-written stub types.
 *
 * @param opts - `gated` (default true) models workerd's input gate
 * @returns The namespace plus the harness's instances, storages, and RPC log
 */
export function makeUsageMeters(opts: { gated?: boolean } = {}): FakeUsageMeters {
  const fake = makeFakeDurableObjects((ctx) => new UsageMeter(ctx, {} as Env), opts);
  return {
    ...fake,
    namespace: fake.namespace as unknown as NonNullable<Env["USAGE_METER"]>,
  };
}
