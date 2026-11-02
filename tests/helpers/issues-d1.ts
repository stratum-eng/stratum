export interface IssueTableRow {
  id: string;
  project: string;
  project_id: string | null;
  number: number;
  title: string;
  body: string | null;
  status: string;
  author_type: string;
  author_id: string;
  assignee: string | null;
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
  project_id: string | null;
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

  // Mirror the storage predicate: match the canonical project_id, or fall back to
  // the name only for legacy rows whose project_id is NULL.
  const matchScope = (r: IssueTableRow, projectId: unknown, project: unknown) =>
    r.project_id === projectId || (r.project_id === null && r.project === project);

  /**
   * Applies a supported issue update to the matching in-memory issue row.
   *
   * @param sql - The SQL update statement describing the assignments and issue scope
   * @param bindings - Values bound to the statement
   */
  function applyUpdate(sql: string, bindings: unknown[]) {
    // UPDATE issues SET <assignments> WHERE (project_id = ? OR (project_id IS NULL
    // AND project = ?)) AND number = ?  — or the legacy name-only WHERE.
    const number = bindings[bindings.length - 1] as number;
    const scoped = /PROJECT_ID = \? OR/i.test(sql);
    const project = bindings[bindings.length - 2] as string;
    const row = scoped
      ? issues.find(
          (r) => matchScope(r, bindings[bindings.length - 3], project) && r.number === number,
        )
      : issues.find((r) => r.project === project && r.number === number);
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
        case "assignee":
          row.assignee = value;
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

  /**
   * Creates a mocked prepared statement for issue and event database operations.
   *
   * @param sql - The SQL statement represented by the mock
   * @param bindings - Values bound to the statement's parameters
   * @returns A statement supporting parameter binding and mocked execution methods
   */
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
            project_id: bindings[3] as string | null,
            payload: bindings[6] as string,
          });
        }
        return { success: true, meta: {} };
      },
      first: async <T>() => {
        if (upper.startsWith("INSERT INTO ISSUES")) {
          // Bind order mirrors `createIssue`'s statement, which uses anonymous
          // `?` placeholders throughout (#340) — so values needed twice are bound
          // twice, and positions 3/4 are the numbering subquery's own copies of
          // project_id/project:
          //
          //   VALUES (?, ?, ?, (SELECT MAX(number)+1 WHERE project_id = ?
          //           OR (project_id IS NULL AND project = ?)), ...) RETURNING *
          //    0: id            1: project      2: project_id
          //    3: project_id    4: project      (numbering subquery)
          //    5: title         6: body         7: author_type
          //    8: author_id     9: linked_change_id
          //   10: created_at   11: updated_at
          const project = bindings[1] as string;
          const projectId = (bindings[2] as string | null) ?? null;
          // Mirror migration 035: number by project_id, with a legacy name fallback.
          // `project_id = ?` is never true when the bound id is NULL (SQL NULL
          // comparison), so a projectId-less create numbers purely by the name
          // fallback.
          const number =
            issues
              .filter(
                (r) =>
                  (projectId !== null && r.project_id === projectId) ||
                  (r.project_id === null && r.project === project),
              )
              .reduce((max, r) => Math.max(max, r.number), 0) + 1;
          const row: IssueTableRow = {
            id: bindings[0] as string,
            project,
            project_id: projectId,
            number,
            title: bindings[5] as string,
            body: bindings[6] as string | null,
            status: "open",
            author_type: bindings[7] as string,
            author_id: bindings[8] as string,
            assignee: null,
            linked_change_id: bindings[9] as string | null,
            closed_at: null,
            closed_by: null,
            created_at: bindings[10] as string,
            updated_at: bindings[11] as string,
          };
          issues.push(row);
          return row as T;
        }
        if (upper.includes("PROJECT_ID = ? OR") && upper.includes("AND NUMBER = ?")) {
          return (issues.find(
            (r) => matchScope(r, bindings[0], bindings[1]) && r.number === bindings[2],
          ) ?? null) as T | null;
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
        } else if (upper.includes("PROJECT_ID = ? OR")) {
          const scoped = issues.filter((r) => matchScope(r, bindings[0], bindings[1]));
          results = (
            upper.includes("AND STATUS = ?")
              ? scoped.filter((r) => r.status === bindings[2])
              : scoped
          ).sort((a, b) => b.number - a.number);
        } else if (upper.includes("WHERE PROJECT = ? AND STATUS = ?")) {
          results = issues
            .filter((r) => r.project === bindings[0] && r.status === bindings[1])
            .sort((a, b) => b.number - a.number);
        } else if (upper.includes("FROM ISSUES WHERE PROJECT = ?")) {
          results = issues
            .filter((r) => r.project === bindings[0])
            .sort((a, b) => b.number - a.number);
        }
        if (upper.includes("LIMIT ?")) {
          results = results.slice(0, bindings[bindings.length - 1] as number);
        }
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }

  const db = { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
  return { db, issues, emittedEvents };
}
