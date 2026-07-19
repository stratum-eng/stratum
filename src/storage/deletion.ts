import type { Env, ProjectEntry, WorkspaceEntry } from "../types";
import { type AppError, toAppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { findActiveJobForTarget } from "./deletion-jobs";
import { artifactsRepoNameFromRemote } from "./git-ops";
import { deleteAllUserSessions } from "./sessions";
import { listProjects } from "./state";

/**
 * Shared tombstone for anonymized cross-project contributions. A single
 * sentinel (vs a per-deletion opaque id) keeps erasure GDPR-clean and simple:
 * the identity is gone, the contribution stays. See PRD Open Question #3.
 */
export const DELETED_USER_SENTINEL = "deleted-user";

/**
 * Durable inventory of everything a project deletion must touch, captured
 * BEFORE any destruction so a re-drive after a partial cascade still knows
 * about FK children whose parents are already gone.
 */
export interface DeletionTarget {
  projectId: string;
  namespace: string;
  slug: string;
  name: string;
  workspaceNames: string[];
  forkRepoNames: string[];
  projectRepoName: string | null;
  changeIds: string[];
  webhookIds: string[];
  /**
   * True when any OTHER project shares this project's name or slug. Historical
   * D1 rows may carry a NULL project_id and only a bare `project` name — under
   * a collision, deleting those by name would destroy another tenant's rows,
   * so the cascade must skip them (and report them as residuals) instead.
   */
  nameCollision: boolean;
}

/**
 * Tables that gained a `project_id` column in migration 025 but whose
 * historical rows may still only be identifiable by the bare `project` name.
 * Order matters for the cascade: `changes`/`webhooks` are FK parents and must
 * come after their children (deleted separately by captured id-sets).
 */
const PROJECT_SCOPED_TABLES = [
  "changes",
  "webhooks",
  "provenance",
  "events",
  "cost_records",
  "commit_metrics",
  "issues",
] as const;

/** Tables keyed by the globally-unique (namespace, slug) tuple. */
const NS_SLUG_TABLES = ["sync_history", "import_jobs", "import_metrics", "failed_imports"] as const;

/** D1 caps bound parameters per statement; 50 keeps IN-lists comfortably under it. */
const IN_LIST_CHUNK_SIZE = 50;

const ARTIFACTS_DELETE_MAX_ATTEMPTS = 3;

const PROJECT_PREFIX = "project:";
const WORKSPACE_PREFIX = "workspace:";

function workspacePrefix(projectId: string): string {
  return `${WORKSPACE_PREFIX}${projectId}:`;
}

function snapshotKey(namespace: string, slug: string): string {
  // Mirrors src/storage/repo-snapshot.ts, which URI-encodes both segments.
  return `repo_snapshot:${encodeURIComponent(namespace)}:${encodeURIComponent(slug)}`;
}

function syncStatusKey(namespace: string, slug: string): string {
  return `sync-status:${namespace}:${slug}`;
}

function policyKey(projectId: string): string {
  return `policy:${projectId}`;
}

function projectKey(namespace: string, slug: string): string {
  return `${PROJECT_PREFIX}${namespace}:${slug}`;
}

function legacyProjectKey(name: string): string {
  return `${PROJECT_PREFIX}${name}`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** KV `list` returns at most one page per call; loop the cursor to exhaustion. */
async function listKeysPaginated(kv: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list(cursor ? { prefix, cursor } : { prefix });
    for (const key of page.keys) names.push(key.name);
    if (page.list_complete) break;
    cursor = page.cursor;
    // Defensive: a stub or degenerate response without a cursor must not spin.
    if (!cursor) break;
  }
  return names;
}

async function selectIds(
  db: D1Database,
  table: "changes" | "webhooks",
  projectId: string,
  name: string,
  nameCollision: boolean,
): Promise<string[]> {
  // Under a name collision the bare-name form would also match another tenant's
  // NULL-project_id rows, so their FK children would be scooped into our id-set
  // and deleted (cross-tenant loss). When colliding, capture by project_id only;
  // NULL-id children are left behind (surfaced as residuals by the cascade).
  const stmt = nameCollision
    ? db.prepare(`SELECT id FROM ${table} WHERE project_id = ?`).bind(projectId)
    : db
        .prepare(
          `SELECT id FROM ${table} WHERE project_id = ? OR (project_id IS NULL AND project = ?)`,
        )
        .bind(projectId, name);
  const result = await stmt.all<{ id: string }>();
  return result.results.map((row) => row.id);
}

/** Whether any OTHER project shares this project's name or slug. */
async function detectNameCollision(
  env: Env,
  project: ProjectEntry,
  logger: Logger,
): Promise<boolean> {
  // Historical rows record whichever form the creating caller used (name or
  // slug), so any overlap in either identifier counts as a collision.
  const identifiers = new Set([project.name, project.slug]);
  const projectKeys = await listKeysPaginated(env.STATE, PROJECT_PREFIX);
  for (const key of projectKeys) {
    const raw = await env.STATE.get(key);
    if (!raw) continue;
    let other: ProjectEntry;
    try {
      other = JSON.parse(raw) as ProjectEntry;
    } catch (error) {
      logger.error(
        "Failed to parse project entry during collision scan",
        error instanceof Error ? error : undefined,
        { key },
      );
      continue;
    }
    if (!other || typeof other !== "object" || other.id === project.id) continue;
    if (identifiers.has(other.name) || identifiers.has(other.slug)) {
      logger.warn("Deletion target name collides with another project", {
        projectId: project.id,
        otherId: other.id,
        name: project.name,
      });
      return true;
    }
  }
  return false;
}

/**
 * Resolve and return the full deletion inventory for a project. Pure data
 * capture — nothing is deleted here. The result is persisted into the
 * deletion job so a crash mid-cascade never loses track of FK children.
 */
export async function captureDeletionTarget(
  env: Env,
  project: ProjectEntry,
  logger: Logger,
): Promise<Result<DeletionTarget, AppError>> {
  try {
    const workspaceKeys = await listKeysPaginated(env.STATE, workspacePrefix(project.id));
    const workspaceNames: string[] = [];
    const forkRepoNames = new Set<string>();
    for (const key of workspaceKeys) {
      workspaceNames.push(key.substring(workspacePrefix(project.id).length));
      const raw = await env.STATE.get(key);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw) as WorkspaceEntry;
        const repoName =
          typeof entry.remote === "string" ? artifactsRepoNameFromRemote(entry.remote) : null;
        if (repoName) forkRepoNames.add(repoName);
      } catch (error) {
        // A corrupt workspace entry still gets its KV key deleted (captured
        // above); we just can't resolve its Artifacts fork. Surface it loudly.
        logger.error(
          "Failed to parse workspace entry during deletion capture",
          error instanceof Error ? error : undefined,
          { key },
        );
      }
    }

    const projectRepoName = artifactsRepoNameFromRemote(project.remote);

    // Collision scan runs BEFORE the id capture so `selectIds` can apply the
    // guard — otherwise the name-form capture scoops another tenant's FK
    // children. Computed ONCE so the cascade and verifier apply the exact same
    // scoping decision on every re-drive.
    const nameCollision = await detectNameCollision(env, project, logger);

    const changeIds = await selectIds(env.DB, "changes", project.id, project.name, nameCollision);
    const webhookIds = await selectIds(env.DB, "webhooks", project.id, project.name, nameCollision);

    return ok({
      projectId: project.id,
      namespace: project.namespace,
      slug: project.slug,
      name: project.name,
      workspaceNames,
      forkRepoNames: [...forkRepoNames],
      projectRepoName,
      changeIds,
      webhookIds,
      nameCollision,
    });
  } catch (error) {
    const appError = toAppError(error);
    logger.error("Failed to capture deletion target", appError, { projectId: project.id });
    return err(appError);
  }
}

