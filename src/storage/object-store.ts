import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";

/**
 * Content-addressed git object plane on R2 (ADR 004 Phase 2). Objects are keyed
 * by their oid under `objects/<oid>`, so writes are idempotent and need zero
 * coordination — any number of writers can store objects in parallel and never
 * collide. This is the "infinite fan-out" plane the ref CAS is decoupled from.
 */
export async function putObject(
  bucket: R2Bucket,
  oid: string,
  bytes: Uint8Array,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const res = await fromPromise(bucket.put(`objects/${oid}`, bytes));
  if (!res.success) {
    logger.error(
      "Failed to write object to R2",
      res.error instanceof Error ? res.error : undefined,
      { oid },
    );
    return err(new AppError("Failed to write object to object store", "STORAGE_ERROR", 500));
  }
  return ok(undefined);
}

/** Read a content-addressed object from R2. Returns null if absent. */
export async function getObject(
  bucket: R2Bucket,
  oid: string,
  logger: Logger,
): Promise<Result<Uint8Array | null, AppError>> {
  const res = await fromPromise(bucket.get(`objects/${oid}`));
  if (!res.success) {
    logger.error(
      "Failed to read object from R2",
      res.error instanceof Error ? res.error : undefined,
      {
        oid,
      },
    );
    return err(new AppError("Failed to read object from object store", "STORAGE_ERROR", 500));
  }
  if (!res.data) return ok(null);
  const buf = await res.data.arrayBuffer();
  return ok(new Uint8Array(buf));
}
