/**
 * The owner-scoped usage aggregate (migration 049) and what may erase it.
 *
 * The first describe block is the reason the table exists: `cost_records` is
 * project-scoped and hard-deleted by the project cascade, so an allowance summed
 * from it is refunded by deleting a project. Every other test here defends a
 * property that regression depends on — that the aggregate is written at all,
 * that concurrent writers sum, that a month boundary starts a new counter.
 *
 * D1 is real SQLite with the production migrations applied, so the PRIMARY KEY,
 * the owner_type CHECK and the UPSERT's conflict target are the shipped ones
 * rather than a stub's idea of them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordCosts } from "../src/storage/costs";
import {
  captureDeletionTarget,
  deleteAccountCascade,
  deleteProjectCascade,
} from "../src/storage/deletion";
import {
  getOwnerUsageSummary,
  meterForCostKind,
  upsertUsage,
  usagePeriod,
} from "../src/storage/usage";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

// The mock is module-level, so without this a `toHaveBeenCalledWith` assertion
// can be satisfied by an earlier test's call and the suite passes on run order.
beforeEach(() => vi.clearAllMocks());

const ALICE = { ownerId: "user_alice", ownerType: "user" } as const;
const PERIOD = "2026-09";

interface UsageRow {
  owner_id: string;
  owner_type: string;
  period: string;
  meter: string;
  source: string;
  quantity: number;
  updated_at: string;
}

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

function usageRows(raw: Raw): UsageRow[] {
  return raw
    .prepare("SELECT * FROM usage_periods ORDER BY owner_id, period, meter, source")
    .all() as unknown as UsageRow[];
}

function countCostRows(raw: Raw): number {
  const row = raw.prepare("SELECT COUNT(*) AS n FROM cost_records").get() as { n: number };
  return row.n;
}

function project(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "proj_abc",
    name: "my-repo",
    slug: "my-repo",
    namespace: "@alice",
    ownerId: "user_alice",
    ownerType: "user",
    remote: "https://acct.artifacts.cloudflare.net/git/@alice/my-repo.git",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEnv(db: D1Database, kv: KVNamespace): Env {
  // No REPO_DO / MERGE_QUEUE: `purgeDurableObject` treats an absent binding as
  // nothing to purge, which is what a minimal deployment does too.
  return {
    DB: db,
    STATE: kv,
    ARTIFACTS: { delete: async () => true } as unknown as Env["ARTIFACTS"],
  } as Env;
}

// ---------------------------------------------------------------------------
// 3.4 / 3.5 — the regression this table exists to prevent
// ---------------------------------------------------------------------------

describe("deleting a project does not refund the allowance", () => {
  it("keeps the owner's aggregate while destroying the project's cost rows", async () => {
    // The defect in one test: burn the month's quota against a project, delete
    // the project, and check the quota is still burnt. Before `usage_periods`
    // the only aggregate lived in `cost_records`, which the cascade below
    // hard-deletes, so this sequence handed the allowance straight back.
    const { db, raw } = makeSqliteD1();
    const kv = makeFakeKV();
    const entry = project();
    await kv.put("project:@alice:my-repo", JSON.stringify(entry));
    const env = makeEnv(db, kv);

    await recordCosts(
      db,
      logger,
      { project: "@alice/my-repo", projectId: entry.id, changeId: "chg_1", ...ALICE },
      [
        { kind: "llm_tokens", quantity: 12_000, estimated: true },
        { kind: "sandbox_ms", quantity: 4_500 },
        { kind: "git_ops", quantity: 2 },
      ],
    );

    const period = usagePeriod();
    const before = await getOwnerUsageSummary(db, logger, "user_alice", period);
    expect(before.success && before.data).toEqual([
      {
        meter: "llm_tokens_month",
        source: "platform",
        quantity: 12_000,
        updatedAt: expect.any(String),
      },
      {
        meter: "sandbox_ms_month",
        source: "platform",
        quantity: 4_500,
        updatedAt: expect.any(String),
      },
    ]);
    expect(countCostRows(raw)).toBe(3);

    const captured = await captureDeletionTarget(env, entry, logger);
    expect(captured.success).toBe(true);
    if (!captured.success) return;
    const cascade = await deleteProjectCascade(env, captured.data, logger);
    expect(cascade.success && cascade.data.residuals).toEqual([]);

    // The ledger is gone — that part is by design, the rows are project data.
    expect(countCostRows(raw)).toBe(0);
    // The allowance is not.
    const after = await getOwnerUsageSummary(db, logger, "user_alice", period);
    expect(after.success && after.data).toEqual(before.success && before.data);
  });

  it("leaves another owner's aggregate untouched when an account is erased", async () => {
    // The mirror of the above: the cascade that IS allowed to clear usage must
    // still be scoped to one subject.
    const { db, raw } = makeSqliteD1();
    await upsertUsage(db, logger, ALICE, PERIOD, [{ meter: "llm_tokens_month", quantity: 10 }]);
    await upsertUsage(db, logger, { ownerId: "org_acme", ownerType: "org" }, PERIOD, [
      { meter: "llm_tokens_month", quantity: 99 },
    ]);

    const env = makeEnv(db, makeFakeKV());
    const erased = await deleteAccountCascade(env, "user_alice", logger);
    expect(erased.success && erased.data.residuals).toEqual([]);

    expect(usageRows(raw).map((r) => [r.owner_id, r.quantity])).toEqual([["org_acme", 99]]);
  });

  it("erases an org's aggregate only when the empty org itself is deleted", async () => {
    // `resolveOrgOwnership` promotes a successor where one exists and deletes
    // the org where none does. A change of owner is not a fresh allowance, so
    // only the second branch may clear the counter.
    async function eraseSoleOwner(withSurvivingMember: boolean): Promise<UsageRow[]> {
      const { db, raw } = makeSqliteD1();
      raw
        .prepare("INSERT INTO users (id, email, token_hash, created_at) VALUES (?, ?, ?, ?)")
        .run("user_alice", "alice@example.com", "h1", "2026-01-01T00:00:00.000Z");
      raw
        .prepare("INSERT INTO orgs (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("org_acme", "Acme", "acme", "user_alice", "2026-01-01T00:00:00.000Z");
      if (withSurvivingMember) {
        raw
          .prepare("INSERT INTO users (id, email, token_hash, created_at) VALUES (?, ?, ?, ?)")
          .run("user_bob", "bob@example.com", "h2", "2026-01-01T00:00:00.000Z");
        raw
          .prepare("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
          .run("org_acme", "user_bob", "admin", "2026-01-01T00:00:00.000Z");
      }
      await upsertUsage(db, logger, { ownerId: "org_acme", ownerType: "org" }, PERIOD, [
        { meter: "sandbox_ms_month", quantity: 250 },
      ]);
      await deleteAccountCascade(makeEnv(db, makeFakeKV()), "user_alice", logger);
      return usageRows(raw);
    }

    expect(await eraseSoleOwner(true)).toHaveLength(1);
    expect(await eraseSoleOwner(false)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3.2 — upsertUsage / getOwnerUsageSummary
// ---------------------------------------------------------------------------

describe("upsertUsage", () => {
  it("sums concurrent increments rather than losing all but one", async () => {
    // The claim the single UPSERT statement buys, and the only reason it is
    // written as one. A read-then-write would let all fifty callers observe the
    // same total across the await between the SELECT and the UPDATE and each
    // write back "+1", leaving 1 where 50 is correct.
    const { db } = makeSqliteD1();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        upsertUsage(db, logger, ALICE, PERIOD, [{ meter: "llm_tokens_month", quantity: 1 }]),
      ),
    );
    const summary = await getOwnerUsageSummary(db, logger, "user_alice", PERIOD);
    expect(summary.success && summary.data[0]?.quantity).toBe(50);
  });

  it("counts each calendar month separately", async () => {
    const { db } = makeSqliteD1();
    await upsertUsage(db, logger, ALICE, "2026-09", [{ meter: "llm_tokens_month", quantity: 700 }]);
    await upsertUsage(db, logger, ALICE, "2026-10", [{ meter: "llm_tokens_month", quantity: 5 }]);

    const september = await getOwnerUsageSummary(db, logger, "user_alice", "2026-09");
    const october = await getOwnerUsageSummary(db, logger, "user_alice", "2026-10");
    expect(september.success && september.data[0]?.quantity).toBe(700);
    expect(october.success && october.data[0]?.quantity).toBe(5);
  });

  it("merges repeated meters in one call into a single row", async () => {
    const { db, raw } = makeSqliteD1();
    await upsertUsage(db, logger, ALICE, PERIOD, [
      { meter: "llm_tokens_month", quantity: 10 },
      { meter: "llm_tokens_month", quantity: 5 },
      { meter: "sandbox_ms_month", quantity: 1 },
    ]);
    expect(usageRows(raw).map((r) => [r.meter, r.quantity])).toEqual([
      ["llm_tokens_month", 15],
      ["sandbox_ms_month", 1],
    ]);
  });

  it("drops a non-finite quantity instead of poisoning the running total", async () => {
    // SQLite has no way back from a NaN total, and every later comparison
    // against a limit would silently be false.
    const { db, raw } = makeSqliteD1();
    await upsertUsage(db, logger, ALICE, PERIOD, [{ meter: "llm_tokens_month", quantity: 100 }]);
    const result = await upsertUsage(db, logger, ALICE, PERIOD, [
      { meter: "llm_tokens_month", quantity: Number.NaN },
      { meter: "sandbox_ms_month", quantity: Number.POSITIVE_INFINITY },
    ]);
    expect(result.success).toBe(true);
    expect(usageRows(raw).map((r) => [r.meter, r.quantity])).toEqual([["llm_tokens_month", 100]]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not a usable increment"),
      expect.objectContaining({ meter: "llm_tokens_month" }),
    );
  });

  it("writes nothing, and succeeds, for an empty delta list", async () => {
    const { db, raw } = makeSqliteD1();
    expect((await upsertUsage(db, logger, ALICE, PERIOD, [])).success).toBe(true);
    expect(usageRows(raw)).toEqual([]);
  });

  it("stamps the owner type without letting it split the counter", async () => {
    // owner_type is out of the PRIMARY KEY on purpose: one account must never
    // hold two rows for the same meter and month, or a limit compared against
    // either alone is wrong.
    const { db, raw } = makeSqliteD1();
    await upsertUsage(db, logger, ALICE, PERIOD, [{ meter: "llm_tokens_month", quantity: 1 }]);
    await upsertUsage(db, logger, { ownerId: "user_alice", ownerType: "org" }, PERIOD, [
      { meter: "llm_tokens_month", quantity: 1 },
    ]);
    expect(usageRows(raw)).toHaveLength(1);
    expect(usageRows(raw)[0]?.quantity).toBe(2);
  });

  it("reports a database failure as a Result rather than throwing", async () => {
    // It runs inside change creation, merge and deploy; a dead D1 must cost the
    // aggregate, never the change.
    const result = await upsertUsage(makeThrowingD1("D1 down"), logger, ALICE, PERIOD, [
      { meter: "llm_tokens_month", quantity: 1 },
    ]);
    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("DATABASE_ERROR");
  });

  it("reports the owner_type CHECK as a Result rather than throwing", async () => {
    const { db } = makeSqliteD1();
    const result = await upsertUsage(
      db,
      logger,
      // Only reachable by lying to the compiler, which is the point: the
      // database refuses an owner_type no billing subject can have.
      { ownerId: "agt_bot", ownerType: "agent" as "user" },
      PERIOD,
      [{ meter: "llm_tokens_month", quantity: 1 }],
    );
    expect(result.success).toBe(false);
  });
});

describe("getOwnerUsageSummary", () => {
  it("returns only the asked-for owner and period, ordered by meter", async () => {
    const { db } = makeSqliteD1();
    await upsertUsage(db, logger, ALICE, PERIOD, [
      { meter: "sandbox_ms_month", quantity: 2 },
      { meter: "llm_tokens_month", quantity: 1 },
    ]);
    await upsertUsage(db, logger, ALICE, "2026-08", [{ meter: "llm_tokens_month", quantity: 999 }]);
    await upsertUsage(db, logger, { ownerId: "org_acme", ownerType: "org" }, PERIOD, [
      { meter: "llm_tokens_month", quantity: 999 },
    ]);

    const summary = await getOwnerUsageSummary(db, logger, "user_alice", PERIOD);
    expect(summary.success && summary.data.map((e) => [e.meter, e.quantity])).toEqual([
      ["llm_tokens_month", 1],
      ["sandbox_ms_month", 2],
    ]);
  });

  it("returns an empty summary for an owner that has consumed nothing", async () => {
    const { db } = makeSqliteD1();
    const summary = await getOwnerUsageSummary(db, logger, "user_nobody", PERIOD);
    expect(summary.success && summary.data).toEqual([]);
  });

  it("reports a database failure as a Result rather than throwing", async () => {
    const summary = await getOwnerUsageSummary(makeThrowingD1(), logger, "user_alice", PERIOD);
    expect(summary.success).toBe(false);
  });
});

describe("usagePeriod", () => {
  it("puts either side of a UTC month boundary in a different period", () => {
    // Honest about its own limits: on a UTC runner — which is what CI is —
    // these assertions do NOT discriminate against a local-time implementation,
    // because local and UTC agree. Forcing `process.env.TZ` here would make them
    // discriminate, and was tried; it is process-global while vitest runs
    // several files per worker, so it perturbs every other suite sharing the
    // process. A flaky suite costs more than this test can buy.
    //
    // The guarantee therefore rests on `usagePeriod` deriving from
    // `toISOString()`, which is UTC by construction. What these pin is the
    // property that matters either way: one millisecond either side of a
    // boundary must not land in the same period, or two counters would share an
    // allowance across the rollover.
    expect(usagePeriod(new Date("2026-09-30T23:59:59.999Z"))).toBe("2026-09");
    expect(usagePeriod(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10");
    expect(usagePeriod(new Date("2025-12-31T23:59:59.999Z"))).toBe("2025-12");
    expect(usagePeriod(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });
});

// ---------------------------------------------------------------------------
// 3.3 — what recordCosts accumulates, and what it declines to
// ---------------------------------------------------------------------------

describe("meterForCostKind", () => {
  it("meters the two kinds an allowance is set on and no others", () => {
    expect(meterForCostKind("llm_tokens")).toBe("llm_tokens_month");
    expect(meterForCostKind("sandbox_ms")).toBe("sandbox_ms_month");
    // Not `deploys_month`: git operations are recorded by paths that deploy
    // nothing, so routing them there would count deploys that never happened.
    expect(meterForCostKind("git_ops")).toBeNull();
  });
});

describe("recordCosts accumulates usage alongside the ledger", () => {
  it("writes both, from one period, for an attributed batch", async () => {
    const { db, raw } = makeSqliteD1();
    const result = await recordCosts(
      db,
      logger,
      { project: "@alice/my-repo", changeId: "chg_1", ...ALICE },
      [
        { kind: "llm_tokens", quantity: 1_500, estimated: true },
        { kind: "git_ops", quantity: 2 },
      ],
    );
    expect(result.success).toBe(true);
    expect(countCostRows(raw)).toBe(2);

    const rows = usageRows(raw);
    expect(rows.map((r) => [r.meter, r.quantity])).toEqual([["llm_tokens_month", 1_500]]);
    expect(rows[0]?.owner_type).toBe("user");
    // Ledger row and aggregate must agree about which month they belong to.
    const created = raw.prepare("SELECT created_at FROM cost_records LIMIT 1").get() as {
      created_at: string;
    };
    expect(rows[0]?.period).toBe(usagePeriod(new Date(created.created_at)));
  });

  it("skips a sample no account can be billed for", async () => {
    // The ledger keeps it with a NULL owner because the spend happened; the
    // aggregate cannot, because a quantity nobody owes cannot be enforced
    // against anyone. `usage_periods.owner_id` is NOT NULL for this reason.
    const { db, raw } = makeSqliteD1();
    const result = await recordCosts(db, logger, { project: "@alice/my-repo" }, [
      { kind: "llm_tokens", quantity: 900, estimated: true },
    ]);
    expect(result.success).toBe(true);
    expect(countCostRows(raw)).toBe(1);
    expect(usageRows(raw)).toEqual([]);
  });

  it("writes no aggregate row for a batch of unmetered kinds alone", async () => {
    const { db, raw } = makeSqliteD1();
    await recordCosts(db, logger, { project: "@alice/my-repo", ...ALICE }, [
      { kind: "git_ops", quantity: 3 },
    ]);
    expect(countCostRows(raw)).toBe(1);
    expect(usageRows(raw)).toEqual([]);
  });

  it("accumulates across separate recordings, as a monthly counter must", async () => {
    const { db, raw } = makeSqliteD1();
    for (const quantity of [100, 250, 40]) {
      await recordCosts(db, logger, { project: "@alice/my-repo", ...ALICE }, [
        { kind: "llm_tokens", quantity },
      ]);
    }
    expect(usageRows(raw).map((r) => r.quantity)).toEqual([390]);
  });

  it("bills a BYOK sample to the same subject as a platform one", async () => {
    // `source` records whose provider account paid; it does not change whose
    // usage it is. An org running its own key still consumes org allowance.
    const { db, raw } = makeSqliteD1();
    await recordCosts(db, logger, { project: "@acme/api", ownerId: "org_acme", ownerType: "org" }, [
      { kind: "llm_tokens", quantity: 800, source: "byok" },
    ]);
    expect(usageRows(raw)[0]).toMatchObject({
      owner_id: "org_acme",
      quantity: 800,
      source: "byok",
    });
  });

  it("refuses a negative delta rather than refunding the month", async () => {
    // The refund vector the CHECK and the guard both exist for. sandbox_ms is
    // wall-clock arithmetic, so a backwards clock step produces one without
    // anybody trying — and it would subtract through the single statement this
    // table exists to make non-refundable.
    const { db, raw } = makeSqliteD1();
    await upsertUsage(db, logger, ALICE, "2026-09", [
      { meter: "sandbox_ms_month", quantity: 5_000 },
    ]);
    const result = await upsertUsage(db, logger, ALICE, "2026-09", [
      { meter: "sandbox_ms_month", quantity: -4_000 },
    ]);

    expect(result.success).toBe(true);
    expect(usageRows(raw).map((r) => r.quantity)).toEqual([5_000]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not a usable increment"),
      expect.objectContaining({ quantity: -4_000 }),
    );
  });

  it("keeps BYOK and platform spend as separate totals for the same meter", async () => {
    // The reason `source` is in the PRIMARY KEY. An allowance limits what the
    // OPERATOR spends, so enforcement reads the platform row alone — a project
    // paying its own provider costs the operator nothing. Summed together these
    // could never be separated again: this table is not rebuildable from
    // cost_records, so the dimension has to be captured as it is written.
    const { db, raw } = makeSqliteD1();
    await recordCosts(db, logger, { project: "@alice/my-repo", ...ALICE }, [
      { kind: "llm_tokens", quantity: 1000 },
      { kind: "llm_tokens", quantity: 250, source: "byok" },
    ]);
    await recordCosts(db, logger, { project: "@alice/my-repo", ...ALICE }, [
      { kind: "llm_tokens", quantity: 500, source: "byok" },
    ]);

    const rows = usageRows(raw).filter((r) => r.meter === "llm_tokens_month");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.source === "platform")?.quantity).toBe(1000);
    expect(rows.find((r) => r.source === "byok")?.quantity).toBe(750);
  });
});
