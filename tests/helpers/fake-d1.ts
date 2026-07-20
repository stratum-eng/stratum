/**
 * Minimal in-memory D1 fake supporting exactly the two query shapes the backup
 * code uses: keyset-paginated `SELECT rowid AS __rowid, * FROM t WHERE rowid > ?
 * ORDER BY rowid LIMIT ?` and multi-row `INSERT INTO t (cols) VALUES (...)`.
 * Rows are stored with an auto-incrementing rowid per table.
 */
type Row = Record<string, unknown>;

export function makeFakeD1(): D1Database & {
  seed: (table: string, rows: Row[]) => void;
  rows: (table: string) => Row[];
} {
  const tables = new Map<string, { rowid: number; data: Row }[]>();

  function tbl(name: string) {
    let t = tables.get(name);
    if (!t) {
      t = [];
      tables.set(name, t);
    }
    return t;
  }

  function prepare(sql: string) {
    let binds: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        binds = args;
        return stmt;
      },
      async run() {
        // Upsert (backup cursor): INSERT ... VALUES (?, ?) ON CONFLICT(col) DO UPDATE ...
        const upsert = sql.match(
          /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]*)\) ON CONFLICT\((\w+)\) DO UPDATE/i,
        );
        if (upsert) {
          const [, name, colList, , conflictCol] = upsert;
          const cols = (colList as string).split(",").map((c) => c.trim());
          const data: Row = {};
          cols.forEach((col, i) => {
            data[col] = binds[i];
          });
          const t = tbl(name as string);
          const existing = t.find(
            (r) => r.data[conflictCol as string] === data[conflictCol as string],
          );
          if (existing) existing.data = { ...existing.data, ...data };
          else t.push({ rowid: (t[t.length - 1]?.rowid ?? 0) + 1, data });
          return { success: true, meta: { changes: 1 } };
        }
        const insert = sql.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES (.+)$/i);
        if (insert) {
          const [, name, colList, valuesClause] = insert;
          const cols = (colList as string).split(",").map((c) => c.trim());
          const groups = (valuesClause as string).match(/\([^)]*\)/g) ?? [];
          const t = tbl(name as string);
          let b = 0;
          for (let g = 0; g < groups.length; g++) {
            const data: Row = {};
            for (const col of cols) data[col] = binds[b++];
            const rowid = (t[t.length - 1]?.rowid ?? 0) + 1;
            t.push({ rowid, data });
          }
          return { success: true, meta: { changes: groups.length } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      async all<T = Row>() {
        // Full-table read (backup cursor): SELECT cols FROM t   (no WHERE)
        const selAll = sql.match(/^SELECT .+ FROM (\w+)\s*$/i);
        if (selAll) {
          const results = tbl(selAll[1] as string).map((r) => ({ ...r.data }));
          return { results: results as T[], success: true, meta: {} };
        }
        const sel = sql.match(/FROM (\w+) WHERE rowid > \? ORDER BY rowid LIMIT \?/i);
        if (sel) {
          const name = sel[1] as string;
          const afterRowid = binds[0] as number;
          const limit = binds[1] as number;
          const results = tbl(name)
            .filter((r) => r.rowid > afterRowid)
            .sort((a, b2) => a.rowid - b2.rowid)
            .slice(0, limit)
            .map((r) => ({ __rowid: r.rowid, ...r.data }));
          return { results: results as T[], success: true, meta: {} };
        }
        return { results: [] as T[], success: true, meta: {} };
      },
      async first<T = Row>() {
        const r = await stmt.all<T>();
        return (r.results[0] ?? null) as T | null;
      },
    };
    return stmt;
  }

  return {
    prepare,
    seed(table: string, rows: Row[]) {
      const t = tbl(table);
      for (const data of rows) t.push({ rowid: (t[t.length - 1]?.rowid ?? 0) + 1, data });
    },
    rows(table: string) {
      return tbl(table).map((r) => r.data);
    },
  } as unknown as D1Database & { seed: (t: string, r: Row[]) => void; rows: (t: string) => Row[] };
}
