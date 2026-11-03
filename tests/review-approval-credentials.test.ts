/**
 * Approvals are made by a signed-in human.
 *
 * `approve` is the human half of the merge gate (`merge.requiredApprovals`).
 * The credentials agents are handed — OAuth grants (MCP clients, `stratum
 * login`) and scoped API tokens — may request changes or comment, which can
 * only block, but may not approve. A browser session approves; the legacy user
 * key keeps working, as it does for agent minting (#376).
 *
 * Driven through the whole Worker against real SQLite, so the credential is
 * resolved by the real auth middleware and the MCP tool lands on the real
 * reviews route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { createApiToken } from "../src/storage/api-tokens";
import { createChange } from "../src/storage/changes";
import { issueTokens, registerClient } from "../src/storage/oauth";
import { createSession } from "../src/storage/sessions";
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
const LEGACY_KEY = "stratum_user_11111111111111111111111111111111";

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let changeId: string;
let grantToken: string;
let scopedToken: string;
let sessionCookie: string;

type Auth = { bearer: string } | { session: true };

async function review(auth: Auth, verdict: string, id = changeId): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: ORIGIN,
  };
  if ("bearer" in auth) headers.Authorization = `Bearer ${auth.bearer}`;
  else headers.Cookie = sessionCookie;
  return app.fetch(
    new Request(`${ORIGIN}/api/changes/${id}/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify({ verdict }),
    }),
    env,
    ctx,
  );
}

function approvals(): number {
  return (
    raw
      .prepare(
        "SELECT COUNT(*) AS n FROM change_reviews WHERE change_id = ? AND verdict = 'approve'",
      )
      .get(changeId) as { n: number }
  ).n;
}

function status(): string {
  return (
    raw.prepare("SELECT status FROM changes WHERE id = ?").get(changeId) as { status: string }
  ).status;
}

beforeEach(async () => {
  const made = makeSqliteD1();
  raw = made.raw;
  const db = made.db;
  env = { DB: db, STATE: makeFakeKV() } as unknown as Env;

  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind("usr_1", "alice@test", "alice", await hashToken(LEGACY_KEY))
    .run();

  const project: ProjectEntry = {
    id: "proj_1",
    name: "repo",
    slug: "repo",
    namespace: "@alice",
    ownerId: "usr_1",
    ownerType: "user",
    remote: "https://acct.artifacts.cloudflare.net/git/x/proj_1.git",
    createdAt: new Date().toISOString(),
    visibility: "private",
  };
  await env.STATE.put("project:@alice:repo", JSON.stringify(project));

  const change = await createChange(db, logger, {
    project: "@alice/repo",
    projectId: "proj_1",
    workspace: "ws",
  });
  if (!change.success) throw change.error;
  changeId = change.data.id;

  const client = await registerClient(db, logger, {
    clientName: "Editor",
    redirectUris: ["http://127.0.0.1:9000/cb"],
  });
  if (!client.success) throw client.error;
  const grant = await issueTokens(db, logger, {
    clientId: client.data.client.id,
    userId: "usr_1",
    scope: "mcp:read mcp:write",
  });
  if (!grant.success) throw grant.error;
  grantToken = grant.data.accessToken;

  const scoped = await createApiToken(db, logger, {
    userId: "usr_1",
    name: "ci",
    scope: "read_write",
  });
  if (!scoped.success) throw scoped.error;
  scopedToken = scoped.data.plaintext;

  const session = await createSession(db, "usr_1", logger);
  if (!session.success) throw session.error;
  sessionCookie = `stratum_session=${session.data.id}`;
});

describe("approve", () => {
  it.each([
    ["an OAuth grant", () => grantToken],
    ["a scoped API token", () => scopedToken],
  ])("is refused for %s, records nothing, and points at the browser", async (_label, token) => {
    const res = await review({ bearer: token() }, "approve");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string; approveUrl: string };
    expect(body.code).toBe("SESSION_REQUIRED");
    expect(body.error).toContain("approve in the browser");
    expect(body.approveUrl).toBe(`/changes/${changeId}`);
    expect(approvals()).toBe(0);
    expect(status()).toBe("open");
  });

  it("works from a browser session", async () => {
    const res = await review({ session: true }, "approve");
    expect(res.status).toBe(201);
    expect(approvals()).toBe(1);
    expect(status()).toBe("approved");
  });

  it("still works with the legacy user key", async () => {
    const res = await review({ bearer: LEGACY_KEY }, "approve");
    expect(res.status).toBe(201);
    expect(approvals()).toBe(1);
  });
});

describe("request_changes", () => {
  it.each([
    ["an OAuth grant", () => grantToken],
    ["a scoped API token", () => scopedToken],
  ])("is still allowed for %s, because it can only block", async (_label, token) => {
    const res = await review({ bearer: token() }, "request_changes");
    expect(res.status).toBe(201);
    expect(status()).toBe("needs_changes");
  });
});

describe("while evaluation is pending (#412)", () => {
  beforeEach(() => {
    raw
      .prepare("UPDATE changes SET status = 'evaluating', eval_run_id = 'erun_1' WHERE id = ?")
      .run(changeId);
  });

  it("refuses an approval, because nothing pins the revision the reviewer saw", async () => {
    const res = await review({ session: true }, "approve");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("EVALUATION_PENDING");
    expect(approvals()).toBe(0);
    expect(status()).toBe("evaluating");
  });

  it("records request_changes without taking the status from the pending run", async () => {
    const res = await review({ session: true }, "request_changes");
    expect(res.status).toBe(201);
    expect(status()).toBe("evaluating");
  });
});

describe("over MCP", () => {
  async function tool(verdict: string): Promise<{ isError?: boolean; text: string }> {
    const res = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${grantToken}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "stratum_review_change", arguments: { change_id: changeId, verdict } },
        }),
      }),
      env,
      ctx,
    );
    const reply = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
    return {
      ...(reply.result?.isError !== undefined ? { isError: reply.result.isError } : {}),
      text: reply.result?.content?.map((part) => part.text).join("\n") ?? "",
    };
  }

  it("refuses an approve verdict from the review tool", async () => {
    const result = await tool("approve");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("approve in the browser");
    expect(approvals()).toBe(0);
  });

  it("accepts request_changes from the review tool", async () => {
    const result = await tool("request_changes");
    expect(result.isError).toBeUndefined();
    expect(status()).toBe("needs_changes");
  });
});
