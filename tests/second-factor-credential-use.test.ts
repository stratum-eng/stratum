/**
 * Org second-factor policy (#256) when a credential is USED (#441).
 *
 * #428 applied the policy when a credential is minted. That left every
 * credential minted before a policy was turned on, or before its owner joined
 * the org, reaching the org's projects with no check. Each credential now
 * records how its minter had authenticated, and the org's policy is evaluated
 * against that on every use, exactly as it is for a session.
 *
 * These tests run the whole Worker (`src/index.ts`) against a real SQLite D1,
 * with no storage mocks, through every kind of credential: API tokens, the
 * legacy key, agents, OAuth grants and workspace git credentials, over both the
 * JSON API and git smart-HTTP.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { dispatchApiRequest } from "../src/mcp/dispatch";
import { getAgentByToken } from "../src/storage/agents";
import { resolveApiToken } from "../src/storage/api-tokens";
import { resolveOAuthAccessToken } from "../src/storage/oauth";
import { addOrgMember, createOrg } from "../src/storage/orgs";
import { createSession } from "../src/storage/sessions";
import { getUserByToken } from "../src/storage/users";
import {
  mintWorkspaceGitCredential,
  resolveWorkspaceGitCredential,
} from "../src/storage/workspace-git-credentials";
import type { Env } from "../src/types";
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

const ORIGIN = "https://stratum.test";
const REDIRECT = "http://127.0.0.1:9876/callback";
const VERIFIER = "a".repeat(64);
const ALICE_LEGACY = "stratum_user_alice_legacy_key_0000000000";

/** A private project of the policy org, and one of Alice's own. */
const ORG_PROJECT = "/api/projects/@acme/app";
const OWN_PROJECT = "/api/projects/@alice/notes";

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let challenge = "";
let acmeId = "";
let globexId = "";
/** Alice's sessions: one with no second factor, one that passed a passkey. */
const cookies = { plain: "", passkey: "", bobPasskey: "" };

type Factors = { secondFactor?: "passkey" | "recovery_code"; ssoOrgId?: string };

async function session(userId: string, factors: Factors = {}): Promise<string> {
  const s = await createSession(env.DB, userId, logger, true, factors);
  if (!s.success) throw s.error;
  return `stratum_session=${s.data.id}`;
}

function setPolicy(slug: string, on: boolean): void {
  raw.prepare("UPDATE orgs SET require_second_factor = ? WHERE slug = ?").run(on ? 1 : 0, slug);
}

beforeAll(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = { DB: sqlite.db, STATE: makeFakeKV() } as unknown as Env;

  for (const [id, username, key] of [
    ["usr_alice", "alice", ALICE_LEGACY],
    ["usr_bob", "bob", "stratum_user_bob_legacy_key_000000000000"],
    ["usr_carol", "carol", "stratum_user_carol_legacy_key_0000000000"],
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(key))
      .run();
  }
  const acme = await createOrg(env.DB, logger, "usr_bob", "Acme", "acme");
  const globex = await createOrg(env.DB, logger, "usr_bob", "Globex", "globex");
  if (!acme.success || !globex.success) throw new Error("org setup");
  acmeId = acme.data.id;
  globexId = globex.data.id;
  await addOrgMember(env.DB, logger, acmeId, "usr_alice", "member");
  await addOrgMember(env.DB, logger, globexId, "usr_alice", "member");

  const projects: Array<Record<string, unknown>> = [
    {
      id: "proj_acme_private",
      slug: "app",
      namespace: "@acme",
      ownerId: acmeId,
      ownerType: "org",
      visibility: "private",
    },
    {
      id: "proj_globex_private",
      slug: "app",
      namespace: "@globex",
      ownerId: globexId,
      ownerType: "org",
      visibility: "private",
    },
    {
      id: "proj_alice",
      slug: "notes",
      namespace: "@alice",
      ownerId: "usr_alice",
      ownerType: "user",
      visibility: "private",
    },
  ];
  for (const p of projects) {
    const entry = {
      name: p.slug,
      remote: `https://acct.artifacts.cloudflare.net/git/x/${p.id}.git`,
      createdAt: new Date().toISOString(),
      ...p,
    };
    await env.STATE.put(`project:${p.namespace}:${p.slug}`, JSON.stringify(entry));
  }

  cookies.plain = await session("usr_alice");
  cookies.passkey = await session("usr_alice", { secondFactor: "passkey" });
  cookies.bobPasskey = await session("usr_bob", { secondFactor: "passkey" });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
});

