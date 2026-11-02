/**
 * An in-memory stand-in for a DurableObjectNamespace.
 *
 * The interesting part is `gated`. workerd holds incoming events for an object
 * while one of its storage operations is in flight (the "input gate"), which is
 * exactly what makes a read-modify-write inside a Durable Object atomic. This
 * helper models that with a per-instance promise chain, so a concurrency test
 * run here reproduces the ordering guarantee production actually provides.
 *
 * Passing `gated: false` removes the guarantee, which is how a test can show
 * that its concurrency assertion is not vacuous: the same assertion must fail
 * against an ungated counter.
 */
export interface FakeDurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface FakeDurableObjects<T> {
  namespace: DurableObjectNamespace;
  /** Live instances, keyed by the name passed to `idFromName`. */
  instances: Map<string, T>;
  /**
   * Each instance's storage, keyed the same way. Exposed here because the
   * runtime's `ctx` is protected on the DurableObject base class, so a test
   * cannot read it off the instance.
   */
  storages: Map<string, FakeDurableObjectStorage>;
  /** Every RPC issued, as `"<name>.<method>"`, in call order. */
  calls: string[];
}

function makeStorage(): FakeDurableObjectStorage {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    // Every accessor is async so awaiting one yields the microtask queue —
    // without that, an ungated read-modify-write would never interleave here
    // and the harness self-check below could not fail.
    //
    // Both directions clone. Real DO storage serializes, so a caller cannot
    // reach back into stored state through a reference it still holds; a Map of
    // live objects would let a test mutate a bucket in place and pass where
    // production would not.
    get: async <T>(key: string) => {
      const value = values.get(key);
      return (value === undefined ? undefined : structuredClone(value)) as T | undefined;
    },
    put: async <T>(key: string, value: T) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key: string) => values.delete(key),
    // Clears the alarm too, matching workerd: `delete_all_deletes_alarm` is
    // the default from compatibility date 2026-02-24 and this Worker is on
    // 2026-04-29, so one `deleteAll` empties an object's storage entirely.
    deleteAll: async () => {
      values.clear();
      alarm = null;
    },
    setAlarm: async (scheduledTime: number) => {
      alarm = scheduledTime;
    },
    getAlarm: async () => alarm,
  };
}

/**
 * Builds a fake namespace whose stubs forward RPC to real instances of a
 * Durable Object class.
 *
 * @param construct - Builds one instance around the supplied storage
 * @param opts - `gated` (default true) models workerd's input gate
 * @returns The namespace, its live instances, and a log of every RPC issued
 */
export function makeFakeDurableObjects<T extends object>(
  construct: (ctx: DurableObjectState) => T,
  opts: { gated?: boolean } = {},
): FakeDurableObjects<T> {
  const gated = opts.gated ?? true;
  const instances = new Map<string, T>();
  const storages = new Map<string, FakeDurableObjectStorage>();
  const gates = new Map<string, Promise<unknown>>();
  const calls: string[] = [];

  function instanceFor(name: string): T {
    const existing = instances.get(name);
    if (existing) return existing;
    const storage = makeStorage();
    storages.set(name, storage);
    const created = construct({ storage } as unknown as DurableObjectState);
    instances.set(name, created);
    return created;
  }

  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, name }),
    get: (id: { toString(): string }) => {
      const name = id.toString();
      return new Proxy(
        {},
        {
          get: (_target, method) => {
            // A Proxy that answers `.then` is a thenable: awaiting a stub (or
            // resolving one inside a promise chain) would call it as a
            // continuation and hang or resolve to the wrong thing. Symbols get
            // the same treatment — Symbol.toPrimitive, util.inspect and friends
            // are probes, not RPC.
            if (typeof method !== "string" || method === "then") return undefined;
            return async (...args: unknown[]) => {
              calls.push(`${name}.${method}`);
              const instance = instanceFor(name) as unknown as Record<
                string,
                (...a: unknown[]) => Promise<unknown>
              >;
              if (!gated) return instance[method]?.(...args);
              // Serialize on the instance the way the runtime's input gate does.
              // `.catch` keeps one rejected call from poisoning the chain, while
              // the rejection still propagates to its own caller below.
              const prior = gates.get(name) ?? Promise.resolve();
              const next = prior.then(() => instance[method]?.(...args));
              gates.set(
                name,
                next.catch(() => undefined),
              );
              return next;
            };
          },
        },
      ) as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return { namespace, instances, storages, calls };
}
