/**
 * Issue #323: API tokens bound to one project or one org, end to end.
 *
 * Driven through the real application — `authMiddleware`, the real routers,
 * real SQLite with every migration applied, and an in-memory KV holding the
 * projects — because the property that matters is not "a bound token reaches
 * its own project" but "a bound token is refused everywhere ELSE", and that is
 * only observable with the whole request path in place.
 *
 * The last block walks the application's ROUTE TABLE rather than a hand-kept
 * list, so a route added later is either refused for bound tokens by the
 * middleware's allow-list, or shows up here as newly reachable and has to be
 * looked at before this file goes green again.
 */
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The worker entry exports only `{ fetch, scheduled, queue }`, not the Hono
// instance, and adding a named export to a Workers entry module is not free
// (named exports are entrypoint candidates). So the route table is read by
// recording every Hono instance as it is constructed — behaviour is the real
// class's, untouched — and picking out the root app below.
const honoInstances = vi.hoisted((): Hono[] => []);
vi.mock("hono", async (importActual) => {
  const actual = await importActual<typeof import("hono")>();
  class RecordingHono extends actual.Hono {
    constructor(...args: ConstructorParameters<typeof actual.Hono>) {
      super(...args);
      honoInstances.push(this as unknown as Hono);
    }
  }
  return { ...actual, Hono: RecordingHono };
});

import app from "../src/index";
import { boundTokenMayReach } from "../src/middleware/auth";
import { isGitHttpPath } from "../src/routes/git-http";
import { isOAuthClientEndpoint } from "../src/routes/mcp-oauth";
import { createApiToken, listApiTokens, resolveApiToken } from "../src/storage/api-tokens";
import { createChange } from "../src/storage/changes";
import { addOrgMember, createOrg } from "../src/storage/orgs";
import { createSession } from "../src/storage/sessions";
import type { BoundCredentialBinding, Env, ProjectEntry } from "../src/types";
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

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let env: Env;
const ids = { acme: "", globex: "", initech: "" };
const tokens = { project: "", org: "", unbound: "", readProject: "" };
let sessionCookie = "";

function project(overrides: Partial<ProjectEntry> & { id: string; slug: string }): ProjectEntry {
  return {
    name: overrides.slug,
    namespace: "@owner",
    ownerId: "usr_owner",
    ownerType: "user",
    remote: `https://acct.artifacts.cloudflare.net/git/x/${overrides.id}.git`,
    createdAt: new Date().toISOString(),
    visibility: "private",
    ...overrides,
  };
}

async function mint(binding?: BoundCredentialBinding, scope: "read" | "read_write" = "read_write") {
  const created = await createApiToken(env.DB, logger, {
    userId: "usr_owner",
    name: `t-${Math.random()}`,
    scope,
    ...(binding !== undefined ? { binding } : {}),
  });
  if (!created.success) throw created.error;
  return created.data.plaintext;
}

beforeAll(async () => {
  const { db } = makeSqliteD1();
  env = { DB: db, STATE: makeFakeKV() } as unknown as Env;

  for (const [id, username] of [
    ["usr_owner", "owner"],
    ["usr_other", "other"],
  ]) {
    await db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(`legacy-${id}`))
      .run();
  }

  // The owner administers acme and globex; initech is someone else's entirely.
  for (const [key, owner, slug] of [
    ["acme", "usr_owner", "acme"],
    ["globex", "usr_owner", "globex"],
    ["initech", "usr_other", "initech"],
  ] as const) {
    const org = await createOrg(db, logger, owner, slug, slug);
    if (!org.success) throw org.error;
    ids[key] = org.data.id;
  }
  // `createOrg` records the owner but not a membership row; access is read from
  // membership, so add it the way the org-creation route does.
  await addOrgMember(db, logger, ids.acme, "usr_owner", "admin");
  await addOrgMember(db, logger, ids.globex, "usr_owner", "admin");
  await addOrgMember(db, logger, ids.initech, "usr_other", "admin");

  const entries = [
    project({ id: "proj_mine", slug: "mine" }),
    project({ id: "proj_other", slug: "other" }),
    project({ id: "proj_public", slug: "public", visibility: "public" }),
    project({
      id: "proj_acme",
      slug: "app",
      namespace: "@acme",
      ownerId: ids.acme,
      ownerType: "org",
    }),
    project({
      id: "proj_globex",
      slug: "app",
      namespace: "@globex",
      ownerId: ids.globex,
      ownerType: "org",
    }),
    project({
      id: "proj_initech",
      slug: "app",
      namespace: "@initech",
      ownerId: ids.initech,
      ownerType: "org",
    }),
  ];
  for (const entry of entries) {
    await env.STATE.put(`project:${entry.namespace}:${entry.slug}`, JSON.stringify(entry));
  }

  tokens.project = await mint({ kind: "project", projectId: "proj_mine" });
  tokens.readProject = await mint({ kind: "project", projectId: "proj_mine" }, "read");
  tokens.org = await mint({ kind: "org", orgId: ids.acme });
  tokens.unbound = await mint();

  const session = await createSession(db, "usr_owner", logger);
  if (!session.success) throw session.error;
  sessionCookie = `stratum_session=${session.data.id}`;
});

