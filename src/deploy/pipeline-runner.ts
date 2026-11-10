/**
 * Deploy pipelines (#416): the half of a deployment that Stratum does itself
 * when the work is done by the CI executor.
 *
 * A static `deploys:` target is published inside the queue consumer: the row
 * is claimed, the provider is called, the row is finished, all in one
 * invocation. A pipeline cannot be — its steps run for minutes in a container
 * owned by another Worker. So here the consumer's job ends at the hand-over:
 *
 *   queued ──claim──▶ running ──(executor reports)──▶ succeeded | failed
 *
 * and three things that the inline runner gets for free have to be built:
 *
 * - **One deployment per environment at a time.** `claimPipelineDeployment`
 *   takes the row and the environment in one statement. A deployment that
 *   finds its environment busy stays `queued`, and {@link advancePipeline}
 *   starts the newest waiting one when the running one ends.
 * - **Promotion is a consequence of success, not a plan made at merge time.**
 *   Only the first environment gets a row when a commit merges. The next
 *   environment's row is created when — and only when — the one before it
 *   succeeded, so a failed step leaves nothing behind that could be promoted,
 *   approved or retried into the next environment.
 * - **An approval gate checked at the last moment.** Whether an environment
 *   needs a person is declared in the pipeline, so it is checked here, against
 *   the pipeline at the deployment's own commit, immediately before the claim:
 *   a `queued` row with no `approvedBy` for such an environment is put back to
 *   `pending_approval`, however it came to be queued.
 * - **A lease the consumer cannot renew.** The row stays `running` until the
 *   executor reports; if it never does, the cron sweep fails the row
 *   (`services/deploy-reports.ts`). It is never re-run on a guess.
 *
 * What Stratum sends the executor is "deploy this commit to this environment"
 * and the steps the merged commit declares. It sends no credential for the
 * deploy target and holds none: those are the executor's.
 */
import {
  type DeployJobDispatch,
  ciExecutorConfig,
  deployJobAllowanceMs,
  repositoryTokenExpiry,
  submitDeployJob,
} from "../services/ci-executor";
import {
  type Deployment,
  type DeploymentStatus,
  type DeploymentTarget,
  PIPELINE_TARGET,
  SUPERSEDED_REASON,
  UNRESOLVED_TARGET,
  claimPipelineDeployment,
  completeDeployment,
  findNewerSucceededDeployment,
  findNextQueuedDeployment,
  getDeployment,
  holdDeploymentForApproval,
  supersedeOlder,
} from "../storage/deployments";
import { extractTokenSecret, freshRepoToken } from "../storage/git-ops";
import type { Env, ProjectEntry } from "../types";
import { projectDisplayName } from "../types";
import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import {
  type DeployEnvironment,
  type DeployPipelineParse,
  type DeployPipelineStep,
  nextEnvironment,
  parseDeployPipeline,
} from "./pipeline";
import type { DeployRunRecord } from "./runner";

/** Where the pipeline lives in a tree. The same file as the CI steps. */
export const PIPELINE_FILE = ".stratum/ci.yaml";

/** Path the executor's deploy reports are POSTed under, on the public origin. */
export const DEPLOY_CALLBACK_PATH = "/api/deploy-reports";

/**
 * What this module needs from the deploy runner that owns the queue message:
 * its context, and the row-level helpers that already carry the runner's
 * rules (one row per unique key, terminal writes that refuse a claimed row,
 * events only for writes that landed). Injected rather than imported so the
 * two modules do not import each other.
 */
export interface PipelineHost {
  env: Env;
  logger: Logger;
  project: ProjectEntry;
  now(): number;
  iso(): string;
  /** The tree at a pinned commit, as path to bytes. */
  readTree(
    commitSha: string,
    changeId?: string,
  ): Promise<Result<Map<string, Uint8Array>, AppError>>;
  /** Insert a row; `null` when another consumer already owns the key. */
  createDeployment(opts: {
    name: string;
    target: DeploymentTarget;
    commitSha: string;
    changeId?: string;
    createdAt?: string;
    status: DeploymentStatus;
    reason?: string;
  }): Promise<Result<Deployment | null, AppError>>;
  failWithoutRunning(deployment: Deployment, reason: string): Promise<DeployRunRecord>;
  supersedeWithoutRunning(deployment: Deployment, reason: string): Promise<DeployRunRecord>;
  emit(
    deployment: Deployment,
    type: "deployment.requested" | "deployment.succeeded" | "deployment.failed",
    extra?: { url?: string; reason?: string },
  ): Promise<void>;
  /** Why the change behind a deployment may no longer be deployed, or null. */
  changeGuard(changeId: string): Promise<string | null>;
  /** The monthly deploy allowance: a refusal, or the means to give the unit back. */
  checkVolume(
    deployment: Deployment,
  ): Promise<{ refusal: string | null; release(): Promise<void> }>;
}

