/**
 * Issue #254: account erasure must still complete once a user has minted tokens.
 *
 * This test enables `PRAGMA foreign_keys = ON` explicitly. D1 enforces foreign
 * keys; the shared `makeSqliteD1` helper does not turn them on, and the existing
 * account-cascade suite uses a statement-recording stub that evaluates no
 * constraints at all. So without this file, `api_tokens.user_id REFERENCES
 * users(id)` could block the cascade's final `DELETE FROM users` in production
 * while every test stayed green — erasure would silently never complete for any
 * account that had ever created a token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiToken } from "../src/storage/api-tokens";
import { deleteAccountCascade } from "../src/storage/deletion";
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

let db: D1Database;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let env: Env;

beforeEach(async () => {
  const made = makeSqliteD1();
  db = made.db;
  raw = made.raw;
  // The point of this file: model D1, which enforces foreign keys.
  raw.exec("PRAGMA foreign_keys = ON");
  env = { DB: db, STATE: makeFakeKV() } as unknown as Env;

  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind("usr_1", "u@test", "u", await hashToken("stratum_user_aaaabbbbccccddddeeeeffff00001111"))
    .run();
  vi.clearAllMocks();
});

describe("account erasure with API tokens", () => {
  it("completes and removes the user row", async () => {
    const created = await createApiToken(db, logger, {
      userId: "usr_1",
      name: "laptop",
      scope: "read_write",
    });
    expect(created.success).toBe(true);

    const result = await deleteAccountCascade(env, "usr_1", logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // A residual here means the cascade recorded a failure and deliberately
    // retained the user row — which is what an FK violation would produce.
    expect(result.data.residuals).toEqual([]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("removes the tokens themselves, not just the user", async () => {
    await createApiToken(db, logger, { userId: "usr_1", name: "a", scope: "read" });
    await createApiToken(db, logger, { userId: "usr_1", name: "b", scope: "read_write" });

    await deleteAccountCascade(env, "usr_1", logger);

    // Credentials named after a person's devices outliving their erasure request
    // is a retention bug in its own right, independent of the FK.
    expect(raw.prepare("SELECT COUNT(*) AS n FROM api_tokens").get()).toEqual({ n: 0 });
  });

  it("leaves another user's tokens alone", async () => {
    await db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(
        "usr_2",
        "v@test",
        "v",
        await hashToken("stratum_user_22223333444455556666777788889999"),
      )
      .run();
    await createApiToken(db, logger, { userId: "usr_1", name: "mine", scope: "read" });
    await createApiToken(db, logger, { userId: "usr_2", name: "theirs", scope: "read" });

    await deleteAccountCascade(env, "usr_1", logger);

    const remaining = raw.prepare("SELECT user_id FROM api_tokens").all() as { user_id: string }[];
    expect(remaining).toEqual([{ user_id: "usr_2" }]);
  });
});
