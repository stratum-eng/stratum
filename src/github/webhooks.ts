/**
 * GitHub Webhook Handler
 * Processes GitHub webhook events for bidirectional sync
 */

import { Hono } from "hono";
import { createChange, getChangeByGitHubBranch, updateChangeStatus } from "../storage/changes";
import { getProjectByGitHubRepo } from "../storage/github-bridge";
import { createImportJob } from "../storage/imports";
import { getWorkspace } from "../storage/state";
import { getSyncStatus, setSyncInProgress } from "../storage/sync";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";

const app = new Hono<{ Bindings: Env }>();

/**
 * Verify GitHub webhook signature
 */
async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBytes = hexToBytes(signature.replace("sha256=", ""));
  const expectedSig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  // Constant-time comparison to prevent timing attacks
  // Include length check in constant-time comparison to prevent length leak
  const sigArray = new Uint8Array(sigBytes);
  const expectedArray = new Uint8Array(expectedSig);
  const maxLength = Math.max(sigArray.length, expectedArray.length);

  let result = 0;
  for (let i = 0; i < maxLength; i++) {
    result |= (sigArray[i] ?? 0) ^ (expectedArray[i] ?? 0);
  }
  // Include length difference in comparison
  result |= sigArray.length ^ expectedArray.length;

  return result === 0;
}

function hexToBytes(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

/**
 * Handle push event from GitHub.
 * Enqueues a sync job when a push lands on the project's default branch.
 * Follows the same pattern as projects.ts sync endpoint for queue usage.
 */
async function handlePush(
  env: Env,
  payload: {
    repository: { owner: { login: string }; name: string };
    ref: string;
    after: string;
    pusher: { email: string };
  },
  logger: Logger,
): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const branch = payload.ref.replace("refs/heads/", "");
  const commitSha = payload.after;

  logger.info("Processing GitHub push event", { owner, repo, branch, commitSha });

  const projectResult = await getProjectByGitHubRepo(env.STATE, owner, repo, logger);
  if (!projectResult.success) {
    logger.debug("No Stratum project found for repo", { owner, repo });
    return;
  }

  const project = projectResult.data;

  if (branch !== project.sourceDefaultBranch) {
    logger.debug("Push to non-default branch, skipping sync", {
      branch,
      defaultBranch: project.sourceDefaultBranch,
    });
    return;
  }

  // De-duplicate: skip if a sync is already running for this project.
  const syncStatusResult = await getSyncStatus(env.STATE, project.namespace, project.slug, logger);
  if (syncStatusResult.success && syncStatusResult.data?.lastSyncStatus === "in_progress") {
    logger.info("Sync already in progress, skipping webhook-triggered sync", {
      projectId: project.id,
    });
    return;
  }

  if (!env.IMPORT_QUEUE) {
    logger.warn("IMPORT_QUEUE not configured — webhook sync trigger skipped", {
      projectId: project.id,
      namespace: project.namespace,
      slug: project.slug,
    });
    return;
  }

  const importId = crypto.randomUUID();
  const sourceBranch = project.sourceDefaultBranch ?? "main";
  const sourceUrl = project.sourceUrl ?? project.remote;

  // Enqueue FIRST — only write state flags after a successful send().
  const { queueSyncJob } = await import("../queue/import-queue");
  await queueSyncJob(env.IMPORT_QUEUE, {
    importId,
    projectId: project.id,
    namespace: project.namespace,
    slug: project.slug,
    githubUrl: sourceUrl,
    branch: sourceBranch,
    depth: 10,
    trigger: "webhook",
  });

  // State flags written only after successful enqueue.
  await setSyncInProgress(env.STATE, project.namespace, project.slug, logger);
  await createImportJob(
    env.DB,
    {
      id: importId,
      projectId: project.id,
      namespace: project.namespace,
      slug: project.slug,
      sourceUrl,
      branch: sourceBranch,
    },
    logger,
  );

  logger.info("Sync job enqueued from GitHub push webhook", {
    projectId: project.id,
    importId,
    commitSha,
  });
}

/**
 * Handle pull request event from GitHub.
 * Maps PR open/close/merge to Stratum Change records.
 * Exported for testing.
 */
