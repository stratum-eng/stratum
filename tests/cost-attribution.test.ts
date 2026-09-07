/**
 * Cost attribution: migration 048's columns, and the one function allowed to
 * decide who a cost row is billed to.
 *
 * D1 is real SQLite with the production migrations applied, so these assertions
 * run against the shipped schema — the CHECK constraints, the NOT NULL DEFAULT
 * that backfills `source`, and the owner index — rather than against a stub's
 * idea of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CostSample,
  getChangeCostSummary,
  recordCosts,
  resolveBillingSubject,
} from "../src/storage/costs";
import type { ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
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

interface CostRow {
  project: string;
  project_id: string | null;
  change_id: string | null;
  kind: string;
  quantity: number;
  owner_id: string | null;
  owner_type: string | null;
  source: string;
  created_at: string;
}

function projectEntry(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "proj_abc",
    name: "my-repo",
    slug: "my-repo",
    namespace: "@alice",
    ownerId: "user_alice",
    ownerType: "user",
    remote: "https://artifacts.example.com/repos/my-repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 2.2 — resolveBillingSubject
// ---------------------------------------------------------------------------

describe("resolveBillingSubject", () => {
  function withAgent(ownerId: string, agentId = "agt_bot") {
    const { db, raw } = makeSqliteD1();
    raw
      .prepare("INSERT INTO users (id, email, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run("user_alice", "alice@example.com", "hash", "2026-01-01T00:00:00.000Z");
    raw
      .prepare(
        "INSERT INTO agents (id, name, owner_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(agentId, "bot", ownerId, "agent-hash", "2026-01-01T00:00:00.000Z");
    return db;
  }

  it("bills a user-owned project to its owner", async () => {
    const { db } = makeSqliteD1();
    await expect(resolveBillingSubject(db, logger, projectEntry())).resolves.toEqual({
      ownerId: "user_alice",
      ownerType: "user",
    });
  });

  it("bills an org-owned project to the org", async () => {
    const { db } = makeSqliteD1();
    const project = projectEntry({ ownerId: "org_acme", ownerType: "org" });
    await expect(resolveBillingSubject(db, logger, project)).resolves.toEqual({
      ownerId: "org_acme",
      ownerType: "org",
    });
  });

  it("takes a bare owner pair as readily as a ProjectEntry", async () => {
    // The recording sites hold a whole entry; nothing should have to synthesize
    // one to ask this question.
    const { db } = makeSqliteD1();
    await expect(
      resolveBillingSubject(db, logger, { ownerId: "org_acme", ownerType: "org" }),
    ).resolves.toEqual({ ownerId: "org_acme", ownerType: "org" });
  });

  it("walks an agent-owned project to the user that owns the agent", async () => {
    // Defensive: no creation path writes ownerType "agent" today. It exists so
    // a restored backup or a future ownership transfer bills the human behind
    // the agent rather than an id no account can be reconciled against.
    const db = withAgent("user_alice");
    const project = projectEntry({ ownerId: "agt_bot", ownerType: "agent" });
    await expect(resolveBillingSubject(db, logger, project)).resolves.toEqual({
      ownerId: "user_alice",
      ownerType: "user",
    });
  });

  it("yields nothing, and logs, when the agent row is gone", async () => {
    const db = withAgent("user_alice", "agt_other");
    const project = projectEntry({ ownerId: "agt_bot", ownerType: "agent" });
    await expect(resolveBillingSubject(db, logger, project)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Cost attribution skipped"),
      expect.objectContaining({ agentId: "agt_bot" }),
    );
  });

  it.each([
    ["no ownerId", { ownerId: "" }],
    ["no ownerType", { ownerType: undefined }],
  ])("yields nothing for a project with %s", async (_label, overrides) => {
    // KV entries are cast without shape validation, so the type's promise is
    // not a runtime guarantee.
    const { db } = makeSqliteD1();
    const project = { ...projectEntry(), ...overrides } as ProjectEntry;
    await expect(resolveBillingSubject(db, logger, project)).resolves.toBeNull();
  });

  it("never throws when the database is unreachable", async () => {
    // The contract that matters: this runs inside change creation, merge and
    // deploy. A dead D1 must cost the attribution, never the change.
    const project = projectEntry({ ownerId: "agt_bot", ownerType: "agent" });
    await expect(
      resolveBillingSubject(makeThrowingD1("D1 down"), logger, project),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2.1 / 2.3 — the columns, and what recordCosts writes into them
// ---------------------------------------------------------------------------

describe("recordCosts attribution columns", () => {
  function rows(raw: ReturnType<typeof makeSqliteD1>["raw"]): CostRow[] {
    return raw.prepare("SELECT * FROM cost_records ORDER BY kind").all() as unknown as CostRow[];
  }

  it("stamps the billing subject on every sample of a batch", async () => {
    const { db, raw } = makeSqliteD1();
    const subject = await resolveBillingSubject(db, logger, projectEntry());
    expect(subject).not.toBeNull();

    const result = await recordCosts(
      db,
      logger,
      {
        project: "@alice/my-repo",
        projectId: "proj_abc",
        changeId: "chg_1",
        workspace: "ws-1",
        ...(subject ?? {}),
      },
      [
        { kind: "git_ops", quantity: 2 },
        { kind: "llm_tokens", quantity: 1200, estimated: true },
      ],
    );

    expect(result.success).toBe(true);
    expect(rows(raw)).toHaveLength(2);
    for (const row of rows(raw)) {
      expect(row.owner_id).toBe("user_alice");
      expect(row.owner_type).toBe("user");
    }
  });

  it("records the row unattributed rather than refusing it when no owner resolves", async () => {
    // The spend happened. A NULL owner is honest about being unbillable; losing
    // the row would lose the only evidence the resource was consumed.
    const { db, raw } = makeSqliteD1();
    const subject = await resolveBillingSubject(db, logger, projectEntry({ ownerId: "" }));
    expect(subject).toBeNull();

    const result = await recordCosts(
      db,
      logger,
      { project: "@alice/my-repo", changeId: "chg_1", ...(subject ?? {}) },
      [{ kind: "llm_tokens", quantity: 900, estimated: true }],
    );

    expect(result.success).toBe(true);
    expect(rows(raw)[0]?.owner_id).toBeNull();
    expect(rows(raw)[0]?.owner_type).toBeNull();
    // Still summarized for the change page, exactly as before attribution.
    const summary = await getChangeCostSummary(db, logger, "chg_1");
    expect(summary.success && summary.data[0]?.total).toBe(900);
  });

  it("defaults source to platform for a sample that does not name one", async () => {
    const { db, raw } = makeSqliteD1();
    await recordCosts(db, logger, { project: "p" }, [{ kind: "git_ops", quantity: 1 }]);
    expect(rows(raw)[0]?.source).toBe("platform");
  });

  it("carries a byok sample through unchanged", async () => {
    // An evaluator running on the project's own credential is the only thing
    // that can know this; every recording site just flattens what it reports.
    const { db, raw } = makeSqliteD1();
    const samples: CostSample[] = [
      { kind: "llm_tokens", quantity: 800, estimated: false, source: "byok" },
      { kind: "git_ops", quantity: 1 },
    ];
    await recordCosts(db, logger, { project: "p", ownerId: "org_acme", ownerType: "org" }, samples);

    const byKind = Object.fromEntries(rows(raw).map((r) => [r.kind, r]));
    expect(byKind.llm_tokens?.source).toBe("byok");
    expect(byKind.git_ops?.source).toBe("platform");
    // Attribution is independent of who paid the provider: an org running BYOK
    // is still the subject the usage is counted against.
    expect(byKind.llm_tokens?.owner_type).toBe("org");
  });

  it("backfills pre-048 rows as platform spend", async () => {
    // The NOT NULL DEFAULT is correct by construction: BYOK did not exist when
    // these rows were written, so every one of them was the operator's spend.
    const { db, raw } = makeSqliteD1();
    raw
      .prepare(
        "INSERT INTO cost_records (id, project, kind, quantity, estimated, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("cost_legacy", "p", "llm_tokens", 500, 0, "2026-01-01T00:00:00.000Z");

    const legacy = rows(raw)[0];
    expect(legacy?.source).toBe("platform");
    expect(legacy?.owner_id).toBeNull();

    // And it still aggregates alongside an attributed row. The legacy INSERT
    // above carries no change_id, so it must be given one to be summarized at
    // all — asserting only that the summary succeeds would pass against an
    // empty result, and therefore against any schema.
    raw.prepare("UPDATE cost_records SET change_id = ? WHERE id = ?").run("chg_1", "cost_legacy");
    await recordCosts(
      db,
      logger,
      { project: "p", changeId: "chg_1", ownerId: "user_alice", ownerType: "user" },
      [{ kind: "llm_tokens", quantity: 250 }],
    );

    const summary = await getChangeCostSummary(db, logger, "chg_1");
    expect(summary.success).toBe(true);
    if (!summary.success) return;
    const llm = summary.data.find((entry) => entry.kind === "llm_tokens");
    expect(llm?.total).toBe(750);
  });

  it("drops one unusable sample instead of losing the whole batch to it", async () => {
    // db.batch is a transaction and quantity is NOT NULL, while SQLite stores
    // NaN as NULL — so an unfiltered NaN would not cost itself, it would abort
    // the write and take every other sample in the same evaluation with it.
    const { db, raw } = makeSqliteD1();
    const result = await recordCosts(
      db,
      logger,
      { project: "p", changeId: "chg_1", ownerId: "user_alice", ownerType: "user" },
      [
        { kind: "llm_tokens", quantity: Number.NaN, estimated: true },
        { kind: "git_ops", quantity: 2 },
      ],
    );

    expect(result.success).toBe(true);
    const kept = rows(raw);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.kind).toBe("git_ops");
  });

  it("drops a negative quantity, which would write fine and refund a month", async () => {
    // Unlike NaN this one costs nothing to store, which is the problem: it
    // becomes a ledger row for negative spend and decrements the owner's usage
    // period. No meter recorded here can run backwards.
    const { db, raw } = makeSqliteD1();
    const result = await recordCosts(
      db,
      logger,
      { project: "p", changeId: "chg_1", ownerId: "user_alice", ownerType: "user" },
      [
        { kind: "llm_tokens", quantity: -1e12 },
        { kind: "git_ops", quantity: 2 },
      ],
    );

    expect(result.success).toBe(true);
    const kept = rows(raw);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.kind).toBe("git_ops");
  });

  it("serves an owner-scoped, newest-first history from the new index", async () => {
    // What idx_costs_owner exists for. `created_at` is written only by
    // recordCosts as an ISO 8601 string, so ordering it in SQL is safe here —
    // the mixed-format hazard 042/044/047 warn about needs two writers.
    const { raw } = makeSqliteD1();
    // Written directly rather than through recordCosts: that function stamps
    // `new Date().toISOString()`, and successive calls land inside the same
    // millisecond, so an ordering assertion over them would hold whatever the
    // ORDER BY said. Distinct timestamps are the whole point of the test.
    const insert = raw.prepare(
      "INSERT INTO cost_records (id, project, kind, quantity, estimated, created_at, owner_id, owner_type, source) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'platform')",
    );
    insert.run("c_old", "p", "git_ops", 1, "2026-01-01T00:00:00.000Z", "user_alice", "user");
    insert.run("c_new", "p", "git_ops", 2, "2026-03-01T00:00:00.000Z", "user_alice", "user");
    insert.run("c_other", "p", "git_ops", 5, "2026-02-01T00:00:00.000Z", "org_acme", "org");

    const mine = raw
      .prepare("SELECT quantity FROM cost_records WHERE owner_id = ? ORDER BY created_at DESC")
      .all("user_alice") as unknown as Array<{ quantity: number }>;
    // Newest first, and another subject's row is not in it.
    expect(mine.map((r) => r.quantity)).toEqual([2, 1]);

    // The planner must actually reach for the index, not merely have it: an
    // index nothing uses is a write cost with no read benefit.
    const plan = raw
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM cost_records WHERE owner_id = ? ORDER BY created_at DESC",
      )
      .all("user_alice") as unknown as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join(" ")).toContain("idx_costs_owner");
  });

  it("reports, and does not throw, when the owner_type CHECK rejects a row", async () => {
    // The CHECK is the last line of defense against an owner_type no billing
    // subject can have. It must surface as a Result, not an exception thrown
    // into a merge.
    const { db } = makeSqliteD1();
    const result = await recordCosts(
      db,
      logger,
      // Only reachable by lying to the compiler — which is the point: the
      // database refuses it even if a future caller bypasses the type.
      { project: "p", ownerId: "agt_bot", ownerType: "agent" as "user" },
      [{ kind: "git_ops", quantity: 1 }],
    );
    expect(result.success).toBe(false);
  });
});
