import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSyncHistory,
  getSyncStatus,
  recordSyncHistory,
  setSyncSettings,
} from "../src/storage/sync";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({ component: "test" });

// ---------------------------------------------------------------------------
// KV mock
// ---------------------------------------------------------------------------

function makeKvMock(initial: Record<string, string> = {}): KVNamespace {
  const store: Record<string, string> = { ...initial };
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete store[key];
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
    getWithMetadata: vi.fn(async (key: string) => ({
      value: store[key] ?? null,
      metadata: null,
    })),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// D1 mock
// ---------------------------------------------------------------------------

interface D1Row {
  id?: number;
  namespace: string;
  slug: string;
  trigger: string;
  status: string;
  commits_synced: number;
  synced_commit: string | null;
  error_message: string | null;
  duration_ms: number | null;
  started_at: string;
  completed_at: string | null;
}

function makeD1Mock(rows: D1Row[] = []): D1Database {
  let nextId = 1;
  const store: D1Row[] = rows.map((r) => ({ ...r, id: nextId++ }));

  const makeStmt = (sql: string) => {
    let bindings: unknown[] = [];
    const stmt = {
      bind: (...args: unknown[]) => {
        bindings = args;
        return stmt;
      },
      run: vi.fn(async () => {
        if (sql.startsWith("INSERT INTO sync_history")) {
          const [ns, sl, tr, st, cs, sc, em, dm, sa, ca] = bindings as [
            string,
            string,
            string,
            string,
            number,
            string | null,
            string | null,
            number | null,
            string,
            string | null,
          ];
          store.push({
            id: nextId++,
            namespace: ns,
            slug: sl,
            trigger: tr,
            status: st,
            commits_synced: cs,
            synced_commit: sc,
            error_message: em,
            duration_ms: dm,
            started_at: sa,
            completed_at: ca,
          });
        }
        return { success: true, results: [], meta: {} };
      }),
      all: vi.fn(async () => {
        if (sql.startsWith("SELECT") && sql.includes("sync_history")) {
          const [ns, sl, lim, off] = bindings as [string, string, number, number];
          const filtered = store
            .filter((r) => r.namespace === ns && r.slug === sl)
            .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
            .slice(off, off + lim);
          return { results: filtered };
        }
        return { results: [] };
      }),
      first: vi.fn(async () => null),
    };
    return stmt;
  };

  return {
    prepare: vi.fn((sql: string) => makeStmt(sql)),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

function makeFailingD1(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
      all: vi.fn().mockRejectedValue(new Error("no such table: sync_history")),
      first: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
    })),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// setSyncSettings tests
// ---------------------------------------------------------------------------

describe("setSyncSettings", () => {
  it("initialises a new blob when none exists", async () => {
    const kv = makeKvMock();
    const result = await setSyncSettings(
      kv,
      "@user",
      "my-repo",
      { autoSyncEnabled: true, syncFrequency: 60 },
      logger,
    );
    expect(result.success).toBe(true);

    const statusResult = await getSyncStatus(kv, "@user", "my-repo", logger);
    expect(statusResult.success).toBe(true);
    expect(statusResult.success && statusResult.data?.autoSyncEnabled).toBe(true);
    expect(statusResult.success && statusResult.data?.syncFrequency).toBe(60);
    expect(statusResult.success && statusResult.data?.lastSyncStatus).toBe("idle");
  });

  it("merges into existing blob without overwriting unrelated fields", async () => {
    const kv = makeKvMock({
      "sync-status:@user:existing": JSON.stringify({
        namespace: "@user",
        slug: "existing",
        lastCheckedAt: "2024-01-01T00:00:00.000Z",
        lastSyncedAt: "2024-01-01T00:00:00.000Z",
        lastSyncedCommit: "abc1234",
        lastSyncStatus: "success",
        hasUpdates: false,
        autoSyncEnabled: false,
        syncFrequency: 30,
      }),
    });

    await setSyncSettings(kv, "@user", "existing", { autoSyncEnabled: true }, logger);

    const statusResult = await getSyncStatus(kv, "@user", "existing", logger);
    expect(statusResult.success && statusResult.data?.autoSyncEnabled).toBe(true);
    expect(statusResult.success && statusResult.data?.syncFrequency).toBe(30); // unchanged
    expect(statusResult.success && statusResult.data?.lastSyncedCommit).toBe("abc1234"); // unchanged
    expect(statusResult.success && statusResult.data?.lastSyncStatus).toBe("success"); // unchanged
  });

  it("updates syncFrequency independently", async () => {
    const kv = makeKvMock();
    await setSyncSettings(
      kv,
      "@user",
      "repo",
      { autoSyncEnabled: true, syncFrequency: 60 },
      logger,
    );
    await setSyncSettings(kv, "@user", "repo", { syncFrequency: 120 }, logger);

    const statusResult = await getSyncStatus(kv, "@user", "repo", logger);
    expect(statusResult.success && statusResult.data?.syncFrequency).toBe(120);
    expect(statusResult.success && statusResult.data?.autoSyncEnabled).toBe(true); // unchanged
  });

  it("returns an error result (does not throw) when KV fails", async () => {
    const kv = makeKvMock();
    (kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV error"));
    const result = await setSyncSettings(kv, "@user", "repo", { autoSyncEnabled: true }, logger);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordSyncHistory tests
// ---------------------------------------------------------------------------

describe("recordSyncHistory", () => {
  it("inserts a success row", async () => {
    const db = makeD1Mock();
    await recordSyncHistory(
      db,
      {
        namespace: "@user",
        slug: "repo",
        trigger: "manual",
        status: "success",
        commitsSynced: 3,
        syncedCommit: "abc1234",
        durationMs: 500,
        startedAt: "2024-01-01T00:00:00.000Z",
        completedAt: "2024-01-01T00:00:00.500Z",
      },
      logger,
    );
    expect(db.prepare as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it("does not throw when D1 fails", async () => {
    const db = makeFailingD1();
    await expect(
      recordSyncHistory(
        db,
        {
          namespace: "@user",
          slug: "repo",
          trigger: "webhook",
          status: "failed",
          errorMessage: "some error",
          startedAt: "2024-01-01T00:00:00.000Z",
        },
        logger,
      ),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getSyncHistory tests
// ---------------------------------------------------------------------------

describe("getSyncHistory", () => {
  let db: D1Database;

  beforeEach(() => {
    db = makeD1Mock([
      {
        namespace: "@user",
        slug: "repo",
        trigger: "manual",
        status: "success",
        commits_synced: 1,
        synced_commit: "aaa",
        error_message: null,
        duration_ms: 100,
        started_at: "2024-01-03T00:00:00.000Z",
        completed_at: "2024-01-03T00:00:00.100Z",
      },
      {
        namespace: "@user",
        slug: "repo",
        trigger: "webhook",
        status: "failed",
        commits_synced: 0,
        synced_commit: null,
        error_message: "clone failed",
        duration_ms: 200,
        started_at: "2024-01-02T00:00:00.000Z",
        completed_at: "2024-01-02T00:00:00.200Z",
      },
      {
        namespace: "@user",
        slug: "repo",
        trigger: "auto",
        status: "success",
        commits_synced: 2,
        synced_commit: "bbb",
        error_message: null,
        duration_ms: 150,
        started_at: "2024-01-01T00:00:00.000Z",
        completed_at: "2024-01-01T00:00:00.150Z",
      },
    ]);
  });

  it("returns rows ordered by started_at DESC", async () => {
    const rows = await getSyncHistory(db, "@user", "repo", 10, 0, logger);
    expect(rows.at(0)?.startedAt).toBe("2024-01-03T00:00:00.000Z");
    expect(rows.at(1)?.startedAt).toBe("2024-01-02T00:00:00.000Z");
    expect(rows.at(2)?.startedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("respects limit", async () => {
    const rows = await getSyncHistory(db, "@user", "repo", 2, 0, logger);
    expect(rows).toHaveLength(2);
  });

  it("respects offset", async () => {
    const rows = await getSyncHistory(db, "@user", "repo", 10, 1, logger);
    expect(rows).toHaveLength(2);
    expect(rows.at(0)?.startedAt).toBe("2024-01-02T00:00:00.000Z");
  });

  it("returns empty array when table does not exist", async () => {
    const rows = await getSyncHistory(makeFailingD1(), "@user", "repo", 10, 0, logger);
    expect(rows).toEqual([]);
  });

  it("maps snake_case columns to camelCase", async () => {
    const rows = await getSyncHistory(db, "@user", "repo", 1, 0, logger);
    expect(rows[0]).toMatchObject({
      namespace: "@user",
      slug: "repo",
      trigger: "manual",
      status: "success",
      commitsSynced: 1,
      syncedCommit: "aaa",
      durationMs: 100,
    });
  });
});
