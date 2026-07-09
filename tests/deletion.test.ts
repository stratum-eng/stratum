import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeletionTarget,
  captureDeletionTarget,
  deleteProjectCascade,
  verifyProjectDeleted,
} from "../src/storage/deletion";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import {
  type ExecutedStatement,
  makeArtifactsStub,
  makeDoNamespaceStub,
  makeKvStub,
  makeRecordingD1,
} from "./helpers/deletion-stubs";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const REMOTE = "https://acct.artifacts.cloudflare.net/git/@alice/alice__api.git";

function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "proj_1",
    name: "api",
    slug: "api",
    namespace: "@alice",
    ownerId: "user_1",
    ownerType: "user",
    remote: REMOTE,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTarget(overrides: Partial<DeletionTarget> = {}): DeletionTarget {
  return {
    projectId: "proj_1",
    namespace: "@alice",
    slug: "api",
    name: "api",
    workspaceNames: ["ws-a"],
    forkRepoNames: ["ws-a-fork"],
    projectRepoName: "alice__api",
    changeIds: ["chg_1", "chg_2"],
    webhookIds: ["wh_1"],
    nameCollision: false,
    ...overrides,
  };
}

function makeEnv(parts: {
  db: D1Database;
  kv: KVNamespace;
  artifacts?: Env["ARTIFACTS"];
  repoDo?: DurableObjectNamespace;
  mergeQueue?: DurableObjectNamespace;
}): Env {
  return {
    DB: parts.db,
    STATE: parts.kv,
    ARTIFACTS: parts.artifacts ?? makeArtifactsStub().artifacts,
    REPO_DO: parts.repoDo,
    MERGE_QUEUE: parts.mergeQueue,
  } as Env;
}

function sqlIndex(executed: ExecutedStatement[], fragment: string): number {
  return executed.findIndex((stmt) => stmt.sql.includes(fragment));
}