let originalFetch: typeof fetch;
beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response("unexpected", { status: 599 })) as never;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Every test starts with no policy anywhere and a legacy key that records
  // nothing, then turns on what it is about.
  setPolicy("acme", false);
  setPolicy("globex", false);
  raw
    .prepare(
      "UPDATE users SET token_minted_second_factor = NULL, token_minted_sso_org_id = NULL, token_hash = ? WHERE id = 'usr_alice'",
    )
    .run(aliceLegacyHash);
});

let aliceLegacyHash = "";
beforeAll(async () => {
  aliceLegacyHash = await hashToken(ALICE_LEGACY);
});

async function withCookie(
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown; form?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers({ Cookie: cookie, Origin: ORIGIN });
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  } else if (init.form !== undefined) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  }
  return app.fetch(
    new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body }),
    env,
    ctx,
  );
}

async function withBearer(
  path: string,
  token: string,
  init: { method?: string; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(
    new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body }),
    env,
    ctx,
  );
}

async function gitClone(repo: string, token: string): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${repo}.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Basic ${btoa(`x:${token}`)}` },
    }),
    env,
    ctx,
  );
}

async function expectRefused(res: Response, org = "acme"): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ code: "SECOND_FACTOR_REQUIRED", org });
  // A credential cannot add a passkey to itself: its holder is told to mint
  // it again, not to enroll.
  expect(String(body.error)).toContain("create the credential again");
}

async function mintToken(cookie: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await withCookie("/api/users/me/tokens", cookie, {
    method: "POST",
    json: { name: `t-${crypto.randomUUID()}`, scope: "read_write", ...body },
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { plaintext?: string };
  if (typeof json.plaintext !== "string") throw new Error(`no token in ${JSON.stringify(json)}`);
  return json.plaintext;
}

async function mintAgent(auth: { cookie: string } | { bearer: string }): Promise<string> {
  const init = { method: "POST", json: { name: `a-${crypto.randomUUID()}` } };
  const res =
    "cookie" in auth
      ? await withCookie("/api/agents", auth.cookie, init)
      : await withBearer("/api/agents", auth.bearer, init);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { token?: string; plaintext?: string };
  const plaintext = json.token ?? json.plaintext;
  if (typeof plaintext !== "string") throw new Error(`no token in ${JSON.stringify(json)}`);
  return plaintext;
}

/** The whole consent flow: Allow in a browser session, then redeem the code. */
async function mintGrant(cookie: string): Promise<string> {
  const registered = await app.fetch(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Editor", redirect_uris: [REDIRECT] }),
    }),
    env,
    ctx,
  );
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const consent = await withCookie("/oauth/authorize", cookie, {
    method: "POST",
    form: {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      state: "xyz",
      decision: "allow",
    },
  });
  expect(consent.status).toBe(302);
  const code = new URL(consent.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  const redeemed = await app.fetch(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }).toString(),
    }),
    env,
    ctx,
  );
  expect(redeemed.status).toBe(200);
  return ((await redeemed.json()) as { access_token: string }).access_token;
}

describe("a credential minted before the policy was turned on", () => {
  it("is refused on the org's projects once the policy is on, and nowhere else", async () => {
    // Minted while no org required anything, from a session with no factor.
    const token = await mintToken(cookies.plain);
    expect((await withBearer(ORG_PROJECT, token)).status).toBe(200);

    setPolicy("acme", true);

    await expectRefused(await withBearer(ORG_PROJECT, token));
    // The org's own endpoints too, with the two exits a member always keeps.
    await expectRefused(await withBearer("/api/orgs/acme", token));
    expect((await withBearer("/api/orgs/acme/security", token)).status).toBe(200);
    // The policy reaches only what the org grants.
    expect((await withBearer(OWN_PROJECT, token)).status).toBe(200);
    expect((await withBearer("/api/projects/@globex/app", token)).status).toBe(200);
  });

  it("is restored by minting it again from a session that meets the policy", async () => {
    setPolicy("acme", true);
    const token = await mintToken(cookies.passkey);
    expect((await withBearer(ORG_PROJECT, token)).status).toBe(200);
    expect((await withBearer("/api/orgs/acme", token)).status).toBe(200);
  });

  it("is refused over git with a plain 403, not a credential-retry 404", async () => {
    const stale = await mintToken(cookies.plain);
    setPolicy("acme", true);

    const refused = await gitClone("/@acme/app", stale);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("X-Stratum-Error-Code")).toBe("SECOND_FACTOR_REQUIRED");
    expect(await refused.text()).toContain("create the credential again");
    // Refused before any upstream git traffic.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();

    // The same token still clones its owner's own repository: the request
    // gets past authorization and on to the (stubbed) git upstream.
    const own = await gitClone("/@alice/notes", stale);
    expect([403, 404]).not.toContain(own.status);

    const fresh = await mintToken(cookies.passkey);
    const allowed = await gitClone("/@acme/app", fresh);
    expect([403, 404]).not.toContain(allowed.status);
  });
});

describe("every kind of credential", () => {
  it("the legacy account key: refused until it is rotated from a satisfying session", async () => {
    setPolicy("acme", true);
    await expectRefused(await withBearer(ORG_PROJECT, ALICE_LEGACY));
    expect((await withBearer(OWN_PROJECT, ALICE_LEGACY)).status).toBe(200);

    const rotated = await withCookie("/api/users/me/rotate-token", cookies.passkey, {
      method: "POST",
    });
    expect(rotated.status).toBe(200);
    const json = (await rotated.json()) as { token?: string; plaintext?: string };
    const key = json.token ?? json.plaintext ?? "";
    expect((await withBearer(ORG_PROJECT, key)).status).toBe(200);
  });

  it("an agent: held to how its minter had signed in", async () => {
    const stale = await mintAgent({ cookie: cookies.plain });
    const fresh = await mintAgent({ cookie: cookies.passkey });
    setPolicy("acme", true);

    await expectRefused(await withBearer(ORG_PROJECT, stale));
    expect((await withBearer(OWN_PROJECT, stale)).status).toBe(200);
    expect((await withBearer(ORG_PROJECT, fresh)).status).toBe(200);
  });

  it("an OAuth grant: carries the consenting session's factors through the code", async () => {
    const stale = await mintGrant(cookies.plain);
    const fresh = await mintGrant(cookies.passkey);
    setPolicy("acme", true);

    await expectRefused(await withBearer(ORG_PROJECT, stale));
    expect((await withBearer(OWN_PROJECT, stale)).status).toBe(200);
    expect((await withBearer(ORG_PROJECT, fresh)).status).toBe(200);
  });

  it("a workspace git credential: satisfies only what its minter does", async () => {
    setPolicy("acme", true);
    const mint = (mintFactors?: Factors) =>
      mintWorkspaceGitCredential(env.DB, logger, {
        userId: "usr_alice",
        minter: { kind: "legacy_token" },
        projectId: "proj_acme_private",
        projectRef: "@acme/app",
        workspaceName: `ws-${crypto.randomUUID()}`,
        workspaceCreatedAt: new Date().toISOString(),
        ttlMinutes: 10,
        ...(mintFactors !== undefined ? { mintFactors } : {}),
      });

    const stale = await mint();
    const fresh = await mint({ secondFactor: "passkey" });
    if (!stale.success || !fresh.success) throw new Error("mint failed");

    const staleResolved = await resolveWorkspaceGitCredential(env.DB, stale.data.plaintext, logger);
    const freshResolved = await resolveWorkspaceGitCredential(env.DB, fresh.data.plaintext, logger);
    if (!staleResolved.success || !freshResolved.success) throw new Error("resolve failed");
    expect(staleResolved.data.policy?.unmetOrgs).toEqual([{ id: acmeId, slug: "acme" }]);
    expect(freshResolved.data.policy?.unmetOrgs).toEqual([]);
  });
});

describe("MCP tool calls", () => {
  // Tool calls reach the routers through their own sub-app, with its own
  // middleware chain, so the policy has to be mounted there as well.
  const viaMcp = (path: string, token: string) =>
    dispatchApiRequest(
      new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${token}` } }),
      env,
      ctx,
      "203.0.113.7",
    );

  it("refuses the org's projects and its own endpoints to an unsatisfying grant", async () => {
    const stale = await mintGrant(cookies.plain);
    const fresh = await mintGrant(cookies.passkey);
    setPolicy("acme", true);

    await expectRefused(await viaMcp(ORG_PROJECT, stale));
    await expectRefused(await viaMcp("/api/orgs/acme", stale));
    await expectRefused(await viaMcp("/api/orgs/acme/teams", stale));
    expect((await viaMcp(OWN_PROJECT, stale)).status).toBe(200);

    expect((await viaMcp(ORG_PROJECT, fresh)).status).toBe(200);
    expect((await viaMcp("/api/orgs/acme", fresh)).status).toBe(200);
  });
});

