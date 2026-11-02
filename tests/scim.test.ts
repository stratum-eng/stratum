/**
 * SCIM 2.0 Users endpoints (#253 Task 6): real routers + real middleware
 * against a real SQLite D1 (every migration applied). Only external I/O
 * (Artifacts, KV) is faked; auth, storage, and the SCIM lifecycle run for
 * real — including the PRD Goal-8 E2E (deactivate → every credential dead →
 * reactivate → restored).
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { csrfMiddleware } from "../src/middleware/csrf";
import { rateLimitMiddleware } from "../src/middleware/rate-limit";
import { gitHttpRouter } from "../src/routes/git-http";
import { scimRouter } from "../src/routes/scim";
import { createAgent } from "../src/storage/agents";
import { addOrgMember } from "../src/storage/orgs";
import { createSession } from "../src/storage/sessions";
import {
  deprovisionUser,
  getSsoConnectionByScimTokenHash,
  reactivateUser,
  rotateScimToken,
  setSsoConnectionEnabled,
  setSsoDomainsVerified,
  upsertSsoConnection,
} from "../src/storage/sso";
import { createUser } from "../src/storage/users";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

// Everything real except createUser, which is a passthrough spy so ONE test
// (the POST email-race heal) can make a single call fail after inserting the
// row — the shape of losing the email UNIQUE race to a concurrent writer.
vi.mock("../src/storage/users", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/users")>();
  return { ...actual, createUser: vi.fn(actual.createUser) };
});

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const BASE = "https://stratum.test";
const DOMAIN = "corp.example.com";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

interface ScimResource {
  schemas: string[];
  id: string;
  userName: string;
  externalId?: string;
  active: boolean;
  name: { formatted: string };
  emails: Array<{ value: string; primary: boolean }>;
  meta: { resourceType: string; created: string; location: string };
}

interface ListResponse {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: ScimResource[];
}

let db: D1Database;
let raw: Raw;
let env: Env;
let app: Hono<{ Bindings: Env }>;
let connectionId: string;
let scimToken: string;

async function makeConnection(
  orgId: string,
  slug: string,
  ownerId: string,
  domain: string,
): Promise<string> {
  raw
    .prepare("INSERT INTO orgs (id, name, slug, owner_id) VALUES (?, ?, ?, ?)")
    .run(orgId, slug, slug, ownerId);
  const upserted = await upsertSsoConnection(db, logger, {
    orgId,
    issuer: `https://idp.${slug}.example.com`,
    clientId: "client-id",
    clientSecretCiphertext: "ciphertext",
    authorizationEndpoint: `https://idp.${slug}.example.com/authorize`,
    tokenEndpoint: `https://idp.${slug}.example.com/token`,
    jwksUri: `https://idp.${slug}.example.com/jwks`,
    emailDomains: [domain],
  });
  if (!upserted.success) throw new Error("seed: upsertSsoConnection failed");
  const id = upserted.data.connection.id;
  const verified = await setSsoDomainsVerified(db, logger, id, [domain]);
  if (!verified.success) throw new Error("seed: verify failed");
  const enabled = await setSsoConnectionEnabled(db, logger, id, true);
  if (!enabled.success) throw new Error("seed: enable failed");
  return id;
}

beforeEach(async () => {
  ({ db, raw } = makeSqliteD1());
  env = {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeFakeKV(),
    DB: db,
  };

  raw
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .run("usr_owner", `owner@${DOMAIN}`, "owner", "hash_owner");
  connectionId = await makeConnection("org_1", "acme", "usr_owner", DOMAIN);
  const rotated = await rotateScimToken(db, logger, connectionId);
  if (!rotated.success) throw new Error("seed: rotateScimToken failed");
  scimToken = rotated.data;

  // Same middleware chain (and order) as src/index.ts, trimmed to the routers
  // under test plus an authMiddleware-protected echo route.
  app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.use("*", csrfMiddleware);
  app.use("*", rateLimitMiddleware());
  app.route("/scim/v2", scimRouter);
  app.route("/", gitHttpRouter);
  app.get("/api/whoami", (c) =>
    c.json({
      userId: c.get("userId") ?? null,
      agentId: c.get("agentId") ?? null,
      scimConnectionId: c.get("scimConnectionId") ?? null,
    }),
  );
});

function scimFetch(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const token = opts.token === undefined ? scimToken : opts.token;
  const headers: Record<string, string> = { ...opts.headers };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/scim+json";
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
      env,
    ),
  );
}

async function provision(
  email: string,
  extra: Record<string, unknown> = {},
): Promise<ScimResource> {
  const res = await scimFetch("POST", "/scim/v2/Users", {
    body: { schemas: [USER_SCHEMA], userName: email, ...extra },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`provision failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ScimResource;
}

function disabledAtOf(userId: string): string | null {
  const row = raw.prepare("SELECT disabled_at FROM users WHERE id = ?").get(userId) as {
    disabled_at: string | null;
  };
  return row.disabled_at;
}

function scimRowOf(
  connId: string,
  userId: string,
): { scim_external_id: string | null; active: number } | undefined {
  return raw
    .prepare(
      "SELECT scim_external_id, active FROM scim_members WHERE connection_id = ? AND user_id = ?",
    )
    .get(connId, userId) as { scim_external_id: string | null; active: number } | undefined;
}

function auditActions(subject: string): Array<{ action: string; actor_type: string }> {
  return raw
    .prepare("SELECT action, actor_type FROM audit_log WHERE subject = ? ORDER BY rowid")
    .all(subject) as Array<{ action: string; actor_type: string }>;
}

describe("getSsoConnectionByScimTokenHash", () => {
  it("resolves an enabled, verified connection by token hash", async () => {
    const result = await getSsoConnectionByScimTokenHash(db, logger, await hashToken(scimToken));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe(connectionId);
  });

  it("does not resolve a disabled connection", async () => {
    await setSsoConnectionEnabled(db, logger, connectionId, false);
    const result = await getSsoConnectionByScimTokenHash(db, logger, await hashToken(scimToken));
    expect(result.success).toBe(false);
  });

  it("does not resolve an unverified connection", async () => {
    raw
      .prepare("UPDATE org_sso_connections SET domains_verified_at = NULL WHERE id = ?")
      .run(connectionId);
    const result = await getSsoConnectionByScimTokenHash(db, logger, await hashToken(scimToken));
    expect(result.success).toBe(false);
  });

  it("a disabled connection's token gets a SCIM-envelope 401 from the middleware", async () => {
    await setSsoConnectionEnabled(db, logger, connectionId, false);
    const res = await scimFetch("GET", "/scim/v2/Users");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/scim+json");
    const body = (await res.json()) as { schemas: string[]; status: string; detail: string };
    expect(body.schemas).toEqual([ERROR_SCHEMA]);
    expect(body.status).toBe("401");
    expect(body.detail).toBe("Invalid token");
  });
});

describe("fail-closed: only a SCIM bearer is honored on /scim/v2", () => {
  async function expectScimUnauthorized(res: Response): Promise<void> {
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/scim+json");
    const body = (await res.json()) as { schemas: string[]; status: string };
    expect(body.schemas).toEqual([ERROR_SCHEMA]);
    expect(body.status).toBe("401");
  }

  it("no auth → 401 SCIM error", async () => {
    await expectScimUnauthorized(await scimFetch("GET", "/scim/v2/Users", { token: null }));
  });

  it("user bearer → 401 SCIM error", async () => {
    const created = await createUser(db, `human@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    await expectScimUnauthorized(
      await scimFetch("GET", "/scim/v2/Users", { token: created.data.plaintext }),
    );
  });

  it("session cookie → 401 SCIM error", async () => {
    const session = await createSession(db, "usr_owner", logger);
    if (!session.success) throw new Error("seed failed");
    const res = await app.fetch(
      new Request(`${BASE}/scim/v2/Users`, {
        headers: { Cookie: `stratum_session=${session.data.id}` },
      }),
      env,
    );
    await expectScimUnauthorized(res);
  });

  it("discovery endpoints are gated too", async () => {
    await expectScimUnauthorized(
      await scimFetch("GET", "/scim/v2/ServiceProviderConfig", { token: null }),
    );
  });
});

describe("discovery endpoints", () => {
  it("ServiceProviderConfig advertises patch + filter, everything else off", async () => {
    const res = await scimFetch("GET", "/scim/v2/ServiceProviderConfig");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/scim+json");
    const body = (await res.json()) as Record<string, { supported?: boolean; maxResults?: number }>;
    expect(body.patch?.supported).toBe(true);
    expect(body.filter?.supported).toBe(true);
    expect(body.filter?.maxResults).toBe(200);
    expect(body.changePassword?.supported).toBe(false);
    expect(body.sort?.supported).toBe(false);
    expect(body.etag?.supported).toBe(false);
    expect(body.bulk?.supported).toBe(false);
    const schemes = body.authenticationSchemes as unknown as Array<{ type: string }>;
    expect(schemes[0]?.type).toBe("oauthbearertoken");
  });

  it("ResourceTypes lists the User resource in a ListResponse envelope", async () => {
    const res = await scimFetch("GET", "/scim/v2/ResourceTypes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.schemas).toEqual([LIST_SCHEMA]);
    expect(body.totalResults).toBe(1);
    expect((body.Resources[0] as unknown as { id: string; schema: string }).id).toBe("User");
    expect((body.Resources[0] as unknown as { schema: string }).schema).toBe(USER_SCHEMA);
  });

  it("Schemas lists the core User schema in a ListResponse envelope", async () => {
    const res = await scimFetch("GET", "/scim/v2/Schemas");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.schemas).toEqual([LIST_SCHEMA]);
    expect((body.Resources[0] as unknown as { id: string }).id).toBe(USER_SCHEMA);
    const attrs = (
      body.Resources[0] as unknown as { attributes: Array<{ name: string; required: boolean }> }
    ).attributes;
    expect(attrs.find((a) => a.name === "userName")?.required).toBe(true);
  });
});

describe("POST /Users (provision + adopt)", () => {
  it("Okta-shaped POST creates the user with membership, scim row, and externalId", async () => {
    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: {
        schemas: [USER_SCHEMA],
        userName: `Alice@${DOMAIN}`,
        externalId: "okta-123",
        name: { givenName: "Alice", familyName: "Example" },
        emails: [{ value: `alice@${DOMAIN}`, primary: true, type: "work" }],
        active: true,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ScimResource;
    expect(body.schemas).toEqual([USER_SCHEMA]);
    expect(body.userName).toBe(`alice@${DOMAIN}`);
    expect(body.externalId).toBe("okta-123");
    expect(body.active).toBe(true);
    expect(body.emails).toEqual([{ value: `alice@${DOMAIN}`, primary: true }]);
    expect(body.meta.resourceType).toBe("User");
    expect(body.meta.location).toBe(`${BASE}/scim/v2/Users/${body.id}`);
    expect(res.headers.get("Location")).toBe(body.meta.location);

    // Username derived exactly like SSO JIT / signup would.
    const user = raw.prepare("SELECT username, email FROM users WHERE id = ?").get(body.id) as {
      username: string;
      email: string;
    };
    expect(user.username).toBe("alice");
    expect(user.email).toBe(`alice@${DOMAIN}`);
    const member = raw
      .prepare("SELECT role FROM org_members WHERE org_id = 'org_1' AND user_id = ?")
      .get(body.id) as { role: string };
    expect(member.role).toBe("member");
    expect(scimRowOf(connectionId, body.id)).toEqual({
      scim_external_id: "okta-123",
      active: 1,
    });

    const actions = auditActions(body.id).map((row) => row.action);
    expect(actions).toContain("scim.user.provisioned");
    for (const row of auditActions(body.id)) expect(row.actor_type).toBe("system");
  });

  it("POST with active:false provisions the user already deactivated", async () => {
    const body = await provision(`suspended@${DOMAIN}`, { active: false });
    expect(body.active).toBe(false);
    expect(disabledAtOf(body.id)).not.toBeNull();
  });

  it("rejects an email outside the verified domains with 400 invalidValue", async () => {
    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: "intruder@evil.example.net" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { schemas: string[]; scimType: string };
    expect(body.schemas).toEqual([ERROR_SCHEMA]);
    expect(body.scimType).toBe("invalidValue");
  });

  it("rejects a missing userName with 400", async () => {
    const res = await scimFetch("POST", "/scim/v2/Users", { body: { schemas: [USER_SCHEMA] } });
    expect(res.status).toBe(400);
  });

  it("adopts an existing verified-domain account with 201 + Location, preserving its admin role", async () => {
    const created = await createUser(db, `carol@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    const carolId = created.data.user.id;
    await addOrgMember(db, logger, "org_1", carolId, "admin");

    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: `carol@${DOMAIN}`, externalId: "idp-carol" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Location")).toBe(`${BASE}/scim/v2/Users/${carolId}`);
    const body = (await res.json()) as ScimResource;
    expect(body.id).toBe(carolId);
    expect(body.externalId).toBe("idp-carol");

    // Adoption must not demote the pre-existing role.
    const member = raw
      .prepare("SELECT role FROM org_members WHERE org_id = 'org_1' AND user_id = ?")
      .get(carolId) as { role: string };
    expect(member.role).toBe("admin");
    expect(scimRowOf(connectionId, carolId)?.active).toBe(1);
  });

  it("a plain duplicate POST converges idempotently (201, no duplicate rows)", async () => {
    const first = await provision(`dana@${DOMAIN}`);
    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: `dana@${DOMAIN}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ScimResource;
    expect(body.id).toBe(first.id);

    const users = raw
      .prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?")
      .get(`dana@${DOMAIN}`) as { n: number };
    expect(users.n).toBe(1);
    const members = raw
      .prepare("SELECT COUNT(*) AS n FROM scim_members WHERE connection_id = ? AND user_id = ?")
      .get(connectionId, first.id) as { n: number };
    expect(members.n).toBe(1);
  });

  it("a retried POST after a partial provision finishes the job (deactivation applied)", async () => {
    // Partial state: the first POST created the user and the scim_members row
    // (active=1, no externalId) but died before applying active:false. The IdP
    // retries the same POST; a 409 would end its retries and strand the
    // account enabled.
    const alice = await provision(`alice@${DOMAIN}`);
    expect(disabledAtOf(alice.id)).toBeNull();

    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: `alice@${DOMAIN}`, active: false },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as ScimResource).active).toBe(false);
    expect(disabledAtOf(alice.id)).not.toBeNull();
    expect(scimRowOf(connectionId, alice.id)?.active).toBe(0);
  });

  it("a retried POST with active:true reactivates a deactivated account (both directions)", async () => {
    const alice = await provision(`alice@${DOMAIN}`, { active: false });
    expect(disabledAtOf(alice.id)).not.toBeNull();

    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: `alice@${DOMAIN}`, active: true },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as ScimResource).active).toBe(true);
    expect(disabledAtOf(alice.id)).toBeNull();
    expect(scimRowOf(connectionId, alice.id)?.active).toBe(1);
  });

  it("a POST whose externalId mismatches the stored one is a genuine 409 uniqueness", async () => {
    await provision(`dana@${DOMAIN}`, { externalId: "idp-dana" });
    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: `dana@${DOMAIN}`, externalId: "idp-other" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { scimType: string }).scimType).toBe("uniqueness");
  });

  it("heals the concurrent-email race: a lost createUser insert falls into the adopt path (201)", async () => {
    const actualUsers =
      await vi.importActual<typeof import("../src/storage/users")>("../src/storage/users");
    // Simulate a concurrent OIDC JIT login (or duplicate POST) winning the
    // email UNIQUE race: by the time our insert reports failure, the row
    // exists.
    vi.mocked(createUser).mockImplementationOnce(async (dbArg, email, log, preferred) => {
      await actualUsers.createUser(dbArg, email, log, preferred);
      return {
        success: false,
        error: new AppError("simulated email UNIQUE race", "STORAGE_ERROR", 500),
      };
    });

    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: `raced@${DOMAIN}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ScimResource;
    expect(body.userName).toBe(`raced@${DOMAIN}`);
    expect(scimRowOf(connectionId, body.id)?.active).toBe(1);
  });
});

describe("GET /Users (list, filters, pagination)", () => {
  it("lists managed users plus verified-domain org members (visible for adoption)", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    // The org owner is an org member within the verified domain → visible.
    await addOrgMember(db, logger, "org_1", "usr_owner", "admin");
    // An org member OUTSIDE the verified domains is not in scope.
    const outsider = await createUser(db, "guest@other.example.net", logger);
    if (!outsider.success) throw new Error("seed failed");
    await addOrgMember(db, logger, "org_1", outsider.data.user.id, "member");

    const res = await scimFetch("GET", "/scim/v2/Users");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.schemas).toEqual([LIST_SCHEMA]);
    const ids = body.Resources.map((r) => r.id);
    expect(ids).toContain(alice.id);
    expect(ids).toContain("usr_owner");
    expect(ids).not.toContain(outsider.data.user.id);
    expect(body.totalResults).toBe(2);
  });

  it("paginates with 1-based startIndex and clamps count", async () => {
    for (const name of ["u1", "u2", "u3"]) await provision(`${name}@${DOMAIN}`);

    const page = await scimFetch("GET", "/scim/v2/Users?startIndex=2&count=1");
    const body = (await page.json()) as ListResponse;
    expect(body.totalResults).toBe(3);
    expect(body.startIndex).toBe(2);
    expect(body.itemsPerPage).toBe(1);
    expect(body.Resources).toHaveLength(1);

    const clamped = await scimFetch("GET", "/scim/v2/Users?count=9999");
    expect(((await clamped.json()) as ListResponse).itemsPerPage).toBe(3);
  });

  it("count=0 returns totalResults with no Resources (RFC 7644 §3.4.2.4)", async () => {
    for (const name of ["u1", "u2"]) await provision(`${name}@${DOMAIN}`);

    const zero = await scimFetch("GET", "/scim/v2/Users?count=0");
    expect(zero.status).toBe(200);
    const body = (await zero.json()) as ListResponse;
    expect(body.totalResults).toBe(2);
    expect(body.itemsPerPage).toBe(0);
    expect(body.Resources).toEqual([]);

    // A negative count is treated as 0.
    const negative = await scimFetch("GET", "/scim/v2/Users?count=-5");
    expect(((await negative.json()) as ListResponse).Resources).toEqual([]);
  });

  it('filters by userName eq "..." (attribute case-insensitive)', async () => {
    await provision(`erin@${DOMAIN}`);
    await provision(`frank@${DOMAIN}`);

    const res = await scimFetch(
      "GET",
      `/scim/v2/Users?filter=${encodeURIComponent(`username eq "Erin@${DOMAIN}"`)}`,
    );
    const body = (await res.json()) as ListResponse;
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0]?.userName).toBe(`erin@${DOMAIN}`);
  });

  it('filters by externalId eq "..."', async () => {
    await provision(`gina@${DOMAIN}`, { externalId: "ext-gina" });
    await provision(`hank@${DOMAIN}`, { externalId: "ext-hank" });

    const res = await scimFetch(
      "GET",
      `/scim/v2/Users?filter=${encodeURIComponent('externalId eq "ext-hank"')}`,
    );
    const body = (await res.json()) as ListResponse;
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0]?.userName).toBe(`hank@${DOMAIN}`);
  });

  it("any other filter is 501 per RFC 7644 §3.4.2.2", async () => {
    const res = await scimFetch(
      "GET",
      `/scim/v2/Users?filter=${encodeURIComponent('emails.value co "corp"')}`,
    );
    expect(res.status).toBe(501);
    expect(((await res.json()) as { schemas: string[] }).schemas).toEqual([ERROR_SCHEMA]);
  });

  it("GET /Users/:id returns the resource, 404 SCIM error out of scope", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const found = await scimFetch("GET", `/scim/v2/Users/${alice.id}`);
    expect(found.status).toBe(200);
    expect(((await found.json()) as ScimResource).id).toBe(alice.id);

    // A real user outside the connection's scope is indistinguishable from a
    // missing one.
    const stranger = await createUser(db, "stranger@elsewhere.example.net", logger);
    if (!stranger.success) throw new Error("seed failed");
    const miss = await scimFetch("GET", `/scim/v2/Users/${stranger.data.user.id}`);
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as { schemas: string[] }).schemas).toEqual([ERROR_SCHEMA]);
  });
});

describe("PUT /Users/:id", () => {
  it("rejects a userName change with 400 mutability", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const res = await scimFetch("PUT", `/scim/v2/Users/${alice.id}`, {
      body: { schemas: [USER_SCHEMA], userName: `renamed@${DOMAIN}`, active: true },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { scimType: string }).scimType).toBe("mutability");
  });

  it("applies externalId and active (same userName is not a change)", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const res = await scimFetch("PUT", `/scim/v2/Users/${alice.id}`, {
      body: {
        schemas: [USER_SCHEMA],
        userName: `ALICE@${DOMAIN}`,
        externalId: "ext-new",
        active: false,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ScimResource;
    expect(body.externalId).toBe("ext-new");
    expect(body.active).toBe(false);
    expect(disabledAtOf(alice.id)).not.toBeNull();
  });

  it("a no-op PUT adopts an adoption-visible user (creates the scim_members row)", async () => {
    const created = await createUser(db, `visible@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    const userId = created.data.user.id;
    await addOrgMember(db, logger, "org_1", userId, "member");
    expect(scimRowOf(connectionId, userId)).toBeUndefined();

    const res = await scimFetch("PUT", `/scim/v2/Users/${userId}`, {
      body: { schemas: [USER_SCHEMA], userName: `visible@${DOMAIN}`, active: true },
    });
    expect(res.status).toBe(200);
    // The IdP now believes it manages this user; the row records that so the
    // user cannot silently fall out of the connection's scope.
    expect(scimRowOf(connectionId, userId)).toEqual({ scim_external_id: null, active: 1 });
  });

  it("an invalid PUT (userName change) does NOT adopt the user", async () => {
    const created = await createUser(db, `visible@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    const userId = created.data.user.id;
    await addOrgMember(db, logger, "org_1", userId, "member");

    const res = await scimFetch("PUT", `/scim/v2/Users/${userId}`, {
      body: { schemas: [USER_SCHEMA], userName: `renamed@${DOMAIN}`, active: true },
    });
    expect(res.status).toBe(400);
    // A 400 must not adopt: the IdP was told the write failed, so no
    // scim_members row may record it as managing this user.
    expect(scimRowOf(connectionId, userId)).toBeUndefined();
  });

  it("a PUT with a malformed `active` neither adopts nor half-applies externalId", async () => {
    const created = await createUser(db, `halfway@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    const userId = created.data.user.id;
    await addOrgMember(db, logger, "org_1", userId, "member");

    const res = await scimFetch("PUT", `/scim/v2/Users/${userId}`, {
      body: { schemas: [USER_SCHEMA], externalId: "ext-halfway", active: "maybe" },
    });
    expect(res.status).toBe(400);
    // Validation precedes every write: no adoption row, so no stored externalId.
    expect(scimRowOf(connectionId, userId)).toBeUndefined();
  });

  it("a PUT with a non-string externalId does NOT adopt the user", async () => {
    const created = await createUser(db, `badext@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    const userId = created.data.user.id;
    await addOrgMember(db, logger, "org_1", userId, "member");

    const res = await scimFetch("PUT", `/scim/v2/Users/${userId}`, {
      body: { schemas: [USER_SCHEMA], externalId: 42 },
    });
    expect(res.status).toBe(400);
    expect(scimRowOf(connectionId, userId)).toBeUndefined();
  });
});

describe("PATCH /Users/:id", () => {
  it('Entra-shaped {"op":"Replace","path":"active","value":"False"} deactivates', async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const res = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "Replace", path: "active", value: "False" }],
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScimResource).active).toBe(false);
    expect(disabledAtOf(alice.id)).not.toBeNull();
    expect(scimRowOf(connectionId, alice.id)?.active).toBe(0);
  });

  it("boolean values and no-path value objects work too", async () => {
    const alice = await provision(`alice@${DOMAIN}`);

    const off = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: { Operations: [{ op: "replace", value: { active: false } }] },
    });
    expect(((await off.json()) as ScimResource).active).toBe(false);

    const on = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: { Operations: [{ op: "replace", path: "Active", value: true }] },
    });
    expect(((await on.json()) as ScimResource).active).toBe(true);
    expect(disabledAtOf(alice.id)).toBeNull();
  });

  it("replaces externalId via path", async () => {
    const alice = await provision(`alice@${DOMAIN}`, { externalId: "before" });
    const res = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: { Operations: [{ op: "replace", path: "externalId", value: "after" }] },
    });
    expect(((await res.json()) as ScimResource).externalId).toBe("after");
  });

  it("accepts an add op on a stored path (Entra sends Add on link)", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const res = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: { Operations: [{ op: "Add", path: "externalId", value: "linked" }] },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScimResource).externalId).toBe("linked");
  });

  it("ignores unknown-attribute ops (Okta/Entra profile sync) instead of erroring", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const res = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: {
        Operations: [
          { op: "replace", path: "displayName", value: "Alice E." },
          { op: "replace", value: { "name.givenName": "Alice" } },
          // An add (or any op) on an unknown path is ignored too — the path
          // resolves first, so the op type never matters for unstored paths.
          { op: "add", path: "nickName", value: "Al" },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScimResource).active).toBe(true);
  });

  it("rejects remove ops on stored paths with 400 and malformed active values with invalidValue", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const removed = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: { Operations: [{ op: "remove", path: "active" }] },
    });
    expect(removed.status).toBe(400);
    expect(((await removed.json()) as { scimType: string }).scimType).toBe("invalidPath");

    const bad = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: { Operations: [{ op: "replace", path: "active", value: "maybe" }] },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { scimType: string }).scimType).toBe("invalidValue");
  });

  it("an invalid PATCH (non-array Operations) does NOT adopt the user", async () => {
    const created = await createUser(db, `patchable@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    const userId = created.data.user.id;
    await addOrgMember(db, logger, "org_1", userId, "member");

    const res = await scimFetch("PATCH", `/scim/v2/Users/${userId}`, {
      body: { Operations: { op: "replace", path: "active", value: false } },
    });
    expect(res.status).toBe(400);
    // A 400 must not adopt — see the PUT counterpart.
    expect(scimRowOf(connectionId, userId)).toBeUndefined();
  });

  it("404s for a user outside the connection's scope", async () => {
    const res = await scimFetch("PATCH", "/scim/v2/Users/usr_ghost", {
      body: { Operations: [{ op: "replace", path: "active", value: false }] },
    });
    expect(res.status).toBe(404);
  });

  it("repairs the drift state: active:false on a half-deprovisioned user actually disables", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const session = await createSession(db, alice.id, logger);
    if (!session.success) throw new Error("seed failed");
    // Drift left by a partial deprovision failure: the vote was recorded but
    // the enforced flag never landed.
    raw
      .prepare("UPDATE scim_members SET active = 0 WHERE connection_id = ? AND user_id = ?")
      .run(connectionId, alice.id);
    expect(disabledAtOf(alice.id)).toBeNull();

    const res = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: { Operations: [{ op: "replace", path: "active", value: false }] },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScimResource).active).toBe(false);
    expect(disabledAtOf(alice.id)).not.toBeNull();
    const sessions = raw
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .get(alice.id) as { n: number };
    expect(sessions.n).toBe(0);
  });

  it("records this connection's deactivation vote even when another connection already disabled the user", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const otherConnectionId = await makeConnection(
      "org_2",
      "globex",
      "usr_owner",
      "globex.example.com",
    );
    // Connection B disables first.
    expect((await deprovisionUser(db, logger, otherConnectionId, alice.id)).success).toBe(true);

    // A's PATCH active:false must still record A's own active=0 vote.
    const res = await scimFetch("PATCH", `/scim/v2/Users/${alice.id}`, {
      body: { Operations: [{ op: "replace", path: "active", value: false }] },
    });
    expect(res.status).toBe(200);
    expect(scimRowOf(connectionId, alice.id)?.active).toBe(0);

    // B reactivates — A's standing vote keeps the account disabled.
    const partial = await reactivateUser(db, logger, otherConnectionId, alice.id);
    expect(partial.success).toBe(true);
    if (partial.success) expect(partial.data.enabled).toBe(false);
    expect(disabledAtOf(alice.id)).not.toBeNull();

    // Once A reactivates too, the account is restored.
    const full = await reactivateUser(db, logger, connectionId, alice.id);
    expect(full.success).toBe(true);
    if (full.success) expect(full.data.enabled).toBe(true);
    expect(disabledAtOf(alice.id)).toBeNull();
  });
});

describe("DELETE /Users/:id", () => {
  it("deactivates (204); a later GET shows the resource with active:false", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const del = await scimFetch("DELETE", `/scim/v2/Users/${alice.id}`);
    expect(del.status).toBe(204);
    expect(disabledAtOf(alice.id)).not.toBeNull();

    // Documented Okta-vs-spec deviation: DELETE deactivates rather than
    // erases, so the resource remains GETtable with active:false.
    const after = await scimFetch("GET", `/scim/v2/Users/${alice.id}`);
    expect(after.status).toBe(200);
    expect(((await after.json()) as ScimResource).active).toBe(false);
  });

  it("a retried DELETE stays 204 without re-auditing the deactivation", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    expect((await scimFetch("DELETE", `/scim/v2/Users/${alice.id}`)).status).toBe(204);
    const deactivations = () =>
      auditActions(alice.id).filter((row) => row.action === "scim.user.deactivated");
    expect(deactivations()).toHaveLength(1);

    expect((await scimFetch("DELETE", `/scim/v2/Users/${alice.id}`)).status).toBe(204);
    expect(deactivations()).toHaveLength(1);
  });
});

describe("externalId uniqueness per connection (migration 051)", () => {
  it("assigning a taken externalId on the same connection is 409 uniqueness", async () => {
    await provision(`alice@${DOMAIN}`, { externalId: "ext-dup" });
    const bob = await provision(`bob@${DOMAIN}`);

    const res = await scimFetch("PATCH", `/scim/v2/Users/${bob.id}`, {
      body: { Operations: [{ op: "replace", path: "externalId", value: "ext-dup" }] },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { scimType: string }).scimType).toBe("uniqueness");
    expect(scimRowOf(connectionId, bob.id)?.scim_external_id).toBeNull();
  });

  it("POSTing a second user with a taken externalId is 409 uniqueness", async () => {
    await provision(`alice@${DOMAIN}`, { externalId: "ext-dup" });
    const res = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: `bob@${DOMAIN}`, externalId: "ext-dup" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { scimType: string }).scimType).toBe("uniqueness");
  });

  it("the same externalId on a DIFFERENT connection is allowed", async () => {
    await provision(`alice@${DOMAIN}`, { externalId: "ext-shared" });
    const otherConnectionId = await makeConnection(
      "org_2",
      "globex",
      "usr_owner",
      "globex.example.com",
    );
    const rotated = await rotateScimToken(db, logger, otherConnectionId);
    if (!rotated.success) throw new Error("seed failed");

    const res = await scimFetch("POST", "/scim/v2/Users", {
      token: rotated.data,
      body: {
        schemas: [USER_SCHEMA],
        userName: "carol@globex.example.com",
        externalId: "ext-shared",
      },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as ScimResource).externalId).toBe("ext-shared");
  });
});

describe("Goal-8 E2E: deactivate kills every credential; reactivate restores", () => {
  it("session, user token, agent token, and git smart-HTTP all die and come back", async () => {
    // Seeded like a real login: account + API token + agent + session.
    const created = await createUser(db, `dave@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    const daveId = created.data.user.id;
    const userToken = created.data.plaintext;
    const agent = await createAgent(db, daveId, "dave-agent", logger);
    if (!agent.success) throw new Error("seed failed");
    const agentToken = agent.data.plaintext;
    const session = await createSession(db, daveId, logger);
    if (!session.success) throw new Error("seed failed");
    const cookie = `stratum_session=${session.data.id}`;

    // Adopt into SCIM management.
    const adopted = await scimFetch("POST", "/scim/v2/Users", {
      body: { schemas: [USER_SCHEMA], userName: `dave@${DOMAIN}` },
    });
    expect(adopted.status).toBe(201);

    const whoami = (headers: Record<string, string>) =>
      app.fetch(new Request(`${BASE}/api/whoami`, { headers }), env);
    // Project doesn't exist, so git-http answers 404 to an AUTHENTICATED
    // caller and a 401 Basic challenge to an anonymous one — a disabled
    // credential collapses to anonymous.
    const gitFetch = (token: string) =>
      app.fetch(
        new Request(`${BASE}/@acme/repo/info/refs?service=git-upload-pack`, {
          headers: { Authorization: `Basic ${btoa(`x:${token}`)}` },
        }),
        env,
      );

    // All four credentials live.
    expect((await whoami({ Authorization: `Bearer ${userToken}` })).status).toBe(200);
    expect((await whoami({ Authorization: `Bearer ${agentToken}` })).status).toBe(200);
    const viaSession = await whoami({ Cookie: cookie });
    expect(((await viaSession.json()) as { userId: string | null }).userId).toBe(daveId);
    expect((await gitFetch(userToken)).status).toBe(404);

    // SCIM deactivation (Entra-shaped PATCH).
    const deactivate = await scimFetch("PATCH", `/scim/v2/Users/${daveId}`, {
      body: { Operations: [{ op: "Replace", path: "active", value: "False" }] },
    });
    expect(deactivate.status).toBe(200);

    // Sessions purged, flag set.
    const sessions = raw
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .get(daveId) as { n: number };
    expect(sessions.n).toBe(0);
    expect(disabledAtOf(daveId)).not.toBeNull();

    // Every credential is inert.
    expect((await whoami({ Authorization: `Bearer ${userToken}` })).status).toBe(401);
    expect((await whoami({ Authorization: `Bearer ${agentToken}` })).status).toBe(401);
    const deadSession = await whoami({ Cookie: cookie });
    expect(((await deadSession.json()) as { userId: string | null }).userId).toBeNull();
    expect((await gitFetch(userToken)).status).toBe(401);
    expect((await gitFetch(agentToken)).status).toBe(401);

    // Audit trail: system actor, both action pairs.
    const actions = auditActions(daveId);
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["scim.user.deactivated", "user.disabled"]),
    );
    for (const row of actions) expect(row.actor_type).toBe("system");

    // Reactivate — the SAME token and agent credentials work again (sessions
    // were destroyed, not suspended, so the cookie stays dead).
    const reactivate = await scimFetch("PATCH", `/scim/v2/Users/${daveId}`, {
      body: { Operations: [{ op: "replace", path: "active", value: true }] },
    });
    expect(reactivate.status).toBe(200);
    expect(disabledAtOf(daveId)).toBeNull();
    expect((await whoami({ Authorization: `Bearer ${userToken}` })).status).toBe(200);
    expect((await whoami({ Authorization: `Bearer ${agentToken}` })).status).toBe(200);
    expect((await gitFetch(userToken)).status).toBe(404);

    expect(auditActions(daveId).map((row) => row.action)).toEqual(
      expect.arrayContaining(["scim.user.reactivated", "user.enabled"]),
    );
  });
});

describe("deprovisionUser / reactivateUser (storage)", () => {
  it("deprovision is idempotent and keeps the earliest disabled_at", async () => {
    const alice = await provision(`alice@${DOMAIN}`);

    const first = await deprovisionUser(db, logger, connectionId, alice.id);
    expect(first.success).toBe(true);
    const stamped = disabledAtOf(alice.id);

    const again = await deprovisionUser(db, logger, connectionId, alice.id);
    expect(again.success).toBe(true);
    expect(disabledAtOf(alice.id)).toBe(stamped);
    if (again.success) expect(again.data.disabledAt).toBe(stamped);
  });

  it("reactivation guard: another connection's standing deactivation keeps the account disabled", async () => {
    const created = await createUser(db, `shared@${DOMAIN}`, logger);
    if (!created.success) throw new Error("seed failed");
    const userId = created.data.user.id;
    const otherConnectionId = await makeConnection(
      "org_2",
      "globex",
      "usr_owner",
      "globex.example.com",
    );

    expect((await deprovisionUser(db, logger, connectionId, userId)).success).toBe(true);
    expect((await deprovisionUser(db, logger, otherConnectionId, userId)).success).toBe(true);
    expect(disabledAtOf(userId)).not.toBeNull();

    // First connection reactivates — the other's active=0 row still stands.
    const partial = await reactivateUser(db, logger, connectionId, userId);
    expect(partial.success).toBe(true);
    if (partial.success) expect(partial.data.enabled).toBe(false);
    expect(disabledAtOf(userId)).not.toBeNull();

    // Once BOTH have reactivated, the account is restored.
    const full = await reactivateUser(db, logger, otherConnectionId, userId);
    expect(full.success).toBe(true);
    if (full.success) expect(full.data.enabled).toBe(true);
    expect(disabledAtOf(userId)).toBeNull();
  });

  it("reactivate is idempotent on an already-active user", async () => {
    const alice = await provision(`alice@${DOMAIN}`);
    const result = await reactivateUser(db, logger, connectionId, alice.id);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(true);
    expect(disabledAtOf(alice.id)).toBeNull();
  });
});
