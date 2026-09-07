import { noticeUsageThresholds } from "../billing/usage-notifications";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { getAgent } from "./agents";
import {
  type UsageDelta,
  type UsageWriteTotal,
  meterForCostKind,
  upsertUsage,
  usagePeriod,
} from "./usage";

export type CostKind = "llm_tokens" | "sandbox_ms" | "git_ops";

/**
 * Whose provider account paid for a sample: the operator's (`platform`) or the
 * project's own credential (`byok`). Recorded per sample rather than per change
 * because one evaluation can mix the two — a BYOK `llm` evaluator alongside
 * git operations that are always the operator's cost.
 */
export type CostSource = "platform" | "byok";

export interface CostSample {
  kind: CostKind;
  quantity: number;
  /** True when the quantity is an estimate (e.g. character-based token counts). */
  estimated?: boolean;
  /** Defaults to `"platform"`: an evaluator that says nothing spent our money. */
  source?: CostSource;
}

/**
 * An account a cost row can actually be billed to.
 *
 * Narrower than `ProjectEntry.ownerType`, which also admits `"agent"` — see
 * `resolveBillingSubject`, which is the only thing allowed to make that mapping.
 */
export interface BillingSubject {
  ownerId: string;
  ownerType: "user" | "org";
}

export interface CostSummaryEntry {
  kind: CostKind;
  total: number;
  estimated: boolean;
}

interface SummaryRow {
  kind: string;
  total: number;
  any_estimated: number;
}

/**
 * The account that owes for spend incurred on behalf of `owner`, or `null` when
 * no account can be named.
 *
 * The single home for the `ownerType -> billing subject` mapping: every
 * recording site resolves through here so the agent walk and the
 * cannot-be-attributed rule exist once rather than at each of them. Accepts a whole
 * `ProjectEntry` (structurally) or a bare owner pair.
 *
 * An **agent is not a payer** — it belongs to one — so `"agent"` walks
 * `agents.owner_id` (migrations/001_core.sql) to the user that owns it.
 * `billingContextFor` (src/services/change-flow.ts) deliberately does not do
 * this: it is synchronous and KV-only, while this needs D1. No creation path
 * writes `ownerType: "agent"` today, so that branch is defensive against
 * restored backups and future ownership transfer, not a live code path.
 *
 * **Never throws.** `recordCosts` is best-effort by contract and runs inside
 * change creation, merge and deploy; an unresolvable owner must cost the
 * attribution, never the change. Every failure returns `null` and logs — a row
 * with a NULL owner is honest about being unattributed, which is why migration
 * 048 leaves those columns nullable.
 *
 * @param owner - A `ProjectEntry`, or any object carrying its owner fields
 * @returns The billing subject, or `null` when none can be named
 */
export async function resolveBillingSubject(
  db: D1Database,
  logger: Logger,
  // Spelled out rather than `ProjectEntry["ownerType"]` on purpose: if a fourth
  // owner kind is ever added, this must fail to compile so someone decides who
  // pays, instead of silently falling through to the agent walk.
  owner: { ownerId?: string; ownerType?: "user" | "org" | "agent" },
): Promise<BillingSubject | null> {
  const { ownerId, ownerType } = owner;
  // KV entries are cast without shape validation and legacy rows genuinely lack
  // fields, so the type's promise is not a runtime guarantee.
  if (!ownerId || !ownerType) {
    logger.warn("Cost attribution skipped: project names no owner", { ownerId, ownerType });
    return null;
  }
  if (ownerType === "user" || ownerType === "org") return { ownerId, ownerType };

  const agentResult = await getAgent(db, ownerId, logger);
  if (!agentResult.success) {
    logger.warn("Cost attribution skipped: agent owner could not be resolved to a user", {
      agentId: ownerId,
      error: agentResult.error.message,
    });
    return null;
  }
  // No emptiness check on the resolved id, unlike the owner fields above:
  // `agents.owner_id` is NOT NULL and REFERENCES users(id), and D1 enforces
  // foreign keys, so a row that exists names a user that exists.
  return { ownerId: agentResult.data.ownerId, ownerType: "user" };
}

