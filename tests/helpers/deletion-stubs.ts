import type { Env } from "../../src/types";

export interface ExecutedStatement {
  sql: string;
  bindings: unknown[];
}

/**
 * Recording D1 stub: every statement lands in `executed` (so tests can assert
 * ordering/scoping) and SELECT results come from the `rowsFor` callback.
 */
export function makeRecordingD1(
  rowsFor: (sql: string, bindings: unknown[]) => Record<string, unknown>[] = () => [],
): { db: D1Database; executed: ExecutedStatement[] } {
  const executed: ExecutedStatement[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        executed.push({ sql, bindings });
        return { success: true, meta: { changes: 1 } };
      },
      all: async <T>() => {
        executed.push({ sql, bindings });
        return { results: rowsFor(sql, bindings) as T[], success: true, meta: {} };
      },
      first: async <T>() => {
        executed.push({ sql, bindings });
        return (rowsFor(sql, bindings)[0] ?? null) as T | null;
      },
    };
  }

  return {
    db: { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database,
    executed,
  };
}

export interface KvStub {
  kv: KVNamespace;
  store: Map<string, string>;
  deletedKeys: string[];
  listCalls: number;
}

/**
 * Map-based KV stub with REAL pagination (small pages) so callers that don't
 * loop the cursor demonstrably miss keys.
 */
export function makeKvStub(pageSize = 2): KvStub {
  const store = new Map<string, string>();
  const deletedKeys: string[] = [];
  const stub: KvStub = {
    store,
    deletedKeys,
    listCalls: 0,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
        deletedKeys.push(key);
      },
      list: async (opts?: { prefix?: string; cursor?: string }) => {
        stub.listCalls += 1;
        const keys = [...store.keys()].filter((k) => k.startsWith(opts?.prefix ?? "")).sort();
        const start = opts?.cursor ? Number(opts.cursor) : 0;
        const page = keys.slice(start, start + pageSize);
        const complete = start + pageSize >= keys.length;
        return complete
          ? { keys: page.map((name) => ({ name })), list_complete: true, cacheStatus: null }
          : {
              keys: page.map((name) => ({ name })),
              list_complete: false,
              cursor: String(start + pageSize),
              cacheStatus: null,
            };
      },
    } as unknown as KVNamespace,
  };
  return stub;
}

export interface ArtifactsStub {
  artifacts: Env["ARTIFACTS"];
  attempts: string[];
  deleted: string[];
}

/**
 * Artifacts stub. `failWith(name, attempt)` may throw to simulate delete
 * failures; a non-throwing call counts as a successful delete.
 */
export function makeArtifactsStub(
  failWith?: (name: string, attempt: number) => void,
): ArtifactsStub {
  const attempts: string[] = [];
  const deleted: string[] = [];
  return {
    attempts,
    deleted,
    artifacts: {
      delete: async (name: string) => {
        attempts.push(name);
        const attempt = attempts.filter((n) => n === name).length;
        failWith?.(name, attempt);
        deleted.push(name);
        return true;
      },
    } as unknown as Env["ARTIFACTS"],
  };
}

export interface DoNamespaceStub {
  ns: DurableObjectNamespace;
  purged: string[];
}

export function makeDoNamespaceStub(): DoNamespaceStub {
  const purged: string[] = [];
  return {
    purged,
    ns: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        purge: async () => {
          purged.push(id.name);
        },
      }),
    } as unknown as DurableObjectNamespace,
  };
}

