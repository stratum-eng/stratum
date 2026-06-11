export interface IssueTableRow {
  id: string;
  project: string;
  number: number;
  title: string;
  body: string | null;
  status: string;
  author_type: string;
  author_id: string;
  linked_change_id: string | null;
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutboxRow {
  id: string;
  type: string;
  project: string;
  payload: string;
}

/**
 * Stateful D1 stub for the issues table, plus a minimal events-outbox sink so
 * the auto-close handler's emitEvent calls can be observed.
 */
export function makeIssuesD1(): {
  db: D1Database;
  issues: IssueTableRow[];
  emittedEvents: OutboxRow[];
} {
  const issues: IssueTableRow[] = [];
  const emittedEvents: OutboxRow[] = [];

  function applyUpdate(sql: string, bindings: unknown[]) {
    // UPDATE issues SET <assignments> WHERE project = ? AND number = ?
    const project = bindings[bindings.length - 2] as string;
    const number = bindings[bindings.length - 1] as number;
    const row = issues.find((r) => r.project === project && r.number === number);
    if (!row) return;

    const assignmentsPart = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE"));
    const assignments = assignmentsPart.split(",").map((a) => a.trim());
    let bindIndex = 0;
    for (const assignment of assignments) {
      const [columnRaw, valueRaw] = assignment.split("=").map((part) => part.trim());
      if (!columnRaw || valueRaw === undefined) continue;
      const value = valueRaw === "NULL" ? null : (bindings[bindIndex++] as never);
      switch (columnRaw) {
        case "updated_at":
          row.updated_at = value as unknown as string;
          break;
        case "title":
          row.title = value as unknown as string;
          break;
        case "body":
          row.body = value;
          break;
        case "status":
          row.status = value as unknown as string;
          break;
        case "linked_change_id":
          row.linked_change_id = value;
          break;
        case "closed_at":
          row.closed_at = value;
          break;
        case "closed_by":
          row.closed_by = value;
          break;
      }
    }
  }

  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase().replace(/\s+/g, " ");
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (upper.startsWith("UPDATE ISSUES SET")) {
          applyUpdate(sql.replace(/\s+/g, " "), bindings);
        } else if (upper.startsWith("INSERT INTO EVENTS")) {
          emittedEvents.push({
            id: bindings[0] as string,
            type: bindings[1] as string,
            project: bindings[2] as string,
            payload: bindings[5] as string,
          });
        }
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        if (upper.startsWith("INSERT INTO ISSUES")) {
          // VALUES (?1, ?2, (SELECT COALESCE(MAX(number),0)+1 ...), ?3..?8) RETURNING *
          const project = bindings[1] as string;
          const number =
            issues
              .filter((r) => r.project === project)
              .reduce((max, r) => Math.max(max, r.number), 0) + 1;
          const row: IssueTableRow = {
            id: bindings[0] as string,
            project,
            number,
            title: bindings[2] as string,
            body: bindings[3] as string | null,
            status: "open",
            author_type: bindings[4] as string,
            author_id: bindings[5] as string,
            linked_change_id: bindings[6] as string | null,
            closed_at: null,
            closed_by: null,
            created_at: bindings[7] as string,
            updated_at: bindings[7] as string,
          };
          issues.push(row);
          return row as T;
        }
        if (upper.includes("FROM ISSUES WHERE PROJECT = ? AND NUMBER = ?")) {
          return (issues.find((r) => r.project === bindings[0] && r.number === bindings[1]) ??
            null) as T | null;
        }
        return null;
      },
      all: async <T>() => {
        let results: IssueTableRow[] = [];
        if (upper.includes("WHERE LINKED_CHANGE_ID = ? AND STATUS = 'OPEN'")) {
          results = issues.filter((r) => r.linked_change_id === bindings[0] && r.status === "open");
        } else if (upper.includes("WHERE PROJECT = ? AND STATUS = ?")) {
          results = issues
            .filter((r) => r.project === bindings[0] && r.status === bindings[1])
            .sort((a, b) => b.number - a.number);
        } else if (upper.includes("FROM ISSUES WHERE PROJECT = ?")) {
          results = issues
            .filter((r) => r.project === bindings[0])
            .sort((a, b) => b.number - a.number);
        }
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
  return { db, issues, emittedEvents };
}
