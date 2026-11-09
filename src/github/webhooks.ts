/**
 * GitHub Webhook Handler
 * Processes GitHub webhook events for bidirectional sync
 */

import { Hono } from "hono";
import { applyExternalChangesRequested } from "../storage/change-reviews";
import {
  createChange,
  getChangeByGitHubBranch,
  recordGithubPrLink,
  updateChangeStatus,
} from "../storage/changes";
import { getProjectByGitHubRepo } from "../storage/github-bridge";
import {
  type InstallationEventFacts,
  deleteInstallation,
  setInstallationSuspended,
  upsertInstallation,
} from "../storage/github-installations";
import { createImportJob, getLatestImportDepth } from "../storage/imports";
import { isPushMirrorEnabled } from "../storage/push-mirrors";
import { getWorkspace } from "../storage/state";
import { getSyncStatus, setSyncInProgress } from "../storage/sync";
import { type Env, projectDefaultBranch } from "../types";
import { type Logger, createLogger } from "../utils/logger";
import { DEFAULT_CLONE_DEPTH } from "../utils/validation";
import { invalidateInstallationCache } from "./app-auth";

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
 * The GitHub App installation a signed event came through, if any. Events
 * from a plain repository webhook carry none; then only the operator's owner
 * binding can route them.
 */
