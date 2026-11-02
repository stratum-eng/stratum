/**
 * The creation side of the rename race guard: the namespace claim written to
 * D1 before a project's KV entry, and `confirmOwnerNamespace`, which re-reads
 * the owner afterwards and withdraws the project if the name moved first. The
 * rename side (the UPDATE that refuses while a claim exists) is covered in
 * user-profile-storage.test.ts and account-settings.test.tsx; between them no
 * interleaving leaves a project under a namespace nobody owns. The guard fails
 * closed: an owner that cannot be re-read or a project that cannot be
 * withdrawn is a server error, never a silently kept entry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/storage/users", () => ({ getUser: vi.fn() }));
vi.mock("../src/storage/state", () => ({ deleteProject: vi.fn(), getProjectByPath: vi.fn() }));
vi.mock("../src/storage/deletion", () => ({ captureDeletionTarget: vi.fn() }));
vi.mock("../src/storage/deletion-jobs", () => ({ createDeletionJob: vi.fn() }));

import { captureDeletionTarget } from "../src/storage/deletion";
import { createDeletionJob } from "../src/storage/deletion-jobs";
import {
  CLAIM_GRACE_MS,
  claimNamespace,
  confirmOwnerNamespace,
  ownerHasClaims,
  releaseNamespaceClaim,
} from "../src/storage/project-namespace";
import { deleteProject, getProjectByPath } from "../src/storage/state";
import { getUser } from "../src/storage/users";
import type { ProjectEntry } from "../src/types";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const owner = (username: string) => ({
  success: true as const,
  data: {
    id: "usr_1",
    email: "a@b.com",
    username,
    tokenHash: "h",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
});
const unreadable = { success: false as const, error: new Error("d1") as never };
const deleted = { success: true as const, data: undefined };
const notDeleted = { success: false as const, error: new Error("kv") as never };

/** Bindings the guard touches, with a spy on the Artifacts delete. `db` defaults to an inert stub for tests that never reach a claim. */
function makeEnv(db: D1Database = {} as D1Database) {
  const artifactsDelete = vi.fn(async () => undefined);
  return {
    env: {
      DB: db,
      STATE: {} as KVNamespace,
      ARTIFACTS: { delete: artifactsDelete } as never,
    } as unknown as Env,
    artifactsDelete,
  };
}

const project: ProjectEntry = {
  id: "prj_1",
  name: "proj",
  slug: "proj",
  namespace: "@alice",
  ownerId: "usr_1",
  ownerType: "user",
  remote: "https://artifacts.example.com/repos/alice__proj",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const inventory = {
  success: true as const,
  data: {
    projectId: "prj_1",
    namespace: "@alice",
    slug: "proj",
    name: "proj",
    workspaceNames: [],
    forkRepoNames: [],
    projectRepoName: "alice__proj",
    changeIds: [],
    webhookIds: [],
    issueIds: [],
    nameCollision: false,
  },
};
const scheduled = {
  success: true as const,
  data: { job: { id: "del_1" }, created: true } as never,
};

const aliceProj = { ownerId: "usr_1", namespace: "@alice", slug: "proj" };
const kv = {} as KVNamespace;
const missing = {
  success: false as const,
  error: { statusCode: 404, message: "not found" } as never,
};
const found = { success: true as const, data: { id: "prj_1" } as never };
/** Past the grace window, so every claim written "now" is checked against KV. */
const later = () => Date.now() + CLAIM_GRACE_MS + 1000;

const confirm = (env: ReturnType<typeof makeEnv>["env"]) =>
  confirmOwnerNamespace(env, "usr_1", project, logger);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deleteProject).mockResolvedValue(deleted);
  vi.mocked(captureDeletionTarget).mockResolvedValue(inventory);
  vi.mocked(createDeletionJob).mockResolvedValue(scheduled);
});

