import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";

/**
 * R2 layout: one timestamped run per backup, all its blobs under that prefix.
 *   <runTs>/_manifest.json          (written LAST — its presence marks a complete run)
 *   <runTs>/d1/<table>.ndjson
 *   <runTs>/kv/projects.json, kv/workspaces.json
 *   <runTs>/repos/<projectId>.pack, repos/<projectId>.manifest.json
 */
export const RUN_MANIFEST_KEY = "_manifest.json";

// First byte of a stored blob flags whether the remainder is AES-GCM ciphertext.
const ENC_MAGIC = 0x01;
const PLAIN_MAGIC = 0x00;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT = "stratum-backup-blob-salt";

async function deriveKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(PBKDF2_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt bytes as `[MAGIC][iv][ciphertext]`, or `[PLAIN_MAGIC][bytes]` when no secret is set. */
async function encodeBlob(bytes: Uint8Array, secret: string | undefined): Promise<Uint8Array> {
  if (!secret) {
    const out = new Uint8Array(bytes.length + 1);
    out[0] = PLAIN_MAGIC;
    out.set(bytes, 1);
    return out;
  }
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = ENC_MAGIC;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

async function decodeBlob(stored: Uint8Array, secret: string | undefined): Promise<Uint8Array> {
  const magic = stored[0];
  const body = stored.subarray(1);
  if (magic === PLAIN_MAGIC) return body;
  if (magic !== ENC_MAGIC) throw new AppError("Unknown backup blob format", "STORAGE_ERROR", 500);
  if (!secret) {
    throw new AppError(
      "Backup blob is encrypted but no BACKUP_ENCRYPTION_SECRET is set",
      "CONFIG_ERROR",
      500,
    );
  }
  const key = await deriveKey(secret);
  const iv = body.subarray(0, IV_BYTES);
  const ct = body.subarray(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(pt);
}

/** Write a backup blob to R2, envelope-encrypting it when a secret is configured. */
export async function putBlob(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  env: Pick<Env, "BACKUP_ENCRYPTION_SECRET">,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const encoded = await encodeBlob(bytes, env.BACKUP_ENCRYPTION_SECRET);
  const res = await fromPromise(bucket.put(key, encoded));
  if (!res.success) {
    logger.error(
      "Failed to write backup blob",
      res.error instanceof Error ? res.error : undefined,
      {
        key,
      },
    );
    return err(new AppError("Failed to write backup blob", "STORAGE_ERROR", 500));
  }
  return ok(undefined);
}

/** Read a backup blob from R2, decrypting when needed. Returns null if absent. */
export async function getBlob(
  bucket: R2Bucket,
  key: string,
  env: Pick<Env, "BACKUP_ENCRYPTION_SECRET">,
  logger: Logger,
): Promise<Result<Uint8Array | null, AppError>> {
  const res = await fromPromise(bucket.get(key));
  if (!res.success) {
    logger.error("Failed to read backup blob", res.error instanceof Error ? res.error : undefined, {
      key,
    });
    return err(new AppError("Failed to read backup blob", "STORAGE_ERROR", 500));
  }
  if (!res.data) return ok(null);
  try {
    const stored = new Uint8Array(await res.data.arrayBuffer());
    return ok(await decodeBlob(stored, env.BACKUP_ENCRYPTION_SECRET));
  } catch (error) {
    return err(
      error instanceof AppError
        ? error
        : new AppError("Failed to decode backup blob", "STORAGE_ERROR", 500),
    );
  }
}

/** List every object key under a prefix, following R2's paginated cursor. */
async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export interface RunInfo {
  runTs: string;
  complete: boolean;
}

/**
 * List backup runs newest-first. A run is "complete" iff its `_manifest.json`
 * (written last) exists — a crashed run is reported but flagged incomplete.
 */
export async function listRuns(
  bucket: R2Bucket,
  logger: Logger,
): Promise<Result<RunInfo[], AppError>> {
  try {
    // Top-level run prefixes are the delimited common prefixes at the root.
    const runTimestamps = new Set<string>();
    const manifests = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ delimiter: "/", cursor, limit: 1000 });
      for (const p of page.delimitedPrefixes) runTimestamps.add(p.replace(/\/$/, ""));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    for (const ts of runTimestamps) {
      const head = await bucket.head(`${ts}/${RUN_MANIFEST_KEY}`);
      if (head) manifests.add(ts);
    }

    const runs = [...runTimestamps]
      .sort()
      .reverse()
      .map((runTs) => ({ runTs, complete: manifests.has(runTs) }));
    return ok(runs);
  } catch (error) {
    logger.error("Failed to list backup runs", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to list backup runs", "STORAGE_ERROR", 500));
  }
}

/**
 * Retain the newest `keep` runs, deleting every object of older runs WHOLE (never
 * splitting a run). Incomplete runs count toward newest-by-timestamp so an
 * in-flight run's files are not pruned by a concurrent invocation.
 */
export async function pruneRuns(
  bucket: R2Bucket,
  keep: number,
  logger: Logger,
): Promise<Result<{ prunedRuns: number }, AppError>> {
  const runsResult = await listRuns(bucket, logger);
  if (!runsResult.success) return err(runsResult.error);
  // Defensive: a non-finite `keep` would make slice() coerce to 0 and delete
  // EVERY run. Fail safe by keeping everything instead of wiping the backups.
  const safeKeep = Number.isFinite(keep) && keep >= 0 ? keep : Number.POSITIVE_INFINITY;
  const stale = runsResult.data.slice(safeKeep); // already newest-first
  let prunedRuns = 0;
  for (const run of stale) {
    try {
      const keys = await listAllKeys(bucket, `${run.runTs}/`);
      // R2 delete accepts up to 1000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) {
        await bucket.delete(keys.slice(i, i + 1000));
      }
      prunedRuns++;
    } catch (error) {
      logger.warn("Failed to prune a backup run; continuing", {
        runTs: run.runTs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok({ prunedRuns });
}
