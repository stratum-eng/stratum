/**
 * Org second-factor policy (#256) at credential minting.
 *
 * The policy is enforced per request against the session's own factors, but a
 * credential minted by that session is not a session: once issued it reaches
 * the org's resources with no policy check. So a session short of some org's
 * policy must not mint anything that could reach that org. These tests run the
 * whole Worker (`src/index.ts`) against a real SQLite D1, through every mint
 * door: API tokens, the legacy key, agents, and the OAuth consent that issues
 * MCP/CLI grants, each over both the JSON API and the settings forms.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { addOrgMember, createOrg } from "../src/storage/orgs";
import { createSession } from "../src/storage/sessions";
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

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let challenge = "";
/** Alice is in `acme` (requires a second factor) and `other` (does not). */
const cookies = { unmet: "", passkey: "", noPolicy: "" };

async function session(userId: string, secondFactor?: "passkey"): Promise<string> {
  const s = await createSession(
    env.DB,
    userId,
    logger,
    true,
    secondFactor !== undefined ? { secondFactor } : {},
  );
  if (!s.success) throw s.error;
  return `stratum_session=${s.data.id}`;
}

beforeAll(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = { DB: sqlite.db, STATE: makeFakeKV() } as unknown as Env;

  for (const [id, username] of [
    ["usr_alice", "alice"],
    ["usr_bob", "bob"],
    ["usr_carol", "carol"],
  ]) {
    await env.DB.prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(`legacy-${id}`))
      .run();
  }
  const acme = await createOrg(env.DB, logger, "usr_bob", "Acme", "acme");
  const other = await createOrg(env.DB, logger, "usr_bob", "Other", "other");
  if (!acme.success || !other.success) throw new Error("org setup");
  await addOrgMember(env.DB, logger, acme.data.id, "usr_alice", "member");
  await addOrgMember(env.DB, logger, other.data.id, "usr_alice", "member");
  raw.prepare("UPDATE orgs SET require_second_factor = 1 WHERE slug = 'acme'").run();

  // Projects a token can be bound to: the policy org's (public and private)
  // and one of Alice's own.
  const projects: Array<Record<string, unknown>> = [
    {
      id: "proj_acme_public",
      slug: "site",
      namespace: "@acme",
      ownerId: acme.data.id,
      ownerType: "org",
      visibility: "public",
    },
    {
      id: "proj_acme_private",
      slug: "app",
      namespace: "@acme",
      ownerId: acme.data.id,
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

  cookies.unmet = await session("usr_alice");
  cookies.passkey = await session("usr_alice", "passkey");
  cookies.noPolicy = await session("usr_carol");

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
beforeEach(() => vi.clearAllMocks());

async function call(
  path: string,
  init: { method?: string; cookie: string; json?: unknown; form?: Record<string, string> },
): Promise<Response> {
  const headers = new Headers({ Cookie: init.cookie, Origin: ORIGIN });
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

async function expectRefused(res: Response, opts: { bindable: boolean }): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ code: "SECOND_FACTOR_REQUIRED", org: "acme" });
  expect(String(body.error)).toContain("/settings/security");
  expect(String(body.error).includes("limit the token")).toBe(opts.bindable);
}

function count(table: string, where = "1=1"): number {
  return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number })
    .n;
}

