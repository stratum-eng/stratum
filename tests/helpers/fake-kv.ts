/** In-memory KV supporting get/put/delete/list(prefix) — enough for state.ts. */
export function makeFakeKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      };
    },
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}
