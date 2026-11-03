import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { StratumClient } from "../src/mcp/client";
import { buildTools } from "../src/mcp/tools";
/**
 * Issues #406, #407 and #413: the MCP tools for creating and importing
 * projects, managing organizations, and working a change through
 * re-evaluation, comments, promotion and sync.
 *
 * Driven through the whole Worker against real SQLite, in the style of
 * `mcp-endpoint.test.ts`: each tool call must land on the REAL route handler
 * and come back with that route's answer — its refusals included. The
 * assertions therefore check text only the real route produces ("requires
 * write access", "must be accepted before promotion"), never just "an error
 * happened", which a mis-wired path would also satisfy.
 */
import { issueTokens, registerClient } from "../src/storage/oauth";
import { getProjectByPath, setProject } from "../src/storage/state";
import type { Env, ProjectEntry } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const ORIGIN = "https://stratum.test";

/** alice: admin of acme. wren: acme member with a write team. reed: plain
 * (read-only) acme member. otto: no relation to acme. */
const TOKENS = {
  alice: "stratum_user_11111111111111111111111111111111",
  wren: "stratum_user_22222222222222222222222222222222",
  reed: "stratum_user_33333333333333333333333333333333",
  otto: "stratum_user_44444444444444444444444444444444",
} as const;

let env: Env;
let db: D1Database;
let queued: Array<Record<string, unknown>>;

interface RpcReply {
  result?: { content?: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

async function call(name: string, args: unknown, token: string): Promise<RpcReply> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
  );
  return (await response.json()) as RpcReply;
}

function text(reply: RpcReply): string {
  return reply.result?.content?.map((part) => part.text).join("\n") ?? "";
}

/** A successful tool result, parsed. Fails the test with the tool's own text
 * otherwise, so a refusal reads as what it was. */
function ok<T>(reply: RpcReply): T {
  expect(reply.error).toBeUndefined();
  if (reply.result?.isError) throw new Error(`tool failed: ${text(reply)}`);
  return JSON.parse(text(reply)) as T;
}

function refused(reply: RpcReply, needle: string): void {
  expect(reply.error).toBeUndefined();
  expect(reply.result?.isError).toBe(true);
  expect(text(reply)).toContain("Stratum API error");
  expect(text(reply)).toContain(needle);
}

async function readOnlyGrant(userId: string): Promise<string> {
  const client = await registerClient(db, logger, {
    clientName: "Reader",
    redirectUris: ["http://127.0.0.1:9000/cb"],
  });
  if (!client.success) throw new Error("client setup failed");
  const tokens = await issueTokens(db, logger, {
    clientId: client.data.client.id,
    userId,
    scope: "mcp:read",
  });
  if (!tokens.success) throw new Error("token setup failed");
  return tokens.data.accessToken;
}

const PROJECT: ProjectEntry = {
  id: "prj_web",
  name: "web",
  slug: "web",
  namespace: "@acme",
  ownerId: "org_acme",
  ownerType: "org",
  remote: "https://artifacts.test/acme-web.git",
  createdAt: "2026-10-01T00:00:00.000Z",
  visibility: "private",
};

beforeEach(async () => {
  const made = makeSqliteD1();
  db = made.db;
  queued = [];
  env = {
    DB: db,
    STATE: makeFakeKV(),
    // A creation that gets past authorization fails here, which is how "the
    // route admitted this caller" is asserted without a real git push.
    ARTIFACTS: {
      create: async (name: string) => {
        if (name.includes("blank")) throw new Error("artifacts unavailable in this test");
        return { name, remote: `https://artifacts.test/${name}.git`, token: "tok" };
      },
      delete: async () => true,
    },
    IMPORT_QUEUE: {
      send: async (message: Record<string, unknown>) => {
        queued.push(message);
      },
    },
  } as unknown as Env;

  const users: Array<[string, string, string]> = [
    ["usr_alice", "alice", TOKENS.alice],
    ["usr_wren", "wren", TOKENS.wren],
    ["usr_reed", "reed", TOKENS.reed],
    ["usr_otto", "otto", TOKENS.otto],
  ];
  for (const [id, username, token] of users) {
    await db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(token))
      .run();
  }
  const raw = made.raw;
  raw
    .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES (?, ?, ?, ?)")
    .run("org_acme", "Acme", "acme", "usr_alice");
  const member = raw.prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)");
  member.run("org_acme", "usr_alice", "admin");
  member.run("org_acme", "usr_wren", "member");
  member.run("org_acme", "usr_reed", "member");
  raw
    .prepare("INSERT INTO teams (id, org_id, name, slug, permissions) VALUES (?, ?, ?, ?, ?)")
    .run("team_dev", "org_acme", "Dev", "dev", "write");
  raw
    .prepare("INSERT INTO team_members (team_id, user_id) VALUES (?, ?)")
    .run("team_dev", "usr_wren");

  const stored = await setProject(env.STATE, PROJECT, logger);
  if (!stored.success) throw stored.error;
  const change = raw.prepare(
    "INSERT INTO changes (id, project, project_id, workspace, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  change.run("chg_open", "@acme/web", "prj_web", "ws1", "open", "2026-10-02T00:00:00.000Z");
  change.run("chg_merged", "@acme/web", "prj_web", "ws2", "merged", "2026-10-02T00:00:00.000Z");
});

