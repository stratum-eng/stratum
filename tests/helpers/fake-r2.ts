/**
 * In-memory R2 bucket good enough for the backup subsystem: put/get/head/delete
 * (single + batch) and list with prefix, delimiter, cursor pagination.
 */
export function makeFakeR2(pageSize = 1000): R2Bucket & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();

  async function put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<unknown> {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    store.set(key, bytes);
    return { key };
  }

  async function get(key: string): Promise<unknown> {
    const bytes = store.get(key);
    if (!bytes) return null;
    return {
      key,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async function head(key: string): Promise<unknown> {
    return store.has(key) ? { key } : null;
  }

  async function del(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
  }

  async function list(opts?: {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
  }): Promise<unknown> {
    const prefix = opts?.prefix ?? "";
    const delimiter = opts?.delimiter;
    const limit = opts?.limit ?? pageSize;
    const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();

    const objects: { key: string }[] = [];
    const delimitedPrefixes = new Set<string>();
    for (const key of all) {
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) {
          delimitedPrefixes.add(prefix + rest.slice(0, idx + delimiter.length));
          continue;
        }
      }
      objects.push({ key });
    }

    const start = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    const pageObjects = objects.slice(start, start + limit);
    const truncated = start + limit < objects.length;
    return {
      objects: pageObjects,
      delimitedPrefixes: [...delimitedPrefixes],
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }

  return {
    store,
    put,
    get,
    head,
    delete: del,
    list,
  } as unknown as R2Bucket & { store: Map<string, Uint8Array> };
}