beforeEach(() => vi.clearAllMocks());

let originalFetch: typeof fetch;
beforeAll(() => {
  // Nothing in these routes should reach the network; fail loudly if one does.
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response("unexpected", { status: 599 })) as never;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

async function call(
  method: string,
  path: string,
  auth: { token: string } | { session: true },
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { Origin: "http://localhost" };
  if ("token" in auth) headers.Authorization = `Bearer ${auth.token}`;
  else headers.Cookie = sessionCookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx,
  );
}

const bearer = (token: string) => ({ token });

async function listedPaths(token: string): Promise<string[]> {
  const res = await call("GET", "/api/projects", bearer(token));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { projects: Array<{ path: string }> };
  return body.projects.map((p) => p.path).sort();
}

describe("a project-bound token", () => {
  it("reads its own project", async () => {
    const res = await call("GET", "/api/projects/@owner/mine", bearer(tokens.project));
    expect(res.status).toBe(200);
  });

  it("writes to its own project", async () => {
    const res = await call("POST", "/api/projects/@owner/mine/issues", bearer(tokens.project), {
      title: "from a bound token",
    });
    expect(res.status).toBe(201);
  });

  it.each([
    "/api/projects/@owner/other",
    "/api/projects/@owner/public",
    "/api/projects/@acme/app",
    "/api/projects/@owner/other/issues",
    "/api/projects/@owner/other/workspaces",
    "/api/workspaces/@owner/other/workspaces",
    "/api/projects/@owner/other/deployments",
    "/api/projects/@owner/other/import/status",
  ])("is a 404 outside its project, exactly like a missing project: GET %s", async (path) => {
    const res = await call("GET", path, bearer(tokens.project));
    expect(res.status).toBe(404);
  });

  it("is a 404 writing outside its project", async () => {
    const res = await call("POST", "/api/projects/@owner/other/issues", bearer(tokens.project), {
      title: "nope",
    });
    expect(res.status).toBe(404);
  });

  describe("webhook secret regeneration (#387)", () => {
    async function webhookOn(path: string): Promise<string> {
      const res = await call("POST", `/api/projects/${path}/webhooks`, bearer(tokens.unbound), {
        url: "https://hooks.example.com/stratum",
        events: "*",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { webhook?: { id: string }; id?: string };
      const id = body.webhook?.id ?? body.id;
      if (id === undefined) throw new Error("no webhook id in create response");
      return id;
    }

    it("is a 404 outside its project, as if the project were missing, and rotates nothing", async () => {
      const id = await webhookOn("@owner/other");
      const before = await env.DB.prepare("SELECT secret FROM webhooks WHERE id = ?")
        .bind(id)
        .first<{ secret: string }>();
      const res = await call(
        "POST",
        `/api/projects/@owner/other/webhooks/${id}/regenerate-secret`,
        bearer(tokens.project),
        {},
      );
      // Not the 403 a stranger gets: that would confirm the project exists.
      expect(res.status).toBe(404);
      const after = await env.DB.prepare("SELECT secret FROM webhooks WHERE id = ?")
        .bind(id)
        .first<{ secret: string }>();
      expect(after?.secret).toBe(before?.secret);
    });

    it("still regenerates on its own project", async () => {
      const id = await webhookOn("@owner/mine");
      const res = await call(
        "POST",
        `/api/projects/@owner/mine/webhooks/${id}/regenerate-secret`,
        bearer(tokens.project),
        {},
      );
      expect(res.status).toBe(200);
    });
  });

  it("is a 404 on the namespace-authorized sync route for another project", async () => {
    const res = await call("POST", "/api/projects/@owner/other/sync", bearer(tokens.project), {});
    expect(res.status).toBe(404);
  });

  it("lists only its own project", async () => {
    expect(await listedPaths(tokens.project)).toEqual(["/@owner/mine"]);
  });

  it.each([
    { label: "personal", body: { name: "fresh" } },
    { label: "org", body: { name: "fresh", org: "acme" } },
  ])("cannot create a $label project", async ({ body }) => {
    const res = await call("POST", "/api/projects", bearer(tokens.project), body);
    expect(res.status).toBe(403);
  });

  it("cannot import a project", async () => {
    const res = await call("POST", "/api/projects/@owner/fresh/import", bearer(tokens.project), {
      url: "https://github.com/a/b",
    });
    expect(res.status).toBe(403);
  });

  it("a read-only bound token still cannot write its own project", async () => {
    const res = await call("POST", "/api/projects/@owner/mine/issues", bearer(tokens.readProject), {
      title: "x",
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "TOKEN_SCOPE_INSUFFICIENT",
    });
  });
});

/**
 * Review finding on #398: routes that refuse a non-writer with `403` answer a
 * MISSING target with `404`, so a bound token could tell the account's other
 * private projects from names that do not exist. Each such route must answer an
 * out-of-binding target exactly as it answers a missing one.
 */
describe("no existence oracle on the routes that answer non-writers with 403", () => {
  let otherChange = "";

  beforeAll(async () => {
    const created = await createChange(env.DB, logger, {
      project: "@owner/other",
      projectId: "proj_other",
      workspace: "ws",
    });
    if (!created.success) throw created.error;
    otherChange = created.data.id;
  });

  type Probe = { label: string; method: string; existing: () => string; missing: string };
  const probes: Probe[] = [
    {
      label: "webhook list",
      method: "GET",
      existing: () => "/api/projects/@owner/other/webhooks",
      missing: "/api/projects/@owner/nope/webhooks",
    },
    {
      label: "webhook create",
      method: "POST",
      existing: () => "/api/projects/@owner/other/webhooks",
      missing: "/api/projects/@owner/nope/webhooks",
    },
    {
      label: "deploy secrets list",
      method: "GET",
      existing: () => "/api/projects/@owner/other/secrets",
      missing: "/api/projects/@owner/nope/secrets",
    },
    {
      label: "deploy secret write",
      method: "PUT",
      existing: () => "/api/projects/@owner/other/secrets/TOKEN",
      missing: "/api/projects/@owner/nope/secrets/TOKEN",
    },
    {
      label: "issue edit",
      method: "PATCH",
      existing: () => "/api/projects/@owner/other/issues/1",
      missing: "/api/projects/@owner/nope/issues/1",
    },
    {
      label: "issue close",
      method: "POST",
      existing: () => "/api/projects/@owner/other/issues/1/close",
      missing: "/api/projects/@owner/nope/issues/1/close",
    },
    {
      label: "workspace create",
      method: "POST",
      existing: () => "/api/workspaces/@owner/other/workspaces",
      missing: "/api/workspaces/@owner/nope/workspaces",
    },
    {
      label: "change create",
      method: "POST",
      existing: () => "/api/projects/@owner%2Fother/changes",
      missing: "/api/projects/@owner%2Fnope/changes",
    },
    {
      label: "merge batch",
      method: "POST",
      existing: () => "/api/projects/@owner%2Fother/changes/merge-batch",
      missing: "/api/projects/@owner%2Fnope/changes/merge-batch",
    },
    ...["merge", "reject", "evaluate", "github-pr", "reviews"].map((action) => ({
      label: `change ${action}`,
      method: "POST",
      existing: () => `/api/changes/${otherChange}/${action}`,
      missing: `/api/changes/chg_does_not_exist/${action}`,
    })),
  ];

  it.each(probes)("$label", async ({ method, existing, missing }) => {
    const body = method === "GET" ? undefined : { title: "x", workspace: "ws", verdict: "approve" };
    const real = await call(method, existing(), bearer(tokens.project), body);
    const absent = await call(method, missing, bearer(tokens.project), body);
    expect(real.status).toBe(404);
    expect(real.status).toBe(absent.status);
    expect(((await real.json()) as { error: string }).error).not.toContain("access denied");
  });

  it("still answers a writer's in-binding refusal-free path normally", async () => {
    expect(
      (await call("GET", "/api/projects/@owner/mine/webhooks", bearer(tokens.project))).status,
    ).toBe(200);
  });
});

describe("import routes do not lock a project the token cannot reach", () => {
  const lockKey = (slug: string) => `ratelimit:import:project:@owner:${slug}`;

  it.each([
    ["import", "/api/projects/@owner/locked-a/import", "locked-a"],
    ["retry", "/api/projects/@owner/other/import/retry", "other"],
    ["cancel", "/api/projects/@owner/other/import/cancel", "other"],
  ])("an out-of-binding %s is refused before the import lock is taken", async (_l, path, slug) => {
    // Each case starts from no limiter state: the owner's legitimate call in
    // the previous case takes a lock of its own, which is not what is tested.
    const held = await env.STATE.list({ prefix: "ratelimit:import:" });
    for (const key of held.keys) await env.STATE.delete(key.name);

    const res = await call("POST", path, bearer(tokens.project), {
      url: "https://github.com/a/b",
    });
    expect([403, 404]).toContain(res.status);
    expect(await env.STATE.get(lockKey(slug))).toBeNull();

    // And the project's owner can still go ahead: not a 429 from a held lock.
    const owner = await call("POST", path, bearer(tokens.unbound), {});
    expect(owner.status).not.toBe(429);
  });
});

describe("an org-bound token", () => {
  it("reads and writes its org's project", async () => {
    expect((await call("GET", "/api/projects/@acme/app", bearer(tokens.org))).status).toBe(200);
    const res = await call("POST", "/api/projects/@acme/app/issues", bearer(tokens.org), {
      title: "org-bound",
    });
    expect(res.status).toBe(201);
  });

  it.each([
    "/api/projects/@globex/app",
    "/api/projects/@initech/app",
    "/api/projects/@owner/mine",
    "/api/projects/@owner/public",
  ])("is a 404 outside its org: %s", async (path) => {
    const res = await call("GET", path, bearer(tokens.org));
    expect(res.status).toBe(404);
  });

  it("lists its org's projects, not the owner's personal ones", async () => {
    expect(await listedPaths(tokens.org)).toEqual(["/@acme/app"]);
  });

  it.each([
    { label: "personal namespace", body: { name: "fresh" } },
    { label: "another org it administers", body: { name: "fresh", org: "globex" } },
  ])("cannot create a project in the $label", async ({ body }) => {
    const res = await call("POST", "/api/projects", bearer(tokens.org), body);
    expect(res.status).toBe(403);
  });
});

describe("account-level surfaces refuse a bound token", () => {
  const refused: Array<[string, string, unknown?]> = [
    ["GET", "/api/users/me/usage"],
    ["GET", "/api/users/me/tokens"],
    ["POST", "/api/users/me/tokens", { name: "wider" }],
    ["POST", "/api/users/me/rotate-token", {}],
    ["POST", "/api/agents", { name: "bot" }],
    ["GET", "/api/agents"],
    ["GET", "/api/orgs"],
    ["GET", "/api/orgs/acme"],
    ["POST", "/api/orgs/acme/members", { userId: "usr_other" }],
    // The org audit log (#255) is org administration: refused even for a token
    // bound to that same org. A binding narrows a credential to a project/org's
    // CODE, not to administering it, and the trail names every member's
    // activity — reading it stays a session or unbound-token privilege.
    ["GET", "/api/orgs/acme/audit"],
    ["GET", "/api/orgs/acme/audit/export"],
    ["GET", "/api/orgs/acme/audit?format=ndjson"],
    ["POST", "/api/bulk-import", {}],
    ["GET", "/api/admin/audit"],
    ["GET", "/auth/sessions"],
    ["GET", "/settings"],
    ["GET", "/"],
    ["GET", "/@owner/mine"],
  ];

  it.each(refused)("%s %s", async (method, path, body) => {
    for (const token of [tokens.project, tokens.org]) {
      const res = await call(method, path, bearer(token), body);
      expect(res.status).toBe(403);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: "TOKEN_BINDING_EXCLUDES_ROUTE",
      });
    }
  });

  it("a READ bound token on a write to such a route gets the scope code (documented precedence)", async () => {
    const res = await call("POST", "/api/agents", bearer(tokens.readProject), { name: "bot" });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "TOKEN_SCOPE_INSUFFICIENT",
    });
  });

  it("still answers GET /api/users/me (identity only)", async () => {
    const res = await call("GET", "/api/users/me", bearer(tokens.project));
    expect(res.status).toBe(200);
  });
});

