import { RUN_MANIFEST_KEY, pruneRuns, putBlob } from "../storage/backup-store";
import { BACKUP_TABLES, exportTable } from "../storage/d1-backup";
import { exportKvIdentity } from "../storage/kv-backup";
import { listProjects } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import type { Logger } from "../utils/logger";
import { type SnapshotResult, snapshotRepo } from "./repo-snapshot";

const DEFAULT_RETENTION = 14;
const DEFAULT_MAX_REPOS_PER_RUN = 25;

/** KV key holding the timestamp of an in-flight run; single-flights all triggers
 * (cron and manual alike) so two runs never write into overlapping prefixes. */
const LOCK_KEY = "backup:lock";
// Kept at/under Cloudflare's 15-minute cron wall-clock cap: a run that is
// force-terminated before its `finally` releases the lock must not leave it stuck
// for longer than a run could possibly have been alive.
const LOCK_TTL_SECONDS = 900;

/** Parse a positive-integer env var, falling back on missing/garbage input.
 * Critical: a NaN retention would make `slice(NaN)` delete every run. */
function positiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export interface BackupRunSummary {
  runTs: string;
  skipped?: "no-backups-bucket" | "locked";
  d1: { table: string; rowCount: number; ok: boolean }[];
  /** `ok` is false if any KV blob failed to write or a project's workspaces were
   * dropped — so a reader never mistakes a partial dump for a whole one. */
  kv: { projects: number; workspaces: number; ok: boolean };
  repos: {
    total: number;
    backedUp: number;
    skipped: { projectId: string; reason: string }[];
    failed: { projectId: string }[];
    deferred: number;
  };
  bytes: number;
  prunedRuns: number;
}

/** Injectable so the orchestration is testable without a real Artifacts clone. */
export interface BackupDeps {
  snapshotRepo: (
    env: Env,
    project: ProjectEntry,
    capturedAt: string,
    logger: Logger,
  ) => ReturnType<typeof snapshotRepo>;
}

const defaultDeps: BackupDeps = { snapshotRepo };

async function readCursors(db: D1Database, logger: Logger): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // Fail-soft: a flaky cursor read must not abort a run whose D1/KV dumps already
  // landed. An empty map just means this run orders repos as if none were backed
  // up yet — coverage is still correct, only the rotation is momentarily reset.
  try {
    const rows = await db.prepare("SELECT project_id, last_backed_up_at FROM backup_state").all<{
      project_id: string;
      last_backed_up_at: string | null;
    }>();
    for (const r of rows.results ?? []) map.set(r.project_id, r.last_backed_up_at ?? "");
  } catch (error) {
    logger.warn("Backup: failed to read repo cursors; using default order", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return map;
}

async function touchCursor(db: D1Database, projectId: string, ts: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO backup_state (project_id, last_backed_up_at) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET last_backed_up_at = excluded.last_backed_up_at",
    )
    .bind(projectId, ts)
    .run();
}

/**
 * Run a full backup: D1 tables + KV identity + a rotating slice of repos, all to
 * R2 under one timestamped run. Fail-soft (one repo/table failing never aborts the
 * run); the run's `_manifest.json` is written LAST so a reader can distinguish a
 * complete run from a crashed one. Returns a summary of what happened.
 */