/**
 * Whether a project's owning user is soft-`deleting`. Queue consumers call this
 * as their first action so a merge/import/sync landing mid-delete can't
 * re-create rows for a project whose owner is being erased.
 *
 * Only user-owned projects are gated here: an org owner isn't a `users` row, and
 * the account cascade deletes org-owned projects through its own path (Task 5),
 * so a per-consumer org lookup would add cost without changing the outcome. Fails
 * OPEN on a DB error (returns false) — a transient lookup failure must not wedge
 * the merge hot path; the verifier still degrades a racing writer to `incomplete`.
 */
export async function isTargetDeleting(
  env: Env,
  project: ProjectEntry,
  logger: Logger,
): Promise<boolean> {
  // The project itself may be mid-deletion (a project-scoped cascade), regardless
  // of owner type. The owner-account check below only covers user-owned projects,
  // so a project-delete would otherwise let merges/imports/syncs keep running
  // against a repo being torn down. Check the active project job first.
  const activeProjectJob = await findActiveJobForTarget(env.DB, logger, "project", project.id);
  if (activeProjectJob.success && activeProjectJob.data) return true;

  if (project.ownerType !== "user") return false;
  try {
    const row = await env.DB.prepare("SELECT deleting_at FROM users WHERE id = ?")
      .bind(project.ownerId)
      .first<{ deleting_at: string | null }>();
    return row?.deleting_at != null;
  } catch (error) {
    logger.error(
      "Failed to check owner deleting status",
      error instanceof Error ? error : undefined,
      { projectId: project.id, ownerId: project.ownerId },
    );
    return false;
  }
}

