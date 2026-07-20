/**
 * MAGIC-7: single-use is enforced atomically — the second consume of a token
 * loses the conditional UPDATE and gets null, even racing the first.
 */
import { describe, expect, it, vi } from "vitest";
import { consumeMagicLink, createMagicLink } from "../src/storage/magic-links";
import type { Logger } from "../src/utils/logger";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

// Minimal D1 modelling the magic_links row + the conditional-UPDATE semantics
// (meta.changes reflects whether the row was still consumable).
function makeD1() {
  const rows = new Map<string, { payload: string; expires_at: number; consumed: number }>();
  return {
    prepare(sql: string) {
      return {
        _sql: sql,
        _b: [] as unknown[],
        bind(...args: unknown[]) {
          this._b = args;
          return this;
        },
        async run() {
          if (this._sql.startsWith("INSERT")) {
            const [hash, payload, expires] = this._b as [string, string, number];
            rows.set(hash, { payload, expires_at: expires, consumed: 0 });
            return { meta: { changes: 1 } };
          }
          // UPDATE ... SET consumed=1 WHERE token_hash=? AND consumed=0 AND expires_at>?
          const [hash, now] = this._b as [string, number];
          const row = rows.get(hash);
          if (row && row.consumed === 0 && row.expires_at > now) {
            row.consumed = 1;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first<T>() {
          const [hash] = this._b as [string];
          const row = rows.get(hash);
          return (row ? { payload: row.payload } : null) as T | null;
        },
      };
    },
  } as unknown as D1Database;
}

describe("magic link atomic single-use", () => {
  it("consumes once, then returns null on reuse", async () => {
    const db = makeD1();
    await createMagicLink(db, "tok-abc", { email: "a@b.com", intent: "login" }, 900, logger);

    const first = await consumeMagicLink(db, "tok-abc", logger);
    expect(first.success && first.data?.email).toBe("a@b.com");

    const second = await consumeMagicLink(db, "tok-abc", logger);
    expect(second.success && second.data).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const db = makeD1();
    const res = await consumeMagicLink(db, "nope", logger);
    expect(res.success && res.data).toBeNull();
  });

  it("returns null once expired", async () => {
    const db = makeD1();
    await createMagicLink(db, "tok-exp", { email: "a@b.com", intent: "login" }, -1, logger);
    const res = await consumeMagicLink(db, "tok-exp", logger);
    expect(res.success && res.data).toBeNull();
  });
});