describe("captureDeletionTarget", () => {
  it("captures identifiers, paginated fork list, and FK id-sets", async () => {
    const { db, executed } = makeRecordingD1((sql) => {
      if (sql.includes("FROM changes")) return [{ id: "chg_1" }, { id: "chg_2" }];
      if (sql.includes("FROM webhooks")) return [{ id: "wh_1" }];
      return [];
    });
    // pageSize 2 with 3 workspaces forces a second list page — a capture that
    // doesn't loop the cursor would miss ws-c.
    const kvStub = makeKvStub(2);
    for (const ws of ["ws-a", "ws-b", "ws-c"]) {
      kvStub.store.set(
        `workspace:proj_1:${ws}`,
        JSON.stringify({
          name: ws,
          remote: `https://acct.artifacts.cloudflare.net/git/@alice/${ws}-fork.git`,
          parent: "api",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    const project = makeProject();
    kvStub.store.set("project:@alice:api", JSON.stringify(project));

    const result = await captureDeletionTarget(makeEnv({ db, kv: kvStub.kv }), project, mockLogger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const target = result.data;
    expect(target.projectId).toBe("proj_1");
    expect(target.namespace).toBe("@alice");
    expect(target.slug).toBe("api");
    expect(target.name).toBe("api");
    expect(target.workspaceNames.sort()).toEqual(["ws-a", "ws-b", "ws-c"]);
    expect(target.forkRepoNames.sort()).toEqual(["ws-a-fork", "ws-b-fork", "ws-c-fork"]);
    expect(target.projectRepoName).toBe("alice__api");
    expect(target.changeIds).toEqual(["chg_1", "chg_2"]);
    expect(target.webhookIds).toEqual(["wh_1"]);
    expect(target.nameCollision).toBe(false);

    // The id capture must cover historical NULL-project_id rows by name.
    const changeSelect = executed.find((stmt) => stmt.sql.includes("SELECT id FROM changes"));
    expect(changeSelect?.sql).toContain("project_id = ? OR (project_id IS NULL AND project = ?)");
    expect(changeSelect?.bindings).toEqual(["proj_1", "api"]);
  });

  it("flags a collision when another namespace has the same slug", async () => {
    const { db } = makeRecordingD1();
    const kvStub = makeKvStub();
    const project = makeProject();
    kvStub.store.set("project:@alice:api", JSON.stringify(project));
    kvStub.store.set(
      "project:@bob:api",
      JSON.stringify(makeProject({ id: "proj_2", namespace: "@bob" })),
    );

    const result = await captureDeletionTarget(makeEnv({ db, kv: kvStub.kv }), project, mockLogger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nameCollision).toBe(true);
  });

  it("under a collision, FK-child id capture is scoped to project_id ONLY (no bare name)", async () => {
    // Regression: the name-form capture would otherwise scoop the OTHER tenant's
    // NULL-project_id change/webhook ids, whose FK children would then be deleted.
    const { db, executed } = makeRecordingD1((sql) => {
      if (sql.includes("FROM changes")) return [{ id: "chg_mine" }];
      if (sql.includes("FROM webhooks")) return [];
      return [];
    });
    const kvStub = makeKvStub();
    const project = makeProject();
    kvStub.store.set("project:@alice:api", JSON.stringify(project));
    kvStub.store.set(
      "project:@bob:api",
      JSON.stringify(makeProject({ id: "proj_2", namespace: "@bob" })),
    );

    const result = await captureDeletionTarget(makeEnv({ db, kv: kvStub.kv }), project, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nameCollision).toBe(true);

    const changeSelect = executed.find((stmt) => stmt.sql.includes("SELECT id FROM changes"));
    // Must NOT include the name-form OR clause, and must bind project_id only.
    expect(changeSelect?.sql).not.toContain("project = ?");
    expect(changeSelect?.bindings).toEqual(["proj_1"]);
  });
});

describe("deleteProjectCascade", () => {
  let kvStub: ReturnType<typeof makeKvStub>;

  beforeEach(() => {
    kvStub = makeKvStub(2);
    kvStub.store.set("workspace:proj_1:ws-a", JSON.stringify({ name: "ws-a" }));
    kvStub.store.set("repo_snapshot:%40alice:api", "{}");
    kvStub.store.set("sync-status:@alice:api", "{}");
    kvStub.store.set("policy:proj_1", "{}");
    kvStub.store.set("project:@alice:api", "{}");
    kvStub.store.set("project:api", "{}");
  });

  it("deletes FK children before their parents", async () => {
    const { db, executed } = makeRecordingD1();
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv }),
      makeTarget(),
      mockLogger,
    );

    expect(result.success).toBe(true);
    const evalRuns = sqlIndex(executed, "DELETE FROM eval_runs");
    const comments = sqlIndex(executed, "DELETE FROM change_comments");
    const reviews = sqlIndex(executed, "DELETE FROM change_reviews");
    const deliveries = sqlIndex(executed, "DELETE FROM webhook_deliveries");
    const changes = sqlIndex(executed, "DELETE FROM changes");
    const webhooks = sqlIndex(executed, "DELETE FROM webhooks");
    for (const child of [evalRuns, comments, reviews, deliveries]) {
      expect(child).toBeGreaterThanOrEqual(0);
      expect(child).toBeLessThan(changes);
      expect(child).toBeLessThan(webhooks);
    }
  });

  it("chunks child IN-lists at 50 ids", async () => {
    const { db, executed } = makeRecordingD1();
    const changeIds = Array.from({ length: 120 }, (_, i) => `chg_${i}`);
    await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv }),
      makeTarget({ changeIds }),
      mockLogger,
    );

    const evalDeletes = executed.filter((stmt) => stmt.sql.startsWith("DELETE FROM eval_runs"));
    expect(evalDeletes).toHaveLength(3);
    expect(evalDeletes[0]?.bindings).toHaveLength(50);
    expect(evalDeletes[2]?.bindings).toHaveLength(20);
  });

  it("scopes by project_id plus name-form when there is no collision", async () => {
    const { db, executed } = makeRecordingD1();
    await deleteProjectCascade(makeEnv({ db, kv: kvStub.kv }), makeTarget(), mockLogger);

    const changesDelete = executed.find((stmt) => stmt.sql.startsWith("DELETE FROM changes"));
    expect(changesDelete?.sql).toContain("project_id = ? OR (project_id IS NULL AND project = ?)");
    expect(changesDelete?.bindings).toEqual(["proj_1", "api"]);
  });

  it("never name-deletes under a collision: NULL-id rows are skipped and reported", async () => {
    const { db, executed } = makeRecordingD1((sql) => {
      // Another tenant's historical rows share the bare name.
      if (sql.includes("COUNT(*)") && sql.includes("FROM changes")) return [{ n: 2 }];
      return [{ n: 0 }];
    });
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv }),
      makeTarget({ nameCollision: true }),
      mockLogger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals).toContain("d1:changes:null-id-rows-skipped(name-collision)");
    // Cross-tenant guard: no DELETE may match rows by bare name.
    const deletes = executed.filter((stmt) => stmt.sql.startsWith("DELETE"));
    for (const stmt of deletes) {
      expect(stmt.sql).not.toContain("project = ?");
    }
    const changesDelete = deletes.find((stmt) => stmt.sql.startsWith("DELETE FROM changes"));
    expect(changesDelete?.bindings).toEqual(["proj_1"]);
  });

  it("tolerates not-found Artifacts deletes", async () => {
    const { db } = makeRecordingD1();
    const artifactsStub = makeArtifactsStub(() => {
      throw new Error("repo not found");
    });
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv, artifacts: artifactsStub.artifacts }),
      makeTarget(),
      mockLogger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals).toEqual([]);
    // Already-gone is success on the first attempt; no retries.
    expect(artifactsStub.attempts).toEqual(["ws-a-fork", "alice__api"]);
  });

  it("retries a failing Artifacts delete 3 times then records a residual", async () => {
    const { db } = makeRecordingD1();
    const artifactsStub = makeArtifactsStub((name) => {
      if (name === "alice__api") throw new Error("upstream 500");
    });
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv, artifacts: artifactsStub.artifacts }),
      makeTarget(),
      mockLogger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals).toContain("artifacts:alice__api");
    expect(artifactsStub.attempts.filter((n) => n === "alice__api")).toHaveLength(3);
    // The fork still deleted fine.
    expect(artifactsStub.deleted).toContain("ws-a-fork");
  });

  it("purges the RepoDO by project id and the MergeQueue by its name conventions", async () => {
    const { db } = makeRecordingD1();
    const repoDo = makeDoNamespaceStub();
    const mergeQueue = makeDoNamespaceStub();
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv, repoDo: repoDo.ns, mergeQueue: mergeQueue.ns }),
      makeTarget({ name: "api-display", slug: "api" }),
      mockLogger,
    );

    expect(result.success).toBe(true);
    expect(repoDo.purged).toEqual(["proj_1"]);
    // change.project historically holds the bare name OR the id.
    expect(mergeQueue.purged.sort()).toEqual(["api", "api-display", "proj_1"]);
  });

  it("under a collision, purges only the project_id-keyed MergeQueue DO", async () => {
    const { db } = makeRecordingD1();
    const repoDo = makeDoNamespaceStub();
    const mergeQueue = makeDoNamespaceStub();
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv, repoDo: repoDo.ns, mergeQueue: mergeQueue.ns }),
      makeTarget({ nameCollision: true }),
      mockLogger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Name/slug forms are shared with the other tenant → not purged, reported.
    expect(mergeQueue.purged).toEqual(["proj_1"]);
    expect(result.data.residuals).toContain("do:MergeQueue:name-forms-skipped(name-collision)");
  });

  it("handles an empty target (no workspaces/changes/webhooks) without IN ()", async () => {
    const { db, executed } = makeRecordingD1();
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv }),
      makeTarget({ workspaceNames: [], forkRepoNames: [], changeIds: [], webhookIds: [] }),
      mockLogger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals).toEqual([]);
    // No child-table DELETE should be emitted for empty id-sets (no `IN ()`).
    const childDeletes = executed.filter(
      (s) => /DELETE FROM (eval_runs|change_comments|change_reviews|webhook_deliveries)/.test(s.sql),
    );
    expect(childDeletes).toHaveLength(0);
    expect(executed.some((s) => s.sql.includes("IN ()"))).toBe(false);
  });

  it("treats absent DO bindings as a no-op", async () => {
    const { db } = makeRecordingD1();
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv }),
      makeTarget(),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals).toEqual([]);
  });

  it("deletes the KV project entry last", async () => {
    const { db } = makeRecordingD1();
    // Extra workspaces to force paginated listing during the KV step.
    kvStub.store.set("workspace:proj_1:ws-b", JSON.stringify({ name: "ws-b" }));
    kvStub.store.set("workspace:proj_1:ws-c", JSON.stringify({ name: "ws-c" }));
    const result = await deleteProjectCascade(
      makeEnv({ db, kv: kvStub.kv }),
      makeTarget(),
      mockLogger,
    );

    expect(result.success).toBe(true);
    const order = kvStub.deletedKeys;
    const projectIdx = order.indexOf("project:@alice:api");
    const legacyIdx = order.indexOf("project:api");
    expect(projectIdx).toBe(order.length - 2);
    expect(legacyIdx).toBe(order.length - 1);
    for (const key of order.slice(0, projectIdx)) {
      expect(key.startsWith("project:")).toBe(false);
    }
    expect(order.filter((k) => k.startsWith("workspace:proj_1:"))).toHaveLength(3);
    expect(kvStub.store.size).toBe(0);
  });

  it("is idempotent: a re-run over already-deleted state succeeds cleanly", async () => {
    const { db } = makeRecordingD1();
    const env = makeEnv({ db, kv: kvStub.kv });
    const first = await deleteProjectCascade(env, makeTarget(), mockLogger);
    const second = await deleteProjectCascade(env, makeTarget(), mockLogger);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.residuals).toEqual([]);
  });
});

