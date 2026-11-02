/**
 * Issue #254: scoped, expiring API tokens — storage and resolution.
 *
 * Driven against REAL SQLite with every migration applied, not a
 * statement-matching stub. The behaviour that matters here is decided by the
 * schema and the SQL: the CHECK constraint on `scope`, the union across two
 * credential tables, and the foreign key to `users` that the account-deletion
 * cascade has to satisfy. A stub would evaluate none of them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_TOKENS_PER_USER,
  createApiToken,
  listApiTokens,
  narrowTokenScope,
  resolveApiToken,
  revokeApiToken,
  touchApiTokenLastUsed,
} from "../src/storage/api-tokens";
import { disableLegacyToken, getUserByToken } from "../src/storage/users";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
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

const LEGACY_PLAINTEXT = "stratum_user_deadbeefdeadbeefdeadbeefdeadbeef";

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];

async function seedUser(id = "usr_1", legacy = LEGACY_PLAINTEXT): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind(id, `${id}@test`, id, await hashToken(legacy))
    .run();
}

beforeEach(() => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  vi.clearAllMocks();
});

describe("createApiToken", () => {
  it("returns the plaintext once and stores only its hash", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "buildkite",
      scope: "read",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(created.data.plaintext).toMatch(/^stratum_user_[0-9a-f]{32}$/);
    const stored = raw.prepare("SELECT token_hash, token_prefix FROM api_tokens").get() as {
      token_hash: string;
      token_prefix: string;
    };
    expect(stored.token_hash).toBe(await hashToken(created.data.plaintext));
    expect(stored.token_hash).not.toBe(created.data.plaintext);
    // The prefix identifies a deployed credential without being usable as one.
    expect(created.data.plaintext.startsWith(stored.token_prefix)).toBe(true);
    expect(stored.token_prefix.length).toBeLessThan(created.data.plaintext.length);
  });

  it("keeps the format the secret scanner matches", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");
    // src/evaluation/secret-scanner.ts matches stratum_user_[a-f0-9]{32}; a
    // wider token would leak past the diff scan silently.
    expect(created.data.plaintext).toMatch(/^stratum_user_[a-f0-9]{32}$/);
  });

  it("rejects an out-of-range expiry rather than storing a nonsense timestamp", async () => {
    await seedUser();
    for (const expiresInDays of [0, 366, 1.5, Number.NaN]) {
      const result = await createApiToken(db, logger, {
        userId: "usr_1",
        name: "t",
        scope: "read",
        expiresInDays,
      });
      expect(result.success).toBe(false);
    }
  });

  it("caps ACTIVE tokens, and revoking one frees a slot", async () => {
    await seedUser();
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_TOKENS_PER_USER; i++) {
      const made = await createApiToken(db, logger, {
        userId: "usr_1",
        name: `t${i}`,
        scope: "read",
      });
      if (!made.success) throw new Error("create failed");
      ids.push(made.data.token.id);
    }

    const overCap = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "one-too-many",
      scope: "read",
    });
    expect(overCap.success).toBe(false);
    if (overCap.success) return;
    expect(overCap.error.code).toBe("TOKEN_LIMIT_REACHED");

    // Revoked rows are kept for the trail but must not count, or a user who
    // rotates often would be permanently locked out with no remedy.
    await revokeApiToken(db, logger, { userId: "usr_1", tokenId: ids[0] as string });
    const afterRevoke = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "replacement",
      scope: "read",
    });
    expect(afterRevoke.success).toBe(true);
  });

  it("does not let EXPIRED tokens occupy slots", async () => {
    await seedUser();
    // Fill the cap with rows that have already lapsed. Written directly because
    // `createApiToken` will not mint a token that is expired on arrival.
    const past = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < MAX_ACTIVE_TOKENS_PER_USER; i++) {
      raw
        .prepare(
          `INSERT INTO api_tokens
             (id, user_id, name, token_hash, token_prefix, scope, expires_at, created_at)
           VALUES (?, 'usr_1', ?, ?, 'stratum_user_0000', 'read', ?, ?)`,
        )
        .run(`tok_old_${i}`, `t${i}`, `hash_${i}`, past, past);
    }

    // Nothing was revoked, so a cap keyed on `revoked_at IS NULL` alone reads
    // this user as full — locking them out with no remedy but revoking twenty
    // already-dead rows one at a time.
    const made = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "replacement",
      scope: "read",
    });
    expect(made.success).toBe(true);
  });

  it("refuses a scope the schema does not allow", async () => {
    await seedUser();
    // The CHECK constraint is the backstop behind the route's validation.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, scope, created_at)
           VALUES ('tok_x','usr_1','x','hash_x','stratum_user_x','admin','2026-01-01T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });
});

describe("listApiTokens", () => {
  it("never returns a hash", async () => {
    await seedUser();
    await createApiToken(db, logger, { userId: "usr_1", name: "t", scope: "read" });
    const listed = await listApiTokens(db, logger, "usr_1");
    expect(listed.success).toBe(true);
    if (!listed.success) return;
    expect(listed.data).toHaveLength(1);
    expect(JSON.stringify(listed.data)).not.toContain("token_hash");
    expect(Object.keys(listed.data[0] as object)).not.toContain("tokenHash");
  });
});

describe("revokeApiToken", () => {
  it("cannot revoke another user's token, and does not disclose that it exists", async () => {
    await seedUser("usr_1");
    await seedUser("usr_2", "stratum_user_11112222333344445555666677778888");
    const mine = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read",
    });
    if (!mine.success) throw new Error("create failed");

    const attempt = await revokeApiToken(db, logger, {
      userId: "usr_2",
      tokenId: mine.data.token.id,
    });
    expect(attempt.success).toBe(false);
    if (attempt.success) return;
    expect(attempt.error.statusCode).toBe(404);
    // Still live for its owner.
    const row = raw
      .prepare("SELECT revoked_at FROM api_tokens WHERE id = ?")
      .get(mine.data.token.id) as { revoked_at: string | null };
    expect(row.revoked_at).toBeNull();
  });
});

describe("resolveApiToken", () => {
  it("reports NOT_FOUND for the legacy credential so the caller falls through", async () => {
    await seedUser();
    // The legacy token lives in `users`, not `api_tokens`. A miss here is the
    // signal for the middleware to try `getUserByToken`, which still authorises
    // it with the full power it has always had.
    const scoped = await resolveApiToken(db, LEGACY_PLAINTEXT, logger);
    expect(scoped.success).toBe(false);
    if (scoped.success) return;
    expect(scoped.error.statusCode).toBe(404);

    const legacy = await getUserByToken(db, LEGACY_PLAINTEXT, logger);
    expect(legacy.success).toBe(true);
  });

  it("resolves an api_token with its own scope and owner", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "buildkite",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");

    const resolved = await resolveApiToken(db, created.data.plaintext, logger);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.data.scope).toBe("read");
    expect(resolved.data.tokenId).toBe(created.data.token.id);
    expect(resolved.data.user.id).toBe("usr_1");
  });

  /**
   * #257 stores the analytics opt-out on `users`, and this join is the only
   * place a scoped-token caller's owner row is read. If the column is dropped
   * from the SELECT, `authMiddleware` publishes "opted in" for someone who
   * opted out — and every other scoped-token assertion still passes, so nothing
   * else would go red. Hence a real-SQLite test on the query itself.
   */
  it("carries the owner's telemetry preference off the same join", async () => {
    await seedUser();
    raw.exec("UPDATE users SET telemetry_opt_out = 1 WHERE id = 'usr_1'");
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "ci",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");

    const resolved = await resolveApiToken(db, created.data.plaintext, logger);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.data.user.telemetryOptOut).toBe(true);
  });

  it("leaves the preference unset for an owner who has not opted out", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "ci",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");

    const resolved = await resolveApiToken(db, created.data.plaintext, logger);
    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.data.user.telemetryOptOut).toBeUndefined();
  });

  it("rejects a revoked token", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read_write",
    });
    if (!created.success) throw new Error("create failed");
    await revokeApiToken(db, logger, { userId: "usr_1", tokenId: created.data.token.id });

    const resolved = await resolveApiToken(db, created.data.plaintext, logger);
    expect(resolved.success).toBe(false);
  });

  it("rejects a token whose owner is SCIM-disabled, and honours it again once re-enabled (#253)", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read_write",
    });
    if (!created.success) throw new Error("create failed");
    raw
      .prepare("UPDATE users SET disabled_at = ? WHERE id = 'usr_1'")
      .run(new Date().toISOString());

    expect((await resolveApiToken(db, created.data.plaintext, logger)).success).toBe(false);

    raw.prepare("UPDATE users SET disabled_at = NULL WHERE id = 'usr_1'").run();
    expect((await resolveApiToken(db, created.data.plaintext, logger)).success).toBe(true);
  });

  it("rejects an expired token, comparing in JS rather than SQL", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");
    // ISO 8601, as the application writes. A SQL comparison against
    // datetime('now') would read this as UNEXPIRED, because ' ' sorts below 'T'.
    raw
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", created.data.token.id);

    const resolved = await resolveApiToken(db, created.data.plaintext, logger);
    expect(resolved.success).toBe(false);
  });

  it("honours a token whose expiry is still in the future", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read",
      expiresInDays: 30,
    });
    if (!created.success) throw new Error("create failed");
    const resolved = await resolveApiToken(db, created.data.plaintext, logger);
    expect(resolved.success).toBe(true);
  });

  it("treats an unparseable expiry as expired", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");
    raw
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .run("not-a-date", created.data.token.id);

    // A token whose lifetime cannot be established must not be honoured forever.
    const resolved = await resolveApiToken(db, created.data.plaintext, logger);
    expect(resolved.success).toBe(false);
  });

  it("rejects a token whose owner is soft-deleting", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");
    raw.prepare("UPDATE users SET deleting_at = ? WHERE id = ?").run("2026-01-01", "usr_1");

    // #236/#229: an erasure-requested account's credentials stop working at once.
    // The scoped path rejects here, because `deleting_at` rides along on the
    // join it already does.
    expect((await resolveApiToken(db, created.data.plaintext, logger)).success).toBe(false);

    // The legacy path splits the responsibility differently, and that is worth
    // pinning: `getUserByToken` still RETURNS the row — it is the middleware
    // that refuses a `deletingAt` user. So the storage call succeeds and carries
    // the flag the caller is required to act on.
    const legacy = await getUserByToken(db, LEGACY_PLAINTEXT, logger);
    expect(legacy.success).toBe(true);
    if (!legacy.success) return;
    expect(legacy.data.deletingAt).toBeTruthy();
  });

  it("rejects an unknown token", async () => {
    await seedUser();
    const resolved = await resolveApiToken(
      db,
      "stratum_user_00000000000000000000000000000000",
      logger,
    );
    expect(resolved.success).toBe(false);
  });

  it("fails CLOSED when the store throws, rather than passing or 500-ing past the caller", async () => {
    const brokenDb = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    const resolved = await resolveApiToken(brokenDb, LEGACY_PLAINTEXT, logger);
    expect(resolved.success).toBe(false);
  });

  it("treats a scope value outside the union as read-only", () => {
    // Belt to the CHECK constraint's braces: defaulting the other way would turn
    // a constraint failure into a privilege escalation.
    expect(narrowTokenScope("admin")).toBe("read");
    expect(narrowTokenScope("")).toBe("read");
    expect(narrowTokenScope("read_write")).toBe("read_write");
  });
});

