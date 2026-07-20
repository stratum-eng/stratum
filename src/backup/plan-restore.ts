import { RUN_MANIFEST_KEY, getBlob, listRunObjects } from "../storage/backup-store";
import { BACKUP_TABLES, verifyTableDump } from "../storage/d1-backup";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import type { BackupRunSummary } from "./run-backup";

export interface D1LegPlan {
  table: string;
  /** Row count the manifest recorded at backup time, or -1 if unknown. */
  expectedRows: number;
  parsedRows: number;
  ok: boolean;
  error?: string;
}

export interface KvLegPlan {
  projects: number;
  workspaces: number;
  ok: boolean;
  error?: string;
}

export interface RepoLegPlan {
  projectId: string;
  tipSha?: string;
  hasPack: boolean;
  ok: boolean;
  error?: string;
}

/**
 * The result of a DRY-RUN restore check: does every blob a backup run produced
 * decode, parse, and agree with the run manifest? Nothing is written — this is
 * the CI-provable "is this backup actually restorable?" gate. `restorable` is
 * true only when the run is complete and every leg checks out.
 */
export interface RestorePlan {
  runTs: string;
  complete: boolean;
  d1: D1LegPlan[];
  kv: KvLegPlan;
  repos: RepoLegPlan[];
  restorable: boolean;
  errors: string[];
}

const REPO_MANIFEST_SUFFIX = ".manifest.json";

async function decodeJson<T>(
  bucket: R2Bucket,
  key: string,
  env: Pick<Env, "BACKUP_ENCRYPTION_SECRET">,
  logger: Logger,
): Promise<Result<T | null, AppError>> {
  const blob = await getBlob(bucket, key, env, logger);
  if (!blob.success) return err(blob.error);
  if (blob.data === null) return ok(null);
  try {
    return ok(JSON.parse(new TextDecoder().decode(blob.data)) as T);
  } catch {
    return err(new AppError(`Backup blob ${key} did not parse as JSON`, "BACKUP_ERROR", 500));
  }
}

async function planD1(
  bucket: R2Bucket,
  runTs: string,
  env: Env,
  manifest: BackupRunSummary | null,
  logger: Logger,
): Promise<D1LegPlan[]> {
  // Prefer the manifest's table list + row counts (lets us catch truncation); fall
  // back to the static schema list when the manifest is missing.
  const expected =
    manifest?.d1 ?? BACKUP_TABLES.map((table) => ({ table, rowCount: -1, ok: true }));
  const legs: D1LegPlan[] = [];
  for (const entry of expected) {
    const key = `${runTs}/d1/${entry.table}.ndjson`;
    const blob = await getBlob(bucket, key, env, logger);
    if (!blob.success) {
      legs.push({
        table: entry.table,
        expectedRows: entry.rowCount,
        parsedRows: 0,
        ok: false,
        error: blob.error.message,
      });
      continue;
    }
    if (blob.data === null) {
      legs.push({
        table: entry.table,
        expectedRows: entry.rowCount,
        parsedRows: 0,
        ok: false,
        error: "dump blob is missing",
      });
      continue;
    }
    const verified = verifyTableDump(entry.table, blob.data);
    if (!verified.success) {
      legs.push({
        table: entry.table,
        expectedRows: entry.rowCount,
        parsedRows: 0,
        ok: false,
        error: verified.error.message,
      });
      continue;
    }
    const parsedRows = verified.data.rowCount;
    const countMatches = entry.rowCount < 0 || parsedRows === entry.rowCount;
    legs.push({
      table: entry.table,
      expectedRows: entry.rowCount,
      parsedRows,
      ok: countMatches,
      ...(countMatches
        ? {}
        : { error: `row count mismatch: manifest ${entry.rowCount}, dump ${parsedRows}` }),
    });
  }
  return legs;
}