describe("organization tools (#413)", () => {
  it("creates an org and makes the caller its admin", async () => {
    const created = ok<{ org: { slug: string; id: string } }>(
      await call("stratum_create_org", { name: "Globex", slug: "globex" }, TOKENS.otto),
    );
    expect(created.org.slug).toBe("globex");

    const listed = ok<{ orgs: Array<{ slug: string }> }>(
      await call("stratum_list_orgs", {}, TOKENS.otto),
    );
    expect(listed.orgs.map((o) => o.slug)).toEqual(["globex"]);
  });

  it("refuses an org slug that collides with a username", async () => {
    refused(
      await call("stratum_create_org", { name: "Otto Inc", slug: "otto" }, TOKENS.alice),
      "already taken",
    );
  });

  it("gets an org for a member, and answers a non-member with not-found", async () => {
    const got = ok<{ org: { id: string } }>(
      await call("stratum_get_org", { org: "@acme" }, TOKENS.reed),
    );
    expect(got.org.id).toBe("org_acme");
    refused(await call("stratum_get_org", { org: "acme" }, TOKENS.otto), "not found");
  });

  it("lets an admin add and remove members, and refuses a non-admin", async () => {
    refused(
      await call("stratum_add_org_member", { org: "acme", user_id: "usr_otto" }, TOKENS.wren),
      "Forbidden",
    );

    ok(
      await call(
        "stratum_add_org_member",
        { org: "acme", user_id: "usr_otto", role: "member" },
        TOKENS.alice,
      ),
    );
    // Otto is a member now, so the org reads for them.
    ok(await call("stratum_get_org", { org: "acme" }, TOKENS.otto));

    refused(
      await call("stratum_remove_org_member", { org: "acme", user_id: "usr_otto" }, TOKENS.reed),
      "Forbidden",
    );
    const removed = ok<{ removed: boolean }>(
      await call("stratum_remove_org_member", { org: "acme", user_id: "usr_otto" }, TOKENS.alice),
    );
    expect(removed.removed).toBe(true);
    refused(await call("stratum_get_org", { org: "acme" }, TOKENS.otto), "not found");
  });

  it("creates and lists teams and adds a member, admins only", async () => {
    refused(
      await call("stratum_create_team", { org: "acme", name: "Ops", slug: "ops" }, TOKENS.wren),
      "Forbidden",
    );
    const team = ok<{ team: { id: string; permissions: string } }>(
      await call(
        "stratum_create_team",
        { org: "acme", name: "Ops", slug: "ops", permissions: "write" },
        TOKENS.alice,
      ),
    );
    expect(team.team.permissions).toBe("write");

    const teams = ok<{ teams: Array<{ slug: string }> }>(
      await call("stratum_list_teams", { org: "acme" }, TOKENS.reed),
    );
    expect(teams.teams.map((t) => t.slug).sort()).toEqual(["dev", "ops"]);
    refused(await call("stratum_list_teams", { org: "acme" }, TOKENS.otto), "not found");

    const added = ok<{ added: boolean }>(
      await call(
        "stratum_add_team_member",
        { org: "acme", team_id: team.team.id, user_id: "usr_reed" },
        TOKENS.alice,
      ),
    );
    expect(added.added).toBe(true);
    refused(
      await call(
        "stratum_add_team_member",
        { org: "acme", team_id: team.team.id, user_id: "usr_otto" },
        TOKENS.reed,
      ),
      "Forbidden",
    );
  });
});

