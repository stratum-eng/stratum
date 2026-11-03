/**
 * Issue #409 (ADR 010): binding an agent identity to an MCP OAuth grant.
 *
 * Driven through the whole Worker (`src/index.ts`) against real SQLite, in the
 * style of `mcp-oauth-flow.test.ts`: a real consent POST, a real code exchange,
 * and then the resulting access token presented to the real middleware and the
 * real routes. The properties under test only exist when those pieces are
 * wired together. The bound grant has to authenticate as the agent everywhere,
 * revoking it has to end the agent's access, and the agent created at consent
 * must hold no credential of its own.
 *
 * Only change creation's evaluation pipeline is stubbed (it needs Artifacts and
 * the evaluators). The stub persists the change through the real storage layer
 * with exactly the actor the route hands it, which is where provenance and the
 * activity-feed actor both come from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/change-flow", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/change-flow")>();
  return { ...actual, createChangeWithEvaluation: vi.fn() };
});
vi.mock("../src/storage/state", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/state")>();
  return { ...actual, getProject: vi.fn(), getWorkspace: vi.fn() };
});
vi.mock("../src/storage/deletion", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/deletion")>();
  return { ...actual, isTargetDeleting: vi.fn(async () => false) };
});

import type { DatabaseSync } from "node:sqlite";
import app from "../src/index";
import { createChangeWithEvaluation } from "../src/services/change-flow";
import { createAgent, getAgentByToken } from "../src/storage/agents";
import { createChange } from "../src/storage/changes";
import { listGrantsForUser } from "../src/storage/oauth";
import { createSession } from "../src/storage/sessions";
import { getProject, getWorkspace } from "../src/storage/state";
import type { Env, ProjectEntry } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { AppError } from "../src/utils/errors";
import type { Logger } from "../src/utils/logger";
import { err, ok } from "../src/utils/result";
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
const REDIRECT = "http://127.0.0.1:9876/callback";
const VERIFIER = "a".repeat(64);

let env: Env;
let db: D1Database;
let raw: DatabaseSync;
let aliceCookie: string;
let CHALLENGE: string;

const project: ProjectEntry = {
  id: "proj_1",
  name: "api",
  slug: "api",
  namespace: "alice",
  ownerId: "usr_1",
  ownerType: "user",
  remote: "https://artifacts.example/repos/api",
  createdAt: "2026-01-01T00:00:00.000Z",
} as ProjectEntry;

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function fetchApp(path: string, init: RequestInit = {}): Promise<Response> {
  return await app.fetch(new Request(`${ORIGIN}${path}`, init), env);
}

async function register(clientName = "Claude Code"): Promise<string> {
  const response = await fetchApp("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT] }),
  });
  return ((await response.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string): string {
  return `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=S256&scope=mcp%3Awrite&state=xyz`;
}

/** The consent POST, with the "Connect as" fields merged in. */
function consent(
  clientId: string,
  actAs: Record<string, string>,
  cookie = aliceCookie,
): Promise<Response> {
  return fetchApp("/oauth/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      Cookie: cookie,
    },
    body: new URLSearchParams({
      decision: "allow",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "mcp:read mcp:write",
      code_challenge: CHALLENGE,
      state: "xyz",
      ...actAs,
    }).toString(),
  });
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

