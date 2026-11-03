import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { getProjectByPath } from "../src/storage/state";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { createLogger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * Issue #406: `POST /api/projects/:namespace/:slug/import` may target an org
 * namespace when the caller has write access to that org, mirroring how
 * `POST /api/projects` treats `org`. Driven through the whole Worker against
 * real SQLite, so org membership, team grants and the import job rows are the
 * real ones — only the repository store and the queue are stand-ins.
 */

const ORIGIN = "https://stratum.test";
const logger = createLogger({ requestId: "test" });

const TOKENS = {
  admin: "stratum_user_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  writer: "stratum_user_wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww",
  reader: "stratum_user_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
  outsider: "stratum_user_oooooooooooooooooooooooooooooooo",
} as const;

let env: Env;
let queued: Array<Record<string, unknown>>;

beforeEach(async () => {
  const { db, raw } = makeSqliteD1();
  queued = [];
  env = {
    DB: db,
    STATE: makeFakeKV(),
    ARTIFACTS: {
      create: async (name: string) => ({
        name,
        remote: `https://artifacts.test/${name}.git`,
        token: "tok",
      }),
      delete: async () => true,
    },
    IMPORT_QUEUE: {
      send: async (message: Record<string, unknown>) => {
        queued.push(message);
      },
    },
  } as unknown as Env;

  const users: Array<[string, string, string]> = [
    ["usr_admin", "ada", TOKENS.admin],
    ["usr_writer", "wren", TOKENS.writer],
    ["usr_reader", "reed", TOKENS.reader],
    ["usr_outsider", "otto", TOKENS.outsider],
  ];
  for (const [id, username, token] of users) {
    await db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(token))
      .run();
  }
  raw
    .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES (?, ?, ?, ?)")
    .run("org_acme", "Acme", "acme", "usr_admin");
  const member = raw.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)");
  member.run("org_acme", "usr_admin", "admin");
  member.run("org_acme", "usr_writer", "member");
  member.run("org_acme", "usr_reader", "member");
  // Write access for a plain member comes from a team grant.
  raw
    .prepare("INSERT INTO teams (id, org_id, name, slug, permissions) VALUES (?, ?, ?, ?, ?)")
    .run("team_dev", "org_acme", "Dev", "dev", "write");
  raw
    .prepare("INSERT INTO team_members (team_id, user_id) VALUES (?, ?)")
    .run("team_dev", "usr_writer");
});

async function send(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  );
}

const IMPORT_BODY = { url: "https://github.com/owner/repo", branch: "main" };

