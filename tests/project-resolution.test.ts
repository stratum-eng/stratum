import { describe, expect, it, vi } from "vitest";
import { getProject, setProject } from "../src/storage/state";
import type { ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((key) => (prefix ? key.startsWith(prefix) : true))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
  } as unknown as KVNamespace;
}

function makeProject(overrides: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: "proj_1",
    name: "my-api",
    slug: "my-api",
    namespace: "@user",
    ownerId: "usr_1",
    ownerType: "user",
    remote: "remote",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getProject reference resolution", () => {
  it("resolves namespaced projects by bare name — the key the changes API uses", async () => {
    const kv = makeKv();
    await setProject(kv, makeProject({}), mockLogger);

    const result = await getProject(kv, "my-api", mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe("proj_1");
  });

  it("resolves namespace/slug references with and without the @", async () => {
    const kv = makeKv();
    await setProject(kv, makeProject({}), mockLogger);

    const withAt = await getProject(kv, "@user/my-api", mockLogger);
    expect(withAt.success).toBe(true);

    const withoutAt = await getProject(kv, "user/my-api", mockLogger);
    expect(withoutAt.success).toBe(true);
  });

  it("still resolves legacy name-keyed entries directly", async () => {
    const kv = makeKv();
    await kv.put("project:legacy-proj", JSON.stringify(makeProject({ name: "legacy-proj" })));

    const result = await getProject(kv, "legacy-proj", mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe("legacy-proj");
  });

  it("returns NOT_FOUND for unknown references", async () => {
    const kv = makeKv();
    await setProject(kv, makeProject({}), mockLogger);

    const result = await getProject(kv, "no-such-project", mockLogger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});
