import { describe, expect, it, vi } from "vitest";
import {
  disableUser,
  enableUser,
  getUser,
  getUserByToken,
  signInGitHubUser,
} from "../src/storage/users";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function seedUser(raw: ReturnType<typeof makeSqliteD1>["raw"], id: string): void {
  raw
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .run(id, `${id}@example.com`, id.replace(/_/g, "-"), `hash_${id}`);
}

function disabledAtOf(raw: ReturnType<typeof makeSqliteD1>["raw"], id: string): string | null {
  const row = raw.prepare("SELECT disabled_at FROM users WHERE id = ?").get(id) as {
    disabled_at: string | null;
  };
  return row.disabled_at;
}

describe("disableUser / enableUser", () => {
  it("disableUser sets disabled_at and getUser surfaces it as disabledAt", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");

    const result = await disableUser(db, "usr_1", mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("disableUser failed");
    expect(disabledAtOf(raw, "usr_1")).toBe(result.data);

    const fetched = await getUser(db, "usr_1", mockLogger);
    expect(fetched.success).toBe(true);
    if (fetched.success) expect(fetched.data.disabledAt).toBe(result.data);
  });

  it("disableUser is idempotent — re-disabling keeps the earliest timestamp", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    const earliest = "2020-01-01T00:00:00.000Z";
    raw.prepare("UPDATE users SET disabled_at = ? WHERE id = 'usr_1'").run(earliest);

    const again = await disableUser(db, "usr_1", mockLogger);
    expect(again.success).toBe(true);
    expect(disabledAtOf(raw, "usr_1")).toBe(earliest);
    // The RETURNED value must be the stored timestamp, not the newer one —
    // an audit/SCIM response built from it must not misreport disablement time.
    expect(again.success && again.data).toBe(earliest);
  });

  it("enableUser clears disabled_at so the row reads as enabled again", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    const disabled = await disableUser(db, "usr_1", mockLogger);
    expect(disabled.success).toBe(true);

    const enabled = await enableUser(db, "usr_1", mockLogger);
    expect(enabled.success).toBe(true);
    expect(disabledAtOf(raw, "usr_1")).toBeNull();

    const fetched = await getUser(db, "usr_1", mockLogger);
    expect(fetched.success).toBe(true);
    if (fetched.success) expect(fetched.data.disabledAt).toBeUndefined();
  });

  it("enableUser is idempotent on an already-enabled account", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");

    const result = await enableUser(db, "usr_1", mockLogger);
    expect(result.success).toBe(true);
    expect(disabledAtOf(raw, "usr_1")).toBeNull();
  });

  it("returns NOT_FOUND for an unknown user", async () => {
    const { db } = makeSqliteD1();

    const disable = await disableUser(db, "usr_ghost", mockLogger);
    expect(disable.success).toBe(false);
    if (!disable.success) expect(disable.error.code).toBe("NOT_FOUND");

    const enable = await enableUser(db, "usr_ghost", mockLogger);
    expect(enable.success).toBe(false);
    if (!enable.success) expect(enable.error.code).toBe("NOT_FOUND");
  });

  it("returns STORAGE_ERROR when D1 throws", async () => {
    const db = makeThrowingD1();

    const disable = await disableUser(db, "usr_1", mockLogger);
    expect(disable.success).toBe(false);
    if (!disable.success) expect(disable.error.code).toBe("STORAGE_ERROR");

    const enable = await enableUser(db, "usr_1", mockLogger);
    expect(enable.success).toBe(false);
    if (!enable.success) expect(enable.error.code).toBe("STORAGE_ERROR");
  });

  it("getUserByToken surfaces disabledAt — the git-http auth path sees the flag", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    // Real token hashing is exercised elsewhere; here the hash IS the lookup key.
    const { hashToken } = await import("../src/utils/crypto");
    const plaintext = "stratum_user_disabletest";
    raw
      .prepare("UPDATE users SET token_hash = ? WHERE id = 'usr_1'")
      .run(await hashToken(plaintext));
    await disableUser(db, "usr_1", mockLogger);

    const fetched = await getUserByToken(db, plaintext, mockLogger);
    expect(fetched.success).toBe(true);
    if (fetched.success) expect(fetched.data.disabledAt).toBeDefined();
  });
});

describe("signInGitHubUser with a frozen account", () => {
  function githubIdOf(raw: ReturnType<typeof makeSqliteD1>["raw"], id: string): string | null {
    const row = raw.prepare("SELECT github_id FROM users WHERE id = ?").get(id) as {
      github_id: string | null;
    };
    return row.github_id;
  }

  it("returns a disabled account matched by email WITHOUT linking the GitHub id", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    await disableUser(db, "usr_1", mockLogger);

    const result = await signInGitHubUser(
      db,
      { githubId: "4242", email: "usr_1@example.com", username: "gh-usr" },
      mockLogger,
    );

    // Returned (so the callback can refuse it) but never linked: a link would
    // hand the frozen row a working GitHub login the moment it is re-enabled.
    expect(result.success).toBe(true);
    if (result.success) expect(result.data?.disabledAt).toBeDefined();
    expect(githubIdOf(raw, "usr_1")).toBeNull();
  });

  it("does not link onto a deleting account either", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");
    raw
      .prepare("UPDATE users SET deleting_at = ? WHERE id = 'usr_1'")
      .run("2026-01-01T00:00:00.000Z");

    await signInGitHubUser(
      db,
      { githubId: "4243", email: "usr_1@example.com", username: "gh-usr" },
      mockLogger,
    );
    expect(githubIdOf(raw, "usr_1")).toBeNull();
  });

  it("still links an enabled account matched by verified email", async () => {
    const { db, raw } = makeSqliteD1();
    seedUser(raw, "usr_1");

    const result = await signInGitHubUser(
      db,
      { githubId: "4244", email: "usr_1@example.com", username: "gh-usr" },
      mockLogger,
    );
    expect(result.success).toBe(true);
    expect(githubIdOf(raw, "usr_1")).toBe("4244");
  });
});