export async function handlePullRequest(
  env: Env,
  payload: {
    action: string;
    number: number;
    pull_request: {
      title: string;
      body: string;
      state: string;
      merged?: boolean;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
      user: { login: string };
    };
    repository: { owner: { login: string }; name: string };
  },
  logger: Logger,
): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.number;
  const action = payload.action;
  const pr = payload.pull_request;

  logger.info("Processing GitHub PR event", { owner, repo, prNumber, action });

  const projectResult = await getProjectByGitHubRepo(env.STATE, owner, repo, logger);
  if (!projectResult.success) {
    logger.debug("No Stratum project found for repo", { owner, repo });
    return;
  }

  const project = projectResult.data;

  if (action === "opened" || action === "synchronize") {
    const existing = await getChangeByGitHubBranch(env.DB, logger, project.id, pr.head.ref);

    if (existing) {
      // Idempotent update of head SHA
      await updateChangeStatus(env.DB, logger, existing.id, existing.status, {
        githubHeadSha: pr.head.sha,
        githubPrNumber: prNumber,
        githubPrUrl: pr.html_url,
        githubOwner: owner,
        githubRepo: repo,
        githubBranch: pr.head.ref,
      });
      logger.info("Updated head SHA on existing Change", { changeId: existing.id });
    } else {
      // Only create a Change if there's a matching workspace — never create phantom records
      const workspaceResult = await getWorkspace(env.STATE, project.id, pr.head.ref, logger);
      if (!workspaceResult.success) {
        logger.debug("No matching workspace for PR branch — skipping", {
          branch: pr.head.ref,
          projectId: project.id,
        });
        return;
      }

      const createResult = await createChange(env.DB, logger, {
        project: project.id,
        workspace: pr.head.ref,
      });
      if (!createResult.success) {
        logger.error("Failed to create Change from PR webhook", createResult.error, { prNumber });
        return;
      }

      await updateChangeStatus(env.DB, logger, createResult.data.id, "open", {
        githubHeadSha: pr.head.sha,
        githubPrNumber: prNumber,
        githubPrUrl: pr.html_url,
        githubOwner: owner,
        githubRepo: repo,
        githubBranch: pr.head.ref,
      });
      logger.info("Created Change from PR webhook", { changeId: createResult.data.id, prNumber });
    }
    return;
  }

  if (action === "closed") {
    const existing = await getChangeByGitHubBranch(env.DB, logger, project.id, pr.head.ref);
    if (!existing) {
      logger.debug("No Change found for closed PR branch", { branch: pr.head.ref });
      return;
    }

    const newStatus = pr.merged ? "merged" : "rejected";
    await updateChangeStatus(env.DB, logger, existing.id, newStatus, {
      githubPrState: "closed",
      ...(pr.merged ? { mergedAt: new Date().toISOString() } : {}),
    });
    logger.info("Updated Change status from PR close", {
      changeId: existing.id,
      newStatus,
      merged: pr.merged,
    });
    return;
  }

  logger.debug("Unhandled PR action", { action, prNumber });
}

/**
 * Handle pull request review event from GitHub.
 * Maps review states to Stratum Change statuses.
 * Exported for testing.
 */
export async function handlePullRequestReview(
  env: Env,
  payload: {
    action: string;
    pull_request: { number: number; head: { ref: string } };
    review: { state: string; user: { login: string } };
    repository: { owner: { login: string }; name: string };
  },
  logger: Logger,
): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const reviewState = payload.review.state;
  const reviewer = payload.review.user.login;
  const headRef = payload.pull_request.head.ref;

  logger.info("Processing GitHub PR review", { owner, repo, prNumber, reviewState, reviewer });

  if (reviewState === "dismissed" || reviewState === "commented") {
    logger.debug("No status change for review state", { reviewState });
    return;
  }

  const projectResult = await getProjectByGitHubRepo(env.STATE, owner, repo, logger);
  if (!projectResult.success) {
    logger.debug("No Stratum project found for repo", { owner, repo });
    return;
  }

  const project = projectResult.data;
  const existing = await getChangeByGitHubBranch(env.DB, logger, project.id, headRef);
  if (!existing) {
    logger.debug("No Change found for reviewed PR branch", { branch: headRef });
    return;
  }

  let newStatus: "accepted" | "needs_changes" | undefined;
  if (reviewState === "approved") {
    newStatus = "accepted";
  } else if (reviewState === "changes_requested") {
    newStatus = "needs_changes";
  }

  if (!newStatus) {
    logger.debug("Unhandled review state", { reviewState });
    return;
  }

  await updateChangeStatus(env.DB, logger, existing.id, newStatus);
  logger.info("Updated Change status from PR review", {
    changeId: existing.id,
    reviewState,
    newStatus,
  });
}

