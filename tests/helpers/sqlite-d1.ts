/// <reference types="vite/client" />
import { DatabaseSync } from "node:sqlite";

/**
 * A D1Database backed by a REAL SQLite engine (node:sqlite) with every
 * production migration applied. Unlike the hand-rolled string-matching stubs,
 * this executes the storage layer's actual SQL — LIKE escaping, subqueries,
 * LIMIT/OFFSET, ON CONFLICT — against the real schema, so tests fail when the
 * SQL is wrong rather than when a stub's regex is.
 *
 * SQL is loaded via Vite's raw glob (not node:fs) so the helper type-checks
 * under the Workers tsconfig; node:sqlite is typed by tests/node-sqlite.d.ts.
 */
const migrationModules = import.meta.glob("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface WrappedStmt {
  bind(...args: unknown[]): WrappedStmt;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: boolean; meta: Record<string, never> }>;
}

export function makeSqliteD1(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const migrations = Object.entries(migrationModules)
    .map(([path, sql]) => [path.split("/").pop() ?? path, sql] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, sql] of migrations) raw.exec(sql);

  function makeStmt(sql: string, binds: unknown[]): WrappedStmt {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        const result = raw.prepare(sql).run(...binds);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      first: async <T>() => (raw.prepare(sql).get(...binds) ?? null) as T | null,
      all: async <T>() => ({
        results: raw.prepare(sql).all(...binds) as T[],
        success: true,
        meta: {},
      }),
    };
  }

  const db = {
    prepare: (sql: string) => makeStmt(sql, []),
    batch: async (statements: WrappedStmt[]) => {
      // D1 batches are atomic — mirror that with a transaction.
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;

  return { db, raw };
}

/** A D1 stand-in whose every operation throws — for exercising error paths. */
export function makeThrowingD1(message = "boom"): D1Database {
  return {
    prepare: () => {
      throw new Error(message);
    },
    batch: () => {
      throw new Error(message);
    },
  } as unknown as D1Database;
}