async function deleteByIdChunks(
  db: D1Database,
  table: string,
  column: string,
  ids: readonly string[],
): Promise<void> {
  for (const batch of chunk(ids, IN_LIST_CHUNK_SIZE)) {
    const placeholders = batch.map(() => "?").join(", ");
    await db
      .prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`)
      .bind(...batch)
      .run();
  }
}

/**
 * Delete a project-scoped table. Rows are matched by `project_id`; NULL-id
 * historical rows are additionally matched by name ONLY when no other project
 * shares the name — under a collision the name form could hit another
 * tenant's rows, so those rows are skipped and reported as residuals instead.
 */
async function deleteProjectScopedTable(
  db: D1Database,
  table: string,
  target: DeletionTarget,
  residuals: string[],
): Promise<void> {
  if (target.nameCollision) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id IS NULL AND project = ?`)
      .bind(target.name)
      .first<{ n: number }>();
    if ((row?.n ?? 0) > 0) {
      residuals.push(`d1:${table}:null-id-rows-skipped(name-collision)`);
    }
    await db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(target.projectId).run();
    return;
  }
  await db
    .prepare(`DELETE FROM ${table} WHERE project_id = ? OR (project_id IS NULL AND project = ?)`)
    .bind(target.projectId, target.name)
    .run();
}

/**
 * Delete one Artifacts repo with a bounded retry (no sleeps — callers run in
 * tests too). "Not found"-ish failures are success: the repo is already gone
 * and the cascade is idempotent. Returns false only on permanent failure.
 */
async function deleteArtifactsRepo(env: Env, name: string, logger: Logger): Promise<boolean> {
  for (let attempt = 1; attempt <= ARTIFACTS_DELETE_MAX_ATTEMPTS; attempt++) {
    try {
      await env.ARTIFACTS.delete(name);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not[ _-]?found|404|does not exist|no such/i.test(message)) {
        logger.debug("Artifacts repo already absent", { name });
        return true;
      }
      logger.warn("Artifacts delete failed", {
        name,
        attempt,
        maxAttempts: ARTIFACTS_DELETE_MAX_ATTEMPTS,
        error: message,
      });
    }
  }
  return false;
}

/** Purge a Durable Object's storage via its `purge()` RPC; false on failure. */
async function purgeDurableObject(
  namespace: DurableObjectNamespace | undefined,
  key: string,
  label: string,
  logger: Logger,
): Promise<boolean> {
  if (!namespace) {
    // Tests (and minimal deployments) run without the DO bindings; nothing to purge.
    logger.debug("DO binding absent; skipping purge", { label, key });
    return true;
  }
  try {
    const stub = namespace.get(namespace.idFromName(key)) as unknown as {
      purge(): Promise<void>;
    };
    await stub.purge();
    return true;
  } catch (error) {
    logger.error(
      "Failed to purge Durable Object storage",
      error instanceof Error ? error : undefined,
      { label, key },
    );
    return false;
  }
}

