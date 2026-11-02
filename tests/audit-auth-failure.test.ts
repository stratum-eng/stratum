import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { emailAuthRouter } from "../src/routes/email-auth";
import { createAgent } from "../src/storage/agents";
import { createApiToken, revokeApiToken } from "../src/storage/api-tokens";
import { consumeMagicLink, createMagicLink } from "../src/storage/magic-links";
import type { Env } from "../src/types";
import { AUTH_FAILURE_DEDUPE_MS, recordAuthFailure } from "../src/utils/auth-audit";
import { hashToken } from "../src/utils/crypto";
import { createLogger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeMagicLinkLimiters } from "./helpers/magic-link-limiter";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * Failed-authentication auditing (#255). Policy under test: a refused
 * credential is recorded only when it identifies a real account, at most once
 * per subject per minute; unknown credentials never reach the table.
 */

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

const logger = createLogger({ component: "Test" });
const LEGACY = "stratum_user_alice_legacy";
let raw: Raw;
let env: Env;
let app: Hono<{ Bindings: Env }>;

interface FailureRow {
  actor_type: string;
  actor_id: string | null;
  subject: string | null;
  org_id: string | null;
  detail: string;
}

function failures(): FailureRow[] {
  return raw
    .prepare(
      "SELECT actor_type, actor_id, subject, org_id, detail FROM audit_log WHERE action = 'auth.failed' ORDER BY rowid",
    )
    .all() as unknown as FailureRow[];
}

function whoami(token: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request("http://localhost/api/whoami", { headers: { Authorization: `Bearer ${token}` } }),
      env,
    ),
  );
}

beforeEach(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeFakeKV(),
    DB: sqlite.db,
    MAGIC_LINK_LIMITER: makeMagicLinkLimiters().namespace,
  };
  raw
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .run("usr_alice", "alice@example.com", "alice", await hashToken(LEGACY));
  app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.get("/api/whoami", (c) => c.json({ userId: c.get("userId") ?? null }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bearer credentials", () => {
  it("records a revoked scoped token against its owner, once per minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
    const minted = await createApiToken(env.DB, logger, {
      userId: "usr_alice",
      name: "laptop",
      scope: "read_write",
    });
    if (!minted.success) throw minted.error;
    await revokeApiToken(env.DB, logger, { userId: "usr_alice", tokenId: minted.data.token.id });

    expect((await whoami(minted.data.plaintext)).status).toBe(401);
    expect((await whoami(minted.data.plaintext)).status).toBe(401);
    expect((await whoami(minted.data.plaintext)).status).toBe(401);
    expect(failures()).toHaveLength(1);
    const [row] = failures();
    expect(row).toMatchObject({
      actor_type: "user",
      actor_id: "usr_alice",
      subject: minted.data.token.id,
    });
    expect(JSON.parse(row?.detail ?? "{}")).toEqual({ method: "api_token", reason: "revoked" });

    // Past the dedupe window the next attempt is recorded again.
    vi.setSystemTime(new Date(Date.now() + AUTH_FAILURE_DEDUPE_MS + 1000));
    expect((await whoami(minted.data.plaintext)).status).toBe(401);
    expect(failures()).toHaveLength(2);
  });

  it("records an expired scoped token", async () => {
    const minted = await createApiToken(env.DB, logger, {
      userId: "usr_alice",
      name: "ci",
      scope: "read",
    });
    if (!minted.success) throw minted.error;
    raw
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", minted.data.token.id);

    expect((await whoami(minted.data.plaintext)).status).toBe(401);
    expect(failures().map((r) => JSON.parse(r.detail))).toEqual([
      { method: "api_token", reason: "expired" },
    ]);
  });

  it("does NOT record a credential that identifies nobody", async () => {
    for (const token of [
      "stratum_user_nonsense",
      "stratum_agent_nonsense",
      "stratum_mcp_nonsense",
      "garbage",
    ]) {
      expect((await whoami(token)).status).toBe(401);
    }
    expect(failures()).toEqual([]);
  });

  it("records a disabled account's legacy token and its agents' tokens", async () => {
    const agent = await createAgent(env.DB, "usr_alice", "bot", logger);
    if (!agent.success) throw agent.error;
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = ?")
      .run("2026-11-01T00:00:00.000Z", "usr_alice");

    expect((await whoami(LEGACY)).status).toBe(401);
    expect((await whoami(agent.data.plaintext)).status).toBe(401);

    const rows = failures();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_type: "user", actor_id: "usr_alice" });
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      method: "legacy_token",
      reason: "owner-disabled",
    });
    expect(rows[1]).toMatchObject({ actor_type: "agent", actor_id: agent.data.agent.id });
    expect(JSON.parse(rows[1]?.detail ?? "{}")).toMatchObject({
      method: "agent_token",
      reason: "owner-disabled",
      ownerId: "usr_alice",
    });
  });

  it("never changes the auth outcome when the audit write fails", async () => {
    const minted = await createApiToken(env.DB, logger, {
      userId: "usr_alice",
      name: "x",
      scope: "read_write",
    });
    if (!minted.success) throw minted.error;
    await revokeApiToken(env.DB, logger, { userId: "usr_alice", tokenId: minted.data.token.id });
    raw.exec("DROP TABLE audit_log");
    expect((await whoami(minted.data.plaintext)).status).toBe(401);
    expect((await whoami(LEGACY)).status).toBe(200);
  });
});

