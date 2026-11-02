/**
 * Migration 047 (deployments + project_secrets) as a schema contract.
 *
 * Two of these assertions guard things that fail silently in production if they
 * regress: the unique index IS the mutual exclusion a deploy relies on (drop it
 * and every merge deploys twice), and the deletion cascade is the only thing
 * that ever removes an encrypted provider credential from D1 (drop that and a
 * deleted project's production tokens live forever, reachable by no UI).
 *
 * Constraint violations are asserted through the raw node:sqlite handle rather
 * than the D1 wrapper: the engine throws synchronously there, so a constraint
 * that has silently stopped being enforced cannot be mistaken for a rejected
 * promise from somewhere else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETED_USER_SENTINEL,
  type DeletionTarget,
  anonymizeUserContributions,
  deleteProjectCascade,
} from "../src/storage/deletion";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeArtifactsStub, makeKvStub } from "./helpers/deletion-stubs";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];

beforeEach(() => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  vi.clearAllMocks();
});

const DEPLOYMENT_COLUMNS =
  "id, project_id, project, change_id, commit_sha, name, target, attempt, status, " +
  "requested_by_type, created_at";

function insertDeployment(overrides: Partial<Record<string, unknown>> = {}): void {
  const row = {
    id: "dep_1",
    project_id: "proj_1",
    project: "api",
    change_id: "chg_1",
    commit_sha: "a".repeat(40),
    name: "production",
    target: "vercel",
    attempt: 1,
    status: "queued",
    requested_by_type: "user",
    created_at: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
  raw
    .prepare(
      `INSERT INTO deployments (${DEPLOYMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.project_id,
      row.project,
      row.change_id,
      row.commit_sha,
      row.name,
      row.target,
      row.attempt,
      row.status,
      row.requested_by_type,
      row.created_at,
    );
}

function insertSecret(id: string, projectId: string, name: string): void {
  raw
    .prepare(
      "INSERT INTO project_secrets " +
        "(id, project_id, name, ciphertext, created_by, updated_by, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      projectId,
      name,
      "enc:opaque",
      "usr_1",
      "usr_1",
      "2026-09-04T00:00:00.000Z",
      "2026-09-04T00:00:00.000Z",
    );
}

function objectNames(type: "table" | "index"): Set<string> {
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

describe("migration 047 schema", () => {
  it("creates both tables and every declared index", () => {
    const tables = objectNames("table");
    expect(tables).toContain("deployments");
    expect(tables).toContain("project_secrets");

    const indexes = objectNames("index");
    expect(indexes).toContain("ux_deployments_attempt");
    expect(indexes).toContain("idx_deployments_project");
    expect(indexes).toContain("ux_project_secrets_name");
  });

  it("accepts every status the deployment state machine can write", () => {
    const statuses = [
      "pending_approval",
      "queued",
      "running",
      "succeeded",
      "failed",
      "superseded",
      "skipped",
    ];
    for (const [i, status] of statuses.entries()) {
      expect(() => insertDeployment({ id: `dep_${i}`, attempt: i + 1, status })).not.toThrow();
    }
  });

  it("rejects a status outside the CHECK", () => {
    expect(() => insertDeployment({ status: "in_progress" })).toThrow(/CHECK constraint/i);
  });

  it("rejects a duplicate (project_id, name, commit_sha, attempt)", () => {
    insertDeployment();
    // A different id and change_id: only the four indexed columns matter, which
    // is what makes the insert itself the deploy's mutual exclusion.
    expect(() => insertDeployment({ id: "dep_2", change_id: "chg_2" })).toThrow(
      /UNIQUE constraint/i,
    );
  });

  it("admits a retry of the same commit as a new attempt", () => {
    insertDeployment();
    expect(() => insertDeployment({ id: "dep_2", attempt: 2 })).not.toThrow();
  });

  it("rejects a duplicate secret name within a project but not across projects", () => {
    insertSecret("sec_1", "proj_1", "VERCEL_TOKEN");
    expect(() => insertSecret("sec_2", "proj_1", "VERCEL_TOKEN")).toThrow(/UNIQUE constraint/i);
    expect(() => insertSecret("sec_3", "proj_2", "VERCEL_TOKEN")).not.toThrow();
  });
});

describe("project deletion and migration 047 tables", () => {
  function makeTarget(overrides: Partial<DeletionTarget> = {}): DeletionTarget {
    return {
      projectId: "proj_1",
      namespace: "@alice",
      slug: "api",
      name: "api",
      workspaceNames: [],
      forkRepoNames: [],
      projectRepoName: null,
      changeIds: [],
      webhookIds: [],
      issueIds: [],
      nameCollision: false,
      ...overrides,
    };
  }

  function makeEnv(): Env {
    return {
      DB: db,
      STATE: makeKvStub().kv,
      ARTIFACTS: makeArtifactsStub().artifacts,
    } as Env;
  }

  it("destroys the project's deployments and encrypted secrets", async () => {
    insertDeployment();
    insertSecret("sec_1", "proj_1", "VERCEL_TOKEN");

    const result = await deleteProjectCascade(makeEnv(), makeTarget(), logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.residuals).toEqual([]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM deployments").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM project_secrets").get()).toEqual({ n: 0 });
  });

  it("leaves another project's credentials alone", async () => {
    insertDeployment({ id: "dep_other", project_id: "proj_2", project: "other" });
    insertSecret("sec_other", "proj_2", "VERCEL_TOKEN");

    await deleteProjectCascade(makeEnv(), makeTarget(), logger);

    expect(raw.prepare("SELECT COUNT(*) AS n FROM deployments").get()).toEqual({ n: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM project_secrets").get()).toEqual({ n: 1 });
  });

  // project_secrets has no bare `project` column, so the name-collision branch
  // of the project-scoped delete would be a `no such column` error there. It
  // must still be scoped by project_id — and only by project_id.
  it("still destroys secrets when the project name collides with another tenant's", async () => {
    insertSecret("sec_1", "proj_1", "VERCEL_TOKEN");
    insertSecret("sec_other", "proj_2", "VERCEL_TOKEN");

    const result = await deleteProjectCascade(
      makeEnv(),
      makeTarget({ nameCollision: true }),
      logger,
    );

    expect(result.success).toBe(true);
    const remaining = raw.prepare("SELECT id FROM project_secrets").all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(["sec_other"]);
  });
});

// An org-owned project survives its members' erasure, so these rows outlive the
// account and would otherwise keep naming a deleted user forever.
describe("account erasure and migration 047 tables", () => {
  it("anonymizes the deploy identity columns without touching the rows", async () => {
    insertSecret("sec_1", "proj_1", "VERCEL_TOKEN");
    insertDeployment({ requested_by_type: "user" });
    raw
      .prepare("UPDATE deployments SET requested_by_id = ?, approved_by = ?")
      .run("usr_1", "usr_1");

    const result = await anonymizeUserContributions(db, "usr_1", logger);

    expect(result.success).toBe(true);
    expect(raw.prepare("SELECT created_by, updated_by FROM project_secrets").get()).toEqual({
      created_by: DELETED_USER_SENTINEL,
      updated_by: DELETED_USER_SENTINEL,
    });
    expect(raw.prepare("SELECT requested_by_id, approved_by FROM deployments").get()).toEqual({
      requested_by_id: DELETED_USER_SENTINEL,
      approved_by: DELETED_USER_SENTINEL,
    });
  });
});
