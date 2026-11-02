/**
 * Runs post-merge deployments: one queue message in, terminal `deployments`
 * rows out.
 *
 * Four properties of this module are load bearing.
 *
 * **The tree is read once, at the pinned merge commit, and the policy is parsed
 * out of those same bytes.** `loadPolicy` takes a branch, not a ref, so using it
 * here would let a *newer* policy apply to an *older* tree: land a benign
 * change, land a policy change, and the first change's still-queued deploy picks
 * up the second policy. Reading at the commit makes config and code provably one
 * commit, and costs nothing extra because the files are what gets uploaded.
 *
 * **`skipped` means exactly one thing: no deploy was configured.** A missing
 * secret, an unset `DEPLOY_SECRET_KEY`, an undecryptable value, an unreadable
 * tree, a rejected `deploys:` entry, a provider error — every one of those is
 * `failed` with a reason naming the cause. Reporting an operator error as a calm
 * grey state is failing open on something that stops production updating.
 *
 * **Everything is scoped on `projectId`, and a message without one is refused.**
 * Project names are not globally unique, so resolving one by name would hand a
 * deploy another tenant's credentials (see `webhookBelongsToProject`).
 *
 * **Every path that claims a row writes a terminal status in a `finally`.** A
 * row left `running` with no lease is a deployment nobody finishes and nobody
 * can retry.
 *
 * `readFiles`, `now` and `fetch` are injected for the reason `SandboxEvaluator`
 * injects its own seams: without them, testing any of the above needs a real git
 * remote, a real clock, and a real provider account.
 */
import { parsePolicyContent } from "../evaluation/policy-loader";
import type { DeployConfig, DeployRejection } from "../evaluation/types";
import { type StratumEvent, emitEvent } from "../queue/events";
import { getChange } from "../storage/changes";
import { recordCosts } from "../storage/costs";
import { isTargetDeleting } from "../storage/deletion";
import {
  type Deployment,
  type DeploymentStatus,
  type DeploymentTarget,
  SUPERSEDED_REASON,
  type TerminalDeploymentStatus,
  UNRESOLVED_TARGET,
  claimDeployment,
  completeDeployment,
  findNewerSucceededDeployment,
  getDeployment,
  insertDeployment,
  isIsoTimestamp,
  supersedeOlder,
} from "../storage/deployments";
import { freshRepoToken, readRepoFiles } from "../storage/git-ops";
import { DEPLOY_SECRET_KEY_MISSING, loadSecretValues } from "../storage/project-secrets";
import { getProjectById } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import { projectDefaultBranch } from "../types";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { DEPLOY_ATTEMPT_DEADLINE_MS } from "./limits";
import { redactAndTruncate } from "./redact";
import { type DeployFetch, getDeployTarget } from "./targets/index";

/**
 * What the `stratum-deploys` queue carries. Two shapes, discriminated on `kind`.
 *
 * - `merge` fans out: the runner reads the tree at `commitSha`, parses the
 *   policy from it, creates one row per declared deploy, and runs the ones that
 *   need no approval.
 * - `deployment` runs one row that already exists. This is what the approve and
 *   retry routes enqueue — they have already decided *which* deployment, and
 *   re-deriving it from the policy could pick a different set.
 *
 * `projectId` is on both because it is the only tenant scope this runner
 * accepts; see the fail-closed check in {@link runDeployMessage}.
 */
export type DeployQueueMessage =
  | {
      kind: "merge";
      projectId: string;
      changeId: string;
      commitSha: string;
      /**
       * When the merge happened, ISO 8601 — **not** when this message is
       * processed. It is carried on the message because the queue is the one
       * place the two can diverge: Cloudflare Queues promise no ordering and a
       * retry reorders outright, so deriving order from processing time let
       * merge A, delivered after merge B, sort *newer* than B and publish the
       * older commit over it. Stamped by `enqueueMergeDeploy` from the change's
       * own `merged_at`.
       *
       * Optional only for compatibility: see {@link mergeTimeOf}.
       */
      mergedAt?: string;
    }
  | { kind: "deployment"; projectId: string; deploymentId: string };

/**
 * Reads a repo tree into path → raw bytes at a pinned commit. Injectable so a
 * test never touches git; `readRepoFiles` is the production implementation.
 *
 * `ref` is the commit and is required here, unlike on `readRepoFiles` itself:
 * the whole point of this runner is that it never reads a branch tip.
 */
export type DeployFilesReader = (
  remote: string,
  token: string,
  logger: Logger,
  ref: string,
  branch: string,
) => Promise<Result<Map<string, Uint8Array>, AppError>>;

/** The seams a test replaces. Every one defaults to the production implementation. */
export interface DeployRunnerDeps {
  readFiles?: DeployFilesReader;
  now?: () => number;
  fetch?: DeployFetch;
  /**
   * Wall-clock budget for one deployment attempt. Defaults to
   * {@link DEPLOY_ATTEMPT_DEADLINE_MS}; a test shortens it rather than waiting
   * ten minutes for a provider that never answers.
   */
  deadlineMs?: number;
}

