import { describe, expect, it, vi } from "vitest";
import { listChanges } from "../src/storage/changes";
import type { Logger } from "../src/utils/logger";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

/** A changes row with every optional column defaulted to null. */
function row(id: string, project: string, projectId: string | null, status = "open") {
  const nulls: Record<string, unknown> = {};
  for (const col of [
    "agent_id",
    "eval_score",
    "eval_passed",
    "eval_reason",
    "base_sha",
    "evaluated_sha",
    "evaluated_tree_oid",
    "agent_model",
    "agent_prompt_hash",
    "workspace_head_sha",
    "merged_at",
    "github_owner",
    "github_repo",
    "github_branch",
    "github_pr_number",
    "github_pr_url",
    "github_pr_state",
    "github_head_sha",
    "github_comment_id",
    "promoted_at",
    "promoted_by",
  ]) {
    nulls[col] = null;
  }
  return {
    id,
    project,
    project_id: projectId,
    workspace: "ws",
    status,
    created_at: "2026-07-20T00:00:00Z",
    ...nulls,
  };
}

/** Fake D1 that honors the project_id-scoped / name-only SELECT shapes. */
function makeChangesD1(rows: ReturnType<typeof row>[]) {
  function makeStmt(sql: string, binds: unknown[]) {
    const upper = sql.trim().toUpperCase().replace(/\s+/g, " ");
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      first: async () => null,
      run: async () => ({ success: true, meta: {} }),
      all: async () => {
        let results = rows;
        if (upper.includes("PROJECT_ID = ? OR")) {
          const [projectId, project] = binds as [string, string];
          results = results.filter(
            (r) => r.project_id === projectId || (r.project_id === null && r.project === project),
          );
          if (upper.includes("AND STATUS = ?"))
            results = results.filter((r) => r.status === binds[2]);
        } else if (upper.includes("WHERE PROJECT = ?")) {
          results = results.filter((r) => r.project === binds[0]);
          if (upper.includes("AND STATUS = ?"))
            results = results.filter((r) => r.status === binds[1]);
        }
        if (upper.includes("LIMIT ?")) {
          results = results.slice(0, binds[binds.length - 1] as number);
        }
        return { results, success: true, meta: {} };
      },
    };
  }
  return { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
}

describe("listChanges tenant isolation (project_id-scoped)", () => {
  it("returns only the queried project's changes for a same-named collision", async () => {
    const db = makeChangesD1([row("chg_a", "acme", "proj_A"), row("chg_b", "acme", "proj_B")]);

    const a = await listChanges(db, logger, "acme", undefined, { projectId: "proj_A" });
    const b = await listChanges(db, logger, "acme", undefined, { projectId: "proj_B" });

    expect(a.success && a.data.map((c) => c.id)).toEqual(["chg_a"]);
    expect(b.success && b.data.map((c) => c.id)).toEqual(["chg_b"]);
  });

  it("keeps legacy NULL-project_id rows reachable via the name fallback", async () => {
    const db = makeChangesD1([row("chg_legacy", "acme", null)]);

    const scoped = await listChanges(db, logger, "acme", undefined, { projectId: "proj_new" });

    expect(scoped.success && scoped.data.map((c) => c.id)).toEqual(["chg_legacy"]);
  });

  it("applies the limit when one is given (bounds the response)", async () => {
    const db = makeChangesD1([
      row("c1", "acme", "proj_A"),
      row("c2", "acme", "proj_A"),
      row("c3", "acme", "proj_A"),
    ]);

    const capped = await listChanges(db, logger, "acme", undefined, {
      projectId: "proj_A",
      limit: 2,
    });
    expect(capped.success && capped.data).toHaveLength(2);
  });

  it("without a projectId, falls back to the legacy name-only match", async () => {
    const db = makeChangesD1([row("chg_a", "acme", "proj_A"), row("chg_other", "other", "proj_B")]);

    const result = await listChanges(db, logger, "acme");

    expect(result.success && result.data.map((c) => c.id)).toEqual(["chg_a"]);
  });
});