describe("what a credential mints inherits its own factors, and no more", () => {
  it("an agent created with an unsatisfying key is created, and reaches no policy org", async () => {
    setPolicy("acme", true);
    // Not refused: Alice may create an agent for her own projects whatever an
    // org she belongs to requires.
    const agent = await mintAgent({ bearer: ALICE_LEGACY });
    expect((await withBearer(OWN_PROJECT, agent)).status).toBe(200);
    await expectRefused(await withBearer(ORG_PROJECT, agent));
  });

  it("an agent created with a satisfying key satisfies the policy too", async () => {
    setPolicy("acme", true);
    raw
      .prepare("UPDATE users SET token_minted_second_factor = 'passkey' WHERE id = 'usr_alice'")
      .run();
    const agent = await mintAgent({ bearer: ALICE_LEGACY });
    expect((await withBearer(ORG_PROJECT, agent)).status).toBe(200);
  });
});

describe("the rule is the session's rule", () => {
  it("an SSO sign-in satisfies the org whose IdP it was, and only that org", async () => {
    const sso = await session("usr_alice", { ssoOrgId: acmeId });
    const token = await mintToken(sso);
    setPolicy("acme", true);
    setPolicy("globex", true);

    expect((await withBearer(ORG_PROJECT, token)).status).toBe(200);
    await expectRefused(await withBearer("/api/projects/@globex/app", token), "globex");
  });

  it("a recovery code counts, as it does for a session", async () => {
    const recovered = await session("usr_alice", { secondFactor: "recovery_code" });
    const token = await mintToken(recovered);
    setPolicy("acme", true);
    expect((await withBearer(ORG_PROJECT, token)).status).toBe(200);
  });

  it("applies to an org the owner joins after minting", async () => {
    // Carol mints while she belongs to no org at all.
    const carol = await session("usr_carol");
    const token = await mintToken(carol);
    setPolicy("acme", true);

    await addOrgMember(env.DB, logger, acmeId, "usr_carol", "member");
    try {
      await expectRefused(await withBearer(ORG_PROJECT, token));
    } finally {
      raw.prepare("DELETE FROM org_members WHERE user_id = 'usr_carol'").run();
    }
  });

  it("turning the policy off restores every credential", async () => {
    const token = await mintToken(cookies.plain);
    setPolicy("acme", true);
    await expectRefused(await withBearer(ORG_PROJECT, token));
    setPolicy("acme", false);
    expect((await withBearer(ORG_PROJECT, token)).status).toBe(200);
  });
});

