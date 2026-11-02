import { describe, expect, it, vi } from "vitest";
import { createUser, getUser, getUserByToken, setUserTelemetryOptOut } from "../src/storage/users";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(function (this: unknown) {
    return logger;
  }),
};

async function seedUser(db: D1Database) {
  const created = await createUser(db, "opt@example.com", logger, "opter");
  if (!created.success) throw new Error("fixture user could not be created");
  return created.data;
}

/**
 * Exercised against a real SQLite engine with every migration applied, so
 * migration 041 and the SQL that reads and writes the column both genuinely
 * execute rather than being matched by a stub's regex.
 */
describe("per-user telemetry preference (migration 041)", () => {
  it("defaults new accounts to opted in, so nothing changes for anyone who does not act", async () => {
    const { db } = makeSqliteD1();
    const { user } = await seedUser(db);

    expect(user.telemetryOptOut).toBeUndefined();

    const fetched = await getUser(db, user.id, logger);
    expect(fetched.success).toBe(true);
    if (!fetched.success) return;
    expect(fetched.data.telemetryOptOut).toBeUndefined();
  });

  it("backfills rows that existed BEFORE the column was added", async () => {
    const { db, raw } = makeSqliteD1();
    const { user } = await seedUser(db);

    // Rewind past 041 so the row genuinely predates the column, then replay the
    // migration. Asserting the DEFAULT on a fresh insert would only prove that
    // NEW rows work; the migration is about accounts that already exist.
    raw.exec("ALTER TABLE users DROP COLUMN telemetry_opt_out");
    raw.exec("ALTER TABLE users ADD COLUMN telemetry_opt_out INTEGER NOT NULL DEFAULT 0");

    const row = raw.prepare("SELECT telemetry_opt_out FROM users WHERE id = ?").get(user.id) as {
      telemetry_opt_out: number;
    };
    expect(row.telemetry_opt_out).toBe(0);

    // ...and the storage layer reads that backfilled row as "opted in".
    const fetched = await getUser(db, user.id, logger);
    expect(fetched.success).toBe(true);
    if (!fetched.success) return;
    expect(fetched.data.telemetryOptOut).toBeUndefined();
  });

  it("round-trips an opt-out and back through every read path", async () => {
    const { db } = makeSqliteD1();
    const { user, plaintext } = await seedUser(db);

    const optedOut = await setUserTelemetryOptOut(db, user.id, true, logger);
    expect(optedOut.success).toBe(true);

    const byId = await getUser(db, user.id, logger);
    expect(byId.success && byId.data.telemetryOptOut).toBe(true);

    // The auth hot path reads by token; the flag must ride that SELECT * too.
    const byToken = await getUserByToken(db, plaintext, logger);
    expect(byToken.success && byToken.data.telemetryOptOut).toBe(true);

    const optedBackIn = await setUserTelemetryOptOut(db, user.id, false, logger);
    expect(optedBackIn.success).toBe(true);

    const reread = await getUser(db, user.id, logger);
    expect(reread.success).toBe(true);
    if (!reread.success) return;
    // Absent, not `false` — downstream truthiness checks must never see undefined
    // leak in from a legacy read, and `absent` is how "opted in" is spelled.
    expect(reread.data.telemetryOptOut).toBeUndefined();
  });

  it("reports a missing user rather than silently succeeding", async () => {
    const { db } = makeSqliteD1();

    const result = await setUserTelemetryOptOut(db, "usr_does_not_exist", true, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("returns an error value instead of throwing when D1 fails", async () => {
    const result = await setUserTelemetryOptOut(makeThrowingD1(), "usr_abc", true, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("STORAGE_ERROR");
    expect(logger.error).toHaveBeenCalled();
  });
});
