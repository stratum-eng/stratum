export interface EventRow {
  id: string;
  type: string;
  project: string;
  project_id: string | null;
  actor_type: string;
  actor_id: string | null;
  payload: string;
  status: string;
  attempts: number;
  created_at: string;
  processed_at: string | null;
}

/** Minimal stateful D1 stub understanding the queries events storage issues. */
export function makeEventsD1(): { db: D1Database; rows: EventRow[] } {
  const rows: EventRow[] = [];

  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    // Queries against other tables (e.g. webhooks, issued by other event
    // handlers) get an empty result instead of misreading event rows.
    const isEventsTable = /\b(FROM|INTO|UPDATE)\s+EVENTS\b/.test(upper);
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (!isEventsTable) return { success: true, meta: {} };
        if (upper.startsWith("INSERT INTO EVENTS")) {
          rows.push({
            id: bindings[0] as string,
            type: bindings[1] as string,
            project: bindings[2] as string,
            project_id: bindings[3] as string | null,
            actor_type: bindings[4] as string,
            actor_id: bindings[5] as string | null,
            payload: bindings[6] as string,
            status: "pending",
            attempts: 0,
            created_at: bindings[7] as string,
            processed_at: null,
          });
        } else if (upper.includes("SET STATUS = 'PROCESSED'")) {
          const row = rows.find((r) => r.id === bindings[1]);
          if (row) {
            row.status = "processed";
            row.processed_at = bindings[0] as string;
          }
        } else if (upper.includes("SET STATUS = 'FAILED'")) {
          const row = rows.find((r) => r.id === bindings[1]);
          if (row) {
            row.status = "failed";
            row.processed_at = bindings[0] as string;
          }
        } else if (upper.includes("SET ATTEMPTS = ATTEMPTS + 1")) {
          const row = rows.find((r) => r.id === bindings[0]);
          if (row) row.attempts += 1;
        }
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        if (!isEventsTable) return null;
        return (rows.find((r) => r.id === bindings[0]) ?? null) as T | null;
      },
      all: async <T>() => {
        if (!isEventsTable) return { results: [] as T[], success: true, meta: {} };
        let results: EventRow[];
        if (upper.includes("WHERE PROJECT = ?")) {
          results = rows
            .filter((r) => r.project === bindings[0])
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, bindings[1] as number);
        } else if (upper.includes("WHERE STATUS = 'PENDING' AND CREATED_AT < ?")) {
          results = rows
            .filter((r) => r.status === "pending" && r.created_at < (bindings[0] as string))
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .slice(0, bindings[1] as number);
        } else {
          results = [...rows]
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, bindings[0] as number);
        }
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
  return { db, rows };
}