async function deleteKvKey(
  env: Env,
  key: string,
  residuals: string[],
  logger: Logger,
): Promise<void> {
  try {
    await env.STATE.delete(key);
  } catch (error) {
    logger.error("Failed to delete KV key", error instanceof Error ? error : undefined, { key });
    residuals.push(`kv:${key}`);
  }
}

/**
 * Destroy every byte tied to a captured deletion target, children before
 * parents and KV last (the project entry is the tombstone-of-record: while it
 * exists a re-drive can always re-resolve the target). Every step is
 * idempotent; the function reports failures as residuals or a Result error and
 * never throws.
 */
export async function deleteProjectCascade(
  env: Env,
  target: DeletionTarget,
  logger: Logger,
): Promise<Result<{ residuals: string[] }, AppError>> {
  const residuals: string[] = [];
  try {
    // 1) D1 — FK children first, keyed by the id-sets captured up front so
    // they stay deletable even after a crash removed their parents.
    await deleteByIdChunks(env.DB, "eval_runs", "change_id", target.changeIds);
    await deleteByIdChunks(env.DB, "change_comments", "change_id", target.changeIds);
    await deleteByIdChunks(env.DB, "change_reviews", "change_id", target.changeIds);
    await deleteByIdChunks(env.DB, "webhook_deliveries", "webhook_id", target.webhookIds);
    for (const table of PROJECT_SCOPED_TABLES) {
      await deleteProjectScopedTable(env.DB, table, target, residuals);
    }

    // 2) Tables keyed by the globally-unique (namespace, slug) tuple.
    for (const table of NS_SLUG_TABLES) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE namespace = ? AND slug = ?`)
        .bind(target.namespace, target.slug)
        .run();
    }

    // 3) Artifacts — forks first, then the project repo. Permanent failures
    // become residuals (never silently done); the job re-drives them later.
    const repoNames = [...target.forkRepoNames];
    if (target.projectRepoName) repoNames.push(target.projectRepoName);
    for (const name of repoNames) {
      const deleted = await deleteArtifactsRepo(env, name, logger);
      if (!deleted) residuals.push(`artifacts:${name}`);
    }

    // 4) Durable Objects. RepoDO is keyed by project.id; MergeQueue is keyed
    // by change.project (see routes/changes.ts), which historically holds the
    // bare name OR the id depending on the creating path — purge every form.
    if (!(await purgeDurableObject(env.REPO_DO, target.projectId, "RepoDO", logger))) {
      residuals.push(`do:RepoDO:${target.projectId}`);
    }
    // Under a name collision the name/slug-addressed MergeQueue DO is shared with
    // the other tenant, so purge only the project_id form; leave (and report) the
    // name/slug forms rather than wipe another tenant's merge-queue state.
    const mergeQueueKeys = new Set<string>([target.projectId]);
    if (!target.nameCollision) {
      mergeQueueKeys.add(target.name);
      mergeQueueKeys.add(target.slug);
    } else {
      residuals.push("do:MergeQueue:name-forms-skipped(name-collision)");
    }
    for (const key of mergeQueueKeys) {
      if (!(await purgeDurableObject(env.MERGE_QUEUE, key, "MergeQueue", logger))) {
        residuals.push(`do:MergeQueue:${key}`);
      }
    }

    // 5) KV last, project entry very last: as long as the entry exists, the
    // project is still resolvable and a re-drive can recapture everything.
    let workspaceKeys: string[] = [];
    try {
      workspaceKeys = await listKeysPaginated(env.STATE, workspacePrefix(target.projectId));
    } catch (error) {
      // Fall back to the captured names; the verifier re-lists for stragglers.
      logger.error(
        "Failed to list workspace keys during cascade",
        error instanceof Error ? error : undefined,
        { projectId: target.projectId },
      );
      residuals.push(`kv:${workspacePrefix(target.projectId)}list-failed`);
    }
    const keySet = new Set(workspaceKeys);
    for (const name of target.workspaceNames) {
      keySet.add(`${workspacePrefix(target.projectId)}${name}`);
    }
    for (const key of keySet) {
      await deleteKvKey(env, key, residuals, logger);
    }
    await deleteKvKey(env, snapshotKey(target.namespace, target.slug), residuals, logger);
    await deleteKvKey(env, syncStatusKey(target.namespace, target.slug), residuals, logger);
    await deleteKvKey(env, policyKey(target.projectId), residuals, logger);
    await deleteKvKey(env, projectKey(target.namespace, target.slug), residuals, logger);
    await deleteKvKey(env, legacyProjectKey(target.name), residuals, logger);

    return ok({ residuals });
  } catch (error) {
    // Contract: this function never throws. A hard failure (e.g. D1 down)
    // surfaces as a Result error; the job stays re-driveable.
    const appError = toAppError(error);
    logger.error("Project deletion cascade failed", appError, { projectId: target.projectId });
    return err(appError);
  }
}

async function countRows(db: D1Database, sql: string, bindings: unknown[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...bindings)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countByIdChunks(
  db: D1Database,
  table: string,
  column: string,
  ids: readonly string[],
): Promise<number> {
  let total = 0;
  for (const batch of chunk(ids, IN_LIST_CHUNK_SIZE)) {
    const placeholders = batch.map(() => "?").join(", ");
    total += await countRows(
      db,
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${placeholders})`,
      [...batch],
    );
  }
  return total;
}

