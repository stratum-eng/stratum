/**
 * Import Queue Processor
 * Handles GitHub import jobs from Cloudflare Queue for durable execution
 */

import { importFromGitHub } from "../storage/git-ops";
import { getProviderFromUrl } from "../storage/git-providers";
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
import { getArtifactsRepoName } from "../types";
import { escapeHtml } from "../utils/html";
import { type Logger, createLogger } from "../utils/logger";
import { emitEvent } from "./events";

const logger = createLogger({ component: "ImportQueue" });

// Default clone depth for imports
const DEFAULT_CLONE_DEPTH = 10;

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

  return {
    type: "github.import",
    importId: msg.importId,
    projectId: msg.projectId,
    namespace: msg.namespace,
    slug: msg.slug,
    githubUrl: msg.githubUrl,
    branch: msg.branch,
    depth: typeof msg.depth === "number" ? msg.depth : DEFAULT_CLONE_DEPTH,
    timestamp: msg.timestamp,
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
 * Process a GitHub import job
 * This is the core import logic that runs within the queue consumer
 */
async function processImportJob(
  env: Env,
  message: ImportJobMessage,
  msg: Message<ImportJobMessage>,
): Promise<void> {
  const { importId, projectId, namespace, slug, githubUrl, branch, depth } = message;
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

    // Update project with actual repo info and mark import as complete
    const updatedProject: ProjectEntry = {
      ...project,
      remote: importResult.data.remote,
      token: importResult.data.token,
      importCompleted: true,
    };

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

    // Final cancellation check before completing
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
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

    // Record completion with duration
    const duration = Date.now() - startedAt;
    await recordImportCompleted(env.DB, namespace, slug, duration, logger);

    // Write repo snapshot to KV so page loads skip git clones going forward
    await writeSnapshotFromRepo(
      env.STATE,
      { remote: updatedProject.remote, token: updatedProject.token, namespace, slug },
      logger,
    );

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

    // Check cancellation before starting
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      await recordImportCancelled(env.DB, namespace, slug, logger);
      msg.ack();
      return;
    }

    // Update status to syncing
    await updateImportStatus(env.DB, namespace, slug, "syncing", logger, "Syncing repository");

    // Perform the sync
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

      // Handle failure with logging and metrics
      await handleImportFailure(env, {
        importId,
        namespace,
        slug,
        githubUrl,
        branch,
        error: importResult.error,
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
          errorMessage: importResult.error.message,
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
        lastSyncError: importResult.error.message,
      };
      await setProject(env.STATE, updatedProject, logger);

      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Sync failed: ${importResult.error.message}`,
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

    // Update project with sync info
    const updatedProject: ProjectEntry = {
      ...project,
      remote: importResult.data.remote,
      token: importResult.data.token,
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
      { remote: updatedProject.remote, token: updatedProject.token, namespace, slug },
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
  params: Omit<ImportJobMessage, "type" | "timestamp"> & { depth?: number },
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
 * Send failure notification email
 */
async function sendFailureNotification(
  env: Env,
  params: {
    namespace: string;
    slug: string;
    errorType: string;
    errorMessage: string;
  },
  logger: Logger,
): Promise<void> {
  if (!env.EMAIL) {
    logger.debug("Email binding not available, skipping notification");
    return;
  }

  const toAddress = env.ADMIN_EMAIL ?? env.EMAIL_FROM_ADDRESS;
  if (!toAddress) {
    logger.debug("No admin email configured, skipping notification");
    return;
  }

  const fromAddress = env.EMAIL_FROM_ADDRESS ?? "alerts@stratum.dev";
  const projectPath = `${params.namespace}/${params.slug}`;

  // Escape all dynamic content for HTML
  const safeProjectPath = escapeHtml(projectPath);
  const safeErrorType = escapeHtml(params.errorType);
  const safeErrorMessage = escapeHtml(params.errorMessage);

  const message: EmailMessage = {
    to: toAddress,
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

  try {
    await env.EMAIL.send(message);
    logger.info("Failure notification sent", {
      to: toAddress,
      namespace: params.namespace,
      slug: params.slug,
    });
  } catch (error) {
    logger.error("Failed to send failure notification", error instanceof Error ? error : undefined);
  }
}
/**
 * Classify error type from error message
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
 * Handle import failure with logging, storage, and alerting
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
  },
): Promise<void> {
  const { importId, namespace, slug, githubUrl, branch, error, startedAt, isSync = false } = params;

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
    await sendFailureNotification(
      env,
      {
        namespace,
        slug,
        errorMessage: error.message,
        errorType,
      },
      logger,
    );
  }
}
