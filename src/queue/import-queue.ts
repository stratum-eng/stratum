/**
 * Import Queue Processor
 * Handles GitHub import jobs from Cloudflare Queue for durable execution
 */

import { importFromGitHub } from "../storage/git-ops";
import {
  createImportJob,
  getImportProgress,
  updateImportProgress,
  updateImportStatus,
  deleteImportJob,
  isImportCancelled,
} from "../storage/imports";
import { getProjectByPath, setProject } from "../storage/state";
import type { ImportJobMessage, SyncJobMessage, ProjectEntry, Env } from "../types";
import type { Message, MessageBatch } from "../types";
import { getArtifactsRepoName } from "../types";
import { createLogger } from "../utils/logger";

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
 */
function validateSyncMessage(body: unknown): SyncJobMessage | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const msg = body as Record<string, unknown>;

  if (msg.type !== "github.sync") {
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

  try {
    new URL(msg.githubUrl);
  } catch {
    return null;
  }

  return {
    type: "github.sync",
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
 * Helper to check for import cancellation and handle cleanup
 */
async function checkAndHandleCancellation(
  env: Env,
  namespace: string,
  slug: string
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
      "Import cancelled by user"
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
  msg: Message<ImportJobMessage>
): Promise<void> {
  const { importId, projectId, namespace, slug, githubUrl, branch, depth } = message;
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);

  logger.info("Processing import job", { importId, namespace, slug, githubUrl });

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
      msg.ack();
      return;
    }

    // Update status to cloning
    await updateImportStatus(env.DB, namespace, slug, "cloning", logger, "Cloning repository");

    // Check cancellation after status update
    if (await checkAndHandleCancellation(env, namespace, slug)) {
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
      depth
    );

    if (!importResult.success) {
      // Check if it was cancelled during the operation
      if (await checkAndHandleCancellation(env, namespace, slug)) {
        msg.ack();
        return;
      }

      logger.error("Import failed", importResult.error, { namespace, slug });
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Import failed: ${importResult.error.message}`
      );
      msg.ack();
      return;
    }

    // Check cancellation before updating project
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      msg.ack();
      return;
    }

    // Update project with actual repo info
    const updatedProject: ProjectEntry = {
      ...project,
      remote: importResult.data.remote,
      token: importResult.data.token,
    };

    const setResult = await setProject(env.STATE, updatedProject, logger);
    if (!setResult.success) {
      logger.error("Failed to update project after import", setResult.error);
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Failed to update project: ${setResult.error.message}`
      );
      msg.ack();
      return;
    }

    // Final cancellation check before completing
    if (await checkAndHandleCancellation(env, namespace, slug)) {
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
      "Import completed successfully"
    );

    logger.info("Import completed successfully", { importId, namespace, slug });
    msg.ack();
  } catch (error) {
    logger.error("Unexpected error in import job", error instanceof Error ? error : undefined, {
      importId,
      namespace,
      slug,
    });

    // Check if this was a cancellation
    const wasCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
    if (wasCancelled) {
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "cancelled",
        logger,
        "Import cancelled"
      );
      await deleteImportJob(env.DB, namespace, slug, logger);
    } else {
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Import failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Retry on unexpected errors (up to queue's max_retries)
    msg.retry();
  }
}

/**
 * Process a GitHub sync job (re-sync existing project)
 */
async function processSyncJob(
  env: Env,
  message: SyncJobMessage,
  msg: Message<SyncJobMessage>
): Promise<void> {
  const { importId, namespace, slug, githubUrl, branch, depth } = message;
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);

  logger.info("Processing sync job", { importId, namespace, slug, githubUrl });

  try {
    // Verify the project exists
    const projectResult = await getProjectByPath(env.STATE, namespace, slug, logger);
    if (!projectResult.success || !projectResult.data) {
      logger.error("Project not found for sync", undefined, { namespace, slug });
      msg.ack();
      return;
    }

    // Check cancellation before starting
    if (await checkAndHandleCancellation(env, namespace, slug)) {
      msg.ack();
      return;
    }

    // Update status to cloning
    await updateImportStatus(env.DB, namespace, slug, "cloning", logger, "Syncing repository");

    // Perform the sync
    const importResult = await importFromGitHub(
      env.ARTIFACTS,
      artifactsRepoName,
      githubUrl,
      logger,
      branch,
      depth
    );

    if (!importResult.success) {
      logger.error("Sync failed", importResult.error, { namespace, slug });
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Sync failed: ${importResult.error.message}`
      );
      msg.ack();
      return;
    }

    // Mark sync as complete
    await updateImportStatus(
      env.DB,
      namespace,
      slug,
      "completed",
      logger,
      "Sync completed successfully"
    );

    logger.info("Sync completed successfully", { importId, namespace, slug });
    msg.ack();
  } catch (error) {
    logger.error("Unexpected error in sync job", error instanceof Error ? error : undefined, {
      importId,
      namespace,
      slug,
    });

    const wasCancelled = await isImportCancelled(env.DB, namespace, slug, logger);
    if (wasCancelled) {
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "cancelled",
        logger,
        "Sync cancelled"
      );
      await deleteImportJob(env.DB, namespace, slug, logger);
    } else {
      await updateImportStatus(
        env.DB,
        namespace,
        slug,
        "failed",
        logger,
        `Sync failed: ${error instanceof Error ? error.message : String(error)}`
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
  env: Env
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
  params: Omit<ImportJobMessage, "type" | "timestamp"> & { depth?: number }
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
  logger.info("Import job queued", { importId: params.importId, namespace: params.namespace, slug: params.slug });
}

/**
 * Send a sync job to the queue
 */
export async function queueSyncJob(
  queue: Queue<SyncJobMessage> | undefined,
  params: Omit<SyncJobMessage, "type" | "timestamp"> & { depth?: number }
): Promise<void> {
  if (!queue) {
    throw new Error("IMPORT_QUEUE not configured");
  }

  const message: SyncJobMessage = {
    type: "github.sync",
    importId: params.importId,
    projectId: params.projectId,
    namespace: params.namespace,
    slug: params.slug,
    githubUrl: params.githubUrl,
    branch: params.branch,
    depth: params.depth ?? DEFAULT_CLONE_DEPTH,
    timestamp: new Date().toISOString(),
  };

  await (queue as Queue<SyncJobMessage | ImportJobMessage>).send(message);
  logger.info("Sync job queued", { importId: params.importId, namespace: params.namespace, slug: params.slug });
}