describe("touchApiTokenLastUsed", () => {
  it("writes when there is no recorded use", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");

    await touchApiTokenLastUsed(db, logger, { tokenId: created.data.token.id });
    const row = raw
      .prepare("SELECT last_used_at FROM api_tokens WHERE id = ?")
      .get(created.data.token.id) as { last_used_at: string | null };
    expect(row.last_used_at).not.toBeNull();
  });

  it("debounces a recent use so every request does not carry a write", async () => {
    await seedUser();
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "t",
      scope: "read",
    });
    if (!created.success) throw new Error("create failed");

    const recent = new Date().toISOString();
    await touchApiTokenLastUsed(db, logger, {
      tokenId: created.data.token.id,
      lastUsedAt: recent,
    });
    const row = raw
      .prepare("SELECT last_used_at FROM api_tokens WHERE id = ?")
      .get(created.data.token.id) as { last_used_at: string | null };
    expect(row.last_used_at).toBeNull();
  });

  it("never throws when the write fails — it must not fail the request", async () => {
    const brokenDb = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    await expect(
      touchApiTokenLastUsed(brokenDb, logger, { tokenId: "tok_1" }),
    ).resolves.toBeUndefined();
  });
});

describe("disableLegacyToken", () => {
  it("makes the legacy credential unusable while the scoped ones keep working", async () => {
    await seedUser();
    const scoped = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "laptop",
      scope: "read_write",
    });
    if (!scoped.success) throw new Error("create failed");

    expect((await getUserByToken(db, LEGACY_PLAINTEXT, logger)).success).toBe(true);
    const disabled = await disableLegacyToken(db, "usr_1", logger);
    expect(disabled.success).toBe(true);

    // The column is NOT NULL and uniquely indexed, so it is rotated to a value
    // nobody holds rather than cleared — indistinguishable from outside.
    expect((await getUserByToken(db, LEGACY_PLAINTEXT, logger)).success).toBe(false);
    expect((await resolveApiToken(db, scoped.data.plaintext, logger)).success).toBe(true);
  });
});