/**
 * Accumulate the metered half of a batch into `usage_periods`.
 *
 * Split out of `recordCosts` so every recording site gets it without any of
 * them knowing it exists — the aggregate must never be something a call site
 * can forget, because a site that forgets is an owner whose spend does not
 * count against their allowance.
 *
 * Samples with no billing subject are skipped. `cost_records` keeps them with a
 * NULL owner because the spend still happened, but a quantity nobody can be
 * billed for cannot be enforced against anyone, so there is no row here to
 * write it into — `usage_periods.owner_id` is NOT NULL for exactly that reason.
 *
 * The period comes from the same `createdAt` the ledger rows carry, so a cost
 * row and the month it counts toward cannot land on opposite sides of a
 * boundary.
 */
async function accumulateUsage(
  db: D1Database,
  logger: Logger,
  opts: { ownerId?: string; ownerType?: BillingSubject["ownerType"] },
  samples: CostSample[],
  createdAt: string,
): Promise<{ subject: BillingSubject; period: string; totals: UsageWriteTotal[] } | null> {
  if (!opts.ownerId || !opts.ownerType) return null;
  const deltas: UsageDelta[] = [];
  for (const sample of samples) {
    // `git_ops` maps to no meter; see `meterForCostKind`.
    const meter = meterForCostKind(sample.kind);
    if (meter) {
      deltas.push({ meter, quantity: sample.quantity, source: sample.source ?? "platform" });
    }
  }
  if (deltas.length === 0) return null;
  // The Result is deliberately not folded into `recordCosts`'s own: the ledger
  // rows above ARE written, and reporting an error would tell the caller the
  // spend went unrecorded when it did not. `upsertUsage` logs its own failure.
  //
  // Be clear about what that costs, because it is not free and there is no job
  // that repairs it: this aggregate cannot be rebuilt from `cost_records` (the
  // project cascade deletes those rows and leaves these standing — see
  // migration 049), so a failed upsert is a permanent under-count of that
  // owner's month. Accepted because the alternative is failing a merge over an
  // accounting write, which is the worse trade in both directions.
  const subject: BillingSubject = { ownerId: opts.ownerId, ownerType: opts.ownerType };
  const period = usagePeriod(new Date(createdAt));
  const written = await upsertUsage(db, logger, subject, period, deltas);
  // The post-write totals travel back up so the caller can notice an 80%
  // crossing without a second read; a failed write reports nothing to notice.
  return written.success ? { subject, period, totals: written.data } : null;
}

/**
 * Record cost samples for a change. Best-effort: failures are logged and
 * reported, but callers treat cost recording as non-blocking.
 *
 * `ownerId`/`ownerType` name who pays, and come from `resolveBillingSubject` —
 * omitting them records the spend unattributed rather than refusing to record
 * it, because a sample nobody can be billed for is still a sample that happened.
 */