/** The pipeline declared by a tree, read out of its `.stratum/ci.yaml`. */
export function pipelineFromTree(files: ReadonlyMap<string, Uint8Array>): DeployPipelineParse {
  const bytes = files.get(PIPELINE_FILE);
  if (bytes === undefined) return { status: "absent" };
  return parseDeployPipeline(new TextDecoder().decode(bytes));
}

/** The commit prefix people recognise, for reasons that name a commit. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** What one deployment row came to in this run, for the queue consumer's log. */
function record(
  deployment: Deployment,
  status: DeploymentStatus,
  reason?: string,
): DeployRunRecord {
  return {
    deploymentId: deployment.id,
    name: deployment.name,
    status,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Create the row for one environment of a commit, and run it unless it waits
 * for approval. Returns the record for the consumer's log, or `null` when
 * another consumer already owns this exact row.
 */
async function startEnvironment(
  host: PipelineHost,
  files: ReadonlyMap<string, Uint8Array>,
  environment: DeployEnvironment,
  opts: { commitSha: string; changeId?: string; createdAt: string },
): Promise<Result<DeployRunRecord | null, AppError>> {
  const status: DeploymentStatus = environment.requiresApproval ? "pending_approval" : "queued";
  const created = await host.createDeployment({
    name: environment.name,
    target: PIPELINE_TARGET,
    commitSha: opts.commitSha,
    ...(opts.changeId !== undefined ? { changeId: opts.changeId } : {}),
    createdAt: opts.createdAt,
    status,
  });
  if (!created.success) return err(created.error);
  if (!created.data) return ok(null);
  await host.emit(created.data, "deployment.requested");
  if (status !== "queued") return ok(record(created.data, status));
  return ok(await runPipelineDeployment(host, created.data, files));
}

/**
 * A merge landed: start its pipeline at the FIRST environment, and only there.
 *
 * `claimedNames` are the names the same commit's `deploys:` entries use. An
 * environment with one of those names would share a deployment row key with a
 * static target, so it is refused by name instead of silently losing to it.
 *
 * @returns The records this produced, and whether the tree declares a
 *   pipeline at all (so the caller knows "nothing configured" from "this").
 */
export async function startPipelineForMerge(
  host: PipelineHost,
  files: ReadonlyMap<string, Uint8Array>,
  opts: { commitSha: string; changeId: string; createdAt: string; claimedNames: Set<string> },
): Promise<Result<{ declared: boolean; records: DeployRunRecord[] }, AppError>> {
  const parsed = pipelineFromTree(files);
  if (parsed.status === "absent") return ok({ declared: false, records: [] });

  const fail = async (
    name: string,
    reason: string,
  ): Promise<Result<{ declared: boolean; records: DeployRunRecord[] }, AppError>> => {
    const created = await host.createDeployment({
      name,
      target: UNRESOLVED_TARGET,
      commitSha: opts.commitSha,
      changeId: opts.changeId,
      createdAt: opts.createdAt,
      status: "failed",
      reason,
    });
    if (!created.success) return err(created.error);
    if (!created.data) return ok({ declared: true, records: [] });
    await host.emit(created.data, "deployment.failed", { reason });
    return ok({ declared: true, records: [record(created.data, "failed", reason)] });
  };

  if (parsed.status === "malformed") {
    // Not `(unresolved)`: that name belongs to the policy file's own failures
    // at this commit, and the two would collide on the row key.
    return fail(
      "(pipeline)",
      `The deploy pipeline in ${PIPELINE_FILE} at ${shortSha(opts.commitSha)} is invalid (${parsed.reason}); nothing was deployed.`,
    );
  }

  const first = parsed.pipeline.environments[0];
  if (first === undefined) return ok({ declared: true, records: [] });
  const clash = parsed.pipeline.environments.find((environment) =>
    opts.claimedNames.has(environment.name),
  );
  if (clash !== undefined) {
    return fail(
      "(pipeline)",
      `Environment '${clash.name}' in ${PIPELINE_FILE} has the same name as a 'deploys:' entry in the policy file; a deployment name must belong to exactly one of them. Nothing was deployed from the pipeline.`,
    );
  }

  const started = await startEnvironment(host, files, first, opts);
  if (!started.success) return err(started.error);
  return ok({ declared: true, records: started.data ? [started.data] : [] });
}

/**
 * Which steps a deployment runs: the environment's `rollback` steps when it is
 * a rollback to a recorded version and the environment declares them,
 * otherwise its ordinary `steps` — for a rollback, at the earlier commit.
 */
function stepsFor(
  environment: DeployEnvironment,
  rollback: { version?: string } | undefined,
): DeployPipelineStep[] {
  if (rollback?.version !== undefined && environment.rollback !== undefined) {
    return environment.rollback;
  }
  return environment.steps;
}

/**
 * Hand one `queued` pipeline deployment to the executor, or say why it was not.
 *
 * The same two ordering checks as the inline runner, in the same order and for
 * the same reason (see `runOneDeployment`), then the claim that also takes the
 * environment. Every path leaves the row terminal, `running` with the
 * executor holding the job, or untouched and still `queued` behind another
 * deployment of its environment.
 */
export async function runPipelineDeployment(
  host: PipelineHost,
  deployment: Deployment,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<DeployRunRecord> {
  const { env, logger, project } = host;

  // Only a `queued` row may go any further. The claim below would refuse
  // anything else anyway, but the steps before it retire OLDER deployments of
  // the environment — and a row still waiting for approval, or already
  // finished, must not be able to supersede anything on the strength of a
  // stray or redelivered message.
  if (deployment.status !== "queued") return record(deployment, deployment.status);

  if (deployment.changeId !== undefined) {
    const guard = await host.changeGuard(deployment.changeId);
    if (guard !== null) return await host.failWithoutRunning(deployment, guard);
  }

  const parsed = pipelineFromTree(files);
  if (parsed.status !== "ok") {
    const why =
      parsed.status === "malformed"
        ? `is invalid (${parsed.reason})`
        : "declares no deploy pipeline";
    return await host.failWithoutRunning(
      deployment,
      `${PIPELINE_FILE} at ${shortSha(deployment.commitSha)} ${why}; nothing was deployed.`,
    );
  }
  const { pipeline } = parsed;
  const environment = pipeline.environments.find((entry) => entry.name === deployment.name);
  if (environment === undefined) {
    return await host.failWithoutRunning(
      deployment,
      `Environment '${deployment.name}' is not declared in ${PIPELINE_FILE} at ${shortSha(deployment.commitSha)}`,
    );
  }

  // The approval gate, enforced where it cannot be walked around. A row is
  // normally created `pending_approval` for an environment that asks for a
  // person, and only an approval moves it on — but a row can also arrive here
  // `queued` by another road (a retry of a deployment that was superseded
  // while it waited has nobody's approval on it). Whatever the road, an
  // environment that requires approval runs nothing that no user approved:
  // the row is parked, to be approved like any other.
  if (environment.requiresApproval && deployment.approvedBy === undefined) {
    const held = await holdDeploymentForApproval(env.DB, logger, {
      projectId: project.id,
      deploymentId: deployment.id,
    });
    if (!held.success) {
      return await host.failWithoutRunning(
        deployment,
        `Environment '${deployment.name}' requires approval and this deployment has none; it could not be held for approval, so it was not run.`,
      );
    }
    return record(deployment, held.data ? "pending_approval" : deployment.status);
  }

  let rollback: { version?: string } | undefined;
  if (deployment.rollbackOf !== undefined) {
    const target = await getDeployment(env.DB, logger, {
      projectId: project.id,
      deploymentId: deployment.rollbackOf,
    });
    if (!target.success || !target.data || target.data.status !== "succeeded") {
      return await host.failWithoutRunning(
        deployment,
        "The deployment this rollback points at could not be read, or did not succeed; nothing was rolled back.",
      );
    }
    rollback = target.data.version !== undefined ? { version: target.data.version } : {};
  }

  const executor = ciExecutorConfig(env);
  if (executor.status !== "configured") {
    return await host.failWithoutRunning(
      deployment,
      `Deploy pipelines run on the CI executor, and ${executor.reason}.`,
    );
  }
  const origin = publicOrigin(env);
  if (origin === null) {
    return await host.failWithoutRunning(
      deployment,
      "This instance has no public URL to give the CI executor; the operator must set APP_URL.",
    );
  }

  const newer = await findNewerSucceededDeployment(env.DB, logger, {
    projectId: project.id,
    name: deployment.name,
    createdAt: deployment.createdAt,
    excludeDeploymentId: deployment.id,
  });
  if (!newer.success) {
    return await host.failWithoutRunning(
      deployment,
      "Could not check whether a newer deployment of this environment already succeeded, so the deploy was not run; retry it",
    );
  }
  if (newer.data !== null) {
    return await host.supersedeWithoutRunning(
      deployment,
      `${SUPERSEDED_REASON}: ${shortSha(newer.data.commitSha)} already succeeded`,
    );
  }
  const superseded = await supersedeOlder(env.DB, logger, {
    projectId: project.id,
    name: deployment.name,
    keepDeploymentId: deployment.id,
    createdAt: deployment.createdAt,
    now: host.iso(),
  });
  if (!superseded.success) {
    logger.error("Could not supersede older deployments", superseded.error, {
      deploymentId: deployment.id,
    });
  }

  const volume = await host.checkVolume(deployment);
  if (volume.refusal !== null) return await host.failWithoutRunning(deployment, volume.refusal);

  const allowanceMs = deployJobAllowanceMs(pipeline.timeoutSeconds);
  const claim = await claimPipelineDeployment(env.DB, logger, {
    projectId: project.id,
    deploymentId: deployment.id,
    leaseMs: allowanceMs,
    now: host.iso(),
  });
  if (!claim.success) {
    // The claim itself failed, a storage error. Returning the row as `queued`
    // would strand it: the queue message is acked, nothing else is running in
    // this environment to start the next queued row, and neither retry nor
    // approve accepts a row in that state. It is still unclaimed, so it can be
    // written failed, which a person can see and retry.
    await volume.release();
    return await host.failWithoutRunning(
      deployment,
      "Not started: the deployment could not be claimed because of a storage error. Nothing was deployed; retry it.",
    );
  }
  if (!claim.data.claimed) {
    // Not this attempt's deploy: the unit it reserved goes back.
    await volume.release();
    if (claim.data.reason === "environment_busy") {
      logger.info("Environment is busy; the deployment waits its turn", {
        deploymentId: deployment.id,
        name: deployment.name,
      });
    }
    return record(deployment, deployment.status);
  }

  // From here the row is `running` and owns its environment. If the hand-over
  // fails the row is finished here, and the environment given to whoever waits.
  const failure = await dispatch(host, executor, {
    deployment,
    environment,
    steps: stepsFor(environment, rollback),
    origin,
    deadline: new Date(host.now() + allowanceMs).toISOString(),
    timeoutSeconds: pipeline.timeoutSeconds,
    allowHosts: pipeline.allowHosts,
    ...(pipeline.instance !== undefined ? { instance: pipeline.instance } : {}),
    ...(rollback !== undefined ? { rollback } : {}),
  });
  if (failure === null) return record(deployment, "running");

  const reason = `Not deployed: ${failure}.`;
  const completed = await completeDeployment(env.DB, logger, {
    projectId: project.id,
    deploymentId: deployment.id,
    status: "failed",
    reason,
    durationMs: 0,
    completedAt: host.iso(),
    onlyIfRunning: true,
  });
  if (completed.success && completed.data) {
    await host.emit(deployment, "deployment.failed", { reason });
  }
  await startNextQueued(host, deployment.name);
  return record(deployment, "failed", reason);
}

/** The origin the executor reports to and links logs on, from `APP_URL`. */
function publicOrigin(env: Pick<Env, "APP_URL">): string | null {
  const configured = env.APP_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Build and submit the dispatch. Returns `null` once the executor has accepted
 * the job, or a reason safe to store and show.
 */
async function dispatch(
  host: PipelineHost,
  executor: Extract<ReturnType<typeof ciExecutorConfig>, { status: "configured" }>,
  args: {
    deployment: Deployment;
    environment: DeployEnvironment;
    steps: DeployPipelineStep[];
    origin: string;
    deadline: string;
    timeoutSeconds: number;
    allowHosts: string[];
    instance?: DeployJobDispatch["job"]["instance"];
    rollback?: { version?: string };
  },
): Promise<string | null> {
  const { env, logger, project } = host;
  const { deployment } = args;

  // Read scope, minted per job: the job fetches one commit and nothing else.
  const token = await freshRepoToken(env.ARTIFACTS, project.remote, "read", logger);
  if (!token.success) return "a read token for the repository could not be minted";

  const body: DeployJobDispatch = {
    event: "deploy.requested",
    deploymentId: deployment.id,
    project: projectDisplayName(project),
    projectId: project.id,
    environment: deployment.name,
    commitSha: deployment.commitSha,
    callbackUrl: `${args.origin}${DEPLOY_CALLBACK_PATH}`,
    deadline: args.deadline,
    ...(args.rollback !== undefined ? { rollback: args.rollback } : {}),
    job: {
      profile: "deploy",
      steps: args.steps.map((step) => ({
        name: step.name,
        run: step.run,
        timeoutSeconds: step.timeoutSeconds,
      })),
      timeoutSeconds: args.timeoutSeconds,
      ...(args.instance !== undefined ? { instance: args.instance } : {}),
      allowHosts: [...args.allowHosts],
      repository: {
        url: project.remote,
        username: "x",
        password: extractTokenSecret(token.data),
        expiresAt: repositoryTokenExpiry(token.data, new Date(host.now())),
      },
      logUrl: `${args.origin}/${project.namespace}/${project.slug}/deployments/${deployment.id}`,
    },
  };
  return submitDeployJob(executor, logger, body);
}

/**
 * Start the deployment that has been waiting for `name`'s environment, if any:
 * the newest `queued` pipeline row. Loops, because a deployment that cannot be
 * handed over is finished on the spot and the next one gets its turn.
 */
async function startNextQueued(host: PipelineHost, name: string): Promise<DeployRunRecord[]> {
  const { env, logger, project } = host;
  const records: DeployRunRecord[] = [];
  // Bounded: every pass either leaves a row `running` (and stops), or moves
  // one row out of `queued` for good.
  for (let pass = 0; pass < 20; pass++) {
    const next = await findNextQueuedDeployment(env.DB, logger, { projectId: project.id, name });
    if (!next.success || next.data === null) break;
    // A static target's queued row is run by its own queue message.
    if (next.data.target !== PIPELINE_TARGET) break;
    const tree = await host.readTree(next.data.commitSha, next.data.changeId);
    const result = tree.success
      ? await runPipelineDeployment(host, next.data, tree.data)
      : await host.failWithoutRunning(
          next.data,
          `Could not read the tree at ${shortSha(next.data.commitSha)}: ${tree.error.message}`,
        );
    records.push(result);
    if (result.status === "running" || result.status === "queued") break;
  }
  return records;
}

/**
 * A pipeline deployment reached a terminal status. Do the two things that
 * follow from that, both of which need a tree and so belong on the queue:
 *
 * 1. **Promote.** If it succeeded, and was an ordinary deploy rather than a
 *    rollback, create the next environment's deployment — `pending_approval`
 *    when that environment asks for a person, otherwise `queued` and started.
 *    A failed deployment creates nothing: there is no row to approve.
 * 2. **Release the environment.** Start the newest deployment that was
 *    waiting behind this one.
 *
 * Safe to deliver twice: the promotion insert is on the unique row key, and
 * starting a deployment is a claim.
 */
export async function advancePipeline(
  host: PipelineHost,
  deploymentId: string,
): Promise<Result<DeployRunRecord[], AppError>> {
  const { env, logger, project } = host;
  const found = await getDeployment(env.DB, logger, { projectId: project.id, deploymentId });
  if (!found.success) return err(found.error);
  const deployment = found.data;
  if (!deployment || deployment.target !== PIPELINE_TARGET) return ok([]);
  // Still in flight: this message is early or stale, and the report (or the
  // sweep) that ends the deployment will send another.
  if (deployment.status === "running" || deployment.status === "queued") return ok([]);

  const records: DeployRunRecord[] = [];
  if (deployment.status === "succeeded" && deployment.rollbackOf === undefined) {
    const tree = await host.readTree(deployment.commitSha, deployment.changeId);
    if (!tree.success) return err(tree.error);
    const parsed = pipelineFromTree(tree.data);
    const next =
      parsed.status === "ok" ? nextEnvironment(parsed.pipeline, deployment.name) : undefined;
    if (next !== undefined) {
      const started = await startEnvironment(host, tree.data, next, {
        commitSha: deployment.commitSha,
        ...(deployment.changeId !== undefined ? { changeId: deployment.changeId } : {}),
        // The promoted row is ordered by the same merge as the row it follows.
        createdAt: deployment.createdAt,
      });
      if (!started.success) return err(started.error);
      if (started.data) records.push(started.data);
    }
  }

  records.push(...(await startNextQueued(host, deployment.name)));
  return ok(records);
}
