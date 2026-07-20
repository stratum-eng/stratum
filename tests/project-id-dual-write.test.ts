import { describe, expect, it, vi } from "vitest";
import { createChange } from "../src/storage/changes";
import { recordCosts } from "../src/storage/costs";
import { insertEvent } from "../src/storage/events";
import { createIssue } from "../src/storage/issues";
import { type CommitMetricInput, recordCommitMetrics } from "../src/storage/metrics";
import { recordProvenance } from "../src/storage/provenance";
import { createWebhook } from "../src/storage/webhooks";
import type { Logger } from "../src/utils/logger";
import { makeEventsD1 } from "./helpers/events-d1";
import { makeIssuesD1 } from "./helpers/issues-d1";
import { makeWebhooksD1 } from "./helpers/webhooks-d1";

// Project-identity unification (branch feat/deletion-cascade): each project-scoped
// write must dual-write the globally-unique project.id alongside the legacy name so
// a future cascade-delete can scope by project_id and never cross tenants.

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

interface Capture {
  columns: string[];
  bindings: unknown[];
}

/** Records the INSERT column list + bindings for each write, so a test can
 *  assert exactly which value landed in the project_id column. Column names come
 *  from the SQL itself, so index-shift bugs cannot mask a wrong binding. */
function makeCapturingD1(): { db: D1Database; captures: Capture[] } {
  const captures: Capture[] = [];

  function parseColumns(sql: string): string[] {
    const match = sql.match(/INSERT( OR IGNORE)? INTO \w+\s*\(([^)]*)\)/i);
    if (!match?.[2]) return [];
    return match[2].split(",").map((c) => c.trim());
  }

  function makeStmt(sql: string, bindings: unknown[]) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      run: async () => {
        if (/^\s*INSERT( OR IGNORE)? INTO/i.test(sql)) {
          captures.push({ columns: parseColumns(sql), bindings });
        }
        return { success: true, meta: {} };
      },
      first: async () => null,
      all: async () => ({ results: [], success: true, meta: {} }),
    };
  }

  const db = {
    prepare: (sql: string) => makeStmt(sql, []),
    batch: async (statements: Array<{ run(): Promise<unknown> }>) =>
      Promise.all(statements.map((s) => s.run())),
  } as unknown as D1Database;
  return { db, captures };
}

/** Read the value bound to a named column of a captured INSERT. */
function boundValue(capture: Capture | undefined, column: string): unknown {
  if (!capture) throw new Error("no INSERT captured");
  const idx = capture.columns.indexOf(column);
  if (idx === -1) throw new Error(`column ${column} not in INSERT: ${capture.columns.join(", ")}`);
  return capture.bindings[idx];
}

describe("project_id dual-write", () => {
  it("createChange persists project_id when provided and round-trips projectId", async () => {
    const { db, captures } = makeCapturingD1();
    const result = await createChange(db, mockLogger, {
      project: "api",
      projectId: "proj_abc",
      workspace: "ws-1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projectId).toBe("proj_abc");
    expect(boundValue(captures[0], "project_id")).toBe("proj_abc");
  });

  it("createChange binds NULL project_id when omitted (backward compatible)", async () => {
    const { db, captures } = makeCapturingD1();
    const result = await createChange(db, mockLogger, { project: "api", workspace: "ws-1" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projectId).toBeUndefined();
    expect(boundValue(captures[0], "project_id")).toBeNull();
  });

  it("recordProvenance persists project_id and round-trips projectId", async () => {
    const { db, captures } = makeCapturingD1();
    const result = await recordProvenance(db, mockLogger, {
      commitSha: "sha1",
      project: "api",
      projectId: "proj_abc",
      workspace: "ws-1",
      changeId: "chg_1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projectId).toBe("proj_abc");
    expect(boundValue(captures[0], "project_id")).toBe("proj_abc");
  });

  it("recordCosts persists project_id for each sample", async () => {
    const { db, captures } = makeCapturingD1();
    const result = await recordCosts(
      db,
      mockLogger,
      { project: "api", projectId: "proj_abc", changeId: "chg_1" },
      [{ kind: "git_ops", quantity: 1 }],
    );
    expect(result.success).toBe(true);
    expect(boundValue(captures[0], "project_id")).toBe("proj_abc");
  });

  it("recordCommitMetrics persists project_id", async () => {
    const { db, captures } = makeCapturingD1();
    const metric: CommitMetricInput = {
      project: "api",
      projectId: "proj_abc",
      changeId: "chg_1",
      outcome: "fast_forward",
      phases: {},
      totalMs: 10,
    };
    const result = await recordCommitMetrics(db, metric, mockLogger);
    expect(result.success).toBe(true);
    expect(boundValue(captures[0], "project_id")).toBe("proj_abc");
  });

  it("createIssue persists project_id and round-trips projectId", async () => {
    const { db, issues } = makeIssuesD1();
    const result = await createIssue(db, mockLogger, {
      project: "api",
      projectId: "proj_abc",
      title: "Bug",
      authorType: "user",
      authorId: "user_1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projectId).toBe("proj_abc");
    expect(issues[0]?.project_id).toBe("proj_abc");
  });

  it("createWebhook persists project_id and round-trips projectId", async () => {
    const { db, webhooks } = makeWebhooksD1();
    const result = await createWebhook(db, mockLogger, {
      project: "api",
      projectId: "proj_abc",
      url: "https://example.com/hook",
      createdBy: "user_1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projectId).toBe("proj_abc");
    expect(webhooks[0]?.project_id).toBe("proj_abc");
  });

  it("insertEvent persists project_id and round-trips projectId", async () => {
    const { db, rows } = makeEventsD1();
    const result = await insertEvent(db, mockLogger, {
      type: "change.created",
      project: "api",
      projectId: "proj_abc",
      actorType: "user",
      actorId: "user_1",
      payload: { changeId: "chg_1" },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.projectId).toBe("proj_abc");
    expect(rows[0]?.project_id).toBe("proj_abc");
  });

  it("two same-name projects in different namespaces get DISTINCT project_id on their changes", async () => {
    // @alice/api and @bob/api collide on the bare name "api"; the whole point of
    // project_id is that their changes stay distinguishable for cascade-delete.
    const { db, captures } = makeCapturingD1();

    const alice = await createChange(db, mockLogger, {
      project: "api",
      projectId: "proj_alice",
      workspace: "ws-a",
    });
    expect(alice.success).toBe(true);
    const aliceProjectId = boundValue(captures[0], "project_id");

    const bob = await createChange(db, mockLogger, {
      project: "api",
      projectId: "proj_bob",
      workspace: "ws-b",
    });
    expect(bob.success).toBe(true);
    const bobProjectId = boundValue(captures[1], "project_id");

    // Same name, but the tenant-scoping id differs — the cross-tenant fix.
    expect(alice.success && bob.success && alice.data.project === bob.data.project).toBe(true);
    expect(aliceProjectId).toBe("proj_alice");
    expect(bobProjectId).toBe("proj_bob");
    expect(aliceProjectId).not.toBe(bobProjectId);
  });
});