export async function recordCosts(
  db: D1Database,
  logger: Logger,
  opts: {
    project: string;
    projectId?: string;
    changeId?: string;
    workspace?: string;
    ownerId?: string;
    ownerType?: BillingSubject["ownerType"];
    /**
     * Everything the threshold notification needs, when the call site can
     * supply it. Absent means the write is recorded and nobody is told they are
     * approaching a limit — which is the correct behaviour for a site with no
     * `Env` in hand, and the reason this is optional rather than a second
     * required argument. Inert unless the cloud billing service is configured.
     */
    notify?: {
      env: Env;
      /** The acting user, for the §4a enforcement subject and the addressee. */
      actorUserId?: string;
      /** Present on a request path; the queue consumers pass nothing. */
      waitUntil?: (promise: Promise<unknown>) => void;
    };
  },
  samples: CostSample[],
): Promise<Result<void, AppError>> {
  if (samples.length === 0) return ok(undefined);

  // Dropped BEFORE the batch, not inside the aggregate that also guards them.
  // `db.batch` is one transaction and `cost_records.quantity` is NOT NULL,
  // while SQLite stores NaN as NULL — so a single unusable sample does not cost
  // itself, it aborts the write and loses every other sample in the same
  // evaluation. Filtering here keeps one bad number from taking the ledger with
  // it, and is why `upsertUsage`'s own guard is a backstop rather than the
  // first line of defence.
  //
  // Negative quantities are dropped for a different reason: they write fine.
  // A row for negative spend is never right — it silently refunds an owner's
  // month through `accumulateUsage` — and no meter this records can go
  // backwards. The providers validate their own token counts (`usageOrNothing`
  // in `evaluation/llm-provider.ts`); this is the defence that does not depend
  // on every future sample source remembering to.
  const usable = samples.filter(
    (sample) => Number.isFinite(sample.quantity) && sample.quantity >= 0,
  );
  if (usable.length !== samples.length) {
    logger.warn("Cost samples dropped: quantity is not a finite, non-negative number", {
      project: opts.project,
      dropped: samples.length - usable.length,
    });
  }
  if (usable.length === 0) return ok(undefined);
  const createdAt = new Date().toISOString();

  try {
    const stmt = db.prepare(
      "INSERT INTO cost_records (id, project, project_id, change_id, workspace, kind, quantity, estimated, created_at, owner_id, owner_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    await db.batch(
      usable.map((sample) =>
        stmt.bind(
          newId("cost"),
          opts.project,
          opts.projectId ?? null,
          opts.changeId ?? null,
          opts.workspace ?? null,
          sample.kind,
          sample.quantity,
          sample.estimated ? 1 : 0,
          createdAt,
          opts.ownerId ?? null,
          opts.ownerType ?? null,
          // Bound explicitly rather than left to the column DEFAULT: the column
          // is NOT NULL, so an unset source must resolve here, not in SQLite.
          sample.source ?? "platform",
        ),
      ),
    );
    logger.debug("Cost samples recorded", {
      project: opts.project,
      changeId: opts.changeId,
      count: samples.length,
    });
    // Only after the ledger write succeeded: the aggregate derives from those
    // rows, so it must never count spend the ledger does not record.
    const accumulated = await accumulateUsage(db, logger, opts, usable, createdAt);
    if (accumulated && opts.notify) {
      noticeUsageThresholds(opts.notify.env, logger, {
        recorded: accumulated.subject,
        ...(opts.notify.actorUserId !== undefined ? { actorUserId: opts.notify.actorUserId } : {}),
        period: accumulated.period,
        totals: accumulated.totals,
        ...(opts.notify.waitUntil !== undefined ? { waitUntil: opts.notify.waitUntil } : {}),
      });
    }
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to record costs",
            "DATABASE_ERROR",
            500,
            { operation: "recordCosts", project: opts.project },
          );
    logger.error("Failed to record cost samples", appError, { project: opts.project });
    return err(appError);
  }
}

export async function getChangeCostSummary(
  db: D1Database,
  logger: Logger,
  changeId: string,
): Promise<Result<CostSummaryEntry[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT kind, SUM(quantity) AS total, MAX(estimated) AS any_estimated FROM cost_records WHERE change_id = ? GROUP BY kind",
      )
      .bind(changeId)
      .all<SummaryRow>();
    return ok(
      result.results.map((row) => ({
        kind: row.kind as CostKind,
        total: row.total,
        estimated: row.any_estimated === 1,
      })),
    );
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to summarize costs",
            "DATABASE_ERROR",
            500,
            { operation: "getChangeCostSummary", changeId },
          );
    logger.error("Failed to get change cost summary", appError, { changeId });
    return err(appError);
  }
}