export async function runBackup(
  env: Env,
  logger: Logger,
  now: string,
  deps: BackupDeps = defaultDeps,
): Promise<BackupRunSummary> {
  const runTs = now;
  const bucket = env.BACKUPS;
  const summary: BackupRunSummary = {
    runTs,
    d1: [],
    kv: { projects: 0, workspaces: 0, ok: true },
    repos: { total: 0, backedUp: 0, skipped: [], failed: [], deferred: 0 },
    bytes: 0,
    prunedRuns: 0,
  };

  if (!bucket) {
    logger.warn("BACKUPS bucket not configured; skipping backup run");
    return { ...summary, skipped: "no-backups-bucket" };
  }

  // Single-flight: refuse to start if another run holds the lock. Best-effort
  // (KV has no compare-and-set), but it covers both cron and the manual endpoint.
  // A KV hiccup must NOT abort the backup — log and proceed lock-less rather than
  // lose a run over a transient coordination read.
  let lockHeld = false;
  if (env.STATE) {
    try {
      const held = await env.STATE.get(LOCK_KEY);
      if (held) {
        logger.warn("Backup already in progress; skipping", { heldBy: held });
        return { ...summary, skipped: "locked" };
      }
      await env.STATE.put(LOCK_KEY, runTs, { expirationTtl: LOCK_TTL_SECONDS });
      lockHeld = true;
    } catch (error) {
      logger.warn("Backup lock unavailable; proceeding without single-flight", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    return await runBackupLocked(env, logger, runTs, deps, summary, bucket);
  } finally {
    // Release only if we actually took the lock and it is still ours (the TTL may
    // have reclaimed it). Never let a release failure mask the run's outcome.
    if (env.STATE && lockHeld) {
      try {
        if ((await env.STATE.get(LOCK_KEY)) === runTs) await env.STATE.delete(LOCK_KEY);
      } catch (error) {
        logger.warn("Failed to release backup lock; it will expire via TTL", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

async function runBackupLocked(
  env: Env,
  logger: Logger,
  runTs: string,
  deps: BackupDeps,
  summary: BackupRunSummary,
  bucket: R2Bucket,
): Promise<BackupRunSummary> {
  const put = async (key: string, bytes: Uint8Array) => {
    const res = await putBlob(bucket, `${runTs}/${key}`, bytes, env, logger);
    if (res.success) summary.bytes += bytes.byteLength;
    return res.success;
  };

  // --- D1 tables ---
  for (const table of BACKUP_TABLES) {
    const dump = await exportTable(env.DB, table, logger);
    if (!dump.success) {
      summary.d1.push({ table, rowCount: 0, ok: false });
      logger.error("Backup: table export failed", dump.error, { table });
      continue;
    }
    const ok = await put(`d1/${table}.ndjson`, dump.data.ndjson);
    summary.d1.push({ table, rowCount: dump.data.rowCount, ok });
  }

  // --- KV identity ---
  if (env.STATE) {
    const kv = await exportKvIdentity(env.STATE, logger);
    if (kv.success) {
      const okProjects = await put("kv/projects.json", kv.data.projects);
      const okWorkspaces = await put("kv/workspaces.json", kv.data.workspaces);
      summary.kv = {
        projects: kv.data.projectCount,
        workspaces: kv.data.workspaceCount,
        ok: okProjects && okWorkspaces && !kv.data.partial,
      };
    } else {
      logger.error("Backup: KV identity export failed", kv.error);
      summary.kv.ok = false;
    }
  }

  // --- Repos, oldest-backed-up first (rotates coverage under the per-run cap) ---
  const maxRepos = positiveIntEnv(env.MAX_REPOS_PER_RUN, DEFAULT_MAX_REPOS_PER_RUN);
  if (env.STATE) {
    const projectsResult = await listProjects(env.STATE, logger);
    if (projectsResult.success) {
      const cursors = await readCursors(env.DB, logger);
      const ordered = [...projectsResult.data].sort((a, b) =>
        (cursors.get(a.id) ?? "").localeCompare(cursors.get(b.id) ?? ""),
      );
      summary.repos.total = ordered.length;
      const slice = ordered.slice(0, maxRepos);
      summary.repos.deferred = ordered.length - slice.length;

      for (const project of slice) {
        try {
          const snap = await deps.snapshotRepo(env, project, runTs, logger);
          if (!snap.success) {
            summary.repos.failed.push({ projectId: project.id });
            logger.error("Backup: repo snapshot failed", snap.error, { projectId: project.id });
          } else {
            const result: SnapshotResult = snap.data;
            if (result.status === "skipped") {
              summary.repos.skipped.push({ projectId: project.id, reason: result.reason });
            } else {
              const okPack = await put(`repos/${project.id}.pack`, result.snapshot.pack);
              const okManifest = await put(
                `repos/${project.id}.manifest.json`,
                new TextEncoder().encode(JSON.stringify(result.snapshot.manifest)),
              );
              if (okPack && okManifest) summary.repos.backedUp++;
              else summary.repos.failed.push({ projectId: project.id });
            }
          }
        } catch (error) {
          summary.repos.failed.push({ projectId: project.id });
          logger.error(
            "Backup: unexpected repo error",
            error instanceof Error ? error : undefined,
            { projectId: project.id },
          );
        }
        // Advance the cursor for EVERY attempted repo — success, skip, or failure —
        // so a permanently-failing repo rotates to the back instead of holding a
        // slot every run and starving healthy repos of coverage.
        try {
          await touchCursor(env.DB, project.id, runTs);
        } catch (error) {
          logger.warn("Backup: failed to advance repo cursor", {
            projectId: project.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      logger.error("Backup: could not list projects", projectsResult.error);
    }
  }

  // --- Retention (keep newest N complete-or-not runs whole) ---
  const retention = positiveIntEnv(env.BACKUP_RETENTION, DEFAULT_RETENTION);
  const pruned = await pruneRuns(bucket, retention, logger);
  if (pruned.success) summary.prunedRuns = pruned.data.prunedRuns;

  // --- Run manifest LAST: its presence marks the run complete ---
  await put(RUN_MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(summary)));

  logger.info("Backup run complete", {
    runTs,
    repos: summary.repos.backedUp,
    deferred: summary.repos.deferred,
    bytes: summary.bytes,
  });
  return summary;
}