function eventInstallationId(payload: { installation?: { id?: unknown } }): number | undefined {
  const id = payload.installation?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
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
    installation?: { id?: unknown };
  },
  logger: Logger,
): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const branch = payload.ref.replace("refs/heads/", "");
  const commitSha = payload.after;

  logger.info("Processing GitHub push event", { owner, repo, branch, commitSha });

  const projectResult = await getProjectByGitHubRepo(
    env,
    owner,
    repo,
    eventInstallationId(payload),
    logger,
  );
  if (!projectResult.success) {
    logger.debug("No authorized Stratum project for repo", { owner, repo });
    return;
  }

  const project = projectResult.data;

  // Forge mode (#417): a project that mirrors TO this repository does not sync
  // FROM it. Its own mirror pushes arrive here as push events, and so would a
  // commit someone made directly on GitHub — which is divergence for the
  // mirror to report, not history for a webhook to pull in unreviewed.
  if (await isPushMirrorEnabled(env.DB, logger, project.id)) {
    logger.debug("Project mirrors to this repo; skipping webhook-triggered sync", {
      projectId: project.id,
    });
    return;
  }

  // Resolve once, up front: the guard and the queued job must agree on which
  // branch is "default". Comparing against the raw sourceDefaultBranch while
  // queueing projectDefaultBranch(project) meant a project whose branch comes
  // from githubDefaultBranch — an import that never set sourceDefaultBranch —
  // had every push to its real default rejected here, so webhook-triggered
  // sync never ran for it.
  const sourceBranch = projectDefaultBranch(project);

  if (branch !== sourceBranch) {
    logger.debug("Push to non-default branch, skipping sync", {
      branch,
      defaultBranch: sourceBranch,
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
  const sourceUrl = project.sourceUrl ?? project.remote;
  // The depth the project was actually imported at, replacing a hardcoded 10.
  // Read before the enqueue (and before the job below is created, which would
  // otherwise become the "most recent" job this reads back).
  //
  // Reaches the FALLBACK FULL IMPORT only — the branch `syncOrImportProject`
  // takes for a project with no parseable Artifacts remote. The incremental
  // fetch every established project takes ignores this and uses its own
  // SYNC_FETCH_DEPTH window. Still worth carrying: the fallback re-imports the
  // whole project, so a wrong depth there is exactly where it is costly.
  const syncDepth =
    (await getLatestImportDepth(env.DB, project.namespace, project.slug, logger)) ??
    DEFAULT_CLONE_DEPTH;

  // Enqueue FIRST — only write state flags after a successful send().
  const { queueSyncJob } = await import("../queue/import-queue");
  await queueSyncJob(env.IMPORT_QUEUE, {
    importId,
    projectId: project.id,
    namespace: project.namespace,
    slug: project.slug,
    githubUrl: sourceUrl,
    branch: sourceBranch,
    depth: syncDepth,
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
      depth: syncDepth,
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
    installation?: { id?: unknown };
  },
  logger: Logger,
): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.number;
  const action = payload.action;
  const pr = payload.pull_request;

  logger.info("Processing GitHub PR event", { owner, repo, prNumber, action });

  const projectResult = await getProjectByGitHubRepo(
    env,
    owner,
    repo,
    eventInstallationId(payload),
    logger,
  );
  if (!projectResult.success) {
    logger.debug("No authorized Stratum project for repo", { owner, repo });
    return;
  }

  const project = projectResult.data;

  if (action === "opened" || action === "synchronize") {
    const existing = await getChangeByGitHubBranch(env.DB, logger, project.id, pr.head.ref);

    if (existing) {
      // Idempotent update of head SHA. Link-only: re-writing the status read
      // above would be held back if a run began since, dropping the link.
      await recordGithubPrLink(env.DB, logger, existing.id, {
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

      // Record the change author so the merge gate can exclude their own
      // approval (SA-2). The acting identity is not in the webhook payload —
      // GitHub names the PR author, who need not be a Stratum user — but the
      // workspace this PR tracks was created in Stratum by someone, and
      // WorkspaceEntry.createdByUserId is the same "user, or an agent's owner"
      // principal the API path records. Without it these changes carry a NULL
      // author, no approval is excluded, and the self-approval bypass this
      // guard exists to close stays open on every webhook-created change.
      const workspaceAuthor = workspaceResult.data.createdByUserId;
      const createResult = await createChange(env.DB, logger, {
        project: project.id,
        projectId: project.id,
        workspace: pr.head.ref,
        ...(workspaceAuthor !== undefined ? { createdByUserId: workspaceAuthor } : {}),
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
    installation?: { id?: unknown };
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

  const projectResult = await getProjectByGitHubRepo(
    env,
    owner,
    repo,
    eventInstallationId(payload),
    logger,
  );
  if (!projectResult.success) {
    logger.debug("No authorized Stratum project for repo", { owner, repo });
    return;
  }

  const project = projectResult.data;
  const existing = await getChangeByGitHubBranch(env.DB, logger, project.id, headRef);
  if (!existing) {
    logger.debug("No Change found for reviewed PR branch", { branch: headRef });
    return;
  }

  // A GitHub "approved" review must NOT move a Change into a mergeable state.
  // The reviewer is an arbitrary GitHub identity with no mapping to an authorized
  // Stratum human, so honoring it would let a GitHub review satisfy the
  // human-only approval invariant (approvals are recorded as change_reviews rows
  // attributed to verified Stratum users, never inferred from GitHub). Approval
  // is informational here; only the restrictive "changes_requested" signal —
  // which can block but never enable a merge — updates status.
  if (reviewState !== "changes_requested") {
    logger.debug("GitHub review does not change Stratum status", { reviewState });
    return;
  }

  const marked = await updateChangeStatus(env.DB, logger, existing.id, "needs_changes");
  if (!marked.success && marked.error.code === "EVALUATION_PENDING") {
    // A pending run owns the status. Flag the change instead, so the run's
    // verdict lands on needs_changes rather than dropping this signal.
    const held = await applyExternalChangesRequested(env.DB, logger, existing.id);
    // Throw rather than return: the route records a thrown delivery with
    // trackWebhookFailure, so a lost signal is visible to monitoring instead
    // of acknowledged as handled.
    if (!held.success) throw held.error;
    logger.info("GitHub changes-requested review held for the pending evaluation", {
      changeId: existing.id,
      status: held.data,
    });
    return;
  }
  if (!marked.success) {
    logger.warn("GitHub changes-requested review not applied", {
      changeId: existing.id,
      code: marked.error.code,
    });
    return;
  }
  logger.info("Marked Change needs_changes from GitHub changes-requested review", {
    changeId: existing.id,
    reviewState,
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

interface InstallationRepo {
  full_name?: unknown;
}

function repoFullNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((repo: InstallationRepo) => repo?.full_name)
    .filter((name): name is string => typeof name === "string");
}

/** Narrows the parts of an installation event payload this handler trusts. */
function installationFacts(
  eventType: string,
  data: Record<string, unknown>,
): InstallationEventFacts | null {
  const installation = data.installation as
    | { id?: unknown; account?: { login?: unknown; id?: unknown; type?: unknown } }
    | undefined;
  const id = installation?.id;
  const account = installation?.account;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (
    typeof account?.login !== "string" ||
    typeof account.id !== "number" ||
    typeof account.type !== "string"
  ) {
    return null;
  }
  const sender = data.sender as { id?: unknown } | undefined;
  // Only the event that created the installation names its installer; any
  // later sender is just whoever changed it, and must not become the person
  // allowed to link it.
  const installer =
    eventType === "installation" && data.action === "created" && typeof sender?.id === "number"
      ? String(sender.id)
      : undefined;
  return {
    installationId: id,
    accountLogin: account.login,
    accountId: String(account.id),
    accountType: account.type,
    ...(installer !== undefined ? { installerGithubId: installer } : {}),
  };
}

/**
 * Keeps the installation record (migration 059) and the KV caches in step with
 * `installation` / `installation_repositories` events. These arrive through the
 * HMAC-verified endpoint, which is what lets the recorded installer serve as
 * proof of control when someone links the installation to a Stratum owner.
 *
 * Every action also invalidates KV: a stale positive or negative entry is
 * wrong either way, and a re-lookup is one cheap API call.
 */
export async function handleInstallationChange(
  env: Pick<Env, "STATE" | "DB">,
  eventType: string,
  data: Record<string, unknown>,
  logger: Logger,
): Promise<void> {
  const facts = installationFacts(eventType, data);
  const action = data.action;

  // Invalidate the KV caches FIRST, independent of the D1 write below: a
  // failed write must not leave a removed repo's cached installation id in
  // place, still steering calls to an installation that lost access to it.
  const repos = [
    ...repoFullNames(data.repositories),
    ...repoFullNames(data.repositories_added),
    ...repoFullNames(data.repositories_removed),
  ];
  // A failed invalidation must not skip the D1 write either: the installer
  // record is what the link flow reads, and GitHub does not redeliver after
  // our 200. Apply the write, then rethrow so the router records the failure.
  let invalidationFailure: { error: unknown } | undefined;
  try {
    await invalidateInstallationCache(env.STATE, {
      repoFullNames: repos,
      ...(facts ? { installationId: facts.installationId } : {}),
    });
  } catch (error) {
    invalidationFailure = { error };
  }

  if (facts) {
    const write =
      eventType === "installation" && action === "deleted"
        ? await deleteInstallation(env.DB, facts.installationId, logger)
        : await upsertInstallation(env.DB, facts, logger);
    if (!write.success) throw write.error;

    if (eventType === "installation" && (action === "suspend" || action === "unsuspend")) {
      const suspended = await setInstallationSuspended(
        env.DB,
        facts.installationId,
        action === "suspend",
        logger,
      );
      if (!suspended.success) throw suspended.error;
    }
  } else {
    logger.warn("Installation event without a usable installation/account", {
      eventType,
      action,
    });
  }
  if (invalidationFailure) throw invalidationFailure.error;

  logger.info("Processed GitHub App installation event", {
    eventType,
    action,
    installationId: facts?.installationId,
    account: facts?.accountLogin,
    repoCount: repos.length,
  });
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

      // Sent to every GitHub App without subscribing. The installation-id cache
      // in app-auth lives a day, so these are what keep it honest when the app is
      // installed, removed, suspended, or has its repository selection changed.
      case "installation":
      case "installation_repositories":
        await handleInstallationChange(c.env, eventType, data, logger);
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
