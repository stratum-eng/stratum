import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { auditRouter, orgAuditRouter } from "../src/routes/audit";
import { orgsRouter } from "../src/routes/orgs";
import { type AuditEntry, recordAudit } from "../src/storage/audit";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import { createLogger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * Org-scoped audit (#255), end to end against real SQLite: the org routes
 * write membership/team events into the org's trail, and
 * GET /api/orgs/:slug/audit (+ /export) serves only that org's rows, only to
 * its admins.
 */

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

const logger = createLogger({ component: "Test" });
let raw: Raw;
let env: Env;
let app: Hono<{ Bindings: Env }>;

const USERS = ["alice", "bob", "carol", "dave"] as const;
type Who = (typeof USERS)[number];
const tokenOf = (who: Who) => `stratum_user_${who}_token`;

beforeEach(async () => {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  env = { ARTIFACTS: {} as Env["ARTIFACTS"], STATE: makeFakeKV(), DB: sqlite.db };
  for (const who of USERS) {
    raw
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .run(`usr_${who}`, `${who}@example.com`, who, await hashToken(tokenOf(who)));
  }
  app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/admin/audit", auditRouter);
  app.route("/api/orgs", orgsRouter);
  app.route("/api/orgs", orgAuditRouter);
});

function call(who: Who | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (who !== null) headers.Authorization = `Bearer ${tokenOf(who)}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    ),
  );
}

async function createOrg(who: Who, slug: string): Promise<string> {
  const res = await call(who, "POST", "/api/orgs", { name: slug, slug });
  expect(res.status).toBe(201);
  return ((await res.json()) as { org: { id: string } }).org.id;
}

async function readAudit(
  who: Who | null,
  slug: string,
  query = "",
): Promise<{ status: number; entries: AuditEntry[]; nextCursor?: string }> {
  const res = await call(who, "GET", `/api/orgs/${slug}/audit${query}`);
  if (res.status !== 200) return { status: res.status, entries: [] };
  const body = (await res.json()) as { entries: AuditEntry[]; nextCursor?: string };
  return { status: 200, ...body };
}

function seed(orgId: string | null, createdAt: string, id: string, action = "token.rotated"): void {
  raw
    .prepare(
      "INSERT INTO audit_log (id, action, actor_type, actor_id, subject, detail, created_at, org_id) VALUES (?, ?, 'user', 'usr_alice', NULL, '{}', ?, ?)",
    )
    .run(id, action, createdAt, orgId);
}

describe("org membership and team changes are audited into the org's trail", () => {
  it("records create, add, role change, remove, and team lifecycle — and skips no-ops", async () => {
    const orgId = await createOrg("alice", "acme");

    expect(
      (await call("alice", "POST", "/api/orgs/acme/members", { userId: "usr_bob" })).status,
    ).toBe(200);
    // Same role again: an upsert that changed nothing writes nothing.
    await call("alice", "POST", "/api/orgs/acme/members", { userId: "usr_bob" });
    await call("alice", "POST", "/api/orgs/acme/members", { userId: "usr_bob", role: "admin" });

    const teamRes = await call("alice", "POST", "/api/orgs/acme/teams", {
      name: "Eng",
      slug: "eng",
      permissions: "write",
    });
    expect(teamRes.status).toBe(201);
    const teamId = ((await teamRes.json()) as { team: { id: string } }).team.id;
    await call("alice", "POST", `/api/orgs/acme/teams/${teamId}/members`, { userId: "usr_bob" });
    await call("alice", "DELETE", `/api/orgs/acme/teams/${teamId}/members/usr_bob`);
    await call("alice", "DELETE", `/api/orgs/acme/teams/${teamId}`);
    await call("alice", "DELETE", "/api/orgs/acme/members/usr_bob");
    // Removing someone who is not a member changed nothing.
    await call("alice", "DELETE", "/api/orgs/acme/members/usr_dave");

    const { status, entries } = await readAudit("alice", "acme");
    expect(status).toBe(200);
    expect(entries.every((e) => e.orgId === orgId)).toBe(true);
    // Compared as a multiset: requests in one test can share a millisecond,
    // and same-timestamp rows order by (random) id, not by insertion.
    expect(entries.map((e) => e.action).sort()).toEqual(
      [
        "org.created",
        "org.member.added",
        "org.member.role_changed",
        "team.created",
        "team.member.added",
        "team.member.removed",
        "team.deleted",
        "org.member.removed",
      ].sort(),
    );
    const roleChange = entries.find((e) => e.action === "org.member.role_changed");
    expect(roleChange).toMatchObject({
      actorId: "usr_alice",
      subject: "usr_bob",
      detail: { role: "admin", previousRole: "member" },
    });
    const removal = entries.find((e) => e.action === "org.member.removed");
    expect(removal?.detail).toEqual({ previousRole: "admin" });
  });
});

describe("GET /api/orgs/:slug/audit — access", () => {
  beforeEach(async () => {
    await createOrg("alice", "acme");
    await call("alice", "POST", "/api/orgs/acme/members", { userId: "usr_bob" });
  });

  it("serves the org's admins", async () => {
    expect((await readAudit("alice", "acme")).status).toBe(200);
  });

  it("refuses a plain member with 403", async () => {
    expect((await readAudit("bob", "acme")).status).toBe(403);
  });

  it("answers a non-member with the missing-org 404 (no existence leak)", async () => {
    expect((await readAudit("carol", "acme")).status).toBe(404);
    expect((await readAudit("carol", "no-such-org")).status).toBe(404);
  });

  it("requires a user", async () => {
    expect((await readAudit(null, "acme")).status).toBe(401);
  });

  it("serves an admin promoted later", async () => {
    await call("alice", "POST", "/api/orgs/acme/members", { userId: "usr_bob", role: "admin" });
    expect((await readAudit("bob", "acme")).status).toBe(200);
  });
});

describe("GET /api/orgs/:slug/audit — isolation, filters, pagination", () => {
  it("never shows another org's rows, or unscoped rows", async () => {
    const acme = await createOrg("alice", "acme");
    const globex = await createOrg("carol", "globex");
    await call("carol", "POST", "/api/orgs/globex/members", { userId: "usr_dave" });
    await recordAudit(env.DB, logger, { action: "token.rotated", actorType: "user", actorId: "x" });

    const acmeRows = await readAudit("alice", "acme");
    expect(acmeRows.entries.map((e) => e.orgId)).toEqual([acme]);
    const globexRows = await readAudit("carol", "globex");
    expect(new Set(globexRows.entries.map((e) => e.orgId))).toEqual(new Set([globex]));
    expect(globexRows.entries).toHaveLength(2);
    // Admin of one org is a stranger to the other.
    expect((await readAudit("alice", "globex")).status).toBe(404);
    expect((await readAudit("carol", "acme")).status).toBe(404);
  });

  it("filters by action and time range and pages with a cursor", async () => {
    const orgId = await createOrg("alice", "acme");
    for (let i = 0; i < 5; i++) {
      seed(orgId, `2026-0${i + 1}-15T00:00:00.000Z`, `aud_seed_${i}`, "webhook.created");
    }

    const byAction = await readAudit("alice", "acme", "?action=webhook.created");
    expect(byAction.entries).toHaveLength(5);

    const ranged = await readAudit(
      "alice",
      "acme",
      "?action=webhook.created&since=2026-02-01T00:00:00Z&until=2026-04-15T00:00:00Z",
    );
    expect(ranged.entries.map((e) => e.id)).toEqual(["aud_seed_2", "aud_seed_1"]);

    const first = await readAudit("alice", "acme", "?action=webhook.created&limit=2");
    expect(first.entries.map((e) => e.id)).toEqual(["aud_seed_4", "aud_seed_3"]);
    expect(first.nextCursor).toBeDefined();
    const second = await readAudit(
      "alice",
      "acme",
      `?action=webhook.created&limit=2&cursor=${first.nextCursor}`,
    );
    expect(second.entries.map((e) => e.id)).toEqual(["aud_seed_2", "aud_seed_1"]);
    const third = await readAudit(
      "alice",
      "acme",
      `?action=webhook.created&limit=2&cursor=${second.nextCursor}`,
    );
    expect(third.entries.map((e) => e.id)).toEqual(["aud_seed_0"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("rejects malformed filters with 400", async () => {
    await createOrg("alice", "acme");
    for (const q of [
      "?since=yesterday",
      "?until=nope",
      "?since=2026-02-01T00:00:00Z&until=2026-01-01T00:00:00Z",
      "?cursor=garbage",
      "?limit=0",
      "?format=csv",
    ]) {
      const res = await call("alice", "GET", `/api/orgs/acme/audit${q}`);
      expect(res.status, q).toBe(400);
    }
  });
});

async function readNdjson(res: Response): Promise<AuditEntry[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

describe("NDJSON export", () => {
  it("streams every row in the window across pages, one JSON object per line", async () => {
    const orgId = await createOrg("alice", "acme");
    const otherOrg = await createOrg("carol", "globex");
    // More than one 500-row page, all inside the default 30-day window.
    const base = Date.now() - 24 * 60 * 60 * 1000;
    raw.exec("BEGIN");
    for (let i = 0; i < 520; i++) {
      seed(
        orgId,
        new Date(base + i * 1000).toISOString(),
        `aud_bulk_${String(i).padStart(4, "0")}`,
      );
    }
    seed(otherOrg, new Date(base).toISOString(), "aud_foreign");
    raw.exec("COMMIT");

    const res = await call("alice", "GET", "/api/orgs/acme/audit/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="audit-acme-/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const rows = await readNdjson(res);
    // 520 seeded + org.created.
    expect(rows).toHaveLength(521);
    expect(new Set(rows.map((r) => r.id)).size).toBe(521);
    expect(rows.every((r) => r.orgId === orgId)).toBe(true);
    // Newest first, contiguous across the page boundary.
    expect(rows[1]?.id).toBe("aud_bulk_0519");
    expect(rows[520]?.id).toBe("aud_bulk_0000");
  });

  it("is also reachable as ?format=ndjson and honours action/since/until", async () => {
    const orgId = await createOrg("alice", "acme");
    seed(orgId, "2026-06-01T00:00:00.000Z", "aud_a", "webhook.created");
    seed(orgId, "2026-06-02T00:00:00.000Z", "aud_b", "webhook.deleted");
    seed(orgId, "2026-07-01T00:00:00.000Z", "aud_c", "webhook.created");

    const res = await call(
      "alice",
      "GET",
      "/api/orgs/acme/audit?format=ndjson&action=webhook.created&since=2026-05-15T00:00:00Z&until=2026-06-15T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect((await readNdjson(res)).map((r) => r.id)).toEqual(["aud_a"]);
  });

  it("honours the actor filter on both export routes", async () => {
    const orgId = await createOrg("alice", "acme");
    const inWindow = new Date(Date.now() - 60_000).toISOString();
    seed(orgId, inWindow, "aud_alice");
    raw
      .prepare(
        "INSERT INTO audit_log (id, action, actor_type, actor_id, subject, detail, created_at, org_id) VALUES ('aud_bob', 'token.rotated', 'user', 'usr_bob', NULL, '{}', ?, ?)",
      )
      .run(inWindow, orgId);

    for (const path of [
      "/api/orgs/acme/audit/export?actor=usr_bob",
      "/api/orgs/acme/audit?format=ndjson&actor=usr_bob",
    ]) {
      const res = await call("alice", "GET", path);
      expect(res.status, path).toBe(200);
      expect(
        (await readNdjson(res)).map((r) => r.id),
        path,
      ).toEqual(["aud_bob"]);
    }
  });

  it("refuses a window longer than 90 days", async () => {
    await createOrg("alice", "acme");
    const res = await call(
      "alice",
      "GET",
      "/api/orgs/acme/audit/export?since=2026-01-01T00:00:00Z&until=2026-06-01T00:00:00Z",
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/90 days/);
  });

  it("is admin-only like the JSON read", async () => {
    await createOrg("alice", "acme");
    await call("alice", "POST", "/api/orgs/acme/members", { userId: "usr_bob" });
    expect((await call("bob", "GET", "/api/orgs/acme/audit/export")).status).toBe(403);
    expect((await call("carol", "GET", "/api/orgs/acme/audit/export")).status).toBe(404);
  });
});

describe("instance-wide read path", () => {
  it("still serves instance admins, now with org filtering and a cursor", async () => {
    env.ADMIN_API_KEY = "sekret";
    const orgId = await createOrg("alice", "acme");
    await recordAudit(env.DB, logger, { action: "token.rotated", actorType: "user", actorId: "x" });

    const all = await app.fetch(
      new Request("http://localhost/api/admin/audit", { headers: { "X-Admin-API-Key": "sekret" } }),
      env,
    );
    expect(all.status).toBe(200);
    expect(((await all.json()) as { entries: AuditEntry[] }).entries).toHaveLength(2);

    const scoped = await app.fetch(
      new Request(`http://localhost/api/admin/audit?org=${orgId}&limit=1`, {
        headers: { "X-Admin-API-Key": "sekret" },
      }),
      env,
    );
    const body = (await scoped.json()) as { entries: AuditEntry[]; nextCursor?: string };
    expect(body.entries.map((e) => e.action)).toEqual(["org.created"]);
    expect(body.nextCursor).toBeUndefined();

    const denied = await call("alice", "GET", "/api/admin/audit");
    expect(denied.status).toBe(403);
  });
});