describe("unbound credentials are unchanged", () => {
  it("an unbound token reaches every project its owner can", async () => {
    for (const path of ["/@owner/mine", "/@owner/other", "/@acme/app", "/@globex/app"]) {
      expect((await call("GET", `/api/projects${path}`, bearer(tokens.unbound))).status).toBe(200);
    }
    expect((await call("GET", "/api/projects/@initech/app", bearer(tokens.unbound))).status).toBe(
      404,
    );
  });

  it("an unbound token lists the personal namespace, as before", async () => {
    expect(await listedPaths(tokens.unbound)).toEqual([
      "/@owner/mine",
      "/@owner/other",
      "/@owner/public",
    ]);
  });

  it("an unbound token still reaches account-level reads", async () => {
    expect((await call("GET", "/api/orgs", bearer(tokens.unbound))).status).toBe(200);
  });

  it("a session reaches every project its user can", async () => {
    for (const path of ["/@owner/mine", "/@owner/other", "/@acme/app"]) {
      expect((await call("GET", `/api/projects${path}`, { session: true })).status).toBe(200);
    }
  });
});

describe("minting a bound token", () => {
  async function mintViaApi(body: Record<string, unknown>): Promise<Response> {
    return call("POST", "/api/users/me/tokens", { session: true }, { name: "ci", ...body });
  }

  it("binds to a project the creator can read, and the token is held to it", async () => {
    const res = await mintViaApi({ scope: "read_write", project: "@owner/other" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      plaintext: string;
      token: { binding: { kind: string; projectId: string; label: string } };
    };
    expect(body.token.binding).toEqual({
      kind: "project",
      projectId: "proj_other",
      label: "@owner/other",
    });

    expect((await call("GET", "/api/projects/@owner/other", bearer(body.plaintext))).status).toBe(
      200,
    );
    expect((await call("GET", "/api/projects/@owner/mine", bearer(body.plaintext))).status).toBe(
      404,
    );
  });

  it("binds to an org the creator belongs to", async () => {
    const res = await mintViaApi({ org: "acme" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: { binding: { kind: string; label: string } } };
    expect(body.token.binding).toMatchObject({ kind: "org", orgId: ids.acme, label: "@acme" });
  });

  it.each([
    { label: "a private project of an org they are not in", body: { project: "@initech/app" } },
    { label: "a project that does not exist", body: { project: "@owner/nope" } },
    { label: "an org they are not in", body: { org: "initech" } },
    { label: "an org that does not exist", body: { org: "nope" } },
  ])("is a 404 for $label", async ({ body }) => {
    const res = await mintViaApi(body);
    expect(res.status).toBe(404);
  });

  it.each([
    { label: "both a project and an org", body: { project: "@owner/mine", org: "acme" } },
    { label: "a malformed project path", body: { project: "mine" } },
    { label: "a non-string org", body: { org: 7 } },
  ])("is a 400 for $label", async ({ body }) => {
    const res = await mintViaApi(body);
    expect(res.status).toBe(400);
  });

  it("an unbound request still mints an account-wide token", async () => {
    const res = await mintViaApi({});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: Record<string, unknown> };
    expect(body.token.binding).toBeUndefined();
  });

  it("the token list labels each binding", async () => {
    const res = await call("GET", "/api/users/me/tokens", { session: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokens: Array<{ binding?: { kind: string; label: string } }>;
    };
    const labels = body.tokens.map((t) => t.binding?.label).filter((l) => l !== undefined);
    expect(labels).toContain("@owner/mine");
    expect(labels).toContain("@acme");
  });
});

describe("over MCP", () => {
  // Every tool call is re-dispatched as an API sub-request carrying the same
  // credential, so the binding applies one layer in exactly as it does over
  // plain HTTP — this pins that the replayed header really is re-resolved.
  async function tool(token: string, name: string, args: unknown): Promise<string> {
    const res = await call("POST", "/mcp", bearer(token), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
    const text = reply.result?.content?.map((part) => part.text).join("\n") ?? "";
    return reply.result?.isError === true ? `ERROR ${text}` : text;
  }

  it("reaches the bound project and is refused another", async () => {
    expect(await tool(tokens.project, "stratum_get_project", { project: "@owner/mine" })).toContain(
      "proj_mine",
    );
    expect(await tool(tokens.project, "stratum_get_project", { project: "@owner/other" })).toMatch(
      /^ERROR /,
    );
  });

  it("lists only what the binding covers", async () => {
    const listed = await tool(tokens.org, "stratum_list_projects", {});
    expect(listed).toContain("@acme");
    expect(listed).not.toContain("@owner");
  });

  it("refuses an account-level tool through the sub-request", async () => {
    expect(await tool(tokens.project, "stratum_get_usage", {})).toMatch(/^ERROR /);
  });
});

describe("the settings page", () => {
  async function submit(form: Record<string, string>): Promise<Response> {
    return await app.fetch(
      new Request("http://localhost/settings/tokens", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          Cookie: sessionCookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form).toString(),
      }),
      env,
      ctx,
    );
  }

  it("mints a project-bound token from the form and lists what it reaches", async () => {
    const res = await submit({ name: "form-ci", scope: "read", project: "@owner/mine" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("stratum_user_");
    expect(html).toContain("Only @owner/mine");
    expect(html).toContain("Projects of @acme");
    expect(html).toContain("All projects");
  });

  it("refuses a project the user cannot reach, without minting", async () => {
    const before = await listApiTokens(env.DB, logger, "usr_owner");
    const res = await submit({ name: "nope", project: "@initech/app" });
    expect(res.status).toBe(404);
    const after = await listApiTokens(env.DB, logger, "usr_owner");
    if (!before.success || !after.success) throw new Error("list failed");
    expect(after.data.length).toBe(before.data.length);
  });

  it("refuses both a project and an org", async () => {
    const res = await submit({ name: "both", project: "@owner/mine", org: "acme" });
    expect(res.status).toBe(400);
  });
});

describe("stored bindings", () => {
  it("a token whose bound project is gone is inert, not account-wide", async () => {
    const orphan = await mint({ kind: "project", projectId: "proj_deleted" });
    expect((await call("GET", "/api/projects/@owner/mine", bearer(orphan))).status).toBe(404);
    expect(await listedPaths(orphan)).toEqual([]);
  });

  it.each([
    { label: "kind without id", kind: "project", id: null },
    { label: "id without kind", kind: null, id: "proj_mine" },
  ])("a half-set binding ($label) is rejected, never read as unbound", async ({ kind, id }) => {
    const plaintext = await mint();
    const rows = await env.DB.prepare("SELECT id FROM api_tokens WHERE token_hash = ?")
      .bind(await hashToken(plaintext))
      .all<{ id: string }>();
    const tokenId = rows.results[0]?.id ?? "";
    await env.DB.prepare("UPDATE api_tokens SET binding_kind = ?, binding_id = ? WHERE id = ?")
      .bind(kind, id, tokenId)
      .run();

    const resolved = await resolveApiToken(env.DB, plaintext, logger);
    expect(resolved.success).toBe(false);
    expect((await call("GET", "/api/projects/@owner/mine", bearer(plaintext))).status).toBe(401);

    const listed = await listApiTokens(env.DB, logger, "usr_owner");
    if (!listed.success) throw listed.error;
    // Listed as bound to nothing, never as account-wide.
    expect(listed.data.find((t) => t.id === tokenId)?.binding).toBeDefined();
  });

  it("an unknown binding kind is refused by the schema", async () => {
    await expect(
      env.DB.prepare(
        "UPDATE api_tokens SET binding_kind = 'everything', binding_id = 'x' WHERE user_id = ?",
      )
        .bind("usr_owner")
        .run(),
    ).rejects.toThrow();
  });
});

/** A route pattern with every `:param` and `*` made concrete, for probing. */
function concrete(path: string): string {
  return path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
}

/**
 * Every endpoint a bound token can reach at all, as registered in the route
 * table. Each was audited for #323: it resolves a project and authorizes
 * through `utils/authz.ts`, where the binding is a required argument, or it is
 * one of the bound-aware non-project handlers (`GET`/`POST /api/projects`, the
 * namespace-authorized import/sync routes, `GET /api/users/me`, `/mcp`).
 *
 * A failure here listing a NEW route means a new endpoint became reachable by
 * bound tokens. Confirm it authorizes through the binding before adding it —
 * that is the whole point of the list, and why it is written out rather than
 * derived from the code it checks.
 */
const AUDITED_BOUND_REACHABLE: readonly string[] = [
  // Not project-addressed; bound-aware in the handler (#323).
  "GET /api/projects",
  "POST /api/projects",
  "GET /api/users/me",
  "GET /mcp",
  "POST /mcp",
  "DELETE /mcp",
  // Public liveness probes; no account data. `stratum login --key` uses /health.
  "GET /health",
  "GET /api/health",
  "GET /api/health/simple",
  // Authorized by "your own namespace" plus `refuseOutsideBinding`, or refused
  // outright for bound tokens (import).
  "POST /api/projects/:namespace/:slug/import",
  "POST /api/projects/:namespace/:slug/import/cancel",
  "POST /api/projects/:namespace/:slug/import/delete",
  "POST /api/projects/:namespace/:slug/import/retry",
  "POST /api/projects/:namespace/:slug/sync",
  // Deprecated; answers 410 to everyone and touches nothing.
  "POST /api/workspaces/:name/merge",
  // Project-addressed (directly, or via a change/workspace/deployment/conflict
  // id resolved to its project), authorized through utils/authz.ts.
  "DELETE /api/projects/:namespace/:slug",
  "DELETE /api/projects/:namespace/:slug/branches/*",
  "DELETE /api/projects/:namespace/:slug/secrets/:name",
  "DELETE /api/projects/:namespace/:slug/webhooks/:id",
  "DELETE /api/workspaces/:name",
  "GET /api/changes/:id",
  "GET /api/changes/:id/comments",
  "GET /api/changes/:id/reviews",
  "GET /api/deployments/:id",
  "GET /api/projects/:name/changes",
  "GET /api/projects/:namespace/:slug",
  "GET /api/projects/:namespace/:slug/activity",
  "GET /api/projects/:namespace/:slug/branches",
  "GET /api/projects/:namespace/:slug/content",
  "GET /api/projects/:namespace/:slug/deployments",
  "GET /api/projects/:namespace/:slug/files",
  "GET /api/projects/:namespace/:slug/import/status",
  "GET /api/projects/:namespace/:slug/import/stream",
  "GET /api/projects/:namespace/:slug/issues",
  "GET /api/projects/:namespace/:slug/issues/:number",
  "GET /api/projects/:namespace/:slug/issues/:number/comments",
  "GET /api/projects/:namespace/:slug/log",
  "GET /api/projects/:namespace/:slug/provenance",
  "GET /api/projects/:namespace/:slug/secrets",
  "GET /api/projects/:namespace/:slug/sync/history",
  "GET /api/projects/:namespace/:slug/sync/status",
  "GET /api/projects/:namespace/:slug/sync/stream",
  "GET /api/projects/:namespace/:slug/tags",
  "GET /api/projects/:namespace/:slug/webhooks",
  "GET /api/projects/:namespace/:slug/webhooks/:id/deliveries",
  "GET /api/workspaces/:namespace/:slug/workspaces",
  "PATCH /api/projects/:namespace/:slug/issues/:number",
  "POST /api/changes/:id/comments",
  "POST /api/changes/:id/comments/:commentId/resolve",
  "POST /api/changes/:id/comments/:commentId/unresolve",
  "POST /api/changes/:id/evaluate",
  "POST /api/changes/:id/github-pr",
  "POST /api/changes/:id/merge",
  "POST /api/changes/:id/reject",
  "POST /api/changes/:id/reviews",
  "POST /api/deployments/:id/approve",
  "POST /api/deployments/:id/retry",
  "POST /api/projects/:name/changes",
  "POST /api/projects/:name/changes/merge-batch",
  "POST /api/projects/:namespace/:slug/branches",
  "POST /api/projects/:namespace/:slug/delete",
  "POST /api/projects/:namespace/:slug/issues",
  "POST /api/projects/:namespace/:slug/issues/:number/close",
  "POST /api/projects/:namespace/:slug/issues/:number/comments",
  "POST /api/projects/:namespace/:slug/secrets",
  "POST /api/projects/:namespace/:slug/secrets/:name/delete",
  "POST /api/projects/:namespace/:slug/sync/settings",
  "POST /api/projects/:namespace/:slug/webhooks",
  "POST /api/projects/:namespace/:slug/webhooks/:id/delete",
  "POST /api/projects/:namespace/:slug/webhooks/:id/toggle",
  // #387: authorizes through webhooks.ts `requireProjectAdmin` (canWriteProject
  // with the request's binding), like every other webhook route.
  "POST /api/projects/:namespace/:slug/webhooks/:id/regenerate-secret",
  "POST /api/projects/conflicts/:id/resolve",
  "POST /api/workspaces/:name/commit",
  "POST /api/workspaces/:namespace/:slug/workspaces",
  // #408: authorizes through canWriteProject and canWriteWorkspace with the
  // request's binding, and the credential it mints is bound to that project.
  "POST /api/workspaces/:namespace/:slug/workspaces/:name/remote-credential",
  "PUT /api/projects/:namespace/:slug/secrets/:name",
];

describe("the route table", () => {
  // The root app: the one instance carrying both a top-level route and the
  // mounted API (the MCP dispatcher mounts the API too, but not `/health`).
  const root = honoInstances.find(
    (instance) =>
      instance.routes.some((route) => route.path === "/health") &&
      instance.routes.some((route) => route.path === "/api/projects/:namespace/:slug"),
  );
  if (root === undefined) throw new Error("could not find the root Hono app");
  // Handlers only: `ALL` entries are the middleware chain, not endpoints.
  const endpoints = [
    ...new Set(
      root.routes
        .filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${route.path}`),
    ),
  ].sort();
  const split = (endpoint: string): [string, string] => {
    const [method = "", path = ""] = endpoint.split(" ");
    return [method, path];
  };
  const isReachable = (endpoint: string): boolean => {
    const [method, path] = split(endpoint);
    return boundTokenMayReach(method, concrete(path));
  };

  it("every endpoint a bound token can reach has been audited", () => {
    expect(endpoints.filter(isReachable)).toEqual([...AUDITED_BOUND_REACHABLE].sort());
  });

  it("every other endpoint refuses a bound token before routing", async () => {
    const refused = endpoints.filter((endpoint) => !isReachable(endpoint));
    expect(refused.length).toBeGreaterThan(50);
    const outcomes: Array<{ endpoint: string; code: unknown }> = [];
    for (const endpoint of refused) {
      const [method, path] = split(endpoint);
      // git smart-HTTP and the OAuth client endpoints authenticate for
      // themselves; the middleware steps aside for them and they never
      // interpret a Bearer user token. Covered by git-http-token-binding.test.ts.
      if (isGitHttpPath(concrete(path)) || isOAuthClientEndpoint(concrete(path))) continue;
      const res = await call(
        method,
        concrete(path),
        bearer(tokens.project),
        method === "GET" || method === "HEAD" ? undefined : {},
      );
      const body = (await res.json().catch(() => ({}))) as { code?: unknown };
      outcomes.push({ endpoint, code: res.status === 403 ? body.code : res.status });
    }
    expect(outcomes.filter((o) => o.code !== "TOKEN_BINDING_EXCLUDES_ROUTE")).toEqual([]);
  });
});