describe("project creation and import tools (#406)", () => {
  it("routes an org project creation through POST /api/projects's org check", async () => {
    refused(
      await call("stratum_create_project", { name: "blank", org: "acme" }, TOKENS.reed),
      "requires write access",
    );
    // A writer is admitted, and the creation proceeds to the repository store —
    // where this test's stand-in fails it.
    refused(
      await call("stratum_create_project", { name: "blank", org: "@acme" }, TOKENS.wren),
      "Failed to create repository",
    );
  });

  it("imports into an org for a writer, recording the org as owner", async () => {
    const imported = ok<{ namespace: string; slug: string; status: string }>(
      await call(
        "stratum_import_project",
        { url: "https://github.com/owner/service.git", org: "acme", branch: "main" },
        TOKENS.wren,
      ),
    );
    // The name defaults to the source repository's, without `.git`.
    expect(imported).toMatchObject({ namespace: "@acme", slug: "service", status: "queued" });
    const project = await getProjectByPath(env.STATE, "@acme", "service", logger);
    if (!project.success) throw project.error;
    expect(project.data).toMatchObject({ ownerType: "org", ownerId: "org_acme" });
    expect(queued).toHaveLength(1);

    const status = ok<{ status: string; namespace: string }>(
      await call("stratum_get_import_status", { project: "@acme/service" }, TOKENS.wren),
    );
    expect(status).toMatchObject({ status: "queued", namespace: "@acme" });
  });

  it("refuses an org import from a read-only member or a non-member with 403", async () => {
    const args = { url: "https://github.com/owner/repo", org: "acme", branch: "main" };
    refused(await call("stratum_import_project", args, TOKENS.reed), "write access");
    refused(await call("stratum_import_project", args, TOKENS.otto), "write access");
    expect(queued).toHaveLength(0);
  });

  it("imports into the caller's own namespace when no org is given", async () => {
    const imported = ok<{ namespace: string; slug: string }>(
      await call(
        "stratum_import_project",
        {
          url: "https://github.com/owner/repo",
          name: "mine",
          branch: "main",
          visibility: "public",
        },
        TOKENS.otto,
      ),
    );
    expect(imported).toMatchObject({ namespace: "@otto", slug: "mine" });
  });

  it("labels an underivable import name as an argument error", async () => {
    const reply = await call("stratum_import_project", { url: "https://github.com/" }, TOKENS.otto);
    expect(reply.result?.isError).toBe(true);
    expect(text(reply)).toContain("Invalid arguments for stratum_import_project");
  });
});

describe("change, sync and branch tools (#407)", () => {
  it("comments on a change and lists the thread", async () => {
    const posted = ok<{ comment: { id: string; body: string } }>(
      await call(
        "stratum_comment_change",
        { change_id: "chg_open", body: "Looks off" },
        TOKENS.reed,
      ),
    );
    expect(posted.comment.body).toBe("Looks off");
    ok(
      await call(
        "stratum_comment_change",
        { change_id: "chg_open", body: "Agreed", parent_comment_id: posted.comment.id },
        TOKENS.wren,
      ),
    );

    const listed = ok<{ comments: Array<{ body: string; parentCommentId?: string }> }>(
      await call("stratum_list_change_comments", { change_id: "chg_open" }, TOKENS.reed),
    );
    expect(listed.comments.map((c) => c.body)).toEqual(["Looks off", "Agreed"]);
    expect(listed.comments[1]?.parentCommentId).toBe(posted.comment.id);

    // Someone who cannot read the project cannot see that the change exists.
    refused(
      await call("stratum_list_change_comments", { change_id: "chg_open" }, TOKENS.otto),
      "not found",
    );
  });

  it("re-evaluates only for project writers, and never a merged change", async () => {
    // A read-only member can see the project, so is told why rather than 404'd.
    refused(
      await call("stratum_evaluate_change", { change_id: "chg_open" }, TOKENS.reed),
      "access denied",
    );
    refused(
      await call("stratum_evaluate_change", { change_id: "chg_merged" }, TOKENS.wren),
      "Cannot re-evaluate a merged change",
    );
  });

  it("promotes only an accepted change, and only for project writers", async () => {
    refused(
      await call("stratum_promote_change", { change_id: "chg_open" }, TOKENS.reed),
      "access denied",
    );
    refused(
      await call("stratum_promote_change", { change_id: "chg_open", draft: false }, TOKENS.wren),
      "must be accepted before promotion",
    );
  });

  it("reads sync status for a project reader, and syncs only for writers", async () => {
    const status = ok<Record<string, unknown>>(
      await call("stratum_get_sync_status", { project: "@acme/web" }, TOKENS.reed),
    );
    expect(status).toBeTypeOf("object");
    refused(
      await call("stratum_get_sync_status", { project: "@acme/web" }, TOKENS.otto),
      "not found",
    );

    refused(
      await call("stratum_sync_project", { project: "@acme/web" }, TOKENS.reed),
      "write access",
    );
    // A writer passes authorization and reaches the project's source check;
    // this project was never imported, so it has none.
    refused(
      await call("stratum_sync_project", { project: "@acme/web" }, TOKENS.wren),
      "not connected to a remote repository",
    );
  });

  it("routes branch listing to the project's branch route", async () => {
    // A project the caller cannot read is answered by the route itself.
    refused(
      await call("stratum_list_branches", { project: "@acme/web" }, TOKENS.otto),
      "not found",
    );
  });
});