/**
 * Reconciliation pass: re-query every store for anything the cascade should
 * have removed. "No orphans" is a checked invariant, not an assertion — only
 * an empty residual set lets a job finish `completed`.
 *
 * Artifacts is intentionally NOT verified here: the binding offers no cheap
 * existence check (get() mints repo handles, list() is unbounded), so we trust
 * the cascade's step-3 residuals, which already report every repo that failed
 * to delete.
 */
export async function verifyProjectDeleted(
  env: Env,
  target: DeletionTarget,
  logger: Logger,
): Promise<Result<{ residuals: string[] }, AppError>> {
  const residuals: string[] = [];
  try {
    const childCounts: [string, string, readonly string[]][] = [
      ["eval_runs", "change_id", target.changeIds],
      ["change_comments", "change_id", target.changeIds],
      ["change_reviews", "change_id", target.changeIds],
      ["webhook_deliveries", "webhook_id", target.webhookIds],
    ];
    for (const [table, column, ids] of childCounts) {
      const n = await countByIdChunks(env.DB, table, column, ids);
      if (n > 0) residuals.push(`d1:${table}:${n}-rows`);
    }

    for (const table of PROJECT_SCOPED_TABLES) {
      const n = target.nameCollision
        ? await countRows(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, [
            target.projectId,
          ])
        : await countRows(
            env.DB,
            `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? OR (project_id IS NULL AND project = ?)`,
            [target.projectId, target.name],
          );
      if (n > 0) residuals.push(`d1:${table}:${n}-rows`);
    }

    for (const table of NS_SLUG_TABLES) {
      const n = await countRows(
        env.DB,
        `SELECT COUNT(*) AS n FROM ${table} WHERE namespace = ? AND slug = ?`,
        [target.namespace, target.slug],
      );
      if (n > 0) residuals.push(`d1:${table}:${n}-rows`);
    }

    const workspaceKeys = await listKeysPaginated(env.STATE, workspacePrefix(target.projectId));
    for (const key of workspaceKeys) residuals.push(`kv:${key}`);

    const singletonKeys = [
      snapshotKey(target.namespace, target.slug),
      syncStatusKey(target.namespace, target.slug),
      policyKey(target.projectId),
      projectKey(target.namespace, target.slug),
      legacyProjectKey(target.name),
    ];
    for (const key of singletonKeys) {
      const value = await env.STATE.get(key);
      if (value !== null) residuals.push(`kv:${key}`);
    }

    return ok({ residuals });
  } catch (error) {
    const appError = toAppError(error);
    logger.error("Project deletion verification failed", appError, {
      projectId: target.projectId,
    });
    return err(appError);
  }
}

