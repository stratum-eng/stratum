/**
 * GitHub Webhook Handler
 * Processes GitHub webhook events for bidirectional sync
 */

import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { getProjectByGitHubRepo } from "../storage/github-bridge";
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
 * Handle push event from GitHub
 */
async function handlePush(
  _db: D1Database,
  kv: KVNamespace,
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

  // Find the corresponding Stratum project
  const projectResult = await getProjectByGitHubRepo(kv, owner, repo, logger);
  if (!projectResult.success) {
    logger.debug("No Stratum project found for repo", { owner, repo });
    return;
  }

  const project = projectResult.data;

  // Only sync if this is the default branch
  if (branch !== project.sourceDefaultBranch) {
    logger.debug("Push to non-default branch, skipping sync", {
      branch,
      defaultBranch: project.sourceDefaultBranch,
    });
    return;
  }

  // TODO: Trigger sync via queue
  logger.info("GitHub push detected, would trigger sync", { projectId: project.id, commitSha });
}

/**
 * Handle pull request event from GitHub
 */
async function handlePullRequest(
  _db: D1Database,
  kv: KVNamespace,
  payload: {
    action: string;
    number: number;
    pull_request: {
      title: string;
      body: string;
      state: string;
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

  logger.info("Processing GitHub PR event", { owner, repo, prNumber, action });

  // Find the corresponding Stratum project
  const projectResult = await getProjectByGitHubRepo(kv, owner, repo, logger);
  if (!projectResult.success) {
    logger.debug("No Stratum project found for repo", { owner, repo });
    return;
  }

  const project = projectResult.data;
  const pr = payload.pull_request;

  // TODO: Implement workspace lookup from branch and user mapping
  // For now, we log that this would sync PR to Change
  logger.info("Would sync GitHub PR to Stratum Change", {
    projectId: project.id,
    prNumber,
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
  });
}

/**
 * Handle pull request review event from GitHub
 */
async function handlePullRequestReview(
  _db: D1Database,
  _kv: KVNamespace,
  payload: {
    action: string;
    pull_request: { number: number };
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

  logger.info("Processing GitHub PR review", { owner, repo, prNumber, reviewState, reviewer });

  // TODO: Update evaluation/approval status in Stratum
  // This would integrate with the approval workflow
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
          c.env.DB,
          c.env.STATE,
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
          c.env.DB,
          c.env.STATE,
          data as {
            action: string;
            number: number;
            pull_request: {
              title: string;
              body: string;
              state: string;
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
          c.env.DB,
          c.env.STATE,
          data as {
            action: string;
            pull_request: { number: number };
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