describe("importing into an org namespace (#406)", () => {
  it("lets an org member with a write team grant import, and records the org as owner", async () => {
    const response = await send("POST", "/api/projects/@acme/repo/import", TOKENS.writer, {
      ...IMPORT_BODY,
      visibility: "public",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { namespace: string; slug: string; importId: string };
    expect(body).toMatchObject({ namespace: "@acme", slug: "repo" });

    const project = await getProjectByPath(env.STATE, "@acme", "repo", logger);
    if (!project.success) throw project.error;
    expect(project.data.ownerType).toBe("org");
    expect(project.data.ownerId).toBe("org_acme");

    // The job reached the queue addressed to the org namespace, with the
    // importer as the person to notify.
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      namespace: "@acme",
      slug: "repo",
      initiatedBy: "usr_writer",
    });
  });

  it("lets an org admin import a private project into the org", async () => {
    const response = await send("POST", "/api/projects/@acme/private-repo/import", TOKENS.admin, {
      ...IMPORT_BODY,
    });
    expect(response.status).toBe(201);
    const project = await getProjectByPath(env.STATE, "@acme", "private-repo", logger);
    if (!project.success) throw project.error;
    expect(project.data).toMatchObject({ ownerType: "org", visibility: "private" });
  });

  it("refuses a read-only org member with 403, creating nothing", async () => {
    const response = await send("POST", "/api/projects/@acme/repo/import", TOKENS.reader, {
      ...IMPORT_BODY,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("write access");
    expect((await getProjectByPath(env.STATE, "@acme", "repo", logger)).success).toBe(false);
    expect(queued).toHaveLength(0);
  });

  it("refuses a non-member with 403, creating nothing", async () => {
    const response = await send("POST", "/api/projects/@acme/repo/import", TOKENS.outsider, {
      ...IMPORT_BODY,
    });
    expect(response.status).toBe(403);
    expect((await getProjectByPath(env.STATE, "@acme", "repo", logger)).success).toBe(false);
    expect(queued).toHaveLength(0);
  });

  it("answers a missing org with the same 403 as one the caller cannot write to", async () => {
    // Distinguishing them would let anyone enumerate org slugs.
    const missing = await send("POST", "/api/projects/@ghost/repo/import", TOKENS.outsider, {
      ...IMPORT_BODY,
    });
    const forbidden = await send("POST", "/api/projects/@acme/repo/import", TOKENS.outsider, {
      ...IMPORT_BODY,
    });
    expect(missing.status).toBe(403);
    expect(await missing.text()).toBe(await forbidden.text());
  });

  it("refuses a non-member before taking the project's import lock", async () => {
    // The refusal sits ahead of the import rate limiter: a lock taken by an
    // outsider would block the org's own import of that slug for minutes.
    await send("POST", "/api/projects/@acme/repo/import", TOKENS.outsider, { ...IMPORT_BODY });
    const kv = env.STATE as unknown as { store: Map<string, string> };
    expect([...kv.store.keys()].some((k) => k.startsWith("ratelimit:import:project:@acme"))).toBe(
      false,
    );
  });

  it("still imports into the caller's own namespace", async () => {
    const response = await send("POST", "/api/projects/@otto/repo/import", TOKENS.outsider, {
      ...IMPORT_BODY,
      visibility: "public",
    });
    expect(response.status).toBe(201);
    const project = await getProjectByPath(env.STATE, "@otto", "repo", logger);
    if (!project.success) throw project.error;
    expect(project.data).toMatchObject({ ownerType: "user", ownerId: "usr_outsider" });
  });

  it("still refuses another user's personal namespace", async () => {
    const response = await send("POST", "/api/projects/@ada/repo/import", TOKENS.writer, {
      ...IMPORT_BODY,
    });
    expect(response.status).toBe(403);
  });
});

describe("following an org-owned import (#406)", () => {
  /** What the queue consumer does when the first attempt ends. */
  function releaseImportLock(): void {
    (env.STATE as unknown as { store: Map<string, string> }).store.delete(
      "ratelimit:import:project:@acme:repo",
    );
  }

  beforeEach(async () => {
    const response = await send("POST", "/api/projects/@acme/repo/import", TOKENS.writer, {
      ...IMPORT_BODY,
      visibility: "private",
    });
    expect(response.status).toBe(201);
  });

  it("reports status to org writers, and hides the unfinished project from everyone else", async () => {
    // An incomplete import is visible only to writers (authz.canReadProject):
    // the repository has no content yet. Read-only members and outsiders get
    // the same 404 a missing project gives.
    for (const token of [TOKENS.writer, TOKENS.admin]) {
      const response = await send("GET", "/api/projects/@acme/repo/import/status", token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; namespace: string };
      expect(body).toMatchObject({ status: "queued", namespace: "@acme" });
    }
    for (const token of [TOKENS.reader, TOKENS.outsider]) {
      const response = await send("GET", "/api/projects/@acme/repo/import/status", token);
      expect(response.status).toBe(404);
    }
  });

  it("opens the progress stream for an org writer, and hides it from outsiders", async () => {
    const response = await send("GET", "/api/projects/@acme/repo/import/stream", TOKENS.writer);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.body?.cancel();

    const outsider = await send("GET", "/api/projects/@acme/repo/import/stream", TOKENS.outsider);
    expect(outsider.status).toBe(404);
  });

  it("lets an org writer retry and re-queues the job, but refuses a read-only member", async () => {
    const refused = await send("POST", "/api/projects/@acme/repo/import/retry", TOKENS.reader);
    expect(refused.status).toBe(403);

    releaseImportLock();
    queued = [];
    const retried = await send("POST", "/api/projects/@acme/repo/import/retry", TOKENS.admin);
    expect(retried.status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ namespace: "@acme", slug: "repo", initiatedBy: "usr_admin" });
  });

  it("lets an org writer cancel, but refuses a non-member", async () => {
    const refused = await send("POST", "/api/projects/@acme/repo/import/cancel", TOKENS.outsider);
    expect(refused.status).toBe(403);

    releaseImportLock();
    const cancelled = await send("POST", "/api/projects/@acme/repo/import/cancel", TOKENS.writer);
    expect(cancelled.status).toBe(200);
  });
});