describe("every resolver reports a policy", () => {
  // The auth paths read an absent policy as "nothing unmet", so that the many
  // test doubles returning a bare credential keep working. That is only safe
  // if no REAL resolver ever leaves it out, which is what this pins.
  it("for each credential kind, against the real schema", async () => {
    const unmet = [{ id: acmeId, slug: "acme" }];
    const apiToken = await mintToken(cookies.plain);
    const agentToken = await mintAgent({ cookie: cookies.plain });
    const grantToken = await mintGrant(cookies.passkey);
    setPolicy("acme", true);

    const token = await resolveApiToken(env.DB, apiToken, logger);
    expect(token.success && token.data.policy).toEqual({ factors: {}, unmetOrgs: unmet });

    const key = await getUserByToken(env.DB, ALICE_LEGACY, logger);
    expect(key.success && key.data.keyPolicy).toEqual({ factors: {}, unmetOrgs: unmet });

    const agent = await getAgentByToken(env.DB, agentToken, logger);
    expect(agent.success && agent.data.policy).toEqual({ factors: {}, unmetOrgs: unmet });

    const grant = await resolveOAuthAccessToken(env.DB, grantToken, logger);
    expect(grant.success && grant.data.policy).toEqual({
      factors: { secondFactor: "passkey" },
      unmetOrgs: [],
    });
  });
});

describe("GET /api/orgs/:slug/security: what the policy refuses", () => {
  it("tells an admin how many credentials are affected, before turning it on", async () => {
    // A clean slate: the earlier tests left credentials behind.
    raw.prepare("DELETE FROM api_tokens").run();
    raw.prepare("DELETE FROM agents").run();
    raw.prepare("DELETE FROM oauth_tokens").run();

    await mintToken(cookies.plain); // account-wide: counted
    await mintToken(cookies.plain, { org: "@acme" }); // bound to this org: counted
    await mintToken(cookies.plain, { project: "@acme/app" }); // its project: counted
    await mintToken(cookies.plain, { project: "@alice/notes" }); // elsewhere: not counted
    await mintToken(cookies.passkey); // satisfies the policy: not counted
    await mintAgent({ cookie: cookies.plain });
    await mintGrant(cookies.plain);
    // An expired token is not a live credential.
    raw
      .prepare(
        "INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, scope, expires_at, created_at) VALUES ('tok_old', 'usr_alice', 'old', 'h_old', 'p', 'read', '2020-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z')",
      )
      .run();

    const res = await withCookie("/api/orgs/acme/security", cookies.bobPasskey);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      requireSecondFactor: false,
      secondFactorImpact: {
        members: 1,
        apiTokens: 3,
        agents: 1,
        oauthGrants: 1,
        // Alice's and Bob's account keys: neither was rotated from a
        // session with a second factor.
        accountKeys: 2,
      },
    });
  });

  it("does not show the counts to a member who is not an admin", async () => {
    const res = await withCookie("/api/orgs/acme/security", cookies.passkey);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("secondFactorImpact");
  });
});
