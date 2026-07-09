import type { Env, ProjectEntry, WorkspaceEntry } from "../types";
import { type AppError, toAppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { artifactsRepoNameFromRemote } from "./git-ops";

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
