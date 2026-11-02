/**
 * Import Queue Processor
 * Handles GitHub import jobs from Cloudflare Queue for durable execution
 */

import { syncOrImportProject } from "../services/project-sync";
import { isTargetDeleting } from "../storage/deletion";
import {
  type SubmoduleContentReport,
  cloneRepo,
  freshRepoToken,
  importFromGitHub,
  scanForSubmoduleContent,
  submoduleUnsupportedError,
} from "../storage/git-ops";
import { getProviderFromUrl } from "../storage/git-providers";
import { finalizeImportSnapshot } from "../storage/import-finalize";
import { deleteImportJob, isImportCancelled, updateImportStatus } from "../storage/imports";
import {
  recordImportCancelled,
  recordImportCompleted,
  recordImportFailed,
  recordImportStarted,
} from "../storage/metrics";
import { writeSnapshotFromRepo } from "../storage/repo-snapshot";
import { getProjectByPath, setProject } from "../storage/state";
import { recordSyncHistory } from "../storage/sync";
import type {
  EmailMessage,
  Env,
  GitProvider,
  ImportJobMessage,
  ProjectEntry,
  SyncJobMessage,
} from "../types";
import type { Message, MessageBatch } from "../types";
import { getArtifactsRepoName, projectDefaultBranch } from "../types";
import { escapeHtml } from "../utils/html";
import { type Logger, createLogger } from "../utils/logger";
import { DEFAULT_CLONE_DEPTH, MAX_CLONE_DEPTH } from "../utils/validation";
import { emitEvent } from "./events";

const logger = createLogger({ component: "ImportQueue" });

/**
 * Validates an import job message
 * Returns validated message or null if invalid
 */
function validateImportMessage(body: unknown): ImportJobMessage | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const msg = body as Record<string, unknown>;

  // Check required fields
  if (msg.type !== "github.import") {
    return null;
  }

  if (
    typeof msg.importId !== "string" ||
    typeof msg.projectId !== "string" ||
    typeof msg.namespace !== "string" ||
    typeof msg.slug !== "string" ||
    typeof msg.githubUrl !== "string" ||
    typeof msg.branch !== "string" ||
    typeof msg.timestamp !== "string"
  ) {
    return null;
  }

  // Validate URL format (basic check)
  try {
    new URL(msg.githubUrl);
  } catch {
    return null;
  }

  // Sanitize depth: only integers in [0, MAX_CLONE_DEPTH] are honored
  // (0 = full history); anything else falls back to the default.
  const depth =
    typeof msg.depth === "number" &&
    Number.isInteger(msg.depth) &&
    msg.depth >= 0 &&
    msg.depth <= MAX_CLONE_DEPTH
      ? msg.depth
      : DEFAULT_CLONE_DEPTH;

  return {
    type: "github.import",
    importId: msg.importId,
    projectId: msg.projectId,
    namespace: msg.namespace,
    slug: msg.slug,
    githubUrl: msg.githubUrl,
    branch: msg.branch,
    depth,
    timestamp: msg.timestamp,
    ...(typeof msg.initiatedBy === "string" ? { initiatedBy: msg.initiatedBy } : {}),
  };
}

/**
 * Validates a sync job message
 * Supports both legacy github.sync and new git.sync types
 */
function validateSyncMessage(body: unknown): SyncJobMessage | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const msg = body as Record<string, unknown>;

  // Support both legacy github.sync and new git.sync types
  if (msg.type !== "github.sync" && msg.type !== "git.sync") {
    return null;
  }

  if (
    typeof msg.importId !== "string" ||
    typeof msg.projectId !== "string" ||
    typeof msg.namespace !== "string" ||
    typeof msg.slug !== "string" ||
    typeof msg.branch !== "string" ||
    typeof msg.timestamp !== "string"
  ) {
    return null;
  }

  // Validate URL - use sourceUrl if available, fall back to githubUrl
  const urlToValidate = (msg.sourceUrl || msg.githubUrl) as string;
  if (typeof urlToValidate !== "string") {
    return null;
  }

  try {
    new URL(urlToValidate);
  } catch {
    return null;
  }

  return {
    type: msg.type as "github.sync" | "git.sync",
    importId: msg.importId,
    projectId: msg.projectId,
    namespace: msg.namespace,
    slug: msg.slug,
    githubUrl: (msg.githubUrl as string) || urlToValidate,
    sourceUrl: msg.sourceUrl as string | undefined,
    provider: msg.provider as GitProvider | undefined,
    branch: msg.branch,
    depth: typeof msg.depth === "number" ? msg.depth : DEFAULT_CLONE_DEPTH,
    timestamp: msg.timestamp,
    // Preserve the trigger so sync history records webhook/auto syncs correctly.
    trigger:
      msg.trigger === "webhook" || msg.trigger === "auto" || msg.trigger === "manual"
        ? msg.trigger
        : undefined,
  };
}

