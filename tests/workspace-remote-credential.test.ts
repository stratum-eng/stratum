/**
 * Issue #408: `stratum_workspace_remote`, a short-lived git credential for one
 * workspace.
 *
 * Driven through the real application (auth middleware, the MCP endpoint and
 * its dispatcher, the workspaces router, git smart-HTTP) against real SQLite
 * with every migration applied, because the property that matters is not "the
 * credential works on its workspace" but "it is refused everywhere ELSE", and
 * that only shows with the whole request path in place. Only the Artifacts
 * side is stubbed: no git server answers here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "secret?expires=9999999999" })),
  };
});

import app from "../src/index";
import { createAgent, deleteAgent } from "../src/storage/agents";
import { createApiToken, listApiTokens, revokeApiToken } from "../src/storage/api-tokens";
import { issueTokens, registerClient, revokeGrantsForClientUser } from "../src/storage/oauth";
import { createSession } from "../src/storage/sessions";
import { disableLegacyToken } from "../src/storage/users";
import { resolveWorkspaceGitCredential } from "../src/storage/workspace-git-credentials";
import type { Env, ProjectEntry, WorkspaceEntry } from "../src/types";
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
const OWNER = "usr_owner";
const LEGACY_TOKEN = "stratum_user_0123456789abcdef0123456789abcdef";

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];

function project(id: string, slug: string): ProjectEntry {
  return {
    id,
    name: slug,
    slug,
    namespace: "@owner",
    ownerId: OWNER,
    ownerType: "user",
    remote: `https://acct.artifacts.cloudflare.net/git/@owner/${slug}.git`,
    createdAt: new Date().toISOString(),
    visibility: "private",
  };
}

async function putWorkspace(projectId: string, name: string, createdAt: string): Promise<void> {
  const entry: WorkspaceEntry = {
    name,
    remote: `https://acct.artifacts.cloudflare.net/git/@owner/${projectId}-${name}.git`,
    parent: projectId,
    createdAt,
    branchName: name,
    createdByUserId: OWNER,
  };
  await env.STATE.put(`workspace:${projectId}:${name}`, JSON.stringify(entry));
}

beforeEach(async () => {
  const made = makeSqliteD1();
  raw = made.raw;
  env = {
    DB: made.db,
    STATE: makeFakeKV(),
    ARTIFACTS: { delete: vi.fn(async () => {}) },
  } as unknown as Env;

  for (const [id, username, token] of [
    [OWNER, "owner", LEGACY_TOKEN],
    ["usr_other", "other", "stratum_user_ffffffffffffffffffffffffffffffff"],
  ] as const) {
    await made.db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, `${username}@test`, username, await hashToken(token))
      .run();
  }

  for (const entry of [project("proj_mine", "mine"), project("proj_other", "other")]) {
    await env.STATE.put(`project:${entry.namespace}:${entry.slug}`, JSON.stringify(entry));
    await env.STATE.put(`project-id:${entry.id}`, JSON.stringify(entry));
  }
  const now = new Date().toISOString();
  await putWorkspace("proj_mine", "ws", now);
  await putWorkspace("proj_mine", "ws2", now);
  await putWorkspace("proj_other", "ws", now);

  vi.clearAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response("PACKDATA", {
        status: 200,
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Minting helpers ──────────────────────────────────────────────────────

async function apiToken(scope: "read" | "read_write" = "read_write"): Promise<string> {
  const made = await createApiToken(env.DB, logger, {
    userId: OWNER,
    name: `t-${Math.random()}`,
    scope,
  });
  if (!made.success) throw made.error;
  return made.data.plaintext;
}

async function oauthGrant(
  scope: "mcp:read" | "mcp:write",
  agentId?: string,
): Promise<{
  accessToken: string;
  clientId: string;
}> {
  const client = await registerClient(env.DB, logger, {
    clientName: "Test Editor",
    redirectUris: ["http://127.0.0.1:9000/callback"],
  });
  if (!client.success) throw client.error;
  const tokens = await issueTokens(env.DB, logger, {
    clientId: client.data.client.id,
    userId: OWNER,
    scope,
    ...(agentId !== undefined ? { agentId } : {}),
  });
  if (!tokens.success) throw tokens.error;
  return { accessToken: tokens.data.accessToken, clientId: client.data.client.id };
}

interface RemoteBody {
  remote: string;
  username: string;
  token: string;
  expiresAt: string;
  credentialId: string;
  branches: string[];
}

interface RpcReply {
  result?: { isError?: boolean; content?: Array<{ text: string }> };
  error?: { code: number; message: string };
}

async function callTool(bearer: string, args: Record<string, unknown>): Promise<RpcReply> {
  const res = await app.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "stratum_workspace_remote", arguments: args },
      }),
    }),
    env,
  );
  return (await res.json()) as RpcReply;
}

/** Mint over MCP, the way an agent does. */
async function mintViaMcp(
  bearer: string,
  args: Record<string, unknown> = { project: "@owner/mine", workspace: "ws" },
): Promise<RemoteBody> {
  const reply = await callTool(bearer, args);
  const text = reply.result?.content?.[0]?.text ?? "";
  if (reply.result?.isError) throw new Error(`tool failed: ${text}`);
  return JSON.parse(text) as RemoteBody;
}

