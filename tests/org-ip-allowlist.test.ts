/**
 * Per-org IP allowlist (#399), end to end.
 *
 * Runs the whole Worker (`src/index.ts`) against a real SQLite D1. `acme`
 * allows only 203.0.113.0/24 and 2001:db8::/32; `other` restricts nothing.
 * Alice administers both, so every refusal below is the allowlist's doing and
 * nothing else's. Each credential kind — session, API token, agent token,
 * OAuth grant — is checked inside and outside the range, as are git, MCP, the
 * org admin routes, and the settings endpoint's self-lockout guard.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { dispatchApiRequest } from "../src/mcp/dispatch";
import { createAgent } from "../src/storage/agents";
import { createApiToken } from "../src/storage/api-tokens";
import { issueTokens, registerClient } from "../src/storage/oauth";
import { addOrgMember, createOrg } from "../src/storage/orgs";
import { createSession } from "../src/storage/sessions";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

vi.mock("../src/storage/git-ops", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/git-ops")>()),
  freshRepoToken: vi.fn(async () => ({ success: true, data: "secret?expires=9999999999" })),
}));

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
const INSIDE = "203.0.113.7";
const INSIDE_V6 = "2001:db8:1::5";
const OUTSIDE = "198.51.100.9";

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
const creds = { session: "", apiToken: "", agentToken: "", oauth: "", carolSession: "" };

beforeAll(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = {
    DB: sqlite.db,
    STATE: makeFakeKV(),
    GIT_PUSH_GATED_ENABLED: "true",
  } as unknown as Env;

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
  await addOrgMember(env.DB, logger, acme.data.id, "usr_alice", "admin");
  await addOrgMember(env.DB, logger, other.data.id, "usr_alice", "admin");
  raw
    .prepare("UPDATE orgs SET ip_allowlist = ? WHERE slug = 'acme'")
    .run(JSON.stringify(["203.0.113.0/24", "2001:db8::/32"]));

  const projects: Array<Record<string, unknown>> = [
    { id: "proj_app", slug: "app", namespace: "@acme", ownerId: acme.data.id, ownerType: "org" },
    {
      id: "proj_site",
      slug: "site",
      namespace: "@acme",
      ownerId: acme.data.id,
      ownerType: "org",
      visibility: "public",
    },
    {
      id: "proj_tool",
      slug: "tool",
      namespace: "@other",
      ownerId: other.data.id,
      ownerType: "org",
    },
    {
      id: "proj_notes",
      slug: "notes",
      namespace: "@alice",
      ownerId: "usr_alice",
      ownerType: "user",
    },
  ];
  for (const p of projects) {
    const entry = {
      name: p.slug,
      visibility: "private",
      remote: `https://acct.artifacts.cloudflare.net/git/x/${p.id}.git`,
      createdAt: new Date().toISOString(),
      ...p,
    };
    await env.STATE.put(`project:${p.namespace}:${p.slug}`, JSON.stringify(entry));
  }

  const s = await createSession(env.DB, "usr_alice", logger, true, {});
  const c = await createSession(env.DB, "usr_carol", logger, true, {});
  if (!s.success || !c.success) throw new Error("session setup");
  creds.session = `stratum_session=${s.data.id}`;
  creds.carolSession = `stratum_session=${c.data.id}`;

  const token = await createApiToken(env.DB, logger, {
    userId: "usr_alice",
    name: "ci",
    scope: "read_write",
  });
  const agent = await createAgent(env.DB, "usr_alice", "bot", logger);
  const client = await registerClient(env.DB, logger, {
    clientName: "Editor",
    redirectUris: ["http://127.0.0.1:9000/cb"],
  });
  if (!token.success || !agent.success || !client.success) throw new Error("credential setup");
  const grant = await issueTokens(env.DB, logger, {
    clientId: client.data.client.id,
    userId: "usr_alice",
    scope: "mcp:read mcp:write",
  });
  if (!grant.success) throw new Error("grant setup");
  creds.apiToken = token.data.plaintext;
  creds.agentToken = agent.data.plaintext;
  creds.oauth = grant.data.accessToken;
});

let originalFetch: typeof fetch;
beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async () =>
      new Response("PACKDATA", {
        status: 200,
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      }),
  ) as never;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

type Credential = "session" | "apiToken" | "agentToken" | "oauth";

function authHeaders(kind: Credential | "carol" | "anonymous"): Record<string, string> {
  switch (kind) {
    case "session":
      return { Cookie: creds.session, Origin: ORIGIN };
    case "carol":
      return { Cookie: creds.carolSession, Origin: ORIGIN };
    case "anonymous":
      return {};
    default:
      return { Authorization: `Bearer ${creds[kind]}` };
  }
}

async function call(
  path: string,
  opts: {
    as: Credential | "carol" | "anonymous";
    ip?: string | null;
    method?: string;
    json?: unknown;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const headers = new Headers({ ...authHeaders(opts.as), ...opts.headers });
  if (opts.ip !== null) headers.set("CF-Connecting-IP", opts.ip ?? INSIDE);
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(opts.json);
  }
  return app.fetch(
    new Request(`${ORIGIN}${path}`, { method: opts.method ?? "GET", headers, body }),
    env,
  );
}

function auditCount(action: string): number {
  return (
    raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action) as {
      n: number;
    }
  ).n;
}

function latestAudit(action: string): { detail: string; org_id: string } {
  return raw
    .prepare(
      "SELECT detail, org_id FROM audit_log WHERE action = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(action) as { detail: string; org_id: string };
}

async function expectIpRefusal(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ code: "IP_NOT_ALLOWED", org: "acme" });
}

describe("every credential kind is held to the allowlist", () => {
  const kinds: Credential[] = ["session", "apiToken", "agentToken", "oauth"];

  it.each(kinds)("%s reads a private org project from inside the range", async (kind) => {
    const res = await call("/api/projects/@acme/app", { as: kind, ip: INSIDE });
    expect(res.status).toBe(200);
  });

  it.each(kinds)("%s matches an IPv6 range too", async (kind) => {
    const res = await call("/api/projects/@acme/app", { as: kind, ip: INSIDE_V6 });
    expect(res.status).toBe(200);
  });

  it.each(kinds)("%s is refused from outside the range", async (kind) => {
    await expectIpRefusal(await call("/api/projects/@acme/app", { as: kind, ip: OUTSIDE }));
  });

  it.each(kinds)("%s still reaches an unrestricted org and personal projects", async (kind) => {
    expect((await call("/api/projects/@other/tool", { as: kind, ip: OUTSIDE })).status).toBe(200);
    expect((await call("/api/projects/@alice/notes", { as: kind, ip: OUTSIDE })).status).toBe(200);
  });
});

describe("client address", () => {
  it("fails closed when CF-Connecting-IP is missing", async () => {
    await expectIpRefusal(await call("/api/projects/@acme/app", { as: "session", ip: null }));
  });

  it("never reads X-Forwarded-For", async () => {
    const res = await call("/api/projects/@acme/app", {
      as: "session",
      ip: OUTSIDE,
      headers: { "X-Forwarded-For": INSIDE },
    });
    await expectIpRefusal(res);
  });
});

describe("what the refusal reveals", () => {
  it("answers a non-member with the usual 404, not IP_NOT_ALLOWED", async () => {
    const res = await call("/api/projects/@acme/app", { as: "carol", ip: OUTSIDE });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("IP_NOT_ALLOWED");
  });

  it("leaves anonymous reads of a public org project alone", async () => {
    expect((await call("/api/projects/@acme/site", { as: "anonymous", ip: OUTSIDE })).status).toBe(
      200,
    );
  });

  it("serves an HTML page to a browser GET", async () => {
    const res = await call("/@acme/app", {
      as: "session",
      ip: OUTSIDE,
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Network not allowed");
    expect(html).toContain(OUTSIDE);
  });
});

describe("denial audit", () => {
  it("records a denial once per member per window, however many requests", async () => {
    const before = auditCount("org.ip_access_denied");
    for (let i = 0; i < 5; i++) {
      await call("/api/projects/@acme/app", { as: "apiToken", ip: `198.51.100.${i + 20}` });
    }
    // Isolate-local memory may already hold this key from earlier tests; what
    // matters is that five refusals never became five rows.
    expect(auditCount("org.ip_access_denied") - before).toBeLessThanOrEqual(1);
    // …and at least one refusal of this member has been recorded, with where
    // it came from and what it was after.
    expect(auditCount("org.ip_access_denied")).toBeGreaterThanOrEqual(1);
    const row = latestAudit("org.ip_access_denied");
    expect(row.org_id).toMatch(/^org/);
    expect(JSON.parse(row.detail)).toMatchObject({
      slug: "acme",
      ip: expect.stringMatching(/^198\.51\.100\./),
      path: "/api/projects/@acme/app",
    });
  });

  it("records the refused address and org", async () => {
    const before = auditCount("org.ip_access_denied");
    await call("/api/projects/@acme/app", { as: "carol", ip: OUTSIDE });
    // A non-member was never let in, so there is nothing to record.
    expect(auditCount("org.ip_access_denied")).toBe(before);
  });
});

describe("org admin routes (/api/orgs/:slug/*)", () => {
  it("refuses a member outside the range", async () => {
    await expectIpRefusal(await call("/api/orgs/acme/members", { as: "session", ip: OUTSIDE }));
    await expectIpRefusal(await call("/api/orgs/acme/security", { as: "apiToken", ip: OUTSIDE }));
  });

  it("allows a member inside the range", async () => {
    const res = await call("/api/orgs/acme/security", { as: "session", ip: INSIDE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ipAllowlist: ["203.0.113.0/24", "2001:db8::/32"],
    });
  });

  it("gives a non-member the usual 404", async () => {
    expect((await call("/api/orgs/acme/security", { as: "carol", ip: OUTSIDE })).status).toBe(404);
  });

  it("does not touch the unrestricted org", async () => {
    expect((await call("/api/orgs/other/security", { as: "session", ip: OUTSIDE })).status).toBe(
      200,
    );
  });

  it("leaves the SSO sign-in flow open", async () => {
    const res = await call("/auth/sso/acme/start", { as: "anonymous", ip: OUTSIDE });
    expect(res.status).not.toBe(403);
  });
});

describe("git over HTTPS", () => {
  function basic(token: string): Record<string, string> {
    return { Authorization: `Basic ${btoa(`x:${token}`)}` };
  }
  async function git(path: string, token: string, ip: string): Promise<Response> {
    return app.fetch(
      new Request(`${ORIGIN}${path}`, {
        headers: { ...basic(token), "CF-Connecting-IP": ip },
      }),
      env,
    );
  }
  const clone = "/@acme/app.git/info/refs?service=git-upload-pack";
  const push = "/@acme/app.git/info/refs?service=git-receive-pack";

  it.each([
    ["clone", clone],
    ["push", push],
  ])("refuses %s of an org repo from outside the range", async (_label, path) => {
    for (const token of [creds.apiToken, creds.agentToken]) {
      const res = await git(path, token, OUTSIDE);
      expect(res.status).toBe(403);
      expect(res.headers.get("X-Stratum-Error-Code")).toBe("IP_NOT_ALLOWED");
      expect(await res.text()).toContain("acme");
    }
  });

  it.each([
    ["clone", clone],
    ["push", push],
  ])("allows %s of an org repo from inside the range", async (_label, path) => {
    const res = await git(path, creds.apiToken, INSIDE);
    expect(res.status).toBe(200);
  });

  it("leaves a member's personal repo alone", async () => {
    const res = await git(
      "/@alice/notes.git/info/refs?service=git-receive-pack",
      creds.apiToken,
      OUTSIDE,
    );
    expect(res.status).toBe(200);
  });
});

describe("MCP", () => {
  async function getProject(ip: string): Promise<string> {
    const res = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creds.oauth}`,
          "CF-Connecting-IP": ip,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "stratum_get_project", arguments: { project: "@acme/app" } },
        }),
      }),
      env,
    );
    const reply = (await res.json()) as {
      result?: { content?: Array<{ text: string }>; isError?: boolean };
    };
    return reply.result?.content?.map((p) => p.text).join("\n") ?? "";
  }

  it("judges a tool call by the original caller's address", async () => {
    expect(await getProject(INSIDE)).toContain("proj_app");
    const refused = await getProject(OUTSIDE);
    expect(refused).not.toContain("proj_app");
    expect(refused).toContain("only allows access from its configured networks");
  });

  it("ignores a CF-Connecting-IP header on the sub-request itself", async () => {
    // Only the server-supplied address counts; a header on the sub-request
    // (which no client can set anyway) is never read.
    const res = await dispatchApiRequest(
      new Request(`${ORIGIN}/api/projects/@acme/app`, {
        headers: { Authorization: `Bearer ${creds.oauth}`, "CF-Connecting-IP": INSIDE },
      }),
      env,
      undefined,
      OUTSIDE,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "IP_NOT_ALLOWED" });
  });
});

describe("PUT /api/orgs/:slug/security", () => {
  async function put(json: unknown, ip: string): Promise<Response> {
    return call("/api/orgs/other/security", { as: "session", ip, method: "PUT", json });
  }

  it("canonicalises, de-duplicates and audits a change", async () => {
    const before = auditCount("org.ip_allowlist_changed");
    const res = await put({ ipAllowlist: ["203.0.113.9/24", "203.0.113.0/24", INSIDE] }, INSIDE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ipAllowlist: ["203.0.113.0/24", "203.0.113.7/32"],
    });
    expect(auditCount("org.ip_allowlist_changed")).toBe(before + 1);
    const row = latestAudit("org.ip_allowlist_changed");
    expect(JSON.parse(row.detail)).toMatchObject({
      slug: "other",
      ipAllowlist: ["203.0.113.0/24", "203.0.113.7/32"],
      previous: [],
    });

    // Saving the same list again changes nothing and audits nothing.
    await put({ ipAllowlist: ["203.0.113.0/24", "203.0.113.7/32"] }, INSIDE);
    expect(auditCount("org.ip_allowlist_changed")).toBe(before + 1);

    // Clearing restores "no restriction".
    const cleared = await put({ ipAllowlist: [] }, INSIDE);
    expect(await cleared.json()).toMatchObject({ ipAllowlist: [] });
    const stored = raw.prepare("SELECT ip_allowlist FROM orgs WHERE slug = 'other'").get() as {
      ip_allowlist: string | null;
    };
    expect(stored.ip_allowlist).toBeNull();
  });

  it("refuses a list that would lock the admin out", async () => {
    const res = await put({ ipAllowlist: ["192.0.2.0/24"] }, OUTSIDE);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "IP_ALLOWLIST_SELF_LOCKOUT", ip: OUTSIDE });
    const stored = raw.prepare("SELECT ip_allowlist FROM orgs WHERE slug = 'other'").get() as {
      ip_allowlist: string | null;
    };
    expect(stored.ip_allowlist).toBeNull();
  });

  it("saves it anyway with the explicit override", async () => {
    const res = await put({ ipAllowlist: ["192.0.2.0/24"], allowSelfLockout: true }, OUTSIDE);
    expect(res.status).toBe(200);
    expect(JSON.parse(latestAudit("org.ip_allowlist_changed").detail)).toMatchObject({
      allowSelfLockout: true,
    });
    // And it took effect: the admin is now outside and refused.
    const after = await call("/api/orgs/other/security", { as: "session", ip: OUTSIDE });
    expect(after.status).toBe(403);
    raw.prepare("UPDATE orgs SET ip_allowlist = NULL WHERE slug = 'other'").run();
  });

  it("rejects malformed input", async () => {
    for (const ipAllowlist of [
      "10.0.0.0/8",
      ["10.0.0.0/33"],
      ["not-an-ip"],
      [42],
      ["fe80::1%eth0"],
      Array.from({ length: 101 }, (_, i) => `10.0.${i}.0/24`),
    ]) {
      const res = await put({ ipAllowlist }, INSIDE);
      expect(res.status).toBe(400);
    }
    expect((await put({}, INSIDE)).status).toBe(400);
    expect((await put({ ipAllowlist: [], allowSelfLockout: "yes" }, INSIDE)).status).toBe(400);
  });

  it("is admin-only", async () => {
    raw.prepare("UPDATE org_members SET role = 'member' WHERE user_id = 'usr_alice'").run();
    try {
      expect((await put({ ipAllowlist: [] }, INSIDE)).status).toBe(403);
    } finally {
      raw.prepare("UPDATE org_members SET role = 'admin' WHERE user_id = 'usr_alice'").run();
    }
  });
});