/**
 * Helper to check for import cancellation and handle cleanup
 */
async function checkAndHandleCancellation(
  env: Env,
  namespace: string,
  slug: string,
): Promise<boolean> {
  const isCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
  if (isCancelled) {
    logger.info("Import cancelled by user", { namespace, slug });
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "cancelled",
      logger,
      "Import cancelled by user",
    );
    await deleteImportJob(env.DB, namespace, slug, logger);
  }
  return isCancelled;
}

/**
 * Best-effort read of a just-imported repo's tree for submodule content
 * (#258). Returns `null` when the guard could not run at all -- the read
 * token could not be minted, the clone failed, or the tree walk failed -- so
 * the caller can distinguish "did not scan" from "scanned, found nothing".
 * Each underlying failure is already logged where it happens; what none of
 * those sites can say, and the caller does, is that the submodule guard was
 * therefore skipped for this import.
 *
 * `branch` is the branch that was actually imported, and both the clone and
 * the scan must use it: an imported repo keeps its source branch name
 * (master/trunk/...), so hard-coding `main` here would make the scan fail to
 * find its ref on exactly those projects and silently downgrade the guard to
 * "skipped" for every one of them.
 */
async function readSubmoduleReport(
  env: Env,
  remote: string,
  branch: string,
  logger: Logger,
): Promise<SubmoduleContentReport | null> {
  // Every failure mode collapses to null, including a thrown one. The caller
  // treats null as "not scanned" and lets the import through with a warning, so
  // a rejected promise here has to reach that path too — without the catch it
  // would escape to the job's outer handler and fail an import for an infra
  // hiccup, which is the opposite of the best-effort contract documented at the
  // call site.
  try {
    const tokenResult = await freshRepoToken(env.ARTIFACTS, remote, "read", logger);
    if (!tokenResult.success) return null;
    const cloneResult = await cloneRepo(remote, tokenResult.data, logger, { ref: branch });
    if (!cloneResult.success) return null;
    const scanResult = await scanForSubmoduleContent(cloneResult.data.fs, branch, logger);
    return scanResult.success ? scanResult.data : null;
  } catch (error) {
    logger.warn("Submodule scan threw while reading the imported tree", {
      remote,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Process a GitHub import job
 * This is the core import logic that runs within the queue consumer
 */
async function processImportJob(
  env: Env,
  message: ImportJobMessage,
  msg: Message<ImportJobMessage>,
): Promise<void> {
  const { importId, projectId, namespace, slug, githubUrl, branch, depth, initiatedBy } = message;
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);

  // Use message timestamp for duration calculation (works across Worker isolates)
  const startedAt = new Date(message.timestamp).getTime();

  logger.info("Processing import job", { importId, namespace, slug, githubUrl });

  // Record that import was started
  await recordImportStarted(env.DB, namespace, slug, logger);

  try {
    // Verify the project exists
    const projectResult = await getProjectByPath(env.STATE, namespace, slug, logger);
    if (!projectResult.success || !projectResult.data) {
      logger.error("Project not found for import", undefined, { namespace, slug });
      // Don't retry - the project should exist
      msg.ack();
      return;
    }

    const project = projectResult.data;

    // Verify project ID matches (security check)
    if (project.id !== projectId) {
      logger.error("Project ID mismatch", undefined, { expected: projectId, got: project.id });
      msg.ack();
      return;
    }

    // No-op if the owner is being erased: re-importing would re-create rows the
    // deletion cascade is removing. Ack (don't retry) so the message drains.
    if (await isTargetDeleting(env, project, logger)) {
      logger.info("Skipping import for deleting owner", { namespace, slug });
      msg.ack();
      return;
    }

    // Check cancellation before starting
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
      msg.ack();
      return;
    }

    // Update status to cloning
    await updateImportStatus(env.DB, namespace, slug, "cloning", logger, "Cloning repository");

    // Check cancellation after status update
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
      msg.ack();
      return;
    }

    // Perform the actual import
    const importResult = await importFromGitHub(
      env.ARTIFACTS,
      artifactsRepoName,
      githubUrl,
      logger,
      branch,
      depth,
    );

    if (!importResult.success) {
      // Check if it was cancelled during the operation
      if (await checkAndHandleCancellation(env, namespace, slug)) {
        await recordImportCancelled(env.DB, namespace, slug, logger);
        msg.ack();
        return;
      }

      // Handle failure with logging, storage, and alerting
      await handleImportFailure(env, {
        importId,
        namespace,
        slug,
        githubUrl,
        branch,
        error: importResult.error,
        startedAt,
        ...(initiatedBy !== undefined ? { initiatedBy } : {}),
      });

      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Import failed: ${importResult.error.message}`,
      );
      msg.ack();
      return;
    }

    // Check cancellation before updating project
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
      msg.ack();
      return;
    }

    // Clone finished — surface the phase transition so the progress UI moves
    // off "cloning" while the project entry and snapshot are written.
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "processing",
      logger,
      "Repository cloned, finalizing import",
    );

    // Fail closed on git submodules (#258). The raw import above (Artifacts
    // cloning the source directly) preserves a gitlink entry byte-for-byte, but
    // every later consumer of this repo's tree -- squash merges, the repo
    // browser, the sandbox evaluator -- goes through isomorphic-git/MemoryFS,
    // which silently drops a gitlink on checkout (see scanForSubmoduleContent's
    // doc comment). This is the last point the imported repo is still
    // disposable, so reject here rather than completing an import a later merge
    // could then silently corrupt. A failure to even run the scan does not
    // block the import -- it is the same best-effort clone
    // `writeSnapshotFromRepo` performs moments later, and an infra hiccup here
    // should not be indistinguishable from a real rejection -- but it is said
    // out loud, because "did not scan" and "scanned, found nothing" are not
    // the same state and only one of them leaves the guard unenforced.
    const submoduleReport = await readSubmoduleReport(
      env,
      importResult.data.remote,
      branch,
      logger,
    );
    // The scan is a full clone plus a tree walk, so it is a phase long enough
    // for a cancellation to land inside it -- and the rejection branch below
    // returns before the next checkpoint, so without this the user who hit
    // cancel gets told their repo was refused for submodules instead of that
    // it was cancelled. Every other phase boundary in this job checks here for
    // the same reason.
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
      msg.ack();
      return;
    }

    if (submoduleReport === null) {
      logger.warn(
        "Submodule guard skipped: could not read the imported tree; import proceeds unscanned",
        { namespace, slug, remote: importResult.data.remote },
      );
    } else if (submoduleReport.gitlinkPaths.length > 0 || submoduleReport.hasGitmodules) {
      const error = submoduleUnsupportedError(submoduleReport);
      logger.warn("Rejecting import: repository contains unsupported submodule content", {
        namespace,
        slug,
        gitlinkPaths: submoduleReport.gitlinkPaths,
        hasGitmodules: submoduleReport.hasGitmodules,
      });
      await handleImportFailure(env, {
        importId,
        namespace,
        slug,
        githubUrl,
        branch,
        error,
        startedAt,
        // Same as every other failure path: without the initiator the user who
        // started this import is never told why it stopped.
        ...(initiatedBy !== undefined ? { initiatedBy } : {}),
      });
      await updateImportStatus(env.DB, namespace, slug, "failed", logger, error.message);
      msg.ack();
      return;
    }
    // Built here, persisted below. `importCompleted: true` must not reach KV
    // until every way this run can still end in a non-terminal-success state
    // has been ruled out, or a cancelled or failed import leaves behind a
    // project entry claiming it completed.
    const updatedProject: ProjectEntry = {
      ...project,
      remote: importResult.data.remote,
      importCompleted: true,
    };

    // Final cancellation check before completing
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
      msg.ack();
      return;
    }

    // Measure the import proper — the clone — before the snapshot walk below,
    // so the recorded duration keeps the meaning it had.
    const duration = Date.now() - startedAt;

    // Snapshot + file count, before the terminal status flip. See
    // finalizeImportSnapshot for why the ordering matters.
    await finalizeImportSnapshot(
      env,
      {
        remote: updatedProject.remote,
        namespace,
        slug,
        defaultBranch: projectDefaultBranch(updatedProject),
      },
      logger,
    );

    // Re-check: the snapshot walk clones the repo, so it is long enough for a
    // cancel to land inside it. Writing "completed" without re-checking would
    // silently overwrite that cancellation.
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
      msg.ack();
      return;
    }

    const setResult = await setProject(env.STATE, updatedProject, logger);
    if (!setResult.success) {
      const error = new Error(setResult.error.message);
      await handleImportFailure(env, {
        importId,
        namespace,
        slug,
        githubUrl,
        branch,
        error,
        startedAt,
        ...(initiatedBy !== undefined ? { initiatedBy } : {}),
      });

      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Failed to update project: ${setResult.error.message}`,
      );
      msg.ack();
      return;
    }

    // Mark import as complete
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "completed",
      logger,
      "Import completed successfully",
    );

    await recordImportCompleted(env.DB, namespace, slug, duration, logger);

    await emitEvent(
      env.DB,
      env.EVENTS_QUEUE,
      {
        type: "project.imported",
        project: updatedProject.name,
        sourceUrl: msg.body.sourceUrl ?? githubUrl,
      },
      { type: "system" },
      logger,
      updatedProject.id,
    );

    logger.info("Import completed successfully", { importId, namespace, slug, duration });
    msg.ack();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Check if this was a cancellation
    const wasCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
    if (wasCancelled) {
      await updateImportStatus(env.DB, namespace, slug, "cancelled", logger, "Import cancelled");
      await recordImportCancelled(env.DB, namespace, slug, logger);
      await deleteImportJob(env.DB, namespace, slug, logger);
    } else {
      // Handle failure with logging, storage, and alerting
      await handleImportFailure(env, {
        importId,
        namespace,
        slug,
        githubUrl,
        branch,
        error: err,
        startedAt,
        ...(initiatedBy !== undefined ? { initiatedBy } : {}),
      });

      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Import failed: ${err.message}`,
      );
    }

    // Import status is already recorded as failed/cancelled — ack so the message
    // isn't re-delivered and doesn't bounce the status back to "cloning".
    // Users can retry via the "Retry Import" button on the project page.
    msg.ack();
  }
}

/**
 * Process a GitHub sync job (re-sync existing project)
 * Updates project with latest commit info after successful sync
 */
async function processSyncJob(
  env: Env,
  message: SyncJobMessage,
  msg: Message<SyncJobMessage>,
): Promise<void> {
  const { importId, projectId, namespace, slug, githubUrl, branch, depth } = message;
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);

  // Record start time for duration tracking
  const startedAt = Date.now();

  logger.info("Processing sync job", { importId, namespace, slug, githubUrl });

  try {
    // Verify the project exists
    const projectResult = await getProjectByPath(env.STATE, namespace, slug, logger);
    if (!projectResult.success || !projectResult.data) {
      logger.error("Project not found for sync", undefined, { namespace, slug });
      msg.ack();
      return;
    }

    const project = projectResult.data;

    // Verify project ID matches (security check)
    if (project.id !== projectId) {
      logger.error("Project ID mismatch", undefined, { expected: projectId, got: project.id });
      msg.ack();
      return;
    }

    // No-op if the owner is being erased (see processImportJob for rationale).
    if (await isTargetDeleting(env, project, logger)) {
      logger.info("Skipping sync for deleting owner", { namespace, slug });
      msg.ack();
      return;
    }

    // Check cancellation before starting
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
      msg.ack();
      return;
    }

    // #304: this write silently failed for every sync until migration 043 —
    // 'syncing' was missing from the status CHECK constraint, so the row kept
    // its previous status (usually 'queued') and the job read as never having
    // been picked up. A failure here must not abort a working sync, but it must
    // not be invisible either: an unwritable status label is what makes a job
    // look wedged to both the UI and the stall sweep.
    const syncingStatusResult = await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "syncing",
      logger,
      "Syncing repository",
    );
    if (!syncingStatusResult.success) {
      logger.error("Failed to record 'syncing' status; continuing with sync", undefined, {
        namespace,
        slug,
        error: syncingStatusResult.error.message,
      });
    }

    // #190: sync is an INCREMENTAL fetch into the existing Artifacts repo, never
    // a delete-and-re-import — re-importing destroyed Stratum-native commits and
    // orphaned workspace forks. Only projects with no recorded Artifacts remote
    // (initial import never completed, so no forks can exist) still take the
    // import path.
    const outcome = await syncOrImportProject(
      env.ARTIFACTS,
      {
        remote: project.remote,
        artifactsRepoName,
        sourceUrl: githubUrl,
        branch,
        depth,
        logContext: { namespace, slug },
      },
      logger,
    );
    const syncedRemote = outcome.remote;
    const syncError = outcome.error;

    if (syncError) {
      // Check if it was cancelled during the operation
      if (await checkAndHandleCancellation(env, namespace, slug)) {
        await recordImportCancelled(env.DB, namespace, slug, logger);
        msg.ack();
        return;
      }

      // Handle failure with logging and metrics
      await handleImportFailure(env, {
        importId,
        namespace,
        slug,
        githubUrl,
        branch,
        error: syncError,
        startedAt,
        isSync: true,
      });
      await recordSyncHistory(
        env.DB,
        {
          namespace,
          slug,
          trigger: message.trigger ?? "manual",
          status: "failed",
          errorMessage: syncError.message,
          durationMs: Date.now() - startedAt,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
        },
        logger,
      );

      // Update project sync error status
      const updatedProject: ProjectEntry = {
        ...project,
        lastSyncedAt: new Date().toISOString(),
        lastSyncStatus: "failed",
        lastSyncError: syncError.message,
      };
      await setProject(env.STATE, updatedProject, logger);

      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Sync failed: ${syncError.message}`,
      );
      msg.ack();
      return;
    }

    // Get latest commit info from provider
    const provider = getProviderFromUrl(githubUrl, logger);
    let latestCommitSha: string | undefined;

    if (provider) {
      const parsed = provider.parseUrl(githubUrl);
      if (parsed) {
        const commitResult = await provider.getLatestCommit(
          parsed.owner,
          parsed.repo,
          branch,
          undefined, // auth - could be enhanced to use env tokens
          logger,
        );
        if (commitResult.success && commitResult.data) {
          latestCommitSha = commitResult.data.sha;
        }
      }
    }

    // Update project with sync info. The remote only changes on the legacy
    // full-import fallback — incremental sync keeps the existing repo (and thus
    // the remote) stable so workspace forks stay attached.
    const updatedProject: ProjectEntry = {
      ...project,
      remote: syncedRemote,
      lastSyncedAt: new Date().toISOString(),
      lastSyncedCommit: latestCommitSha,
      lastSyncStatus: "success",
    };

    const setResult = await setProject(env.STATE, updatedProject, logger);
    if (!setResult.success) {
      logger.error("Failed to update project after sync", setResult.error, { namespace, slug });
    }

    // Mark sync as complete
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "completed",
      logger,
      "Sync completed successfully",
    );

    // Record completion with duration
    const duration = Date.now() - startedAt;
    await recordImportCompleted(env.DB, namespace, slug, duration, logger);
    await recordSyncHistory(
      env.DB,
      {
        namespace,
        slug,
        trigger: message.trigger ?? "manual",
        status: "success",
        syncedCommit: latestCommitSha,
        durationMs: duration,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
      },
      logger,
    );

    // Write repo snapshot to KV so page loads skip git clones going forward
    await writeSnapshotFromRepo(
      env.STATE,
      env.ARTIFACTS,
      {
        remote: updatedProject.remote,
        namespace,
        slug,
        defaultBranch: projectDefaultBranch(updatedProject),
      },
      logger,
    );

    await emitEvent(
      env.DB,
      env.EVENTS_QUEUE,
      {
        type: "sync.completed",
        project: updatedProject.name,
        ...(latestCommitSha !== undefined ? { commit: latestCommitSha } : {}),
      },
      { type: "system" },
      logger,
      updatedProject.id,
    );

    logger.info("Sync completed successfully", {
      importId,
      namespace,
      slug,
      duration,
      latestCommitSha,
    });
    msg.ack();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Check if this was a cancellation
    const wasCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
    if (wasCancelled) {
      await updateImportStatus(env.DB, namespace, slug, "cancelled", logger, "Sync cancelled");
      await recordImportCancelled(env.DB, namespace, slug, logger);
      await deleteImportJob(env.DB, namespace, slug, logger);
    } else {
      // Handle failure with logging and metrics
      await handleImportFailure(env, {
        importId,
        namespace,
        slug,
        githubUrl,
        branch,
        error: err,
        startedAt,
        isSync: true,
      });
      await recordSyncHistory(
        env.DB,
        {
          namespace,
          slug,
          trigger: message.trigger ?? "manual",
          status: "failed",
          errorMessage: err.message,
          durationMs: Date.now() - startedAt,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
        },
        logger,
      );

      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Sync failed: ${err.message}`,
      );
    }

    msg.retry();
  }
}

/**
 * Queue consumer handler for import jobs
 * This is called by the Cloudflare Queue system
 */
export async function handleImportQueue(
  batch: MessageBatch<ImportJobMessage | SyncJobMessage>,
  env: Env,
): Promise<void> {
  logger.info("Processing import queue batch", {
    queue: batch.queue,
    messageCount: batch.messages.length,
  });

  for (const msg of batch.messages) {
    const body = msg.body;

    // Try to validate as import message
    const importMessage = validateImportMessage(body);
    if (importMessage) {
      await processImportJob(env, importMessage, msg as Message<ImportJobMessage>);
      continue;
    }

    // Try to validate as sync message
    const syncMessage = validateSyncMessage(body);
    if (syncMessage) {
      await processSyncJob(env, syncMessage, msg as Message<SyncJobMessage>);
      continue;
    }

    // Unknown message type - ack to prevent retries
    logger.error("Invalid message format in import queue", undefined, {
      body: JSON.stringify(body).slice(0, 200), // Log first 200 chars only
    });
    msg.ack();
  }
}

/**
 * Send an import job to the queue
 */
export async function queueImportJob(
  queue: Queue<ImportJobMessage> | undefined,
  params: Omit<ImportJobMessage, "type" | "timestamp" | "depth"> & { depth?: number },
): Promise<void> {
  if (!queue) {
    throw new Error("IMPORT_QUEUE not configured");
  }

  const message: ImportJobMessage = {
    type: "github.import",
    importId: params.importId,
    projectId: params.projectId,
    namespace: params.namespace,
    slug: params.slug,
    githubUrl: params.githubUrl,
    branch: params.branch,
    depth: params.depth ?? DEFAULT_CLONE_DEPTH,
    timestamp: new Date().toISOString(),
    ...(params.initiatedBy !== undefined ? { initiatedBy: params.initiatedBy } : {}),
  };

  await queue.send(message);
  logger.info("Import job queued", {
    importId: params.importId,
    namespace: params.namespace,
    slug: params.slug,
  });
}

/**
 * Send a sync job to the queue
 * Supports both GitHub and generic git providers
 */
export async function queueSyncJob(
  queue: Queue<SyncJobMessage> | undefined,
  params: Omit<SyncJobMessage, "type" | "timestamp"> & { depth?: number },
): Promise<void> {
  if (!queue) {
    throw new Error("IMPORT_QUEUE not configured");
  }

  // Use generic git.sync type for new syncs, github.sync for backward compatibility
  const isGeneric = params.provider && params.provider !== "github";

  const message: SyncJobMessage = {
    type: isGeneric ? "git.sync" : "github.sync",
    importId: params.importId,
    projectId: params.projectId,
    namespace: params.namespace,
    slug: params.slug,
    githubUrl: params.githubUrl,
    sourceUrl: params.sourceUrl,
    provider: params.provider,
    branch: params.branch,
    depth: params.depth ?? DEFAULT_CLONE_DEPTH,
    timestamp: new Date().toISOString(),
    trigger: params.trigger,
  };

  await (queue as Queue<SyncJobMessage | ImportJobMessage>).send(message);
  logger.info("Sync job queued", {
    importId: params.importId,
    namespace: params.namespace,
    slug: params.slug,
    provider: params.provider || "github",
  });
}

/**
 * Store failed import details in the database
 */
async function storeFailedImport(
  env: Env,
  params: {
    importId?: string;
    namespace: string;
    slug: string;
    errorType: string;
    errorMessage: string;
    errorDetails?: Record<string, unknown>;
    stackTrace?: string;
    sourceUrl?: string;
    branch?: string;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO failed_imports (
          import_id, namespace, slug, error_type, error_message,
          error_details, stack_trace, source_url, branch, notified
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        params.importId ?? null,
        params.namespace,
        params.slug,
        params.errorType,
        params.errorMessage,
        params.errorDetails ? JSON.stringify(params.errorDetails) : null,
        params.stackTrace ?? null,
        params.sourceUrl ?? null,
        params.branch ?? null,
        false,
      )
      .run();

    logger.info("Failed import stored", {
      importId: params.importId,
      namespace: params.namespace,
      slug: params.slug,
      errorType: params.errorType,
    });
  } catch (error) {
    logger.error(
      "Failed to store failed import record",
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Send failure notification email.
 *
 * Recipients: the user who triggered the import (when known), plus an admin
 * copy (ADMIN_EMAIL, falling back to EMAIL_FROM_ADDRESS) — kept deliberately so
 * operators still see import failures across all users.
 */
async function sendFailureNotification(
  env: Env,
  params: {
    namespace: string;
    slug: string;
    errorType: string;
    errorMessage: string;
    /** Email address of the user who triggered the import, when known. */
    initiatorEmail?: string;
  },
  logger: Logger,
): Promise<void> {
  if (!env.EMAIL) {
    logger.debug("Email binding not available, skipping notification");
    return;
  }

  const recipients = new Set<string>();
  if (params.initiatorEmail) {
    recipients.add(params.initiatorEmail);
  }
  const adminAddress = env.ADMIN_EMAIL ?? env.EMAIL_FROM_ADDRESS;
  if (adminAddress) {
    recipients.add(adminAddress);
  }

  if (recipients.size === 0) {
    logger.debug("No notification recipients configured, skipping notification");
    return;
  }

  const fromAddress = env.EMAIL_FROM_ADDRESS ?? "alerts@stratum.dev";
  const projectPath = `${params.namespace}/${params.slug}`;

  // Escape all dynamic content for HTML
  const safeProjectPath = escapeHtml(projectPath);
  const safeErrorType = escapeHtml(params.errorType);
  const safeErrorMessage = escapeHtml(params.errorMessage);

  const message: Omit<EmailMessage, "to"> = {
    from: { email: fromAddress, name: "Stratum Alerts" },
    subject: `[Stratum] Import Failed: ${projectPath}`,
    text: `Import failed for ${projectPath}\n\nError Type: ${params.errorType}\nError: ${params.errorMessage}\n\nTime: ${new Date().toISOString()}`,
    html: `
      <h2>Import Failed</h2>
      <p><strong>Project:</strong> ${safeProjectPath}</p>
      <p><strong>Error Type:</strong> ${safeErrorType}</p>
      <p><strong>Error:</strong> ${safeErrorMessage}</p>
      <p><strong>Time:</strong> ${new Date().toISOString()}</p>
      <hr>
      <p><em>This is an automated alert from Stratum.</em></p>
    `,
  };

  for (const toAddress of recipients) {
    // The admin address is operator configuration, but the initiator's is a
    // user's own email — logging it copies PII into log storage. The type is
    // all the log needs to tell the two deliveries apart.
    const recipientType = toAddress === adminAddress ? "admin" : "initiator";
    try {
      await env.EMAIL.send({ ...message, to: toAddress });
      logger.info("Failure notification sent", {
        recipientType,
        namespace: params.namespace,
        slug: params.slug,
      });
    } catch (error) {
      logger.error(
        "Failed to send failure notification",
        error instanceof Error ? error : undefined,
        { recipientType, namespace: params.namespace, slug: params.slug },
      );
    }
  }
}
/**
 * Reduce an import failure to a stable, coarse error type.
 *
 * The failures arrive as free-form messages from GitHub, Artifacts and git, so
 * the raw text is useless for grouping. This tag is what the stored import
 * record and the failure notification key off, which is why every new terminal
 * failure mode (submodule rejection included) needs a branch here rather than
 * falling into `UNKNOWN_ERROR` and becoming invisible in aggregate.
 */
function classifyError(error: Error): string {
  const message = error.message.toLowerCase();

  if (message.includes("network") || message.includes("fetch") || message.includes("connection")) {
    return "NETWORK_ERROR";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "TIMEOUT";
  }
  if (
    message.includes("authentication") ||
    message.includes("unauthorized") ||
    message.includes("403")
  ) {
    return "AUTH_ERROR";
  }
  if (message.includes("not found") || message.includes("404")) {
    return "NOT_FOUND";
  }
  if (message.includes("rate limit") || message.includes("429")) {
    return "RATE_LIMITED";
  }
  if (message.includes("submodule")) {
    return "UNSUPPORTED_CONTENT";
  }
  if (message.includes("disk") || message.includes("quota") || message.includes("space")) {
    return "STORAGE_ERROR";
  }
  if (message.includes("git") || message.includes("clone") || message.includes("repository")) {
    return "GIT_ERROR";
  }
  if (message.includes("cancel")) {
    return "CANCELLED";
  }

  return "UNKNOWN_ERROR";
}

/**
 * The single place a terminal import failure is turned into everything the
 * outside world sees: the log line, the metric, the stored failure record, and
 * the email to the person who started it.
 *
 * Every failing path funnels through here so a new failure mode cannot ship
 * with only some of those effects — most easily by forgetting `initiatedBy`,
 * which leaves the user who triggered the import waiting on a notification
 * that only ever reached the instance admin.
 */
async function handleImportFailure(
  env: Env,
  params: {
    importId: string;
    namespace: string;
    slug: string;
    githubUrl: string;
    branch: string;
    error: Error;
    startedAt: number;
    isSync?: boolean;
    /** User id of the account that triggered the import, for notification routing. */
    initiatedBy?: string;
  },
): Promise<void> {
  const {
    importId,
    namespace,
    slug,
    githubUrl,
    branch,
    error,
    startedAt,
    isSync = false,
    initiatedBy,
  } = params;

  const errorType = classifyError(error);
  const duration = Date.now() - startedAt;
  const operation = isSync ? "sync" : "import";

  // Log detailed error
  logger.error(`${operation} failed for ${namespace}/${slug}`, error, {
    importId,
    namespace,
    slug,
    errorType,
    duration,
    githubUrl,
    branch,
  });

  // Record metric
  await recordImportFailed(env.DB, namespace, slug, errorType, logger);

  // Store failed import details
  await storeFailedImport(env, {
    importId,
    namespace,
    slug,
    errorType,
    errorMessage: error.message,
    errorDetails: {
      githubUrl,
      branch,
      duration,
      attempts: 1, // Could be tracked from queue message
    },
    stackTrace: error.stack,
    sourceUrl: githubUrl,
    branch,
  });

  // Send notification (if not a cancellation)
  if (errorType !== "CANCELLED") {
    // Resolve the triggering user's email so the notification reaches the
    // person who started the import — not only the instance admin.
    let initiatorEmail: string | undefined;
    if (initiatedBy) {
      try {
        const { getUser } = await import("../storage/users");
        const userResult = await getUser(env.DB, initiatedBy, logger);
        if (userResult.success) {
          initiatorEmail = userResult.data.email;
        } else {
          logger.warn("Could not resolve import initiator for failure notification", {
            initiatedBy,
            namespace,
            slug,
          });
        }
      } catch (lookupError) {
        logger.warn("Initiator lookup failed for failure notification", {
          initiatedBy,
          error: lookupError instanceof Error ? lookupError.message : String(lookupError),
        });
      }
    }

    await sendFailureNotification(
      env,
      {
        namespace,
        slug,
        errorMessage: error.message,
        errorType,
        ...(initiatorEmail !== undefined ? { initiatorEmail } : {}),
      },
      logger,
    );
  }
}