export interface DeletionJobRowStub {
  id: string;
  kind: string;
  target: string;
  state: string;
  checkpoint: string | null;
  heartbeat_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  residuals: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobsD1Stub {
  db: D1Database;
  jobs: Map<string, DeletionJobRowStub>;
  audits: { action: string; subject: string | null; detail: string }[];
  executed: ExecutedStatement[];
}

const UNFINISHED_STATES = new Set(["pending", "running", "verifying"]);

/**
 * Stateful D1 stub for the deletion_jobs + audit_log tables. Statements it
 * doesn't recognize (the cascade/verify traffic in runner tests) fall through
 * to `rowsFor` for results and are recorded like everything else.
 */
export function makeJobsD1(
  rowsFor: (sql: string, bindings: unknown[]) => Record<string, unknown>[] = () => [],
): JobsD1Stub {
  const jobs = new Map<string, DeletionJobRowStub>();
  const audits: { action: string; subject: string | null; detail: string }[] = [];
  const executed: ExecutedStatement[] = [];

  function handle(
    sql: string,
    bindings: unknown[],
  ): { rows: Record<string, unknown>[]; changes: number } {
    executed.push({ sql, bindings });
    const norm = sql.replace(/\s+/g, " ").trim();

    if (norm.startsWith("INSERT INTO deletion_jobs")) {
      const [id, kind, target, createdAt] = bindings as [string, string, string, string];
      jobs.set(id, {
        id,
        kind,
        target,
        state: "pending",
        checkpoint: null,
        heartbeat_at: null,
        lease_owner: null,
        lease_expires_at: null,
        residuals: null,
        created_at: createdAt,
        started_at: null,
        finished_at: null,
      });
      return { rows: [], changes: 1 };
    }

    if (norm.startsWith("SELECT * FROM deletion_jobs WHERE id = ?")) {
      const job = jobs.get(bindings[0] as string);
      return { rows: job ? [{ ...job }] : [], changes: 0 };
    }

    if (norm.startsWith("UPDATE deletion_jobs SET lease_owner = ?")) {
      const [owner, expiresIso, nowIso, id, nowIso2] = bindings as [
        string,
        string,
        string,
        string,
        string,
      ];
      const job = jobs.get(id);
      const leaseFree =
        job !== undefined &&
        (job.lease_owner === null ||
          job.lease_expires_at === null ||
          job.lease_expires_at < nowIso2);
      if (job && UNFINISHED_STATES.has(job.state) && leaseFree) {
        job.lease_owner = owner;
        job.lease_expires_at = expiresIso;
        job.heartbeat_at = nowIso;
        return { rows: [], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }

    if (norm.startsWith("UPDATE deletion_jobs SET heartbeat_at = ?")) {
      const [heartbeatAt, leaseExpiresAt, checkpoint, id, owner] = bindings as [
        string,
        string,
        string | null,
        string,
        string,
      ];
      const job = jobs.get(id);
      if (!job || job.lease_owner !== owner) return { rows: [], changes: 0 };
      job.heartbeat_at = heartbeatAt;
      job.lease_expires_at = leaseExpiresAt;
      job.checkpoint = checkpoint ?? job.checkpoint;
      return { rows: [], changes: 1 };
    }

    if (norm.startsWith("UPDATE deletion_jobs SET state = ?, started_at")) {
      const [state, startedAt, id, owner] = bindings as [string, string, string, string];
      const job = jobs.get(id);
      if (!job || job.lease_owner !== owner) return { rows: [], changes: 0 };
      job.state = state;
      job.started_at = job.started_at ?? startedAt;
      return { rows: [], changes: 1 };
    }

    if (norm.startsWith("UPDATE deletion_jobs SET state = ?, residuals = ?")) {
      const [state, residuals, finishedAt, id, owner] = bindings as [
        string,
        string,
        string,
        string,
        string,
      ];
      const job = jobs.get(id);
      if (!job || job.lease_owner !== owner) return { rows: [], changes: 0 };
      job.state = state;
      job.residuals = residuals;
      job.finished_at = finishedAt;
      job.lease_owner = null;
      job.lease_expires_at = null;
      return { rows: [], changes: 1 };
    }

    if (norm.startsWith("SELECT * FROM deletion_jobs WHERE state IN")) {
      const staleBefore = bindings[0] as string;
      const rows = [...jobs.values()]
        .filter(
          (job) =>
            UNFINISHED_STATES.has(job.state) &&
            (job.heartbeat_at === null || job.heartbeat_at < staleBefore),
        )
        .map((job) => ({ ...job }));
      return { rows, changes: 0 };
    }

    if (norm.startsWith("INSERT INTO audit_log")) {
      audits.push({
        action: bindings[1] as string,
        subject: bindings[4] as string | null,
        detail: bindings[5] as string,
      });
      return { rows: [], changes: 1 };
    }

    return { rows: rowsFor(sql, bindings), changes: 1 };
  }

  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        const { changes } = handle(sql, bindings);
        return { success: true, meta: { changes } };
      },
      all: async <T>() => {
        const { rows } = handle(sql, bindings);
        return { results: rows as T[], success: true, meta: {} };
      },
      first: async <T>() => {
        const { rows } = handle(sql, bindings);
        return (rows[0] ?? null) as T | null;
      },
    };
  }

  return {
    db: { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database,
    jobs,
    audits,
    executed,
  };
}