/** One deployment row this run touched, for the queue consumer's log. */
export interface DeployRunRecord {
  deploymentId: string;
  name: string;
  /** The status this run believes the row now holds. */
  status: DeploymentStatus;
  reason?: string;
  url?: string;
}

/** Everything one queue message produced. */
export interface DeployRunSummary {
  /** Rows created or completed, in the order they were handled. */
  deployments: DeployRunRecord[];
  /**
   * Why the message was abandoned before any deploy ran, when it was. Present
   * on a reverted change, a deleting project, and a message with no
   * `projectId` — none of which are retryable, so the consumer should ack.
   */
  aborted?: string;
}

/**
 * Name for a row that is not tied to a declared deploy entry: a policy that
 * could not be parsed, a tree that could not be read, or a merge with nothing
 * configured. The parentheses put it outside `^[a-z][a-z0-9-]{0,31}$`, so it can
 * never collide with a name a policy file is allowed to declare.
 */
const UNRESOLVED_DEPLOY_NAME = "(unresolved)";

/** Repo-relative policy files, in the order `loadPolicy` tries them. */
const POLICY_FILES = [
  { path: ".stratum/policy.yaml", format: "yaml" },
  { path: "stratum.config.json", format: "json" },
] as const;

/**
 * Longest `reason` persisted on a row. The reason is rendered in a list view, so
 * a provider that returns a wall of text must not decide how tall that row is;
 * the full payload is on `log_tail`.
 */
const MAX_REASON_LENGTH = 1_000;

/** Stamped only if something threw between the assignments in `runOneDeployment`. */
const ABANDONED_REASON = "The deploy runner exited without recording an outcome";

/** Stamped on a row whose attempt outlived the runner's wall-clock budget. */
function deadlineReason(deadlineMs: number): string {
  return `The deploy did not finish within ${Math.round(deadlineMs / 1000)}s and was abandoned before its lease could expire; retry it`;
}

const DELETING_REASON = "The project is being deleted; the deploy was not run";

const NO_PROJECT_ID_REASON =
  "The deploy message carried no projectId; refusing to resolve a project by name";

const NO_POLICY_REASON =
  "No .stratum/policy.yaml or stratum.config.json at this commit, so no deploy is configured";

const NO_DEPLOYS_REASON = "The policy at this commit declares no 'deploys:' entries";

/** Stamped on a row refused because a newer merge of the same name already shipped. */
function alreadyShippedReason(newer: Deployment): string {
  return `${SUPERSEDED_REASON}: ${shortSha(newer.commitSha)} already succeeded`;
}

const GUARD_UNREADABLE_REASON =
  "Could not check whether a newer deployment of this name already succeeded, so the deploy was not run; retry it";

/** What one deployment attempt decided to write. */
interface TerminalWrite {
  status: TerminalDeploymentStatus;
  reason?: string;
  url?: string;
  logTail?: string;
}

/** The `deploys:` half of a policy, read out of a pinned tree. */
interface TreePolicy {
  deploys: DeployConfig[];
  rejections: DeployRejection[];
  /** True when neither policy file exists at this commit. */
  absent: boolean;
}

/** Resolved once per message so no helper has to re-derive it. */
interface RunContext {
  env: Env;
  logger: Logger;
  project: ProjectEntry;
  now: () => number;
  iso: () => string;
  readFiles: DeployFilesReader;
  fetch: DeployFetch;
  deadlineMs: number;
}

/**
 * Run one deploy queue message.
 *
 * Never throws: a deploy failure is a row, not an exception. The `err` channel
 * is reserved for a fault that leaves the runner unable to say what happened —
 * the project could not be resolved, or D1 refused a write — which is the only
 * case where redelivering the message can help.
 *
 * @param deps - Test seams; every one defaults to the production implementation
 */
export async function runDeployMessage(
  env: Env,
  message: DeployQueueMessage,
  logger: Logger,
  deps: DeployRunnerDeps = {},
): Promise<Result<DeployRunSummary, AppError>> {
  const projectId = message.projectId;
  // Fail closed. Legacy event rows can carry no project id at all
  // (`src/queue/events.ts`), and the tempting fallback — resolve the project by
  // its bare name — crosses tenants, because a same-named project in another
  // account would hand this deploy someone else's credentials. Reported as an
  // abort rather than an error: no redelivery of this message can fix it.
  if (typeof projectId !== "string" || projectId.trim() === "") {
    logger.error("Deploy message has no projectId", undefined, { kind: message.kind });
    return ok({ deployments: [], aborted: NO_PROJECT_ID_REASON });
  }

  const projectResult = await getProjectById(env.STATE, projectId, logger);
  if (!projectResult.success) {
    logger.error("Could not resolve the deploy's project", projectResult.error, { projectId });
    return err(projectResult.error);
  }

  const now = deps.now ?? Date.now;
  const ctx: RunContext = {
    env,
    logger,
    project: projectResult.data,
    now,
    iso: () => new Date(now()).toISOString(),
    readFiles: deps.readFiles ?? readRepoFiles,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    deadlineMs: deps.deadlineMs ?? DEPLOY_ATTEMPT_DEADLINE_MS,
  };

  return message.kind === "merge"
    ? runMergeMessage(ctx, message)
    : runDeploymentMessage(ctx, message);
}

