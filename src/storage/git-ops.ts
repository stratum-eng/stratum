import { createPatch } from "diff";
import git from "isomorphic-git";
import type { ArtifactsCreateResult, ArtifactsNamespace, Author, CommitLogEntry } from "../types";
import { AppError, ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, fromPromise, ok } from "../utils/result";
import { MemoryFS } from "./memory-fs";

// Custom HTTP client for Cloudflare Workers
// isomorphic-git/http/web expects browser APIs that don't exist in Workers
const http = {
  async request({
    url,
    method = "GET",
    headers = {},
    body: requestBody,
  }: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: AsyncIterableIterator<Uint8Array>;
  }) {
    // Stream request body directly instead of buffering to avoid OOM on large payloads
    let body: ReadableStream<Uint8Array> | undefined;
    if (requestBody) {
      body = new ReadableStream({
        async pull(controller) {
          const { value, done } = await requestBody.next();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },
      });
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
    });

    const resHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    // Stream response body instead of materializing to avoid high memory usage
    async function* bodyGenerator(): AsyncIterableIterator<Uint8Array> {
      if (!response.body) return;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }

    return {
      url: response.url,
      method,
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: resHeaders,
      body: bodyGenerator(),
    };
  },
};

const DIR = "/";

// Node.js-compatible FS interface (returned by MemoryFS.toNodeFS())
interface NodeFS {
  promises: {
    readFile(path: string, options?: { encoding?: string }): Promise<string | Uint8Array>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  };
}

const SYSTEM_AUTHOR: Author = { name: "Stratum", email: "system@usestratum.dev" };

export type MergeStrategy = "merge" | "squash";

export interface MergeWorkspaceOptions {
  author?: Author;
  strategy?: MergeStrategy;
}

export class MergeConflictError extends AppError {
  constructor(message: string) {
    super(message, "MERGE_CONFLICT", 409);
    this.name = "MergeConflictError";
  }
}

/**
 * Artifacts tokens are formatted as `<secret>?expires=<timestamp>`.
 * Only the secret portion is used for HTTP Basic auth.
 */
export function extractTokenSecret(token: string): string {
  return token.split("?expires=")[0] ?? token;
}

function makeAuth(token: string) {
  const secret = extractTokenSecret(token);
  return () => ({ username: "x", password: secret });
}