describe("API tokens (POST /api/users/me/tokens)", () => {
  it("refuses an unbound token while an org's policy is unmet", async () => {
    const before = count("api_tokens");
    await expectRefused(
      await call("/api/users/me/tokens", {
        method: "POST",
        cookie: cookies.unmet,
        json: { name: "ci" },
      }),
      { bindable: true },
    );
    expect(count("api_tokens")).toBe(before);
  });

  it("refuses binding a token to the org whose policy is unmet", async () => {
    const res = await call("/api/users/me/tokens", {
      method: "POST",
      cookie: cookies.unmet,
      json: { name: "ci", org: "@acme" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      code: "SECOND_FACTOR_REQUIRED",
      org: "acme",
    });
  });

  it("still allows a token bound to an org outside the policy", async () => {
    const res = await call("/api/users/me/tokens", {
      method: "POST",
      cookie: cookies.unmet,
      json: { name: "other-only", org: "@other" },
    });
    expect(res.status).toBe(201);
  });

  it("allows an unbound token once the session has a passkey, or with no policy orgs", async () => {
    for (const cookie of [cookies.passkey, cookies.noPolicy]) {
      const res = await call("/api/users/me/tokens", {
        method: "POST",
        cookie,
        json: { name: `ok-${Math.random()}` },
      });
      expect(res.status).toBe(201);
    }
  });
});

describe("project-bound tokens decide on the project's owning org", () => {
  async function mintBound(cookie: string, project: string): Promise<Response> {
    return call("/api/users/me/tokens", {
      method: "POST",
      cookie,
      json: { name: `bound-${Math.random()}`, project },
    });
  }

  it("refuses a token bound to a PUBLIC project of the policy org", async () => {
    // Public means anyone can read it, but the token would still carry the
    // member's write access there, which the policy withholds.
    const before = count("api_tokens");
    const res = await mintBound(cookies.unmet, "@acme/site");
    expect(res.status).toBe(403);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      code: "SECOND_FACTOR_REQUIRED",
      org: "acme",
    });
    expect(count("api_tokens")).toBe(before);
  });

  it("refuses a token bound to a private project of the policy org", async () => {
    const res = await mintBound(cookies.unmet, "@acme/app");
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("SECOND_FACTOR_REQUIRED");
  });

  it("allows a token bound to the member's own project", async () => {
    expect((await mintBound(cookies.unmet, "@alice/notes")).status).toBe(201);
  });

  it("allows the policy org's projects once the policy is met", async () => {
    expect((await mintBound(cookies.passkey, "@acme/site")).status).toBe(201);
    expect((await mintBound(cookies.passkey, "@acme/app")).status).toBe(201);
  });

  it("refuses the public-project binding on the settings form too", async () => {
    const res = await call("/settings/tokens", {
      method: "POST",
      cookie: cookies.unmet,
      form: { name: "ci", project: "@acme/site" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("requires a second factor");
  });
});

describe("legacy key rotation", () => {
  it("refuses over the API and the settings form, and leaves the key unchanged", async () => {
    const hashBefore = raw.prepare("SELECT token_hash FROM users WHERE id = 'usr_alice'").get();
    await expectRefused(
      await call("/api/users/me/rotate-token", { method: "POST", cookie: cookies.unmet }),
      { bindable: false },
    );
    const form = await call("/settings/rotate-token", {
      method: "POST",
      cookie: cookies.unmet,
      form: {},
    });
    expect(form.status).toBe(403);
    expect(await form.text()).toContain("requires a second factor");
    expect(raw.prepare("SELECT token_hash FROM users WHERE id = 'usr_alice'").get()).toEqual(
      hashBefore,
    );
  });

  it("rotates once the policy is met", async () => {
    const res = await call("/api/users/me/rotate-token", {
      method: "POST",
      cookie: cookies.passkey,
    });
    expect(res.status).toBe(200);
  });
});

describe("agents", () => {
  it("refuses an agent over the API and the settings form", async () => {
    const before = count("agents");
    await expectRefused(
      await call("/api/agents", { method: "POST", cookie: cookies.unmet, json: { name: "bot" } }),
      { bindable: false },
    );
    const form = await call("/settings/agents", {
      method: "POST",
      cookie: cookies.unmet,
      form: { name: "bot" },
    });
    expect(form.status).toBe(403);
    expect(await form.text()).toContain("requires a second factor");
    expect(count("agents")).toBe(before);
  });

  it("creates the agent once the policy is met, or with no policy orgs", async () => {
    for (const cookie of [cookies.passkey, cookies.noPolicy]) {
      const res = await call("/api/agents", { method: "POST", cookie, json: { name: "bot" } });
      expect(res.status).toBe(201);
    }
  });
});

describe("API token settings form", () => {
  it("refuses an unbound token and a token bound to the policy org", async () => {
    const before = count("api_tokens");
    const unbound = await call("/settings/tokens", {
      method: "POST",
      cookie: cookies.unmet,
      form: { name: "ci" },
    });
    expect(unbound.status).toBe(403);
    expect(await unbound.text()).toContain("limit the token to a project or organization");

    const bound = await call("/settings/tokens", {
      method: "POST",
      cookie: cookies.unmet,
      form: { name: "ci", bindKind: "org", bindOrg: "acme", org: "acme" },
    });
    // Rendered as the settings page, not swapped for the middleware's JSON.
    expect(bound.status).toBe(403);
    expect(bound.headers.get("Content-Type") ?? "").toContain("text/html");
    expect(await bound.text()).toContain("requires a second factor");
    expect(count("api_tokens")).toBe(before);
  });
});

describe("SCIM token (org admin minting for the org)", () => {
  it("is refused by the org-route policy for a policy org", async () => {
    const res = await call("/api/orgs/acme/sso/scim-token", {
      method: "POST",
      cookie: cookies.unmet,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("SECOND_FACTOR_REQUIRED");
  });
});

describe("OAuth consent (MCP and CLI grants)", () => {
  async function registerClient(): Promise<string> {
    const res = await app.fetch(
      new Request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Editor", redirect_uris: [REDIRECT] }),
      }),
      env,
      ctx,
    );
    return ((await res.json()) as { client_id: string }).client_id;
  }

  function authorizeQuery(clientId: string): string {
    return `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
  }

  it("shows the refusal instead of the consent screen, and the POST issues no code", async () => {
    const clientId = await registerClient();
    const page = await call(`/oauth/authorize?${authorizeQuery(clientId)}`, {
      cookie: cookies.unmet,
    });
    const html = await page.text();
    expect(html).toContain("Second factor required");
    expect(html).not.toContain('name="decision"');

    const before = count("oauth_auth_codes");
    const post = await call("/oauth/authorize", {
      method: "POST",
      cookie: cookies.unmet,
      form: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        state: "xyz",
        decision: "allow",
      },
    });
    expect(post.status).not.toBe(302);
    expect(await post.text()).toContain("requires a second factor");
    expect(count("oauth_auth_codes")).toBe(before);
  });

  it("issues a code once the policy is met", async () => {
    const clientId = await registerClient();
    const post = await call("/oauth/authorize", {
      method: "POST",
      cookie: cookies.passkey,
      form: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        state: "xyz",
        decision: "allow",
      },
    });
    expect(post.status).toBe(302);
    expect(post.headers.get("Location") ?? "").toContain("code=");
  });
});