/**
 * The timestamp every row this merge creates is stamped with.
 *
 * Falls back to processing time when the message carries no usable `mergedAt`.
 * That fallback exists for exactly one reason: a `merge` message enqueued by the
 * previous deployment of this Worker is still in flight when this one starts
 * consuming, and it has no `mergedAt` field at all. Crashing or dropping it
 * would lose a real deploy over a schema change; stamping processing time
 * restores that single message to the pre-fix behaviour, and every message
 * enqueued afterwards carries a real merge time. It also covers a `merged_at`
 * that is not the ISO form the columns require (a legacy or imported change
 * row) — a value the storage layer would reject outright, stranding the deploy.
 *
 * @returns The merge time, and whether it came from the message or the clock
 */
function mergeTimeOf(
  ctx: RunContext,
  message: Extract<DeployQueueMessage, { kind: "merge" }>,
): string {
  if (isIsoTimestamp(message.mergedAt)) return message.mergedAt;

  ctx.logger.warn("Deploy message carries no usable merge time; ordering on processing time", {
    changeId: message.changeId,
    commitSha: message.commitSha,
    mergedAt: message.mergedAt ?? null,
  });
  return ctx.iso();
}

/** Fan a merge out into one row per declared deploy, then run the queued ones. */
async function runMergeMessage(
  ctx: RunContext,
  message: Extract<DeployQueueMessage, { kind: "merge" }>,
): Promise<Result<DeployRunSummary, AppError>> {
  const { env, logger, project } = ctx;

  if (await isTargetDeleting(env, project, logger)) {
    logger.info("Not deploying: the project is being deleted", {
      projectId: project.id,
      changeId: message.changeId,
    });
    return ok({ deployments: [], aborted: DELETING_REASON });
  }

  const guard = await changeStillDeployable(ctx, message.changeId);
  if (guard !== null) {
    logger.info("Not deploying", { changeId: message.changeId, reason: guard });
    return ok({ deployments: [], aborted: guard });
  }

  // Every row this message creates is stamped with the *merge* time, so the
  // history — and the two supersession checks that read `created_at` — order by
  // when the code merged, not by when the queue got round to this message.
  const createdAt = mergeTimeOf(ctx, message);

  const records = new Map<string, DeployRunRecord>();

  const treeResult = await readTree(ctx, message.commitSha, message.changeId);
  if (!treeResult.success) {
    // The config lives in the tree, so there is no deploy name to attach this
    // to — but staying silent would make a merge that never deployed
    // indistinguishable from one that had nothing to deploy.
    const created = await createDeployment(ctx, {
      name: UNRESOLVED_DEPLOY_NAME,
      target: UNRESOLVED_TARGET,
      commitSha: message.commitSha,
      changeId: message.changeId,
      createdAt,
      status: "failed",
      reason: `Could not read the tree at ${shortSha(message.commitSha)}: ${treeResult.error.message}`,
    });
    if (!created.success) return err(created.error);
    if (created.data) {
      records.set(created.data.id, toRecord(created.data));
      await emitDeploymentEvent(ctx, created.data, "deployment.failed", {
        reason: created.data.reason,
      });
    }
    return ok({ deployments: [...records.values()] });
  }

  const files = treeResult.data;
  const policy = policyFromTree(files, logger);

  // A rejected entry becomes a visible failed row, never a dropped one: a deploy
  // the author wrote and that never runs means production silently stopped
  // updating. See the note in `sanitizeDeploys`.
  //
  // *One row per rejection*, which is why the names are made distinct first.
  // `insertDeployment` excludes on (project, name, commit, attempt), so two
  // rejections sharing a name — two entries with no usable `name` at all, or a
  // duplicate-name pair — would collapse into one row and silently lose a
  // reason. A rejection can also collide with an *accepted* entry, because the
  // duplicate-name rule rejects the second declaration of a name the first
  // declaration is legitimately using; the accepted names are therefore claimed
  // up front, so a rejection row can never take the key the real deploy needs.
  const claimedNames = new Set(policy.deploys.map((entry) => entry.name));
  for (const rejection of policy.rejections) {
    const created = await createDeployment(ctx, {
      name: distinctName(rejection.name ?? UNRESOLVED_DEPLOY_NAME, claimedNames),
      target: UNRESOLVED_TARGET,
      commitSha: message.commitSha,
      changeId: message.changeId,
      createdAt,
      status: "failed",
      reason: rejection.reason,
    });
    if (!created.success) return err(created.error);
    if (created.data) {
      records.set(created.data.id, toRecord(created.data));
      await emitDeploymentEvent(ctx, created.data, "deployment.failed", {
        reason: created.data.reason,
      });
    }
  }

  if (policy.deploys.length === 0) {
    // `skipped` only when there is genuinely nothing configured. If entries were
    // rejected, those failures are the story and a calm grey row alongside them
    // would misreport it.
    if (policy.rejections.length === 0) {
      const created = await createDeployment(ctx, {
        name: UNRESOLVED_DEPLOY_NAME,
        target: UNRESOLVED_TARGET,
        commitSha: message.commitSha,
        changeId: message.changeId,
        createdAt,
        status: "skipped",
        reason: policy.absent ? NO_POLICY_REASON : NO_DEPLOYS_REASON,
      });
      if (!created.success) return err(created.error);
      if (created.data) records.set(created.data.id, toRecord(created.data));
    }
    return ok({ deployments: [...records.values()] });
  }

  const runnable: Array<{ deployment: Deployment; config: DeployConfig }> = [];
  for (const config of policy.deploys) {
    const status: DeploymentStatus = config.requiresApproval ? "pending_approval" : "queued";
    const created = await createDeployment(ctx, {
      name: config.name,
      target: config.target,
      commitSha: message.commitSha,
      changeId: message.changeId,
      createdAt,
      status,
    });
    if (!created.success) return err(created.error);
    // `null` means another consumer won the unique index for this exact
    // (project, name, commit, attempt) — a normal outcome, and its owner runs it.
    if (!created.data) continue;
    records.set(created.data.id, toRecord(created.data));
    await emitDeploymentEvent(ctx, created.data, "deployment.requested");
    if (status === "queued") runnable.push({ deployment: created.data, config });
  }

  // Sequential, not concurrent: these deploys share one invocation's CPU and
  // subrequest budget, and two targets uploading the same tree at once would
  // double the peak memory the Worker holds.
  for (const { deployment, config } of runnable) {
    records.set(deployment.id, await runOneDeployment(ctx, deployment, config, files));
  }

  return ok({ deployments: [...records.values()] });
}