function verify(token: string): Promise<Response> {
  const body = new FormData();
  body.append("token", token);
  return Promise.resolve(
    emailAuthRouter.fetch(
      new Request("http://localhost/verify", {
        method: "POST",
        body,
        headers: { Origin: "http://localhost" },
      }),
      env,
    ),
  );
}

describe("dedupe window", () => {
  const sso = (orgId?: string) => ({
    method: "sso" as const,
    reason: "account_disabled",
    actorType: "user" as const,
    actorId: "usr_alice",
    subject: "usr_alice",
    ...(orgId !== undefined ? { orgId } : {}),
  });

  it("keys on org scope: one org's failure never suppresses another's", async () => {
    await recordAuthFailure(env.DB, logger, sso("org_a"));
    await recordAuthFailure(env.DB, logger, sso("org_b"));
    await recordAuthFailure(env.DB, logger, sso("org_a"));
    // Unscoped matches only unscoped, in both directions.
    await recordAuthFailure(env.DB, logger, sso());
    await recordAuthFailure(env.DB, logger, sso());

    expect(failures().map((r) => r.org_id)).toEqual(["org_a", "org_b", null]);
  });

  it("writes exactly one row when failures race", async () => {
    // With a separate probe-then-insert, every caller would pass the probe
    // before any insert landed; the guarded single-statement insert cannot.
    await Promise.all(
      Array.from({ length: 5 }, () => recordAuthFailure(env.DB, logger, sso("org_a"))),
    );
    expect(failures()).toHaveLength(1);
  });

  it("fails open when the guarded insert errors", async () => {
    const realPrepare = env.DB.prepare.bind(env.DB);
    const flaky = {
      ...env.DB,
      prepare: (sql: string) => {
        if (sql.includes("WHERE NOT EXISTS")) throw new Error("guard down");
        return realPrepare(sql);
      },
    } as D1Database;
    await recordAuthFailure(flaky, logger, sso("org_a"));
    expect(failures()).toHaveLength(1);
  });
});

describe("magic links", () => {
  it("records a reused link against the account it was minted for", async () => {
    await createMagicLink(
      env.DB,
      "link-1",
      { email: "alice@example.com", intent: "login" },
      600,
      logger,
    );
    await consumeMagicLink(env.DB, "link-1", logger);

    const res = await verify("link-1");
    expect(res.headers.get("location")).toContain("error=link_expired");
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({ actor_id: "usr_alice", subject: "usr_alice" });
    expect(JSON.parse(failures()[0]?.detail ?? "{}")).toEqual({
      method: "magic_link",
      reason: "link_already_used",
    });
  });

  it("records an expired link", async () => {
    await createMagicLink(
      env.DB,
      "link-2",
      { email: "alice@example.com", intent: "login" },
      -60,
      logger,
    );
    await verify("link-2");
    expect(JSON.parse(failures()[0]?.detail ?? "{}")).toMatchObject({ reason: "link_expired" });
  });

  it("does not record an unknown link, or one for an email with no account", async () => {
    await verify("never-issued");
    await createMagicLink(
      env.DB,
      "link-3",
      { email: "nobody@example.com", intent: "login" },
      -60,
      logger,
    );
    await verify("link-3");
    expect(failures()).toEqual([]);
  });

  it("records a valid link for a disabled account", async () => {
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = ?")
      .run("2026-11-01T00:00:00.000Z", "usr_alice");
    await createMagicLink(
      env.DB,
      "link-4",
      { email: "alice@example.com", intent: "login" },
      600,
      logger,
    );
    const res = await verify("link-4");
    expect(res.headers.get("location")).toContain("error=account_disabled");
    expect(JSON.parse(failures()[0]?.detail ?? "{}")).toEqual({
      method: "magic_link",
      reason: "account_disabled",
    });
  });
});