/**
 * Track webhook failure for monitoring
 */
async function trackWebhookFailure(
  kv: KVNamespace,
  eventType: string,
  deliveryId: string,
  error: string,
): Promise<void> {
  const key = `webhook_failure:${Date.now()}:${deliveryId}`;
  await kv.put(
    key,
    JSON.stringify({ eventType, deliveryId, error, timestamp: Date.now() }),
    { expirationTtl: 604800 }, // 7 day retention
  );

  // Also increment failure counter for this event type
  const counterKey = `webhook_failures:${eventType}:${new Date().toISOString().slice(0, 10)}`; // Daily counter
  const current = Number.parseInt((await kv.get(counterKey)) ?? "0");
  await kv.put(counterKey, String(current + 1), { expirationTtl: 604800 });
}

// POST /api/webhooks/github - Main webhook endpoint
app.post("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const signature = c.req.header("x-hub-signature-256");
  const eventType = c.req.header("x-github-event");
  const deliveryId = c.req.header("x-github-delivery");

  if (!signature || !eventType || !deliveryId) {
    logger.warn("Missing required GitHub webhook headers");
    return c.json({ error: "Missing required headers" }, 400);
  }

  // Get webhook secret from environment
  const webhookSecret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("GitHub webhook secret not configured");
    return c.json({ error: "Webhook not configured" }, 501);
  }

  // Get raw payload for signature verification
  const payload = await c.req.text();

  // Verify signature
  const isValid = await verifyWebhookSignature(payload, signature, webhookSecret);
  if (!isValid) {
    logger.warn("Invalid webhook signature", { deliveryId, eventType });
    return c.json({ error: "Invalid signature" }, 401);
  }

  logger.info("Received valid GitHub webhook", { eventType, deliveryId });

  // Check for duplicate delivery (idempotency)
  const deliveryKey = `webhook_delivery:${deliveryId}`;
  const existingDelivery = await c.env.STATE.get(deliveryKey);
  if (existingDelivery) {
    logger.info("Duplicate webhook delivery detected, skipping", { deliveryId });
    return c.json({ received: true, duplicate: true });
  }

  // Record delivery immediately to prevent race conditions
  await c.env.STATE.put(deliveryKey, Date.now().toString(), { expirationTtl: 86400 }); // 24 hour retention

  // Parse payload
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(payload);
  } catch {
    logger.warn("Invalid JSON payload");
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Process based on event type
  try {
    switch (eventType) {
      case "push":
        await handlePush(
          c.env,
          data as {
            repository: { owner: { login: string }; name: string };
            ref: string;
            after: string;
            pusher: { email: string };
          },
          logger,
        );
        break;

      case "pull_request":
        await handlePullRequest(
          c.env,
          data as {
            action: string;
            number: number;
            pull_request: {
              title: string;
              body: string;
              state: string;
              merged?: boolean;
              html_url: string;
              head: { ref: string; sha: string };
              base: { ref: string };
              user: { login: string };
            };
            repository: { owner: { login: string }; name: string };
          },
          logger,
        );
        break;

      case "pull_request_review":
        await handlePullRequestReview(
          c.env,
          data as {
            action: string;
            pull_request: { number: number; head: { ref: string } };
            review: { state: string; user: { login: string } };
            repository: { owner: { login: string }; name: string };
          },
          logger,
        );
        break;

      case "ping":
        logger.info("GitHub webhook ping received");
        break;

      default:
        logger.debug("Unhandled GitHub event type", { eventType });
    }

    // Return 200 quickly - processing is async
    return c.json({ received: true });
  } catch (error) {
    // Log error with full context
    logger.error("Error processing webhook", error instanceof Error ? error : undefined, {
      eventType,
      deliveryId,
    });

    // Track webhook failure for monitoring
    await trackWebhookFailure(
      c.env.STATE,
      eventType,
      deliveryId,
      error instanceof Error ? error.message : "Unknown error",
    );

    // Still return 200 to prevent GitHub from retrying
    return c.json({ received: true, error: "Processing error logged" });
  }
});

export { app as githubWebhookRouter };