describe("a read-only grant (mcp:read)", () => {
  const READS: Array<[string, Record<string, unknown>]> = [
    ["stratum_list_orgs", {}],
    ["stratum_get_org", { org: "acme" }],
    ["stratum_list_teams", { org: "acme" }],
    ["stratum_list_change_comments", { change_id: "chg_open" }],
    ["stratum_get_sync_status", { project: "@acme/web" }],
    ["stratum_get_import_status", { project: "@acme/web" }],
    ["stratum_list_branches", { project: "@acme/web" }],
  ];
  const WRITES: Array<[string, Record<string, unknown>]> = [
    ["stratum_create_org", { name: "Globex", slug: "globex" }],
    ["stratum_add_org_member", { org: "acme", user_id: "usr_otto" }],
    ["stratum_remove_org_member", { org: "acme", user_id: "usr_reed" }],
    ["stratum_create_team", { org: "acme", name: "Ops", slug: "ops" }],
    ["stratum_add_team_member", { org: "acme", team_id: "team_dev", user_id: "usr_reed" }],
    ["stratum_create_project", { name: "x", org: "acme" }],
    ["stratum_import_project", { url: "https://github.com/o/r", org: "acme" }],
    ["stratum_sync_project", { project: "@acme/web" }],
    ["stratum_evaluate_change", { change_id: "chg_open" }],
    ["stratum_promote_change", { change_id: "chg_open" }],
    ["stratum_comment_change", { change_id: "chg_open", body: "hi" }],
  ];

  it("calls every new list/get tool without a scope refusal", async () => {
    const token = await readOnlyGrant("usr_alice");
    for (const [name, args] of READS) {
      const reply = await call(name, args, token);
      expect(reply.error, name).toBeUndefined();
      expect(text(reply), name).not.toContain("read-only");
    }
  });

  it("is refused on every new mutating tool, before the route runs", async () => {
    const token = await readOnlyGrant("usr_alice");
    for (const [name, args] of WRITES) {
      const reply = await call(name, args, token);
      expect(reply.result?.isError, name).toBe(true);
      expect(text(reply), name).toContain("read-only");
    }
    // Nothing a refused call would have written exists.
    expect(queued).toHaveLength(0);
    const orgs = await db.prepare("SELECT slug FROM orgs").all<{ slug: string }>();
    expect(orgs.results.map((o) => o.slug)).toEqual(["acme"]);
    const comments = await db
      .prepare("SELECT COUNT(*) AS n FROM change_comments")
      .first<{ n: number }>();
    expect(comments?.n).toBe(0);
  });
});

describe("stratum_import_project on a connection bound to an agent", () => {
  it("defaults to the owner's namespace, which /me reports under `owner`", async () => {
    const importProject = vi.fn(async () => ({ namespace: "@alice", slug: "repo" }));
    const client = {
      me: async () => ({
        actingAs: "agent" as const,
        agent: { id: "agt_1", name: "Claude Code" },
        owner: { id: "usr_1", username: "alice" },
      }),
      importProject,
    } as unknown as StratumClient;
    const tool = buildTools(client).find((t) => t.name === "stratum_import_project");
    const result = await tool?.handler({ url: "https://github.com/owner/repo" });
    expect(result?.isError).toBeFalsy();
    expect(importProject).toHaveBeenCalledWith(
      { namespace: "@alice", slug: "repo" },
      { url: "https://github.com/owner/repo" },
    );
  });
});