describe("confirmOwnerNamespace", () => {
  it("keeps a project whose owner still carries the namespace", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice"));
    const { env } = makeEnv();
    expect((await confirm(env)).success).toBe(true);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("withdraws a project written under a name the owner no longer has", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(409);
    expect(deleteProject).toHaveBeenCalledWith(env.STATE, "@alice", "proj", logger);
    expect(artifactsDelete).toHaveBeenCalledWith("alice__proj");
  });

  it("still withdraws when the backing repository cannot be deleted", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    const { env, artifactsDelete } = makeEnv();
    artifactsDelete.mockRejectedValue(new Error("artifacts down"));
    const result = await confirm(env);
    expect(!result.success && result.error.statusCode).toBe(409);
    expect(deleteProject).toHaveBeenCalled();
  });

  // One failed read must not decide a project's fate; two do, and the answer
  // is to withdraw rather than leave an entry a rename may have stranded.
  it("retries the owner read once and keeps the project when it then matches", async () => {
    vi.mocked(getUser).mockResolvedValueOnce(unreadable).mockResolvedValueOnce(owner("alice"));
    const { env } = makeEnv();
    expect((await confirm(env)).success).toBe(true);
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("withdraws the project and reports a server error when the owner cannot be re-read", async () => {
    vi.mocked(getUser).mockResolvedValue(unreadable);
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(500);
    expect(deleteProject).toHaveBeenCalledTimes(1);
    expect(artifactsDelete).toHaveBeenCalledWith("alice__proj");
  });

  // A read that throws is a failed read, not an unhandled rejection that would
  // leave the project in place with no verdict at all.
  it("treats a read that throws like one that fails, and withdraws after two", async () => {
    vi.mocked(getUser).mockRejectedValue(new Error("D1 exploded"));
    const { env } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(500);
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(deleteProject).toHaveBeenCalledTimes(1);
  });

  it("keeps the project when a thrown first read is followed by a matching one", async () => {
    vi.mocked(getUser)
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(owner("alice"));
    const { env } = makeEnv();
    expect((await confirm(env)).success).toBe(true);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("releases the namespace claim of a withdrawn project", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const { env } = makeEnv(db);
    expect((await confirm(env)).success).toBe(false);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger);
    expect(claims.success && claims.data).toBe(false);
  });

  it("keeps the claim, like the repository, for the scheduled removal", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    vi.mocked(deleteProject).mockResolvedValue(notDeleted);
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const { env } = makeEnv(db);
    expect((await confirm(env)).success).toBe(false);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger);
    expect(claims.success && claims.data).toBe(true);
  });

  // KV first, repository second: a project whose entry cannot be removed is
  // still reachable, so its repository must stay, and someone has to know.
  it("retries the entry delete once, then withdraws normally", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    vi.mocked(deleteProject).mockResolvedValueOnce(notDeleted).mockResolvedValueOnce(deleted);
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(!result.success && result.error.statusCode).toBe(409);
    expect(deleteProject).toHaveBeenCalledTimes(2);
    expect(artifactsDelete).toHaveBeenCalled();
  });

  // An entry that will not go is still reachable, so it is handed to the
  // deletion jobs the sweep re-drives, and the repository stays for that job.
  it("schedules a durable removal, keeping the repository, when the entry cannot be removed", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    vi.mocked(deleteProject).mockResolvedValue(notDeleted);
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(500);
    expect(!result.success && result.error.message).toContain("scheduled");
    expect(artifactsDelete).not.toHaveBeenCalled();
    expect(captureDeletionTarget).toHaveBeenCalledWith(env, project, logger);
    expect(createDeletionJob).toHaveBeenCalledWith(env.DB, logger, {
      kind: "project",
      target: inventory.data,
      targetId: "prj_1",
    });
  });

  it("builds the deletion target from the entry when the inventory cannot be captured", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    vi.mocked(deleteProject).mockResolvedValue(notDeleted);
    vi.mocked(captureDeletionTarget).mockResolvedValue({
      success: false,
      error: new Error("kv down") as never,
    });
    const { env } = makeEnv();
    const result = await confirm(env);
    expect(!result.success && result.error.message).toContain("scheduled");
    expect(createDeletionJob).toHaveBeenCalledWith(
      env.DB,
      logger,
      expect.objectContaining({
        kind: "project",
        targetId: "prj_1",
        target: expect.objectContaining({
          projectId: "prj_1",
          namespace: "@alice",
          slug: "proj",
          projectRepoName: "alice__proj",
          // Unknown, so assumed: the cascade must not touch rows keyed by a
          // bare name another tenant might share.
          nameCollision: true,
        }),
      }),
    );
  });

  it("reports the operator case when the removal cannot be scheduled either", async () => {
    vi.mocked(getUser).mockResolvedValue(owner("alice-two"));
    vi.mocked(deleteProject).mockResolvedValue(notDeleted);
    vi.mocked(createDeletionJob).mockResolvedValue({
      success: false,
      error: new Error("d1 down") as never,
    });
    const { env, artifactsDelete } = makeEnv();
    const result = await confirm(env);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.statusCode).toBe(500);
    expect(!result.success && result.error.message).toContain("Contact support");
    expect(artifactsDelete).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("namespace claims", () => {
  it("records a claim and reports it for its owner only", async () => {
    const { db } = makeSqliteD1();
    expect((await claimNamespace(db, aliceProj, logger)).success).toBe(true);
    const alice = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger);
    const bob = await ownerHasClaims({ DB: db, STATE: kv }, "usr_2", logger);
    expect(alice.success && alice.data).toBe(true);
    expect(bob.success && bob.data).toBe(false);
  });

  it("refreshes rather than rejects the same owner re-creating a deleted slug", async () => {
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const again = await claimNamespace(db, aliceProj, logger);
    expect(again.success).toBe(true);
  });

  it("releases a claim so a withdrawn creation leaves nothing behind", async () => {
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    expect((await releaseNamespaceClaim(db, "@alice", "proj", logger)).success).toBe(true);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger);
    expect(claims.success && claims.data).toBe(false);
  });

  it("reports a database failure as a Result rather than throwing", async () => {
    const broken = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("D1 down");
          },
          first: async () => {
            throw new Error("D1 down");
          },
          all: async () => {
            throw new Error("D1 down");
          },
        }),
      }),
    } as unknown as D1Database;
    expect((await claimNamespace(broken, aliceProj, logger)).success).toBe(false);
    expect((await ownerHasClaims({ DB: broken, STATE: kv }, "usr_1", logger)).success).toBe(false);
    expect((await releaseNamespaceClaim(broken, "@alice", "proj", logger)).success).toBe(false);
  });
});