describe("verifyProjectDeleted", () => {
  it("returns empty residuals for a clean state", async () => {
    const { db } = makeRecordingD1(() => [{ n: 0 }]);
    const result = await verifyProjectDeleted(
      makeEnv({ db, kv: makeKvStub().kv }),
      makeTarget(),
      mockLogger,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals).toEqual([]);
  });

  it("detects planted D1 rows and KV keys", async () => {
    const { db } = makeRecordingD1((sql) => {
      if (sql.includes("FROM events")) return [{ n: 3 }];
      return [{ n: 0 }];
    });
    const kvStub = makeKvStub();
    kvStub.store.set("workspace:proj_1:ws-straggler", "{}");
    kvStub.store.set("project:@alice:api", "{}");

    const result = await verifyProjectDeleted(
      makeEnv({ db, kv: kvStub.kv }),
      makeTarget(),
      mockLogger,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals).toContain("d1:events:3-rows");
    expect(result.data.residuals).toContain("kv:workspace:proj_1:ws-straggler");
    expect(result.data.residuals).toContain("kv:project:@alice:api");
  });

  it("omits the name-form query under a collision", async () => {
    const { db, executed } = makeRecordingD1(() => [{ n: 0 }]);
    await verifyProjectDeleted(
      makeEnv({ db, kv: makeKvStub().kv }),
      makeTarget({ nameCollision: true }),
      mockLogger,
    );

    const scoped = executed.filter(
      (stmt) => stmt.sql.includes("COUNT(*)") && stmt.sql.includes("project_id = ?"),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const stmt of scoped) {
      expect(stmt.sql).not.toContain("project = ?");
    }
  });
});