async function planKv(
  bucket: R2Bucket,
  runTs: string,
  env: Env,
  manifest: BackupRunSummary | null,
  logger: Logger,
): Promise<KvLegPlan> {
  const projects = await decodeJson<unknown[]>(bucket, `${runTs}/kv/projects.json`, env, logger);
  const workspaces = await decodeJson<unknown[]>(
    bucket,
    `${runTs}/kv/workspaces.json`,
    env,
    logger,
  );
  if (!projects.success)
    return { projects: 0, workspaces: 0, ok: false, error: projects.error.message };
  if (!workspaces.success)
    return { projects: 0, workspaces: 0, ok: false, error: workspaces.error.message };
  if (projects.data === null || workspaces.data === null) {
    return { projects: 0, workspaces: 0, ok: false, error: "kv identity dump is missing" };
  }
  if (!Array.isArray(projects.data) || !Array.isArray(workspaces.data)) {
    return { projects: 0, workspaces: 0, ok: false, error: "kv identity dump is not an array" };
  }
  const projectCount = projects.data.length;
  const workspaceCount = workspaces.data.length;
  // The manifest records what was dumped; a mismatch means the blob was truncated.
  const expected = manifest?.kv;
  const matches =
    !expected || (expected.projects === projectCount && expected.workspaces === workspaceCount);
  return {
    projects: projectCount,
    workspaces: workspaceCount,
    ok: matches,
    ...(matches
      ? {}
      : {
          error: `kv count mismatch: manifest ${expected?.projects}/${expected?.workspaces}, dump ${projectCount}/${workspaceCount}`,
        }),
  };
}

async function planRepos(
  bucket: R2Bucket,
  runTs: string,
  env: Env,
  logger: Logger,
): Promise<RepoLegPlan[]> {
  const keys = await listRunObjects(bucket, runTs);
  const prefix = `${runTs}/repos/`;
  const manifestKeys = keys.filter((k) => k.startsWith(prefix) && k.endsWith(REPO_MANIFEST_SUFFIX));
  const legs: RepoLegPlan[] = [];
  for (const manifestKey of manifestKeys) {
    const projectId = manifestKey.slice(prefix.length, -REPO_MANIFEST_SUFFIX.length);
    const manifest = await decodeJson<{ tipSha?: string }>(bucket, manifestKey, env, logger);
    if (!manifest.success) {
      legs.push({ projectId, hasPack: false, ok: false, error: manifest.error.message });
      continue;
    }
    if (manifest.data === null || typeof manifest.data.tipSha !== "string") {
      legs.push({ projectId, hasPack: false, ok: false, error: "repo manifest missing tipSha" });
      continue;
    }
    // Fetch (and thus decrypt) the pack to prove it is present and decodable.
    const pack = await getBlob(bucket, `${prefix}${projectId}.pack`, env, logger);
    if (!pack.success) {
      legs.push({
        projectId,
        tipSha: manifest.data.tipSha,
        hasPack: false,
        ok: false,
        error: pack.error.message,
      });
      continue;
    }
    const hasPack = pack.data !== null && pack.data.byteLength > 0;
    legs.push({
      projectId,
      tipSha: manifest.data.tipSha,
      hasPack,
      ok: hasPack,
      ...(hasPack ? {} : { error: "pack blob missing or empty" }),
    });
  }
  return legs;
}

/**
 * Dry-run restore verification for a single backup run. Reads every blob under
 * `<runTs>/`, decrypting via `getBlob`, and checks each leg against the run
 * manifest. Never writes — safe to run against a production backup bucket. The
 * actual write/apply restore path (recreating tables, pushing repos) is a
 * separate, gated break-glass operation.
 */
export async function planRestore(
  env: Env,
  runTs: string,
  logger: Logger,
): Promise<Result<RestorePlan, AppError>> {
  const bucket = env.BACKUPS;
  if (!bucket) return err(new AppError("Backups bucket not configured", "STORAGE_ERROR", 500));

  const errors: string[] = [];

  const manifestResult = await decodeJson<BackupRunSummary>(
    bucket,
    `${runTs}/${RUN_MANIFEST_KEY}`,
    env,
    logger,
  );
  if (!manifestResult.success) return err(manifestResult.error);
  const manifest = manifestResult.data;
  if (manifest === null) {
    // _manifest.json is written last; its absence means the run crashed partway.
    errors.push("run is incomplete: _manifest.json is missing (crashed run)");
  }

  const d1 = await planD1(bucket, runTs, env, manifest, logger);
  const kv = await planKv(bucket, runTs, env, manifest, logger);
  const repos = await planRepos(bucket, runTs, env, logger);

  const d1Ok = d1.every((leg) => leg.ok);
  const reposOk = repos.every((leg) => leg.ok);
  const restorable = manifest !== null && errors.length === 0 && d1Ok && kv.ok && reposOk;

  logger.info("Computed restore plan", {
    runTs,
    restorable,
    d1Failed: d1.filter((l) => !l.ok).length,
    reposFailed: repos.filter((l) => !l.ok).length,
    kvOk: kv.ok,
  });

  return ok({ runTs, complete: manifest !== null, d1, kv, repos, restorable, errors });
}