/**
 * Every cross-project identity column that names a user. Anonymizing these to
 * the shared sentinel erases the person while preserving the contribution
 * (GDPR: right-to-erasure without destroying other tenants' history). Runs
 * AFTER the user's owned projects are deleted, so only cross-project rows
 * remain to rewrite.
 */
const IDENTITY_COLUMNS: readonly [table: string, column: string][] = [
  ["audit_log", "actor_id"],
  ["provenance", "agent_id"],
  ["issues", "author_id"],
  ["change_comments", "author_id"],
  ["change_reviews", "reviewer_id"],
  ["webhooks", "created_by"],
  ["changes", "agent_id"],
];

/**
 * Rewrite every identity column that names `userId` to the shared sentinel.
 * Idempotent: re-running matches nothing (the id is already gone). Never
 * deletes — the contribution stays, only the author is anonymized.
 */
export async function anonymizeUserContributions(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    for (const [table, column] of IDENTITY_COLUMNS) {
      await db
        .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`)
        .bind(DELETED_USER_SENTINEL, userId)
        .run();
    }
    logger.info("Anonymized user contributions", { userId });
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error);
    logger.error("Failed to anonymize user contributions", appError, { userId });
    return err(appError);
  }
}

interface OrgOwnerRow {
  id: string;
  owner_id: string;
}

interface OrgMemberIdRow {
  user_id: string;
}

/**
 * Resolve an org where `userId` is the sole owner (owner_id = userId): promote
 * a successor if the org has other members, else delete the empty org. Never
 * blocks erasure. Deterministic + idempotent: promotion picks the lowest
 * user_id among candidates so a re-drive reaches the same successor.
 */
async function resolveOrgOwnership(
  env: Env,
  org: OrgOwnerRow,
  userId: string,
  residuals: string[],
  logger: Logger,
): Promise<void> {
  const db = env.DB;

  // Prefer another admin; fall back to any other member. Lowest user_id wins so
  // concurrent drivers converge on the same successor. Exclude users who are
  // themselves being erased — promoting to a soon-to-be-deleted user would leave
  // the org with a dangling owner and no membership row to re-promote from.
  const nextAdmin = await db
    .prepare(
      "SELECT user_id FROM org_members WHERE org_id = ? AND role = 'admin' AND user_id != ? " +
        "AND user_id IN (SELECT id FROM users WHERE deleting_at IS NULL) " +
        "ORDER BY user_id ASC LIMIT 1",
    )
    .bind(org.id, userId)
    .first<OrgMemberIdRow>();

  let successor = nextAdmin?.user_id ?? null;
  if (!successor) {
    const nextMember = await db
      .prepare(
        "SELECT user_id FROM org_members WHERE org_id = ? AND user_id != ? " +
          "AND user_id IN (SELECT id FROM users WHERE deleting_at IS NULL) " +
          "ORDER BY user_id ASC LIMIT 1",
      )
      .bind(org.id, userId)
      .first<OrgMemberIdRow>();
    successor = nextMember?.user_id ?? null;
  }

  if (successor) {
    await db.prepare("UPDATE orgs SET owner_id = ? WHERE id = ?").bind(successor, org.id).run();
    logger.info("Promoted org successor during account erasure", { orgId: org.id, successor });
    return;
  }

  // No other members: the org is empty. Cascade its owned projects, then delete
  // the org and any residual membership/team rows so no orphan survives.
  logger.info("Deleting empty org during account erasure", { orgId: org.id });
  const projectsResult = await listProjects(env.STATE, logger);
  if (projectsResult.success) {
    for (const project of projectsResult.data) {
      if (project.ownerType !== "org" || project.ownerId !== org.id) continue;
      await cascadeOwnedProject(env, project, `org:${org.id}:`, residuals, logger);
    }
  } else {
    residuals.push(`org:${org.id}:project-list-failed`);
  }
  await db.prepare("DELETE FROM org_members WHERE org_id = ?").bind(org.id).run();
  await db
    .prepare("DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE org_id = ?)")
    .bind(org.id)
    .run();
  await db.prepare("DELETE FROM teams WHERE org_id = ?").bind(org.id).run();
  await db.prepare("DELETE FROM orgs WHERE id = ?").bind(org.id).run();
}

/** Capture + cascade + verify one owned project, prefixing any residuals. */
async function cascadeOwnedProject(
  env: Env,
  project: ProjectEntry,
  prefix: string,
  residuals: string[],
  logger: Logger,
): Promise<void> {
  const captured = await captureDeletionTarget(env, project, logger);
  if (!captured.success) {
    residuals.push(`${prefix}${project.slug}:capture-failed`);
    return;
  }
  const cascade = await deleteProjectCascade(env, captured.data, logger);
  if (cascade.success) {
    for (const r of cascade.data.residuals) residuals.push(`${prefix}${project.slug}:${r}`);
  } else {
    residuals.push(`${prefix}${project.slug}:cascade:${cascade.error.code}`);
  }
  const verified = await verifyProjectDeleted(env, captured.data, logger);
  if (verified.success) {
    for (const r of verified.data.residuals) residuals.push(`${prefix}${project.slug}:${r}`);
  } else {
    residuals.push(`${prefix}${project.slug}:verify:${verified.error.code}`);
  }
}

/**
 * GDPR-grade account erasure. Order is load-bearing:
 *   1. delete owned projects (so only cross-project rows remain to anonymize),
 *   2. anonymize the remainder,
 *   3. drop agents / sessions / memberships,
 *   4. resolve sole-owner orgs (promote or delete — never blocks),
 *   5. delete the users row LAST (frees email/username/token_hash/github_id
 *      uniques only once everything else is gone).
 * Every step is idempotent so a re-drive converges. Returns the residual set;
 * an empty set lets the job finish `completed`.
 */
export async function deleteAccountCascade(
  env: Env,
  userId: string,
  logger: Logger,
): Promise<Result<{ residuals: string[] }, AppError>> {
  const residuals: string[] = [];
  const db = env.DB;
  try {
    // 1) Owned (user) projects first.
    const projectsResult = await listProjects(env.STATE, logger);
    if (!projectsResult.success) {
      residuals.push("account:project-list-failed");
    } else {
      for (const project of projectsResult.data) {
        if (project.ownerType !== "user" || project.ownerId !== userId) continue;
        await cascadeOwnedProject(env, project, "project:", residuals, logger);
      }
    }

    // 2) Anonymize the cross-project remainder.
    const anonymized = await anonymizeUserContributions(db, userId, logger);
    if (!anonymized.success) residuals.push(`account:anonymize:${anonymized.error.code}`);

    // 3) Agents, sessions, memberships.
    await db.prepare("DELETE FROM agents WHERE owner_id = ?").bind(userId).run();
    const sessions = await deleteAllUserSessions(db, userId, logger);
    if (!sessions.success) residuals.push(`account:sessions:${sessions.error.code}`);
    await db.prepare("DELETE FROM org_members WHERE user_id = ?").bind(userId).run();
    await db.prepare("DELETE FROM team_members WHERE user_id = ?").bind(userId).run();

    // 4) Sole-owner org fallback (after membership rows are gone so an empty org
    //    is correctly detected). Never blocks erasure.
    const ownedOrgs = await db
      .prepare("SELECT id, owner_id FROM orgs WHERE owner_id = ?")
      .bind(userId)
      .all<OrgOwnerRow>();
    for (const org of ownedOrgs.results) {
      await resolveOrgOwnership(env, org, userId, residuals, logger);
    }

    // 5) The user row LAST — and ONLY when erasure is fully complete. Deleting
    //    it while residuals remain would strand PII (project rows/repos) with the
    //    account gone and no user to re-drive against. Leaving it keeps the row
    //    (access already revoked via deleting_at) so a re-enqueued job finishes
    //    the job and then removes it. The `users` delete is itself idempotent.
    if (residuals.length === 0) {
      await db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    } else {
      residuals.push("account:user-row-retained-pending-residuals");
      logger.warn("Account erasure incomplete; retaining user row for re-drive", {
        userId,
        residualCount: residuals.length,
      });
    }

    return ok({ residuals });
  } catch (error) {
    const appError = toAppError(error);
    logger.error("Account deletion cascade failed", appError, { userId });
    return err(appError);
  }
}
