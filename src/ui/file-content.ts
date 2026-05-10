import { readFileFromRepo } from "../storage/git-ops";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";

export type FileContentResult =
  | { kind: "content"; value: string }
  | { kind: "binary" }
  | { kind: "oversize" }
  | { kind: "not-found" };

const MAX_FILE_BYTES = 512 * 1024;

export function isValidFilePath(path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\0")) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === ".." || segment === ".") return false;
  }
  return true;
}

export async function getFileContent(
  remote: string,
  token: string,
  path: string,
  logger: Logger,
): Promise<Result<FileContentResult, AppError>> {
  const readResult = await readFileFromRepo(remote, token, path, logger, {
    maxBytes: MAX_FILE_BYTES,
  });

  if (!readResult.success) {
    if (readResult.error.code === "FILE_TOO_LARGE") {
      return ok({ kind: "oversize" });
    }
    if (readResult.error.code === "FS_ERROR") {
      return ok({ kind: "not-found" });
    }
    return err(readResult.error);
  }

  const content = readResult.data;

  if (content.includes("\0")) {
    return ok({ kind: "binary" });
  }

  // Defensive fallback: check byte size in case lower-layer check is bypassed
  if (new TextEncoder().encode(content).length > MAX_FILE_BYTES) {
    return ok({ kind: "oversize" });
  }

  return ok({ kind: "content", value: content });
}