async function exchange(form: Record<string, string>): Promise<Response> {
  return fetchApp("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

/** Consent with the given identity and redeem the code. */
async function connect(
  clientId: string,
  actAs: Record<string, string>,
): Promise<{ status: number; tokens: Tokens }> {
  const consented = await consent(clientId, actAs);
  const location = consented.headers.get("location");
  if (location === null) throw new Error(`consent did not redirect (${consented.status})`);
  const code = new URL(location).searchParams.get("code") ?? "";
  const response = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: clientId,
  });
  return { status: response.status, tokens: (await response.json()) as Tokens };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

interface RpcReply {
  result?: { content?: Array<{ text: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

async function callTool(token: string, name: string, args: unknown = {}): Promise<RpcReply> {
  const response = await fetchApp("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return (await response.json()) as RpcReply;
}

function toolText(reply: RpcReply): string {
  return reply.result?.content?.map((part) => part.text).join("\n") ?? "";
}

function agentRows(): Array<{ id: string; name: string; owner_id: string; credential: string }> {
  return raw
    .prepare("SELECT id, name, owner_id, credential FROM agents ORDER BY id")
    .all() as Array<{
    id: string;
    name: string;
    owner_id: string;
    credential: string;
  }>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  env = { DB: db, STATE: {}, ARTIFACTS: {} } as unknown as Env;
  CHALLENGE = await pkceChallenge(VERIFIER);

  for (const [id, email, username] of [
    ["usr_1", "alice@test", "alice"],
    ["usr_2", "bob@test", "bob"],
  ] as const) {
    await db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, email, username, await hashToken(`legacy-${id}`))
      .run();
  }
  const session = await createSession(db, "usr_1", logger);
  if (!session.success) throw new Error("session setup failed");
  aliceCookie = `stratum_session=${session.data.id}`;

  vi.mocked(getProject).mockResolvedValue(ok(project));
  vi.mocked(getWorkspace).mockResolvedValue(
    ok({
      name: "fix",
      remote: "https://artifacts.example/repos/fix",
      parent: project.id,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  vi.mocked(createChangeWithEvaluation).mockImplementation(async (e, log, args) => {
    const change = await createChange(e.DB, log, {
      project: args.projectName,
      projectId: args.project.id,
      workspace: args.workspaceName,
      ...(args.actor.agentId !== undefined ? { agentId: args.actor.agentId } : {}),
      ...((args.actor.userId ?? args.actor.agentOwnerId) !== undefined
        ? { createdByUserId: (args.actor.userId ?? args.actor.agentOwnerId) as string }
        : {}),
    });
    if (!change.success) return err(new AppError("create failed", "DATABASE_ERROR", 500));
    if (args.queueRun) {
      return ok({ mode: "queued", change: change.data, runId: args.queueRun.runId } as never);
    }
    return ok({
      mode: "evaluated",
      change: change.data,
      evalResult: { score: 1, passed: true, reason: "stub" },
      evalRuns: [],
    } as never);
  });
});

describe("the consent screen", () => {
  it("offers a new agent by default, the user's own agents, and acting as the user", async () => {
    await createAgent(db, "usr_1", "release-bot", logger);
    await createAgent(db, "usr_2", "bobs-secret-agent", logger);
    const clientId = await register();

    const response = await fetchApp(authorizeUrl(clientId), { headers: { Cookie: aliceCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("Connect as");
    expect(html).toMatch(/<input type="radio" name="act_as" value="new" checked/);
    expect(html).toContain('name="agent_name" value="Claude Code"');
    expect(html).toContain("release-bot");
    // Only agents the signed-in user owns are offered.
    expect(html).not.toContain("bobs-secret-agent");
    expect(html).toContain('value="user"');
    expect(html).toContain("no agent provenance");
    // Server-rendered: the choice needs no script.
    expect(html).not.toMatch(/<script(?![^>]*nonce)[^>]*>[^<]*act_as/);
    // A label wrapping a radio plus another control would let the select or
    // text box change without moving the radio, submitting the wrong choice.
    const fieldset = html.slice(html.indexOf('class="consent-actas"'));
    for (const label of fieldset.match(/<label>[\s\S]*?<\/label>/g) ?? []) {
      expect(label.match(/<(input|select)\b/g)?.length).toBe(1);
    }
  });

  it("refuses to bind an agent the user does not own, and issues no code", async () => {
    const bobs = await createAgent(db, "usr_2", "bobs-agent", logger);
    if (!bobs.success) throw new Error("setup");
    const clientId = await register();

    const response = await consent(clientId, { act_as: "agent", agent_id: bobs.data.agent.id });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("does not exist or is not yours");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM oauth_auth_codes").get()).toEqual({ n: 0 });
  });

  it("refuses a new agent with no name", async () => {
    const clientId = await register();
    const response = await consent(clientId, { act_as: "new", agent_name: "   " });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("creates the agent at redemption, not at consent, so an unredeemed code leaves none", async () => {
    const clientId = await register();
    const consented = await consent(clientId, { act_as: "new", agent_name: "Claude on laptop" });
    expect(consented.status).toBe(302);
    expect(agentRows()).toEqual([]);
  });
});

describe("a grant bound to a new agent", () => {
  it("creates a grant-only agent with no usable token of its own", async () => {
    const clientId = await register();
    const { status } = await connect(clientId, {
      act_as: "new",
      agent_name: "Claude Code on my-laptop",
    });
    expect(status).toBe(200);

    const rows = agentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Claude Code on my-laptop",
      owner_id: "usr_1",
      credential: "oauth_grant",
    });
    const bound = raw.prepare("SELECT agent_id FROM oauth_tokens").get() as { agent_id: string };
    expect(bound.agent_id).toBe(rows[0]?.id);
  });

  it("authenticates as the agent: whoami says so, and a change carries the agent", async () => {
    const clientId = await register();
    const { tokens } = await connect(clientId, { act_as: "new", agent_name: "Claude Code" });
    const agentId = agentRows()[0]?.id;

    const who = await callTool(tokens.access_token, "stratum_whoami");
    expect(who.error).toBeUndefined();
    const identity = JSON.parse(toolText(who)) as Record<string, unknown>;
    expect(identity).toEqual({
      actingAs: "agent",
      agent: { id: agentId, name: "Claude Code" },
      owner: { id: "usr_1", username: "alice" },
    });
    // The agent acts for the owner but is not handed their email.
    expect(toolText(who)).not.toContain("alice@test");

    const created = await fetchApp("/api/projects/api/changes", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(tokens.access_token) },
      body: JSON.stringify({ workspace: "fix" }),
    });
    expect(created.status).toBe(201);
    // The route handed the pipeline an AGENT actor acting for alice, with no
    // human userId: the same actor an agent token produces. That actor is what
    // the event pipeline records as `{ type: "agent" }` for the activity feed
    // and what provenance snapshots at merge.
    const actor = vi.mocked(createChangeWithEvaluation).mock.calls[0]?.[2].actor;
    expect(actor).toEqual({ agentId, agentOwnerId: "usr_1" });
    const row = raw.prepare("SELECT agent_id, created_by_user_id FROM changes").get();
    expect(row).toEqual({ agent_id: agentId, created_by_user_id: "usr_1" });
  });

  it("keeps the agent across a refresh", async () => {
    const clientId = await register();
    const { tokens } = await connect(clientId, { act_as: "new", agent_name: "Claude Code" });
    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as Tokens;
    const who = JSON.parse(toolText(await callTool(rotated.access_token, "stratum_whoami")));
    expect(who.actingAs).toBe("agent");
    expect(agentRows()).toHaveLength(1);
  });

  it("cannot approve a change: approval stays with a signed-in human", async () => {
    const clientId = await register();
    const { tokens } = await connect(clientId, { act_as: "new", agent_name: "Claude Code" });
    const response = await fetchApp("/api/changes/chg_any/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(tokens.access_token) },
      body: JSON.stringify({ verdict: "approve" }),
    });
    expect(response.status).toBe(401);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM change_reviews").get()).toEqual({ n: 0 });
  });

  it("cannot mint an agent token", async () => {
    const clientId = await register();
    const { tokens } = await connect(clientId, { act_as: "new", agent_name: "Claude Code" });
    const response = await fetchApp("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(tokens.access_token) },
      body: JSON.stringify({ name: "escape-hatch" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.status).toBeLessThan(404);
    expect(agentRows()).toHaveLength(1);
  });
});

describe("the agent's access lives exactly as long as the grant", () => {
  it("ends when the grant is revoked over RFC 7009", async () => {
    const clientId = await register();
    const { tokens } = await connect(clientId, { act_as: "new", agent_name: "Claude Code" });
    expect((await callTool(tokens.access_token, "stratum_whoami")).error).toBeUndefined();

    await fetchApp("/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh_token }).toString(),
    });

    const after = await fetchApp("/api/users/me", { headers: bearer(tokens.access_token) });
    expect(after.status).toBe(401);
    // The agent row survives, because provenance references it, but nothing
    // can authenticate as it any more.
    expect(agentRows()).toHaveLength(1);
  });

  it("ends when the user disconnects it from settings", async () => {
    const clientId = await register();
    const { tokens } = await connect(clientId, { act_as: "new", agent_name: "Claude Code" });
    const grantId = (raw.prepare("SELECT id FROM oauth_tokens").get() as { id: string }).id;

    const disconnect = await fetchApp(`/settings/connections/${grantId}/revoke`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: aliceCookie },
    });
    expect(disconnect.status).toBeLessThan(400);

    const after = await fetchApp("/api/users/me", { headers: bearer(tokens.access_token) });
    expect(after.status).toBe(401);
  });

  it("ends when the agent is deleted, rather than falling back to acting as the user", async () => {
    const existing = await createAgent(db, "usr_1", "release-bot", logger);
    if (!existing.success) throw new Error("setup");
    const clientId = await register();
    const { tokens } = await connect(clientId, {
      act_as: "agent",
      agent_id: existing.data.agent.id,
    });
    expect((await fetchApp("/api/users/me", { headers: bearer(tokens.access_token) })).status).toBe(
      200,
    );

    raw.prepare("DELETE FROM agents WHERE id = ?").run(existing.data.agent.id);
    const after = await fetchApp("/api/users/me", { headers: bearer(tokens.access_token) });
    expect(after.status).toBe(401);
  });

  it("refuses the grant if its agent changed hands after consent", async () => {
    const existing = await createAgent(db, "usr_1", "release-bot", logger);
    if (!existing.success) throw new Error("setup");
    const clientId = await register();
    const { tokens } = await connect(clientId, {
      act_as: "agent",
      agent_id: existing.data.agent.id,
    });
    raw.prepare("UPDATE agents SET owner_id = 'usr_2' WHERE id = ?").run(existing.data.agent.id);
    const after = await fetchApp("/api/users/me", { headers: bearer(tokens.access_token) });
    expect(after.status).toBe(401);
  });

  it("never lets a grant-only agent authenticate with an agent token", async () => {
    const clientId = await register();
    await connect(clientId, { act_as: "new", agent_name: "Claude Code" });
    const agentId = agentRows()[0]?.id as string;
    // Simulate the impossible: someone holds a plaintext that hashes to the row.
    const forged = "stratum_agent_forged0000000000000000000000";
    raw
      .prepare("UPDATE agents SET token_hash = ? WHERE id = ?")
      .run(await hashToken(forged), agentId);
    const lookup = await getAgentByToken(db, forged, logger);
    expect(lookup.success).toBe(false);
  });
});

describe("binding an existing agent", () => {
  it("acts as that agent without minting anything new", async () => {
    const existing = await createAgent(db, "usr_1", "release-bot", logger);
    if (!existing.success) throw new Error("setup");
    const clientId = await register();
    const { tokens } = await connect(clientId, {
      act_as: "agent",
      agent_id: existing.data.agent.id,
    });
    const who = JSON.parse(toolText(await callTool(tokens.access_token, "stratum_whoami")));
    expect(who.agent).toEqual({ id: existing.data.agent.id, name: "release-bot" });
    expect(agentRows()).toHaveLength(1);
    // The agent's own token is independent of the grant and still works.
    expect((await getAgentByToken(db, existing.data.plaintext, logger)).success).toBe(true);
  });
});

describe("grants that act as the user", () => {
  it("keep working as before, and whoami labels them", async () => {
    const clientId = await register();
    const { tokens } = await connect(clientId, { act_as: "user" });
    const who = JSON.parse(toolText(await callTool(tokens.access_token, "stratum_whoami")));
    expect(who).toMatchObject({ actingAs: "user", id: "usr_1", email: "alice@test" });
    expect(agentRows()).toEqual([]);
  });

  it("is the reading of a consent form that predates the choice", async () => {
    // A consent page rendered before this change has no `act_as` field, and
    // what it offered was "act as you".
    const clientId = await register();
    const { tokens } = await connect(clientId, {});
    const who = JSON.parse(toolText(await callTool(tokens.access_token, "stratum_whoami")));
    expect(who.actingAs).toBe("user");
  });

  it("are labelled in the connected-applications listing", async () => {
    const clientId = await register();
    await connect(clientId, { act_as: "user" });
    await connect(clientId, { act_as: "new", agent_name: "Claude Code" });
    const listed = await listGrantsForUser(db, logger, "usr_1");
    if (!listed.success) throw new Error("listing failed");
    const labels = listed.data.map((grant) => grant.agent?.name ?? "user").sort();
    expect(labels).toEqual(["Claude Code", "user"]);

    const settings = await fetchApp("/settings", { headers: { Cookie: aliceCookie } });
    const html = await settings.text();
    expect(html).toContain("You (no agent provenance)");
    expect(html).toContain("Agent: Claude Code");
  });
});