/** Run one row that already exists — what the approve and retry routes enqueue. */
async function runDeploymentMessage(
  ctx: RunContext,
  message: Extract<DeployQueueMessage, { kind: "deployment" }>,
): Promise<Result<DeployRunSummary, AppError>> {
  const { env, logger, project } = ctx;

  const existing = await getDeployment(env.DB, logger, {
    projectId: project.id,
    deploymentId: message.deploymentId,
  });
  if (!existing.success) return err(existing.error);
  if (!existing.data) {
    // Scoped lookup: "not in this project" and "does not exist" are the same
    // answer on purpose, so a probe cannot confirm an id in another tenant.
    const aborted = `Deployment ${message.deploymentId} is not in this project`;
    logger.warn("Deploy message names an unknown deployment", {
      deploymentId: message.deploymentId,
      projectId: project.id,
    });
    return ok({ deployments: [], aborted });
  }
  const deployment = existing.data;

  if (await isTargetDeleting(env, project, logger)) {
    return ok({
      deployments: [await failWithoutRunning(ctx, deployment, DELETING_REASON)],
      aborted: DELETING_REASON,
    });
  }

  // A retry of an older commit carries no change id and there is nothing to
  // re-read; the operator picked that commit deliberately.
  if (deployment.changeId !== undefined) {
    const guard = await changeStillDeployable(ctx, deployment.changeId);
    if (guard !== null) {
      return ok({
        deployments: [await failWithoutRunning(ctx, deployment, guard)],
        aborted: guard,
      });
    }
  }

  const treeResult = await readTree(ctx, deployment.commitSha, deployment.changeId);
  if (!treeResult.success) {
    const reason = `Could not read the tree at ${shortSha(deployment.commitSha)}: ${treeResult.error.message}`;
    return ok({ deployments: [await failWithoutRunning(ctx, deployment, reason)] });
  }

  // Config comes from the pinned commit here too, so an approval granted days
  // later still deploys with the configuration the commit was reviewed under.
  const policy = policyFromTree(treeResult.data, logger);
  const config = policy.deploys.find((entry) => entry.name === deployment.name);
  if (!config) {
    const rejection = policy.rejections.find((entry) => entry.name === deployment.name);
    const reason =
      rejection?.reason ??
      `Deploy "${deployment.name}" is not declared in the policy at ${shortSha(deployment.commitSha)}`;
    return ok({ deployments: [await failWithoutRunning(ctx, deployment, reason)] });
  }

  return ok({
    deployments: [await runOneDeployment(ctx, deployment, config, treeResult.data)],
  });
}

/**
 * Claim a row and publish it, always leaving it terminal.
 *
 * Both ordering checks run *before* the claim, because two merges in quick
 * succession arrive in whatever order the queue chooses and without them the
 * older commit can be the one left in production. They are two halves of one
 * rule and neither covers the other's case:
 *
 * - {@link findNewerSucceededDeployment} refuses *this* deploy when a newer
 *   merge of the same name has already shipped. This is the half that closes
 *   the race, because by then there is nothing left for `supersedeOlder` to
 *   retire — the newer row is terminal.
 * - {@link supersedeOlder} retires the older rows that have not started yet, so
 *   a message for one of them cannot come back and publish it later.
 */