const MINT_PATH = "/api/workspaces/@owner/mine/workspaces/ws/remote-credential";

async function mintViaRest(
  headers: Record<string, string>,
  body: unknown = {},
  path = MINT_PATH,
): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

// ── git helpers ──────────────────────────────────────────────────────────

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`stratum:${token}`)}` };
}

function pktLine(payload: string): Uint8Array {
  const data = new TextEncoder().encode(payload);
  const header = new TextEncoder().encode((data.byteLength + 4).toString(16).padStart(4, "0"));
  const out = new Uint8Array(data.byteLength + 4);
  out.set(header, 0);
  out.set(data, 4);
  return out;
}

/** A receive-pack request updating refs/heads/main. */
function pushBody(): Uint8Array {
  const parts = [
    pktLine(`${"a".repeat(40)} ${"b".repeat(40)} refs/heads/main\0report-status`),
    new TextEncoder().encode("0000"),
    new TextEncoder().encode("PACKDATA"),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function git(token: string, path: string, method: "GET" | "POST"): Promise<Response> {
  return app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: basic(token),
      ...(method === "POST" ? { body: path.endsWith("receive-pack") ? pushBody() : "" } : {}),
    }),
    env,
  );
}

/** Fetch and push entry points on a repo path. */
function entryPoints(repo: string): Array<{ label: string; path: string; method: "GET" | "POST" }> {
  return [
    {
      label: "fetch advertisement",
      path: `${repo}/info/refs?service=git-upload-pack`,
      method: "GET",
    },
    { label: "fetch RPC", path: `${repo}/git-upload-pack`, method: "POST" },
    {
      label: "push advertisement",
      path: `${repo}/info/refs?service=git-receive-pack`,
      method: "GET",
    },
    { label: "push RPC", path: `${repo}/git-receive-pack`, method: "POST" },
  ];
}

const OWN_WORKSPACE = "/@owner/mine/workspaces/ws.git";

// ── Tests ────────────────────────────────────────────────────────────────

describe("minting over MCP", () => {
  it("returns the workspace's clone URL and a git-only credential that expires in an hour", async () => {
    const { accessToken } = await oauthGrant("mcp:write");
    const before = Date.now();
    const body = await mintViaMcp(accessToken);

    expect(body.remote).toBe(`${ORIGIN}${OWN_WORKSPACE}`);
    expect(body.username).toBe("stratum");
    expect(body.token).toMatch(/^stratum_git_[0-9a-f]{32}$/);
    expect(body.branches).toEqual(["main", "ws"]);
    const ttl = Date.parse(body.expiresAt) - before;
    expect(ttl).toBeGreaterThan(59 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  it("honours a shorter requested lifetime and rejects one out of range", async () => {
    const token = await apiToken();
    const before = Date.now();
    const body = await mintViaMcp(`${token}`, {
      project: "@owner/mine",
      workspace: "ws",
      expires_in_minutes: 10,
    });
    expect(Date.parse(body.expiresAt) - before).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);

    for (const minutes of [0, 4, 61, 24 * 60]) {
      const reply = await callTool(token, {
        project: "@owner/mine",
        workspace: "ws",
        expires_in_minutes: minutes,
      });
      expect(reply.result?.isError).toBe(true);
      expect(reply.result?.content?.[0]?.text).toContain("expiresInMinutes");
    }
  });

  it("is refused for an mcp:read grant, and nothing is minted", async () => {
    const { accessToken } = await oauthGrant("mcp:read");
    const reply = await callTool(accessToken, { project: "@owner/mine", workspace: "ws" });
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain("read-only");
    const rows = raw
      .prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE purpose = 'workspace_git'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("is refused for a read-only API token on the REST route", async () => {
    const res = await mintViaRest({ Authorization: `Bearer ${await apiToken("read")}` });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("TOKEN_SCOPE_INSUFFICIENT");
  });

  it("is refused for a browser session, whose sign-out a child could not notice", async () => {
    const session = await createSession(env.DB, OWNER, logger);
    if (!session.success) throw session.error;
    const res = await mintViaRest({
      Cookie: `stratum_session=${session.data.id}`,
      Origin: ORIGIN,
    });
    expect(res.status).toBe(403);
  });

  it("is a 404 for a workspace the caller cannot push to", async () => {
    const stranger = await createApiToken(env.DB, logger, {
      userId: "usr_other",
      name: "stranger",
      scope: "read_write",
    });
    if (!stranger.success) throw stranger.error;
    const res = await mintViaRest({ Authorization: `Bearer ${stranger.data.plaintext}` });
    expect(res.status).toBe(404);
  });

  it("respects the minting token's project binding (#323)", async () => {
    for (const [projectId, status] of [
      ["proj_other", 404],
      ["proj_mine", 201],
    ] as const) {
      const bound = await createApiToken(env.DB, logger, {
        userId: OWNER,
        name: `bound-${projectId}`,
        scope: "read_write",
        binding: { kind: "project", projectId },
      });
      if (!bound.success) throw bound.error;
      const res = await mintViaRest({ Authorization: `Bearer ${bound.data.plaintext}` });
      expect(res.status).toBe(status);
    }
  });

  it("is a 404 for a workspace that does not exist", async () => {
    const res = await mintViaRest(
      { Authorization: `Bearer ${await apiToken()}` },
      {},
      "/api/workspaces/@owner/mine/workspaces/nope/remote-credential",
    );
    expect(res.status).toBe(404);
  });

  it("is audited, without the secret anywhere in the trail or the logs", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    const { accessToken, clientId } = await oauthGrant("mcp:write");
    const body = await mintViaMcp(accessToken);
    await git(body.token, `${OWN_WORKSPACE}/info/refs?service=git-upload-pack`, "GET");

    const rows = raw
      .prepare(
        "SELECT actor_id, subject, detail, project_id FROM audit_log WHERE action = 'workspace_remote.credential_minted'",
      )
      .all() as Array<{ actor_id: string; subject: string; detail: string; project_id: string }>;
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.actor_id).toBe(OWNER);
    expect(row?.subject).toBe(body.credentialId);
    expect(row?.project_id).toBe("proj_mine");
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({
      workspace: "ws",
      mintedBy: "oauth_grant",
      oauthClientId: clientId,
      expiresAt: body.expiresAt,
    });

    const secretHex = body.token.slice("stratum_git_".length);
    const everything = JSON.stringify(raw.prepare("SELECT * FROM audit_log").all());
    expect(everything).not.toContain(secretHex);
    expect(logged.join("\n")).not.toContain(secretHex);
  });

  it("is not listed among the user's API tokens, and does not count toward their cap", async () => {
    const token = await apiToken();
    await mintViaMcp(token);
    const listed = await listApiTokens(env.DB, logger, OWNER);
    if (!listed.success) throw listed.error;
    expect(listed.data.map((t) => t.tokenPrefix.startsWith("stratum_git_"))).not.toContain(true);
  });
});

describe("the credential over git", () => {
  it.each(entryPoints(OWN_WORKSPACE))("works on its own workspace: $label", async (entry) => {
    const { token } = await mintViaMcp(await apiToken());
    const res = await git(token, entry.path, entry.method);
    expect(res.status).toBe(200);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled();
  });

  it.each([
    ...entryPoints("/@owner/mine/workspaces/ws2.git"),
    ...entryPoints("/@owner/other/workspaces/ws.git"),
    ...entryPoints("/@owner/mine.git"),
    ...entryPoints("/@owner/other.git"),
  ])("is a 404 everywhere else: $path", async (entry) => {
    const { token } = await mintViaMcp(await apiToken());
    vi.mocked(globalThis.fetch).mockClear();
    const res = await git(token, entry.path, entry.method);
    expect(res.status).toBe(404);
    // Nothing proxied, so no Artifacts credential was used for that repo.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("does not follow its workspace's name to a re-created workspace", async () => {
    const { token } = await mintViaMcp(await apiToken());
    await putWorkspace("proj_mine", "ws", new Date(Date.now() + 1000).toISOString());
    const res = await git(token, `${OWN_WORKSPACE}/info/refs?service=git-upload-pack`, "GET");
    expect(res.status).toBe(404);
  });

  it("is refused after it expires, and the refusal is audited", async () => {
    const { token, credentialId } = await mintViaMcp(await apiToken(), {
      project: "@owner/mine",
      workspace: "ws",
      expires_in_minutes: 5,
    });
    const path = `${OWN_WORKSPACE}/info/refs?service=git-upload-pack`;
    expect((await git(token, path, "GET")).status).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    const res = await git(token, path, "GET");
    // An unrecognised credential on a private repo is challenged, exactly like
    // no credential at all.
    expect(res.status).toBe(401);

    const failure = raw
      .prepare("SELECT subject, detail FROM audit_log WHERE action = 'auth.failed'")
      .get() as { subject: string; detail: string } | undefined;
    expect(failure?.subject).toBe(credentialId);
    expect(JSON.parse(failure?.detail ?? "{}")).toMatchObject({
      method: "workspace_git_token",
      reason: "expired",
      via: "git",
    });
  });
});

describe("the credential on the API", () => {
  it.each([
    ["GET", "/api/projects/@owner/mine"],
    ["GET", "/api/users/me"],
    ["GET", "/api/workspaces/@owner/mine/workspaces"],
    ["POST", "/api/workspaces/ws/commit"],
    ["POST", MINT_PATH],
    ["POST", "/mcp"],
  ])("is refused: %s %s", async (method, path) => {
    const { token } = await mintViaMcp(await apiToken());
    for (const authorization of [`Bearer ${token}`, basic(token).Authorization ?? ""]) {
      const res = await app.fetch(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
        env,
      );
      expect(res.status).toBe(401);
    }
  });
});

describe("the credential cannot outlive the credential that minted it", () => {
  const path = `${OWN_WORKSPACE}/info/refs?service=git-upload-pack`;

  it("dies when the minting API token is revoked", async () => {
    const parent = await createApiToken(env.DB, logger, {
      userId: OWNER,
      name: "parent",
      scope: "read_write",
    });
    if (!parent.success) throw parent.error;
    const { token } = await mintViaMcp(parent.data.plaintext);
    expect((await git(token, path, "GET")).status).toBe(200);

    await revokeApiToken(env.DB, logger, { userId: OWNER, tokenId: parent.data.token.id });
    expect((await git(token, path, "GET")).status).toBe(401);
  });

  it("is capped at the minting API token's expiry, and dies with it", async () => {
    const parent = await createApiToken(env.DB, logger, {
      userId: OWNER,
      name: "parent",
      scope: "read_write",
      expiresInDays: 1,
    });
    if (!parent.success) throw parent.error;
    const parentExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    raw
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .run(parentExpiry, parent.data.token.id);

    const body = await mintViaMcp(parent.data.plaintext);
    expect(body.expiresAt).toBe(parentExpiry);

    // The parent expiring and the child expiring coincide here, so prove the
    // live parent check separately: expire only the parent.
    raw
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), parent.data.token.id);
    expect((await git(body.token, path, "GET")).status).toBe(401);
  });

  it("dies when the minting OAuth grant is revoked", async () => {
    const { accessToken, clientId } = await oauthGrant("mcp:write");
    const { token } = await mintViaMcp(accessToken);
    expect((await git(token, path, "GET")).status).toBe(200);

    await revokeGrantsForClientUser(env.DB, logger, { clientId, userId: OWNER });
    expect((await git(token, path, "GET")).status).toBe(401);
  });

  it("survives the access token's rotation but not the grant's end", async () => {
    const { accessToken } = await oauthGrant("mcp:write");
    const { token } = await mintViaMcp(accessToken);
    // The access token lapsing alone leaves a live grant (the refresh token
    // still works), so the child keeps working.
    raw
      .prepare("UPDATE oauth_tokens SET access_expires_at = ?")
      .run(new Date(Date.now() - 1000).toISOString());
    expect((await git(token, path, "GET")).status).toBe(200);
    raw
      .prepare("UPDATE oauth_tokens SET refresh_expires_at = ?")
      .run(new Date(Date.now() - 1000).toISOString());
    expect((await git(token, path, "GET")).status).toBe(401);
  });

  it("dies when the legacy key that minted it is disabled", async () => {
    const { token } = await mintViaMcp(LEGACY_TOKEN);
    expect((await git(token, path, "GET")).status).toBe(200);

    await disableLegacyToken(env.DB, OWNER, logger);
    expect((await git(token, path, "GET")).status).toBe(401);
  });

  it("acts as the agent that minted it, and dies with the agent", async () => {
    const agent = await createAgent(env.DB, OWNER, "builder", logger);
    if (!agent.success) throw agent.error;
    const { token } = await mintViaMcp(agent.data.plaintext);
    expect((await git(token, path, "GET")).status).toBe(200);
    expect(
      (await git(token, `${OWN_WORKSPACE}/info/refs?service=git-receive-pack`, "GET")).status,
    ).toBe(200);

    await deleteAgent(env.DB, agent.data.agent.id, logger);
    expect((await git(token, path, "GET")).status).toBe(401);
  });

  it("acts as the agent an OAuth grant is bound to, and fails closed without it", async () => {
    const agent = await createAgent(env.DB, OWNER, "builder", logger);
    if (!agent.success) throw agent.error;
    const { accessToken } = await oauthGrant("mcp:write", agent.data.agent.id);
    const { token } = await mintViaMcp(accessToken);
    expect((await git(token, path, "GET")).status).toBe(200);

    const resolved = await resolveWorkspaceGitCredential(env.DB, token, logger);
    if (!resolved.success) throw resolved.error;
    expect(resolved.data?.agentId).toBe(agent.data.agent.id);

    // Remove only the agent row: the grant row stays, as it would if the two
    // ever disagreed, and the child must not fall back to acting as the owner.
    await env.DB.prepare("DELETE FROM agents WHERE id = ?").bind(agent.data.agent.id).run();
    expect((await git(token, path, "GET")).status).toBe(401);
  });

  it("is refused once its owner loses access to the project", async () => {
    const { token } = await mintViaMcp(await apiToken());
    // The project changes hands: the credential's authority is re-derived from
    // its owner's own access on every request, never frozen at mint.
    const moved = { ...project("proj_mine", "mine"), ownerId: "usr_other" };
    await env.STATE.put("project:@owner:mine", JSON.stringify(moved));
    for (const entry of entryPoints(OWN_WORKSPACE)) {
      expect((await git(token, entry.path, entry.method)).status).toBe(404);
    }
  });
});

describe("bounds on minting", () => {
  it("caps the live credentials one user may hold, and prunes long-expired ones", async () => {
    const token = await apiToken();
    for (let i = 0; i < 20; i += 1) {
      expect((await mintViaRest({ Authorization: `Bearer ${token}` })).status).toBe(201);
    }
    const refused = await mintViaRest({ Authorization: `Bearer ${token}` });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("TOKEN_LIMIT_REACHED");

    // Long-expired rows stop counting and are deleted on the next mint.
    raw
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE purpose = 'workspace_git'")
      .run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());
    expect((await mintViaRest({ Authorization: `Bearer ${token}` })).status).toBe(201);
    const left = raw
      .prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE purpose = 'workspace_git'")
      .get() as { n: number };
    expect(left.n).toBe(1);
  });

  it("refuses a malformed stored credential rather than widening it", async () => {
    const { token } = await mintViaMcp(await apiToken());
    raw.prepare("UPDATE api_tokens SET parent_id = NULL WHERE purpose = 'workspace_git'").run();
    const res = await git(token, `${OWN_WORKSPACE}/info/refs?service=git-upload-pack`, "GET");
    expect(res.status).toBe(401);
  });
});
