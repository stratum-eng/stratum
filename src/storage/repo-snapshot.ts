import type { KVNamespace } from "@cloudflare/workers-types";
import git from "isomorphic-git";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";
import { cloneRepo } from "./git-ops";

export const SNAPSHOT_COMMIT_LIMIT = 20;

const README_MAX_BYTES = 100 * 1024; // 100 KB

export type RepoSnapshot = {
  v: 1;
  files: string[];
  commits: Array<{ sha: string; message: string; author: string; timestamp: number }>;
  readme: string | null;
  readmeTruncated: boolean;
  snapshotAt: string; // UTC ISO-8601 with "Z" suffix
};

type MinimalFS = {
  promises: {
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    readFile(path: string, opts?: { encoding?: string } | string): Promise<string | Uint8Array>;
  };
};

function snapshotKey(namespace: string, slug: string): string {
  return `repo_snapshot:${encodeURIComponent(namespace)}:${encodeURIComponent(slug)}`;
}

export async function writeRepoSnapshot(
  kv: KVNamespace,
  project: { namespace: string; slug: string },
  data: Omit<RepoSnapshot, "snapshotAt" | "v">,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const snapshot: RepoSnapshot = {
    v: 1,
    ...data,
    snapshotAt: new Date().toISOString(),
  };

  try {
    await kv.put(snapshotKey(project.namespace, project.slug), JSON.stringify(snapshot), {
      expirationTtl: 604800, // 7 days
    });
    logger.debug("Wrote repo snapshot to KV", {
      namespace: project.namespace,
      slug: project.slug,
      fileCount: data.files.length,
      commitCount: data.commits.length,
    });
    return ok(undefined);
  } catch (error) {
    return err(
      new AppError(
        `Failed to write repo snapshot: ${error instanceof Error ? error.message : String(error)}`,
        "KV_ERROR",
        500,
      ),
    );
  }
}

export async function readRepoSnapshot(
  kv: KVNamespace,
  project: { namespace: string; slug: string },
  logger: Logger,
): Promise<Result<RepoSnapshot | null, AppError>> {
  const key = snapshotKey(project.namespace, project.slug);

  let raw: string | null;
  try {
    raw = await kv.get(key);
  } catch (error) {
    logger.warn("KV error reading repo snapshot", {
      namespace: project.namespace,
      slug: project.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return ok(null);
  }

  if (raw === null) {
    return ok(null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Corrupt repo snapshot (JSON parse failure), deleting", {
      namespace: project.namespace,
      slug: project.slug,
    });
    kv.delete(key).catch(() => {});
    return ok(null);
  }

  if (typeof parsed !== "object" || parsed === null || (parsed as { v?: unknown }).v !== 1) {
    logger.warn("Repo snapshot schema version mismatch, deleting", {
      namespace: project.namespace,
      slug: project.slug,
    });
    kv.delete(key).catch(() => {});
    return ok(null);
  }

  return ok(parsed as RepoSnapshot);
}

async function walkDir(fs: MinimalFS, base: string, prefix: string): Promise<string[]> {
  const entries = await fs.promises.readdir(base);
  const files: string[] = [];

  for (const entry of entries) {
    if (entry === ".git") continue;
    const fullPath = base === "/" ? `/${entry}` : `${base}/${entry}`;
    let stat: { isDirectory(): boolean; isFile(): boolean };
    try {
      stat = await fs.promises.stat(fullPath);
    } catch {
      continue; // skip unreadable entries (e.g. broken symlinks)
    }
    if (stat.isDirectory()) {
      const sub = await walkDir(fs, fullPath, `${prefix}${entry}/`);
      files.push(...sub);
    } else {
      files.push(`${prefix}${entry}`);
    }
  }

  return files;
}

export async function writeSnapshotFromRepo(
  kv: KVNamespace,
  project: { remote: string; token: string; namespace: string; slug: string },
  logger: Logger,
): Promise<void> {
  try {
    const cloneResult = await cloneRepo(project.remote, project.token, logger);

    if (!cloneResult.success) {
      logger.warn("writeSnapshotFromRepo: clone failed, skipping snapshot", {
        namespace: project.namespace,
        slug: project.slug,
        error: cloneResult.error.message,
      });
      return;
    }

    const { fs, dir } = cloneResult.data;
    const minimalFs: MinimalFS = fs as unknown as MinimalFS;

    // Files
    let files: string[] = [];
    try {
      files = await walkDir(minimalFs, dir, "");
    } catch (error) {
      logger.warn("writeSnapshotFromRepo: file walk failed", {
        namespace: project.namespace,
        slug: project.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Commits
    let commits: RepoSnapshot["commits"] = [];
    const logResult = await fromPromise(
      git.log({ fs: fs as Parameters<typeof git.log>[0]["fs"], dir, depth: SNAPSHOT_COMMIT_LIMIT }),
    );
    if (logResult.success) {
      commits = logResult.data.map((c) => ({
        sha: c.oid,
        message: c.commit.message.trim(),
        author: `${c.commit.author.name} <${c.commit.author.email}>`,
        timestamp: c.commit.author.timestamp,
      }));
    } else {
      logger.warn("writeSnapshotFromRepo: git log failed", {
        namespace: project.namespace,
        slug: project.slug,
      });
    }

    // README
    let readme: string | null = null;
    let readmeTruncated = false;
    const readmePath = files.find((f) => f.toLowerCase() === "readme.md");
    if (readmePath) {
      try {
        const raw = await minimalFs.promises.readFile(`/${readmePath}`, { encoding: "utf8" });
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        if (new TextEncoder().encode(text).byteLength > README_MAX_BYTES) {
          readme = text.slice(0, README_MAX_BYTES);
          readmeTruncated = true;
          logger.warn("writeSnapshotFromRepo: README truncated at 100 KB", {
            namespace: project.namespace,
            slug: project.slug,
          });
        } else {
          readme = text;
        }
      } catch {
        // README unreadable — leave null
      }
    }

    const writeResult = await writeRepoSnapshot(
      kv,
      project,
      { files, commits, readme, readmeTruncated },
      logger,
    );

    if (!writeResult.success) {
      logger.warn("writeSnapshotFromRepo: KV write failed", {
        namespace: project.namespace,
        slug: project.slug,
        error: writeResult.error.message,
      });
    } else {
      logger.info("Repo snapshot written", {
        namespace: project.namespace,
        slug: project.slug,
        fileCount: files.length,
        commitCount: commits.length,
        hasReadme: readme !== null,
      });
    }
  } catch (error) {
    logger.warn("writeSnapshotFromRepo: unexpected error, skipping snapshot", {
      namespace: project.namespace,
      slug: project.slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