/**
 * A claim's release is best effort, so past the grace window the claim is
 * checked against KV rather than believed: a deleted or half-withdrawn project
 * must not hold a username forever, and a live one must still hold it.
 */
describe("stale namespace claims", () => {
  it("counts a fresh claim without consulting KV", async () => {
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger);
    expect(claims.success && claims.data).toBe(true);
    expect(getProjectByPath).not.toHaveBeenCalled();
  });

  it("counts an old claim whose project is in KV", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue(found);
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger, later());
    expect(claims.success && claims.data).toBe(true);
    expect(getProjectByPath).toHaveBeenCalledWith(kv, "@alice", "proj", logger);
  });

  it("drops an old claim with no project behind it and reports none", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue(missing);
    const { db, raw } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger, later());
    expect(claims.success && claims.data).toBe(false);
    expect(raw.prepare("SELECT count(*) AS n FROM namespace_claims").get()).toEqual({ n: 0 });
    // Dropped for good: the next check needs no KV read.
    const again = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger, later());
    expect(again.success && again.data).toBe(false);
    expect(getProjectByPath).toHaveBeenCalledTimes(1);
  });

  it("keeps checking past a stale claim and counts a later live one", async () => {
    vi.mocked(getProjectByPath).mockResolvedValueOnce(missing).mockResolvedValueOnce(found);
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    await claimNamespace(db, { ...aliceProj, slug: "other" }, logger);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger, later());
    expect(claims.success && claims.data).toBe(true);
  });

  it("fails closed when KV cannot answer for an old claim", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: false,
      error: { statusCode: 500, message: "kv down" } as never,
    });
    const { db, raw } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger, later());
    expect(claims.success).toBe(false);
    expect(raw.prepare("SELECT count(*) AS n FROM namespace_claims").get()).toEqual({ n: 1 });
  });

  it("treats a KV read that throws as unknown, not as absent", async () => {
    vi.mocked(getProjectByPath).mockRejectedValue(new Error("kv exploded"));
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const claims = await ownerHasClaims({ DB: db, STATE: kv }, "usr_1", logger, later());
    expect(claims.success).toBe(false);
  });

  it("reports a stale claim it could not drop rather than a clean slate", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue(missing);
    const { db } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    const noDelete = {
      prepare: (sql: string) => {
        if (sql.trim().toUpperCase().startsWith("DELETE")) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error("D1 down");
              },
            }),
          };
        }
        return db.prepare(sql);
      },
    } as unknown as D1Database;
    const claims = await ownerHasClaims({ DB: noDelete, STATE: kv }, "usr_1", logger, later());
    expect(claims.success).toBe(false);
  });

  it("leaves a claim refreshed by a re-creation of the same slug alone", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue(missing);
    const { db, raw } = makeSqliteD1();
    await claimNamespace(db, aliceProj, logger);
    // Between the read and the drop, the same slug is claimed again: the row
    // now carries a newer timestamp and must survive the drop.
    const refreshing = {
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        if (!sql.trim().toUpperCase().startsWith("SELECT")) return stmt;
        return {
          bind: (...args: unknown[]) => ({
            all: async <T>() => {
              const rows = await stmt.bind(...args).all<T>();
              raw
                .prepare("UPDATE namespace_claims SET created_at = ? WHERE slug = ?")
                .run("2099-01-01T00:00:00.000Z", "proj");
              return rows;
            },
          }),
        };
      },
    } as unknown as D1Database;
    const claims = await ownerHasClaims({ DB: refreshing, STATE: kv }, "usr_1", logger, later());
    expect(claims.success && claims.data).toBe(false);
    expect(raw.prepare("SELECT count(*) AS n FROM namespace_claims").get()).toEqual({ n: 1 });
  });
});