export async function initAndPush(
  remote: string,
  token: string,
  files: Record<string, string>,
  message: string,
  logger: Logger,
  author: Author = SYSTEM_AUTHOR,
): Promise<Result<string, AppError>> {
  logger.debug("Initializing git repository", { remote, fileCount: Object.keys(files).length });

  const rawFs = new MemoryFS();
  const fs = rawFs.toNodeFS();

  const initResult = await fromPromise(git.init({ fs, dir: DIR, defaultBranch: "main" }));
  if (!initResult.success) {
    logger.error("Failed to initialize git repository", initResult.error, { remote });
    return err(
      new ExternalServiceError("Git", "Failed to initialize repository", initResult.error),
    );
  }

  for (const [path, content] of Object.entries(files)) {
    // Use raw fs for writeFile since we need Result handling
    const writeResult = await rawFs.promises.writeFile(`/${path}`, content);
    if (!writeResult.success) {
      logger.error("Failed to write file to memory FS", writeResult.error, { path, remote });
      return err(writeResult.error);
    }
    const addResult = await fromPromise(git.add({ fs, dir: DIR, filepath: path }));
    if (!addResult.success) {
      logger.error("Failed to stage file", addResult.error, { path, remote });
      return err(new ExternalServiceError("Git", `Failed to stage file: ${path}`, addResult.error));
    }
  }

  const commitResult = await fromPromise(git.commit({ fs, dir: DIR, message, author }));
  if (!commitResult.success) {
    logger.error("Failed to commit", commitResult.error, { remote, message });
    return err(new ExternalServiceError("Git", "Failed to commit", commitResult.error));
  }

  const pushResult = await fromPromise(
    git.push({ fs, dir: DIR, http, url: remote, ref: "main", onAuth: makeAuth(token) }),
  );
  if (!pushResult.success) {
    logger.error("Failed to push to remote", pushResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to push to remote", pushResult.error));
  }

  logger.info("Successfully initialized and pushed repository", { remote, sha: commitResult.data });
  return ok(commitResult.data);
}

export async function cloneRepo(
  remote: string,
  token: string,
  logger: Logger,
): Promise<Result<{ fs: NodeFS; dir: string }, AppError>> {
  logger.debug("Cloning repository", { remote });

  const fs = new MemoryFS().toNodeFS();
  const cloneResult = await fromPromise(
    git.clone({
      fs,
      http,
      dir: DIR,
      url: remote,
      ref: "main",
      singleBranch: true,
      depth: 50,
      onAuth: makeAuth(token),
    }),
  );

  if (!cloneResult.success) {
    logger.error("Failed to clone repository", cloneResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to clone repository", cloneResult.error));
  }

  logger.info("Successfully cloned repository", { remote });
  return ok({ fs: fs as unknown as NodeFS, dir: DIR });
}

export async function commitAndPush(
  fs: NodeFS,
  dir: string,
  remote: string,
  token: string,
  changes: Record<string, string>,
  message: string,
  logger: Logger,
  author: Author = SYSTEM_AUTHOR,
): Promise<Result<string, AppError>> {
  logger.debug("Committing and pushing changes", {
    remote,
    changeCount: Object.keys(changes).length,
  });

  const base = dir.endsWith("/") ? dir : `${dir}/`;
  for (const [path, content] of Object.entries(changes)) {
    try {
      await fs.promises.writeFile(`${base}${path}`, content);
    } catch (error) {
      const appError = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to write file to memory FS", appError, { path, remote });
      return err(new AppError(`Failed to write file: ${path}`, "FS_ERROR", 500));
    }

    const addResult = await fromPromise(git.add({ fs, dir, filepath: path }));
    if (!addResult.success) {
      logger.error("Failed to stage file", addResult.error, { path, remote });
      return err(new ExternalServiceError("Git", `Failed to stage file: ${path}`, addResult.error));
    }
  }

  const commitResult = await fromPromise(git.commit({ fs, dir, message, author }));
  if (!commitResult.success) {
    logger.error("Failed to commit", commitResult.error, { remote, message });
    return err(new ExternalServiceError("Git", "Failed to commit", commitResult.error));
  }

  const pushResult = await fromPromise(
    git.push({ fs, dir, http, url: remote, ref: "main", onAuth: makeAuth(token) }),
  );
  if (!pushResult.success) {
    logger.error("Failed to push to remote", pushResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to push to remote", pushResult.error));
  }

  logger.info("Successfully committed and pushed changes", { remote, sha: commitResult.data });
  return ok(commitResult.data);
}

/**
 * Merges a workspace into its parent project repo.
 *
 * Attempts a true three-way merge via isomorphic-git's multi-remote fetch.
 * Falls back to a squash merge (copy changed files, single commit) if the
 * merge fails — this covers cases where isomorphic-git can't resolve the
 * merge or the remotes have diverged in a way that produces conflicts.
 */
export async function mergeWorkspaceIntoProject(
  projectRemote: string,
  projectToken: string,
  workspaceRemote: string,
  workspaceToken: string,
  logger: Logger,
  options: MergeWorkspaceOptions = {},
): Promise<Result<string, AppError>> {
  logger.debug("Merging workspace into project", {
    projectRemote,
    workspaceRemote,
    strategy: options.strategy,
  });

  const author = options.author ?? SYSTEM_AUTHOR;
  const cloneResult = await cloneRepo(projectRemote, projectToken, logger);
  if (!cloneResult.success) return err(cloneResult.error);
  const { fs, dir } = cloneResult.data;

  const addRemoteResult = await fromPromise(
    git.addRemote({ fs, dir, remote: "workspace", url: workspaceRemote }),
  );
  if (!addRemoteResult.success) {
    logger.error("Failed to add workspace remote", addRemoteResult.error, {
      projectRemote,
      workspaceRemote,
    });
    return err(
      new ExternalServiceError("Git", "Failed to add workspace remote", addRemoteResult.error),
    );
  }

  const fetchResult = await fromPromise(
    git.fetch({
      fs,
      http,
      dir,
      remote: "workspace",
      ref: "main",
      singleBranch: true,
      onAuth: makeAuth(workspaceToken),
    }),
  );
  if (!fetchResult.success) {
    logger.error("Failed to fetch workspace", fetchResult.error, { workspaceRemote });
    return err(new ExternalServiceError("Git", "Failed to fetch workspace", fetchResult.error));
  }

  let workspaceSha: string;
  const resolveFetchResult = await fromPromise(git.resolveRef({ fs, dir, ref: "FETCH_HEAD" }));
  if (resolveFetchResult.success) {
    workspaceSha = resolveFetchResult.data;
  } else {
    const resolveRemoteResult = await fromPromise(
      git.resolveRef({ fs, dir, ref: "refs/remotes/workspace/main" }),
    );
    if (!resolveRemoteResult.success) {
      logger.error("Failed to resolve workspace ref", resolveRemoteResult.error, {
        workspaceRemote,
      });
      return err(
        new ExternalServiceError(
          "Git",
          "Failed to resolve workspace ref",
          resolveRemoteResult.error,
        ),
      );
    }
    workspaceSha = resolveRemoteResult.data;
  }

  if (options.strategy === "squash") {
    return squashMerge(fs, dir, workspaceSha, projectRemote, projectToken, author, logger);
  }

  const mergeResult = await fromPromise(
    git.merge({
      fs,
      dir,
      ours: "main",
      theirs: workspaceSha,
      author,
      message: "Merge workspace into project",
    }),
  );

  if (!mergeResult.success) {
    const message =
      mergeResult.error instanceof Error ? mergeResult.error.message : String(mergeResult.error);
    logger.error("Merge failed", mergeResult.error, { projectRemote, workspaceRemote, message });
    return err(
      new MergeConflictError(`Merge failed; workspace may be stale or conflicting: ${message}`),
    );
  }

  const pushResult = await fromPromise(
    git.push({
      fs,
      dir,
      http,
      url: projectRemote,
      ref: "main",
      onAuth: makeAuth(projectToken),
    }),
  );
  if (!pushResult.success) {
    logger.error("Failed to push merge result", pushResult.error, { projectRemote });
    return err(new ExternalServiceError("Git", "Failed to push merge result", pushResult.error));
  }

  if (!mergeResult.data.oid) {
    logger.error("Merge produced no commit OID", undefined, { projectRemote, workspaceRemote });
    return err(new ExternalServiceError("Git", "Merge produced no commit OID"));
  }

  logger.info("Successfully merged workspace into project", {
    projectRemote,
    workspaceRemote,
    sha: mergeResult.data.oid,
  });
  return ok(mergeResult.data.oid);
}

async function squashMerge(
  projectFs: NodeFS,
  projectDir: string,
  workspaceSha: string,
  projectRemote: string,
  projectToken: string,
  author: Author,
  logger: Logger,
): Promise<Result<string, AppError>> {
  logger.debug("Performing squash merge", { projectRemote, workspaceSha });

  const workspaceFilesResult = await listFilesAtCommit(projectFs, workspaceSha, logger);
  if (!workspaceFilesResult.success) return err(workspaceFilesResult.error);

  const projectFilesResult = await listFilesAtCommit(projectFs, "main", logger);
  if (!projectFilesResult.success) return err(projectFilesResult.error);

  const workspaceFiles = workspaceFilesResult.data;
  const projectFiles = projectFilesResult.data;
  const workspaceMap = new Map(workspaceFiles);

  const changed = workspaceFiles.filter(([path, hash]) => {
    const projectHash = projectFiles.find(([p]) => p === path)?.[1];
    return projectHash !== hash;
  });
  const deleted = projectFiles.filter(([path]) => !workspaceMap.has(path));

  for (const [path] of changed) {
    const contentResult = await readFileAtCommit(projectFs, workspaceSha, path, logger);
    if (!contentResult.success) return err(contentResult.error);

    try {
      await projectFs.promises.writeFile(`${projectDir}/${path}`, contentResult.data);
    } catch (error) {
      const appError = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to write file during squash merge", appError, { path, projectRemote });
      return err(new AppError(`Failed to write file: ${path}`, "FS_ERROR", 500));
    }

    const addResult = await fromPromise(
      git.add({ fs: projectFs, dir: projectDir, filepath: path }),
    );
    if (!addResult.success) {
      logger.error("Failed to stage file during squash merge", addResult.error, {
        path,
        projectRemote,
      });
      return err(new ExternalServiceError("Git", `Failed to stage file: ${path}`, addResult.error));
    }
  }

  for (const [path] of deleted) {
    try {
      await projectFs.promises.unlink(`${projectDir}/${path}`);
    } catch (error) {
      const appError = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to unlink file during squash merge", appError, { path, projectRemote });
      return err(new AppError(`Failed to unlink file: ${path}`, "FS_ERROR", 500));
    }

    const removeResult = await fromPromise(
      git.remove({ fs: projectFs, dir: projectDir, filepath: path }),
    );
    if (!removeResult.success) {
      logger.error("Failed to remove file during squash merge", removeResult.error, {
        path,
        projectRemote,
      });
      return err(
        new ExternalServiceError("Git", `Failed to remove file: ${path}`, removeResult.error),
      );
    }
  }

  const changeCount = changed.length + deleted.length;
  if (changeCount === 0) {
    const resolveResult = await fromPromise(
      git.resolveRef({ fs: projectFs, dir: projectDir, ref: "main" }),
    );
    if (!resolveResult.success) {
      logger.error("Failed to resolve main ref", resolveResult.error, { projectRemote });
      return err(
        new ExternalServiceError("Git", "Failed to resolve main ref", resolveResult.error),
      );
    }
    return ok(resolveResult.data);
  }

  const commitResult = await fromPromise(
    git.commit({
      fs: projectFs,
      dir: projectDir,
      message: `Squash merge workspace (${changeCount} file${changeCount === 1 ? "" : "s"} changed)`,
      author,
    }),
  );
  if (!commitResult.success) {
    logger.error("Failed to commit squash merge", commitResult.error, { projectRemote });
    return err(
      new ExternalServiceError("Git", "Failed to commit squash merge", commitResult.error),
    );
  }

  const pushResult = await fromPromise(
    git.push({
      fs: projectFs,
      dir: projectDir,
      http,
      url: projectRemote,
      ref: "main",
      onAuth: makeAuth(projectToken),
    }),
  );
  if (!pushResult.success) {
    logger.error("Failed to push squash merge", pushResult.error, { projectRemote });
    return err(new ExternalServiceError("Git", "Failed to push squash merge", pushResult.error));
  }

  logger.info("Successfully completed squash merge", { projectRemote, sha: commitResult.data });
  return ok(commitResult.data);
}

async function listFilesAtCommit(
  fs: NodeFS,
  ref: string,
  logger: Logger,
): Promise<Result<[path: string, oid: string][], AppError>> {
  const files: [string, string][] = [];
  const walkResult = await fromPromise(
    git.walk({
      fs,
      dir: DIR,
      trees: [git.TREE({ ref })],
      map: async (filepath, [entry]) => {
        if (!entry) return;
        const type = await entry.type();
        if (type === "blob") {
          const oid = await entry.oid();
          files.push([filepath, oid]);
        }
      },
    }),
  );

  if (!walkResult.success) {
    logger.error("Failed to walk files at commit", walkResult.error, { ref });
    return err(
      new ExternalServiceError("Git", `Failed to list files at commit: ${ref}`, walkResult.error),
    );
  }

  return ok(files);
}

async function readFileAtCommit(
  fs: NodeFS,
  ref: string,
  path: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  const readResult = await fromPromise(git.readBlob({ fs, dir: DIR, oid: ref, filepath: path }));
  if (!readResult.success) {
    logger.error("Failed to read file at commit", readResult.error, { ref, path });
    return err(
      new ExternalServiceError(
        "Git",
        `Failed to read file: ${path} at commit: ${ref}`,
        readResult.error,
      ),
    );
  }

  return ok(new TextDecoder().decode(readResult.data.blob));
}

export async function readFileFromRepo(
  remote: string,
  token: string,
  path: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  logger.debug("Reading file from repo", { remote, path });

  const cloneResult = await cloneRepo(remote, token, logger);
  if (!cloneResult.success) return err(cloneResult.error);

  const { fs } = cloneResult.data;

  try {
    const content = await fs.promises.readFile(`/${path}`, { encoding: "utf8" });
    logger.info("Successfully read file from repo", { remote, path });
    return ok(typeof content === "string" ? content : new TextDecoder().decode(content));
  } catch (error) {
    logger.error("Failed to read file from repo", error instanceof Error ? error : undefined, {
      remote,
      path,
    });
    return err(new AppError(`Failed to read file: ${path}`, "FS_ERROR", 500));
  }
}

export async function listFilesInRepo(
  remote: string,
  token: string,
  logger: Logger,
): Promise<Result<string[], AppError>> {
  logger.debug("Listing files in repo", { remote });

  const cloneResult = await cloneRepo(remote, token, logger);
  if (!cloneResult.success) return err(cloneResult.error);

  const { fs, dir } = cloneResult.data;
  return walkDir(fs, dir, "", logger);
}

async function walkDir(
  fs: NodeFS,
  base: string,
  prefix: string,
  logger: Logger,
): Promise<Result<string[], AppError>> {
  const dirPath = base === "/" ? "/" : base;

  try {
    const entries = await fs.promises.readdir(dirPath);
    const files: string[] = [];

    for (const entry of entries) {
      if (entry === ".git") continue;
      const fullPath = base === "/" ? `/${entry}` : `${base}/${entry}`;

      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.isDirectory()) {
          const subFilesResult = await walkDir(fs, fullPath, `${prefix}${entry}/`, logger);
          if (!subFilesResult.success) return err(subFilesResult.error);
          files.push(...subFilesResult.data);
        } else {
          files.push(`${prefix}${entry}`);
        }
      } catch (error) {
        logger.error("Failed to stat file", error instanceof Error ? error : undefined, {
          fullPath,
        });
        return err(new AppError(`Failed to stat file: ${fullPath}`, "FS_ERROR", 500));
      }
    }

    return ok(files);
  } catch (error) {
    logger.error("Failed to read directory", error instanceof Error ? error : undefined, {
      dirPath,
    });
    return err(new AppError(`Failed to read directory: ${dirPath}`, "FS_ERROR", 500));
  }
}

export async function getCommitLog(
  remote: string,
  token: string,
  logger: Logger,
  depth = 20,
): Promise<Result<CommitLogEntry[], AppError>> {
  logger.debug("Getting commit log", { remote, depth });

  const cloneResult = await cloneRepo(remote, token, logger);
  if (!cloneResult.success) return err(cloneResult.error);

  const { fs, dir } = cloneResult.data;
  const logResult = await fromPromise(git.log({ fs, dir, depth }));
  if (!logResult.success) {
    logger.error("Failed to get commit log", logResult.error, { remote });
    return err(new ExternalServiceError("Git", "Failed to get commit log", logResult.error));
  }

  const commits = logResult.data.map((c) => ({
    sha: c.oid,
    message: c.commit.message.trim(),
    author: `${c.commit.author.name} <${c.commit.author.email}>`,
    timestamp: c.commit.author.timestamp,
  }));

  logger.info("Successfully retrieved commit log", { remote, commitCount: commits.length });
  return ok(commits);
}

export async function importFromGitHub(
  artifacts: ArtifactsNamespace,
  name: string,
  githubUrl: string,
  logger: Logger,
  branch = "main",
  depth = 10,
  timeoutMs = 120000, // 2 minute default timeout
): Promise<Result<ArtifactsCreateResult, AppError>> {
  logger.debug("Importing from GitHub", { name, githubUrl, branch, depth, timeoutMs });

  // Create timeout handle outside try so finally can access it
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Import operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Race between import and timeout
    const result = await Promise.race([
      artifacts.import({
        source: {
          url: githubUrl,
          branch,
          depth,
        },
        target: {
          name,
        },
      }),
      timeoutPromise,
    ]);

    logger.info("Successfully imported from GitHub", {
      name,
      githubUrl,
      branch,
      remote: result.remote,
    });
    return ok(result);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new ExternalServiceError(
            "Artifacts",
            error instanceof Error ? error.message : "Import failed",
            error instanceof Error ? error : undefined,
          );
    logger.error("Failed to import from GitHub", appError, { name, githubUrl, branch });
    return err(appError);
  } finally {
    // Always clear the timeout to prevent memory leaks
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Builds a git-style unified diff header + POSIX patch for a modified file.
 * `createPatch` computes a real line-level diff with proper @@ hunks.
 */
function fileUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  // createPatch returns: "Index: <path>\n===...\n--- <path>\n+++ <path>\n@@ ... @@\n..."
  // We strip the Index/=== preamble and replace the --- / +++ markers with git-style ones.
  const patch = createPatch(path, oldContent, newContent, "", "");
  const lines = patch.split("\n");
  // Drop the first two lines ("Index: …" and "===…") then fix up --- / +++ paths.
  const body = lines
    .slice(2)
    .map((line) => {
      if (line.startsWith("--- ")) return `--- a/${path}`;
      if (line.startsWith("+++ ")) return `+++ b/${path}`;
      return line;
    })
    .join("\n");
  return `diff --git a/${path} b/${path}\n${body}`;
}

function newFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const lineCount = lines.length;
  const body = lines.map((l) => `+${l}`).join("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lineCount} @@\n${body}\n`;
}

function deletedFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const lineCount = lines.length;
  const body = lines.map((l) => `-${l}`).join("\n");
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\n--- a/${path}\n+++ /dev/null\n@@ -1,${lineCount} +0,0 @@\n${body}\n`;
}

export async function getDiffBetweenRepos(
  baseRemote: string,
  baseToken: string,
  workspaceRemote: string,
  workspaceToken: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  logger.debug("Getting diff between repos", { baseRemote, workspaceRemote });

  const [workspaceCloneResult, baseCloneResult] = await Promise.all([
    cloneRepo(workspaceRemote, workspaceToken, logger),
    cloneRepo(baseRemote, baseToken, logger),
  ]);

  if (!workspaceCloneResult.success) return err(workspaceCloneResult.error);
  if (!baseCloneResult.success) return err(baseCloneResult.error);

  const { fs: workspaceFs } = workspaceCloneResult.data;
  const { fs: baseFs } = baseCloneResult.data;

  const [workspaceFilesResult, baseFilesResult] = await Promise.all([
    listFilesAtCommit(workspaceFs, "main", logger),
    listFilesAtCommit(baseFs, "main", logger),
  ]);

  if (!workspaceFilesResult.success) return err(workspaceFilesResult.error);
  if (!baseFilesResult.success) return err(baseFilesResult.error);

  const workspaceFiles = workspaceFilesResult.data;
  const baseFiles = baseFilesResult.data;

  const baseContent = new Map<string, string>();
  const workspaceContent = new Map<string, string>();

  await Promise.all([
    ...baseFiles.map(async ([path]) => {
      const contentResult = await readFileAtCommit(baseFs, "main", path, logger);
      if (contentResult.success) {
        baseContent.set(path, contentResult.data);
      }
    }),
    ...workspaceFiles.map(async ([path]) => {
      const contentResult = await readFileAtCommit(workspaceFs, "main", path, logger);
      if (contentResult.success) {
        workspaceContent.set(path, contentResult.data);
      }
    }),
  ]);

  const diff = buildUnifiedDiff(baseContent, workspaceContent);
  logger.info("Successfully generated diff between repos", { baseRemote, workspaceRemote });
  return ok(diff);
}

export function buildUnifiedDiff(
  baseFiles: Map<string, string>,
  workspaceFiles: Map<string, string>,
): string {
  const diffParts: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...workspaceFiles.keys()]);

  for (const path of [...paths].sort()) {
    const oldContent = baseFiles.get(path);
    const newContent = workspaceFiles.get(path);
    if (oldContent === newContent) continue;

    if (oldContent === undefined && newContent !== undefined) {
      diffParts.push(newFileDiff(path, newContent));
    } else if (newContent === undefined && oldContent !== undefined) {
      diffParts.push(deletedFileDiff(path, oldContent));
    } else if (oldContent !== undefined && newContent !== undefined) {
      diffParts.push(fileUnifiedDiff(path, oldContent, newContent));
    }
  }

  return diffParts.join("\n");
}