async function runOneDeployment(
  ctx: RunContext,
  deployment: Deployment,
  config: DeployConfig,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<DeployRunRecord> {
  const { env, logger, project } = ctx;

  const newer = await findNewerSucceededDeployment(env.DB, logger, {
    projectId: project.id,
    name: deployment.name,
    createdAt: deployment.createdAt,
    excludeDeploymentId: deployment.id,
  });
  if (!newer.success) {
    // Fatal, unlike the `supersedeOlder` failure below, and the asymmetry is
    // deliberate: that one only tidies stale history, while this one is the only
    // thing standing between a reordered message and an older commit going live.
    // A visible `failed` row an operator can retry is the cheaper mistake.
    logger.error("Could not check for a newer succeeded deployment", newer.error, {
      deploymentId: deployment.id,
      projectId: project.id,
    });
    return await failWithoutRunning(ctx, deployment, GUARD_UNREADABLE_REASON);
  }
  if (newer.data !== null) {
    logger.info("Not deploying: a newer commit of this deploy already succeeded", {
      deploymentId: deployment.id,
      projectId: project.id,
      name: deployment.name,
      commitSha: deployment.commitSha,
      newerDeploymentId: newer.data.id,
      newerCommitSha: newer.data.commitSha,
    });
    return await supersedeWithoutRunning(ctx, deployment, alreadyShippedReason(newer.data));
  }

  const superseded = await supersedeOlder(env.DB, logger, {
    projectId: project.id,
    name: deployment.name,
    keepDeploymentId: deployment.id,
    createdAt: deployment.createdAt,
    now: ctx.iso(),
  });
  if (!superseded.success) {
    // Not fatal. Superseding is about ordering older *queued* rows; refusing to
    // deploy because that bookkeeping failed would turn a stale history entry
    // into a production outage.
    logger.error("Could not supersede older deployments", superseded.error, {
      deploymentId: deployment.id,
      projectId: project.id,
    });
  }

  const claim = await claimDeployment(env.DB, logger, {
    projectId: project.id,
    deploymentId: deployment.id,
    now: ctx.iso(),
  });
  if (!claim.success) {
    logger.error("Could not claim the deployment", claim.error, {
      deploymentId: deployment.id,
      projectId: project.id,
    });
    return { deploymentId: deployment.id, name: deployment.name, status: deployment.status };
  }
  if (!claim.data.claimed) {
    // Someone else holds the lease, or the row is not claimable at all
    // (`pending_approval` deliberately is not). Writing a status here would
    // clobber whatever its real owner is about to write.
    logger.warn("Deployment not claimed; leaving it to its owner", {
      deploymentId: deployment.id,
      projectId: project.id,
      why: claim.data.reason,
    });
    return { deploymentId: deployment.id, name: deployment.name, status: deployment.status };
  }

  const startedAt = ctx.now();
  /**
   * Filled in by `deployOnce` the moment secrets resolve — before anything that
   * could throw with a value in hand — so the redaction in the `finally` covers
   * a thrown provider error as well as a returned one.
   */
  const secretValues: string[] = [];
  let terminal: TerminalWrite = { status: "failed", reason: ABANDONED_REASON };
  let writtenReason: string | null = null;

  /**
   * The runner's half of the lease invariant (`src/deploy/limits.ts`). The
   * attempt is abandoned strictly before `DEFAULT_DEPLOY_LEASE_MS` can elapse,
   * so "the lease expired" can only ever mean "no runner is alive" — otherwise
   * `claimDeployment` would hand this still-uploading row to a second consumer
   * and the same commit would deploy twice. The signal is threaded into the
   * provider `fetch` so the timeout actually cuts the upload off rather than
   * leaving it running behind a resolved race.
   */
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<TerminalWrite>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      resolve({ status: "failed", reason: deadlineReason(ctx.deadlineMs) });
    }, ctx.deadlineMs);
  });

  try {
    terminal = await Promise.race([
      deployOnce(ctx, claim.data.deployment, config, files, secretValues, controller.signal),
      deadline,
    ]);
  } catch (error) {
    // A target that throws — a malformed provider response, an unexpected
    // runtime fault — must still leave a terminal row. This is why the write
    // below is in a `finally` and not on the happy path.
    logger.error("Deploy threw", error instanceof Error ? error : undefined, {
      deploymentId: deployment.id,
      projectId: project.id,
    });
    terminal = {
      status: "failed",
      reason: `Deploy failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    // Left armed, this keeps the invocation alive for the rest of the budget.
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);

    // The single point where anything from a provider reaches D1, so redaction
    // goes here rather than at each producer: a payload that echoed a credential
    // cannot get past it, whichever branch produced it.
    writtenReason =
      terminal.reason === undefined
        ? null
        : redactAndTruncate(terminal.reason, secretValues, MAX_REASON_LENGTH);
    const logTail =
      terminal.logTail === undefined ? null : redactAndTruncate(terminal.logTail, secretValues);

    const completed = await completeDeployment(env.DB, logger, {
      projectId: project.id,
      deploymentId: deployment.id,
      status: terminal.status,
      reason: writtenReason,
      url: terminal.url ?? null,
      logTail,
      durationMs: Math.max(0, ctx.now() - startedAt),
      completedAt: ctx.iso(),
    });
    if (!completed.success) {
      logger.error("Could not write the deployment's terminal status", completed.error, {
        deploymentId: deployment.id,
        projectId: project.id,
      });
    }

    await emitDeploymentEvent(
      ctx,
      deployment,
      terminal.status === "succeeded" ? "deployment.succeeded" : "deployment.failed",
      {
        ...(terminal.url !== undefined ? { url: terminal.url } : {}),
        ...(writtenReason !== null ? { reason: writtenReason } : {}),
      },
    );
  }

  const record: DeployRunRecord = {
    deploymentId: deployment.id,
    name: deployment.name,
    status: terminal.status,
  };
  if (writtenReason !== null) record.reason = writtenReason;
  if (terminal.url !== undefined) record.url = terminal.url;
  return record;
}

/**
 * Resolve secrets and hand the tree to the provider. Returns what should be
 * written; never writes anything itself, so its caller's `finally` owns the row.
 */
async function deployOnce(
  ctx: RunContext,
  deployment: Deployment,
  config: DeployConfig,
  files: ReadonlyMap<string, Uint8Array>,
  secretValues: string[],
  signal: AbortSignal,
): Promise<TerminalWrite> {
  const { env, logger, project } = ctx;
  const target = getDeployTarget(config.target);

  // The policy's `secrets:` list is what the author declared; the target's own
  // names are what it actually reads. Loading the union means a policy that
  // omits `VERCEL_TOKEN` still works, while a name the author *did* declare and
  // never stored is still an error they are told about.
  const declared = config.secrets ?? [];
  const wanted = [...new Set([...declared, ...target.requiredSecrets, ...target.optionalSecrets])];

  const loaded = await loadSecretValues(env.DB, logger, env, {
    projectId: project.id,
    names: wanted,
  });
  if (!loaded.success) {
    return {
      status: "failed",
      reason:
        loaded.error.code === DEPLOY_SECRET_KEY_MISSING
          ? "DEPLOY_SECRET_KEY is not configured on this instance, so deploy secrets cannot be decrypted. Set it as a Wrangler secret and retry."
          : `Could not load deploy secrets: ${loaded.error.message}`,
    };
  }
  secretValues.push(...loaded.data.values.values());

  // Reported apart from `missing`, and before it, because the remedy is
  // different and more alarming: the ciphertext is there but will not
  // authenticate, which means DEPLOY_SECRET_KEY was rotated or the row was
  // moved. An *optional* secret counts here too — deploying without a
  // `VERCEL_TEAM_ID` that exists but cannot be read would publish to the wrong
  // account rather than fail.
  if (loaded.data.undecryptable.length > 0) {
    const names = loaded.data.undecryptable.join(", ");
    const plural = loaded.data.undecryptable.length === 1 ? "" : "s";
    return {
      status: "failed",
      reason: `Could not decrypt project secret${plural}: ${names} — DEPLOY_SECRET_KEY may have been rotated; re-enter the value${plural} in project settings`,
    };
  }

  const required = new Set([...declared, ...target.requiredSecrets]);
  const missing = loaded.data.missing.filter((name) => required.has(name));
  if (missing.length > 0) {
    const plural = missing.length === 1 ? "" : "s";
    return {
      status: "failed",
      reason: `Missing project secret${plural}: ${missing.join(", ")} — add ${missing.length === 1 ? "it" : "them"} in project settings`,
    };
  }

  const secrets: Record<string, string> = {};
  for (const [name, value] of loaded.data.values) secrets[name] = value;

  // Limits are deliberately *not* enforced here. Each target narrows the tree to
  // its own `dir` first, so `enforceLimits` has to run there or it would judge
  // bytes that are never uploaded.
  const result = await target.deploy({
    files,
    secrets,
    config,
    commitSha: deployment.commitSha,
    logger,
    // Every target reaches its provider through this one `fetch`, so attaching
    // the deadline's signal here covers all of them without a target ever
    // having to know a deadline exists.
    fetch: (url, init) => ctx.fetch(url, { ...init, signal }),
  });

  if (!result.success) {
    const failure: TerminalWrite = { status: "failed", reason: result.error.reason };
    if (result.error.logTail !== undefined) failure.logTail = result.error.logTail;
    return failure;
  }

  const success: TerminalWrite = { status: "succeeded" };
  if (result.data.url !== undefined) success.url = result.data.url;
  if (result.data.logTail !== undefined) success.logTail = result.data.logTail;

  // Honesty about asynchronous providers. Vercel answers as soon as it has
  // *accepted* the deployment (`readyState: "QUEUED"`) and builds afterwards,
  // and this runner deliberately does not poll — polling would hold a queue
  // message open for the length of someone else's build, and the visibility
  // timeout is sized for an upload, not a build. Recording that as a bare
  // `succeeded` would claim the commit is live when it may still be building,
  // so the provider's own state is carried into the reason and the row says
  // "accepted for build" rather than implying more than the provider promised.
  const detail: string[] = [];
  if (result.data.state !== undefined) {
    detail.push(
      `provider state at hand-off: ${result.data.state} (the provider finishes asynchronously; Stratum does not poll it)`,
    );
  }
  if (result.data.providerId !== undefined) {
    detail.push(`provider deployment ${result.data.providerId}`);
  }
  if (detail.length > 0) success.reason = detail.join("; ");

  return success;
}

/**
 * Why this change must not be deployed, or `null` when it may be.
 *
 * A merge can be reverted between the enqueue and this run —
 * `runPostMergeCheck` auto-reverts, and the queue promises nothing about when a
 * message is delivered — so the change's status is re-read here rather than
 * trusted from the message. Anything other than `merged` fails closed.
 */
async function changeStillDeployable(ctx: RunContext, changeId: string): Promise<string | null> {
  const result = await getChange(ctx.env.DB, ctx.logger, changeId);
  if (!result.success) {
    return `Change ${changeId} could not be read (${result.error.message}); refusing to deploy`;
  }

  const change = result.data;
  // Legacy rows carry no project id, so this can only be checked when present —
  // but when it is present and disagrees, the message is pointing across tenants.
  if (change.projectId !== undefined && change.projectId !== ctx.project.id) {
    return `Change ${changeId} belongs to a different project; refusing to deploy`;
  }
  if (change.status !== "merged") {
    return `Change ${changeId} is ${change.status}, not merged; refusing to deploy`;
  }
  return null;
}

/** Mint a read token and read the tree at the pinned commit, recording the git cost either way. */
async function readTree(
  ctx: RunContext,
  commitSha: string,
  changeId?: string,
): Promise<Result<Map<string, Uint8Array>, AppError>> {
  const { env, logger, project } = ctx;

  // Read scope: this path never pushes. Minted fresh because no token is
  // persisted and an Artifacts token is only good for about an hour.
  const token = await freshRepoToken(env.ARTIFACTS, project.remote, "read", logger);
  if (!token.success) return err(token.error);

  const files = await ctx.readFiles(
    project.remote,
    token.data,
    logger,
    commitSha,
    projectDefaultBranch(project),
  );

  // Recorded whether or not the read succeeded: a clone that failed still cost
  // the round trip.
  await recordCosts(
    env.DB,
    logger,
    {
      project: project.name,
      projectId: project.id,
      ...(changeId !== undefined ? { changeId } : {}),
    },
    [{ kind: "git_ops", quantity: 1 }],
  );

  return files;
}

/**
 * Read the `deploys:` half of the policy out of tree bytes.
 *
 * Mirrors `loadPolicy`'s file order and its refusal to fall through after a
 * *present but malformed* file: a broken policy is an answer, and reading the
 * other file instead would apply configuration the author did not think was in
 * effect. A malformed file yields one named rejection rather than silence,
 * because a single YAML typo must not quietly stop production updating.
 */
function policyFromTree(files: ReadonlyMap<string, Uint8Array>, logger: Logger): TreePolicy {
  const decoder = new TextDecoder();

  for (const { path, format } of POLICY_FILES) {
    const bytes = files.get(path);
    if (bytes === undefined) continue;

    const parsed = parsePolicyContent(decoder.decode(bytes), format, logger);
    if (parsed.status === "malformed") {
      return {
        deploys: [],
        rejections: [
          {
            name: null,
            reason: `Policy file ${path} is present but invalid (${parsed.reason}); no deploy configuration could be read from it.`,
          },
        ],
        absent: false,
      };
    }

    return {
      deploys: parsed.policy.deploys ?? [],
      rejections: parsed.policy.deployRejections ?? [],
      absent: false,
    };
  }

  return { deploys: [], rejections: [], absent: true };
}

/**
 * Insert one deployment row.
 *
 * @returns The row, or `null` when another consumer already owns this
 *   `(project, name, commit, attempt)` — a normal outcome of the unique index
 *   being the mutual exclusion, not a failure.
 */
async function createDeployment(
  ctx: RunContext,
  opts: {
    name: string;
    target: DeploymentTarget;
    commitSha: string;
    changeId?: string;
    /**
     * The merge time this row is ordered by. Omitted only by callers that have
     * no merge behind them, which then get the clock — see
     * `Deployment.createdAt`.
     */
    createdAt?: string;
    status: DeploymentStatus;
    reason?: string;
  },
): Promise<Result<Deployment | null, AppError>> {
  const result = await insertDeployment(ctx.env.DB, ctx.logger, {
    projectId: ctx.project.id,
    project: ctx.project.name,
    changeId: opts.changeId ?? null,
    commitSha: opts.commitSha,
    name: opts.name,
    target: opts.target,
    status: opts.status,
    // Truncated, not redacted: nothing here has seen a secret value yet — these
    // reasons come from the policy file and from git.
    reason:
      opts.reason === undefined ? null : redactAndTruncate(opts.reason, [], MAX_REASON_LENGTH),
    // A merge-triggered deploy has no human behind it.
    requestedByType: "system",
    ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    now: ctx.iso(),
  });
  if (!result.success) return err(result.error);

  if (!result.data.inserted) {
    ctx.logger.info("Deployment already owned by another consumer", {
      projectId: ctx.project.id,
      name: opts.name,
      commitSha: opts.commitSha,
    });
    return ok(null);
  }
  return ok(result.data.deployment);
}

/**
 * Write a terminal `failed` on a row that was never claimed — the change was
 * reverted, the project is being deleted, the tree would not read, or the deploy
 * is no longer declared. Leaving it `queued` would strand it forever.
 */
async function failWithoutRunning(
  ctx: RunContext,
  deployment: Deployment,
  reason: string,
): Promise<DeployRunRecord> {
  const truncated = redactAndTruncate(reason, [], MAX_REASON_LENGTH);

  const completed = await completeDeployment(ctx.env.DB, ctx.logger, {
    projectId: ctx.project.id,
    deploymentId: deployment.id,
    status: "failed",
    reason: truncated,
    completedAt: ctx.iso(),
  });
  if (!completed.success) {
    ctx.logger.error("Could not fail the deployment", completed.error, {
      deploymentId: deployment.id,
      projectId: ctx.project.id,
    });
  }

  await emitDeploymentEvent(ctx, deployment, "deployment.failed", { reason: truncated });
  return {
    deploymentId: deployment.id,
    name: deployment.name,
    status: "failed",
    reason: truncated,
  };
}

/**
 * Retire a row that lost to a newer commit, without ever claiming it.
 *
 * Writes `superseded` rather than `failed` because nothing went wrong: the
 * commit this row would have published was simply overtaken. No event is
 * emitted, matching `supersedeOlder` — the events registry has `requested`,
 * `succeeded` and `failed`, and reporting a retired row as a failure would page
 * someone about a healthy outcome.
 *
 * `completeDeployment` refuses a row that is already terminal, so replaying the
 * message for an already-superseded deployment leaves it exactly where it is.
 */
async function supersedeWithoutRunning(
  ctx: RunContext,
  deployment: Deployment,
  reason: string,
): Promise<DeployRunRecord> {
  const truncated = redactAndTruncate(reason, [], MAX_REASON_LENGTH);

  const completed = await completeDeployment(ctx.env.DB, ctx.logger, {
    projectId: ctx.project.id,
    deploymentId: deployment.id,
    status: "superseded",
    reason: truncated,
    completedAt: ctx.iso(),
  });
  if (!completed.success) {
    ctx.logger.error("Could not supersede the deployment", completed.error, {
      deploymentId: deployment.id,
      projectId: ctx.project.id,
    });
  }

  return {
    deploymentId: deployment.id,
    name: deployment.name,
    status: "superseded",
    reason: truncated,
  };
}

/**
 * Emit a `deployment.*` notification.
 *
 * The events registry carries notifications *about* deploys and never the work
 * itself — that is why `stratum-deploys` exists — so a failure here is logged by
 * `emitEvent` and never allowed to affect the deployment's outcome.
 */
async function emitDeploymentEvent(
  ctx: RunContext,
  deployment: Deployment,
  type: "deployment.requested" | "deployment.succeeded" | "deployment.failed",
  extra: { url?: string; reason?: string } = {},
): Promise<void> {
  const base = {
    project: ctx.project.name,
    deploymentId: deployment.id,
    name: deployment.name,
    target: deployment.target,
    commit: deployment.commitSha,
  };

  let event: StratumEvent;
  if (type === "deployment.succeeded") {
    event = { type, ...base, ...(extra.url !== undefined ? { url: extra.url } : {}) };
  } else if (type === "deployment.failed") {
    event = { type, ...base, reason: extra.reason ?? deployment.reason ?? "Deployment failed" };
  } else {
    event = {
      type,
      ...base,
      ...(deployment.changeId !== undefined ? { changeId: deployment.changeId } : {}),
    };
  }

  await emitEvent(
    ctx.env.DB,
    ctx.env.EVENTS_QUEUE ?? null,
    event,
    { type: "system" },
    ctx.logger,
    ctx.project.id,
  );
}

function toRecord(deployment: Deployment): DeployRunRecord {
  const record: DeployRunRecord = {
    deploymentId: deployment.id,
    name: deployment.name,
    status: deployment.status,
  };
  if (deployment.reason !== undefined) record.reason = deployment.reason;
  if (deployment.url !== undefined) record.url = deployment.url;
  return record;
}

/**
 * `base`, or the first of `base #2`, `base #3`, … not already spoken for.
 * Records the answer in `claimed`, so successive calls keep diverging.
 *
 * Deterministic given the same policy, which is what keeps `insertDeployment`'s
 * unique index doing its job: two consumers fanning out the same merge derive
 * the same names in the same order, so exactly one of them wins each row. The
 * suffixed form cannot collide with a declared deploy name either — those match
 * `^[a-z][a-z0-9-]{0,31}$`, which admits neither a space nor a `#`.
 */
function distinctName(base: string, claimed: Set<string>): string {
  let candidate = base;
  for (let n = 2; claimed.has(candidate); n++) candidate = `${base} #${n}`;
  claimed.add(candidate);
  return candidate;
}

/** The commit prefix humans recognise, for reasons that name a commit. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
