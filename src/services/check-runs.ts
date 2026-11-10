/**
 * Check runs (#414, ADR 011): dispatching them to a runner, accepting the
 * runner's signed reports, re-running one, and expiring the ones that never
 * report.
 *
 * The contract with a runner has two halves, both defined in this file:
 *
 * - **Dispatch** ({@link CheckDispatchPayload}): after a revision of a change
 *   has been evaluated, Stratum creates one `queued` check run per name the
 *   project's BASE policy declares and POSTs the payload, signed, to the
 *   declaring `checks` entry's `url`. The response is only an acknowledgement;
 *   any 2xx leaves the runs `queued`.
 * - **Callback** ({@link CheckReportBody}): the runner POSTs each transition to
 *   `<callbackUrl>/<checkRunId>`, signed with the same key.
 *
 * What a runner can and cannot do follows from where identity lives. A check
 * run's change, revision and name are fixed when Stratum creates the row; the
 * callback addresses a row by id and may only move its status forward. So a
 * runner cannot create a check, rename one, or carry a result from one
 * revision to another — and holding the signing key for one project's checks
 * says nothing about any other project's, because the key is resolved from the
 * project the row belongs to.
 *
 * A project that has a `.stratum/ci.yaml` on its base branch gets a second
 * kind of dispatch (#415): one job, for every step in that file, sent to the
 * instance's own CI executor. Its check runs are the same rows and the same
 * callback; what differs is the key (the instance's, never a project's) and
 * that the executor is handed a read token for the repository. See
 * `./ci-executor.ts`.
 */
import { loadPolicy } from "../evaluation";
import { type CiConfig, ciStepNames } from "../evaluation/ci-config";
import {
  DEFAULT_CHECK_DISPATCH_TIMEOUT_MS,
  MAX_PHASE_TIMEOUT_MS,
  MIN_PHASE_TIMEOUT_MS,
  checkDeadlineMs,
} from "../evaluation/limits";
import { llmProviderCatalog } from "../evaluation/llm-providers";
import { hmacSha256Hex, resolveSigningKey } from "../evaluation/signing-secret";
import type { ChecksEvaluatorConfig, EvalPolicy } from "../evaluation/types";
import { getChange } from "../storage/changes";
import {
  CHECK_SUMMARY_DEADLINE,
  type CheckRun,
  REPORTABLE_CHECK_STATUSES,
  type ReportableCheckStatus,
  applyCheckReport,
  createCheckRuns,
  expireOverdueChecks,
  failCheckRuns,
  getCheckRun,
  isTerminalCheckStatus,
} from "../storage/checks";
import { getExternalPullRequestByChange } from "../storage/external-pull-requests";
import { freshRepoToken, getDiffBetweenRepos } from "../storage/git-ops";
import {
  type Change,
  type Env,
  type ProjectEntry,
  projectDefaultBranch,
  projectDisplayName,
} from "../types";
import { constantTimeEqual } from "../utils/crypto";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { validateWebhookUrl } from "../utils/validation";
import {
  CI_EXECUTOR_SECRET_REF,
  buildCiJobSpec,
  ciCheckDeadline,
  ciExecutorConfig,
  submitCiJob,
} from "./ci-executor";

/** Header carrying `sha256=<hex HMAC-SHA256 of the raw body>`, in both directions. */
export const CHECK_SIGNATURE_HEADER = "X-Stratum-Signature";

/** Path the callback endpoint is mounted at; `callbackUrl` is this on the public origin. */
export const CHECK_CALLBACK_PATH = "/api/checks";

/** Longest `summary` stored for a check. Longer reports are truncated, not refused. */
export const MAX_CHECK_SUMMARY_LENGTH = 4000;

/** Longest `detailsUrl` accepted. */
export const MAX_CHECK_DETAILS_URL_LENGTH = 2048;

/**
 * The body Stratum POSTs to a `checks` entry's `url`.
 *
 * Every field is named here rather than spread from a larger object, for the
 * reason `EvaluationContext` gives: the destination is a URL the policy file
 * chose, so what leaves the Worker must be a deliberate list.
 */
export interface CheckDispatchPayload {
  event: "checks.requested";
  /** The change the checks belong to. */
  changeId: string;
  /** `@namespace/slug` of the project. */
  project: string;
  /** The commit `diff` was computed against. */
  baseSha: string;
  /** The evaluated revision. Every report must echo it back. */
  headSha: string;
  /**
   * Git tree id of `headSha`. A runner that rebuilds the revision from
   * `baseSha` plus `diff` can compare the tree it built to this before running
   * anything — the diff is text, and a binary file or a mode change it cannot
   * carry would otherwise go untested without anyone noticing.
   */
  headTreeSha: string;
  /** Unified diff of `baseSha..headSha`. */
  diff: string;
  /** Check name to check run id, for exactly the checks this request asks for. */
  checkRunIds: Record<string, string>;
  /** Reports go to `<callbackUrl>/<checkRunId>`. */
  callbackUrl: string;
  /** ISO 8601 instant after which an unreported check is `errored`. */
  deadline: string;
}

/** The body a runner POSTs to `<callbackUrl>/<checkRunId>`. */
export interface CheckReportBody {
  /** Must equal the id in the URL, so a signed body is bound to one check run. */
  checkRunId: string;
  /** Must equal the dispatched `headSha`. */
  headSha: string;
  status: ReportableCheckStatus;
  /**
   * Strictly increasing per check run (a counter, or milliseconds since the
   * epoch). A report at or below the last applied one is a redelivery.
   */
  sequence: number;
  summary?: string;
  detailsUrl?: string;
}

/**
 * Where a runner reports to: `APP_URL` when the operator set one, otherwise
 * the origin of the request that triggered the dispatch.
 *
 * A queue consumer has no request, so an instance that evaluates on the queue
 * needs `APP_URL`; without either there is no address to give the runner and
 * the dispatch fails closed.
 */
function callbackUrlFor(env: Pick<Env, "APP_URL">, requestOrigin?: string): string | null {
  const configured = env.APP_URL?.trim();
  const source = configured && configured.length > 0 ? configured : requestOrigin;
  if (!source) return null;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${CHECK_CALLBACK_PATH}`;
  } catch {
    return null;
  }
}

/** The dispatch request's timeout: the entry's `timeoutMs`, clamped, or the default. */
function dispatchTimeoutMs(entry: ChecksEvaluatorConfig): number {
  const raw = entry.timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_CHECK_DISPATCH_TIMEOUT_MS;
  return Math.min(MAX_PHASE_TIMEOUT_MS, Math.max(MIN_PHASE_TIMEOUT_MS, Math.floor(raw)));
}

/** What a dispatch needs to know about the revision it announces. */
export interface CheckDispatchTarget {
  changeId: string;
  project: ProjectEntry;
  /** The policy read from the project's base branch — never from the change. */
  policy: EvalPolicy;
  diff: string;
  baseSha: string;
  /** The evaluated revision the runs are bound to. */
  headSha: string;
  /** The tree of `headSha`, as read when the revision was evaluated. */
  headTreeSha: string;
  /** Origin of the triggering request, used when `APP_URL` is not set. */
  requestOrigin?: string;
}

/**
 * Send one entry's dispatch request for runs that already exist. Returns
 * `null` on an acknowledged delivery, or why it was not delivered — a reason
 * safe to store and show (URLs and secret NAMES only, never key material).
 */
async function deliverDispatch(
  env: Env,
  logger: Logger,
  target: CheckDispatchTarget,
  entry: ChecksEvaluatorConfig,
  runs: CheckRun[],
  deadline: string,
): Promise<string | null> {
  // Same private-host filter as the webhook evaluator: the URL is repository
  // content, and this is a server-side request on its behalf.
  const urlCheck = validateWebhookUrl(entry.url, logger);
  if (!urlCheck.success) {
    return `the checks URL is not allowed (${urlCheck.error[0]?.message ?? "invalid URL"})`;
  }
  const callbackUrl = callbackUrlFor(env, target.requestOrigin);
  if (callbackUrl === null) {
    return "this instance has no public URL to give the runner; the operator must set APP_URL";
  }

  // Resolved per dispatch, so rotating the project secret takes effect on the
  // next one. Anything but a key resolved from the project store fails closed:
  // an unsigned dispatch would invite callbacks nothing could verify.
  const signing = await resolveSigningKey(
    { secretRef: entry.secretRef },
    { env, projectId: target.project.id },
    logger,
    "checks evaluator",
  );
  if (signing.status !== "resolved") {
    return signing.status === "unavailable"
      ? `the signing secret is unavailable (${signing.reason})`
      : "no signing secret is configured";
  }

  const payload: CheckDispatchPayload = {
    event: "checks.requested",
    changeId: target.changeId,
    project: projectDisplayName(target.project),
    baseSha: target.baseSha,
    headSha: target.headSha,
    headTreeSha: target.headTreeSha,
    diff: target.diff,
    checkRunIds: Object.fromEntries(runs.map((run) => [run.name, run.id])),
    callbackUrl,
    deadline,
  };
  const body = JSON.stringify(payload);
  const signature = await hmacSha256Hex(signing.key, body);

  const controller = new AbortController();
  const timeoutMs = dispatchTimeoutMs(entry);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(entry.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stratum-Event": payload.event,
        [CHECK_SIGNATURE_HEADER]: `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
      // Never follow a redirect to a (possibly internal) address.
      redirect: "manual",
    });
    if (!response.ok) return `the runner answered HTTP ${response.status}`;
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Check dispatch request failed", { url: entry.url, error: message });
    return controller.signal.aborted
      ? `the runner did not answer within ${timeoutMs}ms`
      : "the runner could not be reached";
  } finally {
    clearTimeout(timer);
  }
}

/** Create one entry's runs and deliver its dispatch; a failed delivery errors them. */
async function dispatchEntry(
  env: Env,
  logger: Logger,
  target: CheckDispatchTarget,
  entry: ChecksEvaluatorConfig,
  names: string[],
  supersede: "all" | "same-names",
): Promise<Result<{ runs: CheckRun[]; failure: string | null }, Error>> {
  const now = new Date();
  const deadline = new Date(now.getTime() + checkDeadlineMs(entry)).toISOString();
  const created = await createCheckRuns(env.DB, logger, {
    changeId: target.changeId,
    projectId: target.project.id,
    revision: target.headSha,
    baseSha: target.baseSha,
    names,
    secretRef: entry.secretRef,
    deadlineAt: deadline,
    supersede,
    now: now.toISOString(),
  });
  if (!created.success) return created;

  const failure = await deliverDispatch(env, logger, target, entry, created.data, deadline);
  if (failure === null) return ok({ runs: created.data, failure: null });

  const summary = `Dispatch failed: ${failure}.`;
  logger.warn("Check dispatch failed; marking its runs errored", {
    changeId: target.changeId,
    revision: target.headSha,
    reason: failure,
  });
  await failCheckRuns(env.DB, logger, { ids: created.data.map((run) => run.id), summary });
  return ok({
    runs: created.data.map((run) => ({ ...run, status: "errored" as const, summary })),
    failure,
  });
}

/**
 * Hand the base branch's CI steps, as one job, to the instance's executor.
 * Returns `null` once the executor has accepted the job, or why it could not
 * be handed over.
 */
async function deliverCiJob(
  env: Env,
  logger: Logger,
  target: CheckDispatchTarget,
  config: CiConfig,
  runs: CheckRun[],
  deadline: string,
  now: Date,
): Promise<string | null> {
  const executor = ciExecutorConfig(env);
  if (executor.status !== "configured") return executor.reason;

  const callbackUrl = callbackUrlFor(env, target.requestOrigin);
  if (callbackUrl === null) {
    return "this instance has no public URL to give the CI executor; the operator must set APP_URL";
  }
  // Without the tree id the executor could not prove it rebuilt the evaluated
  // revision, and it refuses to run steps on a tree it cannot prove.
  if (target.headTreeSha === "") return "the evaluated revision has no recorded tree id";

  // Minted here, per job, and sent only inside the signed request. Read scope:
  // a job can fetch the repository and nothing else.
  const token = await freshRepoToken(env.ARTIFACTS, target.project.remote, "read", logger);
  if (!token.success) return "a read token for the repository could not be minted";

  // A change that began as a pull request on the mirror is marked as such
  // (#420), so the executor can hold it to the CI profile on its own account.
  // If the lookup fails the job is marked external: the stricter of the two.
  const external = await getExternalPullRequestByChange(env.DB, logger, target.changeId);
  const jobOrigin = !external.success || external.data !== null ? "external" : "project";

  const origin = new URL(callbackUrl).origin;
  return submitCiJob(executor, logger, {
    event: "checks.requested",
    changeId: target.changeId,
    project: projectDisplayName(target.project),
    baseSha: target.baseSha,
    headSha: target.headSha,
    headTreeSha: target.headTreeSha,
    diff: target.diff,
    checkRunIds: Object.fromEntries(runs.map((run) => [run.name, run.id])),
    callbackUrl,
    deadline,
    job: buildCiJobSpec({
      config,
      repositoryUrl: target.project.remote,
      repositoryToken: token.data,
      // Logs are read through THIS Worker, which is the one that knows who
      // may read the project. The executor reports these as `detailsUrl`.
      logUrls: Object.fromEntries(
        runs.map((run) => [
          run.name,
          `${origin}/api/changes/${encodeURIComponent(target.changeId)}/checks/${run.id}/log`,
        ]),
      ),
      now,
      origin: jobOrigin,
    }),
  });
}

/**
 * Create a run for every step of the base branch's `.stratum/ci.yaml` and
 * submit the job; a job that could not be submitted errors them.
 *
 * Always the whole step list, including on a re-run of one step: the steps
 * share one checkout and run in order, so `test` on its own, without the
 * `install` before it, is not the check the file describes.
 */
async function dispatchCiJob(
  env: Env,
  logger: Logger,
  target: CheckDispatchTarget,
  config: CiConfig,
  supersede: "all" | "same-names",
): Promise<Result<{ runs: CheckRun[]; failure: string | null }, Error>> {
  const now = new Date();
  const deadline = ciCheckDeadline(config, now);
  const created = await createCheckRuns(env.DB, logger, {
    changeId: target.changeId,
    projectId: target.project.id,
    revision: target.headSha,
    baseSha: target.baseSha,
    names: ciStepNames(config),
    secretRef: CI_EXECUTOR_SECRET_REF,
    ciConfigDigest: config.digest,
    deadlineAt: deadline,
    supersede,
    now: now.toISOString(),
  });
  if (!created.success) return created;

  const failure = await deliverCiJob(env, logger, target, config, created.data, deadline, now);
  if (failure === null) return ok({ runs: created.data, failure: null });

  const summary = `Dispatch failed: ${failure}.`;
  logger.warn("CI job dispatch failed; marking its runs errored", {
    changeId: target.changeId,
    revision: target.headSha,
    reason: failure,
  });
  await failCheckRuns(env.DB, logger, { ids: created.data.map((run) => run.id), summary });
  return ok({
    runs: created.data.map((run) => ({ ...run, status: "errored" as const, summary })),
    failure,
  });
}

/** The policy's `checks` evaluator entries, in file order. */
function checksEntries(policy: EvalPolicy): ChecksEvaluatorConfig[] {
  return policy.evaluators.filter(
    (entry): entry is ChecksEvaluatorConfig => entry.type === "checks",
  );
}

/**
 * Dispatch every check the base policy declares for a freshly evaluated
 * revision. Called once the verdict for that revision has been recorded.
 *
 * Never throws and returns no error: the evaluation it follows has already
 * landed, and a dispatch that fails must not undo or mask it. Failure is safe
 * by construction instead — a run that was created but not delivered is
 * `errored`, and one that was never created is missing, and the merge gate
 * blocks on both. Re-evaluating the change dispatches again.
 *
 * A policy with no `checks` entry and no `.stratum/ci.yaml` costs nothing
 * here: no query, no write.
 */
export async function dispatchChecks(
  env: Env,
  logger: Logger,
  target: CheckDispatchTarget,
): Promise<CheckRun[]> {
  const entries = checksEntries(target.policy);
  const ci = target.policy.ci;
  if (entries.length === 0 && ci === undefined) return [];

  const dispatched: CheckRun[] = [];
  try {
    for (const [index, entry] of entries.entries()) {
      // Only the first entry clears the change's pending runs wholesale; the
      // rest would otherwise end the runs their siblings just created.
      const result = await dispatchEntry(
        env,
        logger,
        target,
        entry,
        entry.checks,
        index === 0 ? "all" : "same-names",
      );
      if (result.success) dispatched.push(...result.data.runs);
    }
    if (ci !== undefined) {
      const result = await dispatchCiJob(
        env,
        logger,
        target,
        ci,
        entries.length === 0 ? "all" : "same-names",
      );
      if (result.success) dispatched.push(...result.data.runs);
    }
  } catch (error) {
    logger.error(
      "Check dispatch threw; required checks stay unreported and block the merge",
      error instanceof Error ? error : new Error(String(error)),
      { changeId: target.changeId, revision: target.headSha },
    );
  }
  return dispatched;
}

/**
 * Re-run one check on the revision it was dispatched for.
 *
 * A re-run is a new attempt, with a new id, on the SAME revision — it cannot
 * be used to carry a check onto a revision nobody evaluated. So it is refused
 * unless the run is still the newest attempt of its name, the change's
 * evaluated revision is still the run's, and the workspace has not moved since.
 * The endpoint and key come from the base policy as it is now, not as it was
 * when the run was created: a check the policy no longer declares is not
 * re-run.
 *
 * Re-running a step of the first-party CI job re-runs the whole job — every
 * step gets a new attempt — because the steps share one checkout.
 */
export async function rerunCheck(
  env: Env,
  logger: Logger,
  args: {
    change: Change;
    project: ProjectEntry;
    checkId: string;
    workspaceRemote: string;
    requestOrigin?: string;
  },
): Promise<Result<{ check: CheckRun; dispatchFailure: string | null }, AppError>> {
  const { change, project, checkId, workspaceRemote } = args;

  const found = await getCheckRun(env.DB, logger, checkId);
  if (!found.success) return err(new AppError(found.error.message, "DATABASE_ERROR", 500));
  // A run on another change is reported exactly like one that does not exist.
  if (found.data === null || found.data.check.changeId !== change.id) {
    return err(new AppError(`Check run '${checkId}' not found`, "NOT_FOUND", 404));
  }
  const { check, superseded } = found.data;

  if (change.status === "evaluating") {
    return err(
      new AppError(
        "Evaluation is still pending; its checks are dispatched when it finishes",
        "EVALUATION_PENDING",
        409,
      ),
    );
  }
  if (["merged", "rejected", "reverted"].includes(change.status)) {
    return err(new AppError(`Cannot re-run a check on a ${change.status} change`, "CONFLICT", 409));
  }
  if (change.evaluatedSha === undefined || change.evaluatedSha !== check.revision) {
    return err(
      new AppError(
        "This check ran against a revision the change has moved on from; re-evaluate the change instead",
        "STALE_REVISION",
        409,
      ),
    );
  }
  if (superseded) {
    return err(
      new AppError("A newer run of this check exists; re-run that one", "CHECK_SUPERSEDED", 409),
    );
  }

  const [projectToken, workspaceToken] = await Promise.all([
    freshRepoToken(env.ARTIFACTS, project.remote, "read", logger),
    freshRepoToken(env.ARTIFACTS, workspaceRemote, "read", logger),
  ]);
  if (!projectToken.success) {
    return err(new AppError(projectToken.error.message, projectToken.error.code, 500));
  }
  if (!workspaceToken.success) {
    return err(new AppError(workspaceToken.error.message, workspaceToken.error.code, 500));
  }

  const branch = projectDefaultBranch(project);
  const policy = await loadPolicy(
    project.remote,
    projectToken.data,
    logger,
    branch,
    llmProviderCatalog(env, logger),
  );
  if (policy.configError) return err(new AppError(policy.configError, "POLICY_INVALID", 409));
  const entry = checksEntries(policy).find((candidate) => candidate.checks.includes(check.name));
  const ci =
    policy.ci !== undefined && ciStepNames(policy.ci).includes(check.name) ? policy.ci : undefined;
  if (!entry && ci === undefined) {
    return err(
      new AppError(
        `The project's policy no longer declares a check named '${check.name}'`,
        "CHECK_NOT_DECLARED",
        409,
      ),
    );
  }

  const diffResult = await getDiffBetweenRepos(
    project.remote,
    projectToken.data,
    workspaceRemote,
    workspaceToken.data,
    logger,
    branch,
  );
  if (!diffResult.success) {
    return err(new AppError(diffResult.error.message, diffResult.error.code, 400));
  }
  if (diffResult.data.workspaceOid !== check.revision) {
    return err(
      new AppError(
        "The workspace has advanced since this revision was evaluated; re-evaluate the change instead",
        "STALE_REVISION",
        409,
      ),
    );
  }

  const target: CheckDispatchTarget = {
    changeId: change.id,
    project,
    policy,
    diff: diffResult.data.diff,
    baseSha: diffResult.data.baseOid,
    headSha: check.revision,
    headTreeSha: diffResult.data.workspaceTreeOid,
    ...(args.requestOrigin !== undefined ? { requestOrigin: args.requestOrigin } : {}),
  };
  const result = entry
    ? await dispatchEntry(env, logger, target, entry, [check.name], "same-names")
    : ci !== undefined
      ? await dispatchCiJob(env, logger, target, ci, "same-names")
      : err(new Error("Check is not declared"));
  if (!result.success) return err(new AppError(result.error.message, "DATABASE_ERROR", 500));
  const rerun = result.data.runs.find((run) => run.name === check.name);
  if (!rerun) return err(new AppError("Check run was not created", "INTERNAL_ERROR", 500));
  return ok({ check: rerun, dispatchFailure: result.data.failure });
}

/** Why a signed report was not applied. Each maps to one HTTP status in the route. */
export type CheckReportConflict =
  /** The report names a revision, or arrives for a change, that has moved on. */
  | "STALE_REVISION"
  /** A re-run replaced this check run; its id is no longer the one that counts. */
  | "CHECK_SUPERSEDED"
  /** The check already reached a terminal state. */
  | "CHECK_TERMINAL"
  /** The deadline passed before a terminal report arrived. */
  | "CHECK_DEADLINE_EXCEEDED";

export type CheckReportOutcome =
  /**
   * Unknown check, missing or malformed signature, wrong signature, or a key
   * that cannot be resolved. Deliberately one outcome: an unsigned caller must
   * not be able to tell which, or it could probe for check ids.
   */
  | { kind: "unauthenticated" }
  /** Signed, but not a usable report. */
  | { kind: "invalid"; message: string }
  /** Signed and well-formed, but not allowed to land. Nothing was written. */
  | { kind: "conflict"; code: CheckReportConflict; message: string; check: CheckRun }
  /** `applied: false` is an acknowledged redelivery: nothing changed. */
  | { kind: "ok"; applied: boolean; check: CheckRun }
  | { kind: "error"; message: string };

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

/** The key first-party check runs are verified with, in `resolveSigningKey`'s shape. */
function executorSigningKey(
  env: Env,
): { status: "resolved"; key: string } | { status: "unavailable"; reason: string } {
  const executor = ciExecutorConfig(env);
  return executor.status === "configured"
    ? { status: "resolved", key: executor.secret }
    : { status: "unavailable", reason: executor.reason };
}

/**
 * Parse and validate a runner's report for `checkId`. Returns the report, or
 * the reason it is malformed. Called only after the signature has verified.
 */
function parseReport(raw: string, checkId: string): CheckReportBody | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "body is not valid JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "body must be a JSON object";
  }
  const body = parsed as Record<string, unknown>;

  if (body.checkRunId !== checkId) {
    return "checkRunId must equal the check run id in the URL";
  }
  if (typeof body.headSha !== "string" || body.headSha.length === 0) {
    return "headSha is required";
  }
  if (
    typeof body.status !== "string" ||
    !(REPORTABLE_CHECK_STATUSES as readonly string[]).includes(body.status)
  ) {
    return `status must be one of ${REPORTABLE_CHECK_STATUSES.join(", ")}`;
  }
  if (
    typeof body.sequence !== "number" ||
    !Number.isSafeInteger(body.sequence) ||
    body.sequence < 1
  ) {
    return "sequence must be a positive integer that increases with every report";
  }
  if (body.summary !== undefined && typeof body.summary !== "string") {
    return "summary must be a string";
  }

  const report: CheckReportBody = {
    checkRunId: checkId,
    headSha: body.headSha,
    status: body.status as ReportableCheckStatus,
    sequence: body.sequence,
  };
  if (typeof body.summary === "string") {
    report.summary = body.summary.slice(0, MAX_CHECK_SUMMARY_LENGTH);
  }
  if (body.detailsUrl !== undefined) {
    // Rendered as a link on the change page, so it must be a plain web URL:
    // no `javascript:`, and no credentials a viewer's click would send on.
    const detailsUrl = body.detailsUrl;
    let url: URL | null = null;
    if (typeof detailsUrl === "string" && detailsUrl.length <= MAX_CHECK_DETAILS_URL_LENGTH) {
      try {
        url = new URL(detailsUrl);
      } catch {
        url = null;
      }
    }
    if (
      url === null ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return `detailsUrl must be an http(s) URL without credentials, at most ${MAX_CHECK_DETAILS_URL_LENGTH} characters`;
    }
    report.detailsUrl = url.toString();
  }
  return report;
}

/**
 * Verify and apply one runner report.
 *
 * Order matters and is the security property: nothing about the check — not
 * even that it exists — is disclosed or acted on until the signature over the
 * raw body has been verified with the key of the project the check belongs
 * to. Everything after that point answers a caller who holds that key.
 *
 * Replay is handled in three layers. The signed body names its own check run
 * and revision, so a captured report cannot be pointed at another check or a
 * later revision. `sequence` makes a redelivered or reordered report a no-op.
 * And a terminal state is final, so nothing replayed can reopen a result.
 */
export async function reportCheck(
  env: Env,
  logger: Logger,
  args: { checkId: string; rawBody: string; signatureHeader: string | undefined; now?: Date },
): Promise<CheckReportOutcome> {
  const { checkId, rawBody } = args;
  const now = args.now ?? new Date();

  const presented = SIGNATURE_PATTERN.exec(args.signatureHeader ?? "")?.[1]?.toLowerCase();
  if (presented === undefined) return { kind: "unauthenticated" };

  const found = await getCheckRun(env.DB, logger, checkId);
  if (!found.success) return { kind: "error", message: "Could not read the check run" };
  if (found.data === null) return { kind: "unauthenticated" };
  const { check, superseded } = found.data;

  // A first-party run is verified against the instance's executor secret and
  // nothing else. The branch is on the row's own marker, set at creation from
  // the base config — not on anything the caller sent — so a project's runner
  // key cannot report a CI step, and the executor's cannot report a project's.
  const signing =
    check.ciConfigDigest !== undefined
      ? executorSigningKey(env)
      : await resolveSigningKey(
          { secretRef: check.secretRef },
          { env, projectId: check.projectId },
          logger,
          "check callback",
        );
  if (signing.status !== "resolved") {
    // The reason stays in the log: telling an unsigned caller that a project's
    // secret is missing would disclose both the check and its configuration.
    logger.warn("Check callback refused: signing secret unavailable", {
      checkId,
      reason: signing.status === "unavailable" ? signing.reason : "unsigned",
    });
    return { kind: "unauthenticated" };
  }
  const expected = await hmacSha256Hex(signing.key, rawBody);
  // Both sides are 64 hex characters, so the length short-circuit in
  // `constantTimeEqual` reveals nothing.
  if (!constantTimeEqual(presented, expected)) {
    logger.warn("Check callback refused: signature mismatch", { checkId });
    return { kind: "unauthenticated" };
  }

  const report = parseReport(rawBody, checkId);
  if (typeof report === "string") return { kind: "invalid", message: report };

  const conflict = (code: CheckReportConflict, message: string): CheckReportOutcome => ({
    kind: "conflict",
    code,
    message,
    check,
  });

  if (report.headSha !== check.revision) {
    return conflict("STALE_REVISION", "headSha is not the revision this check was dispatched for");
  }
  // A redelivery of something already applied, or an older report arriving
  // late. Acknowledged so a runner retrying a lost response stops retrying.
  if (report.sequence <= check.lastSequence) return { kind: "ok", applied: false, check };
  if (superseded) {
    return conflict("CHECK_SUPERSEDED", "A newer run of this check has replaced this one");
  }

  const change = await getChange(env.DB, logger, check.changeId);
  if (!change.success && change.error.code !== "NOT_FOUND") {
    return { kind: "error", message: "Could not read the change" };
  }
  if (!change.success || change.data.evaluatedSha !== check.revision) {
    return conflict(
      "STALE_REVISION",
      "The change has moved on from the revision this check was dispatched for",
    );
  }
  if (isTerminalCheckStatus(check.status)) {
    return conflict("CHECK_TERMINAL", `This check already finished as ${check.status}`);
  }

  const nowIso = now.toISOString();
  if (check.deadlineAt <= nowIso) {
    // The sweep would do this within five minutes; doing it here means a late
    // report sees the state it is about to be refused for.
    await failCheckRuns(env.DB, logger, {
      ids: [check.id],
      summary: CHECK_SUMMARY_DEADLINE,
      now: nowIso,
    });
    return {
      kind: "conflict",
      code: "CHECK_DEADLINE_EXCEEDED",
      message: "This check's deadline has passed",
      check: {
        ...check,
        status: "errored",
        summary: CHECK_SUMMARY_DEADLINE,
        completedAt: nowIso,
      },
    };
  }

  const applied = await applyCheckReport(env.DB, logger, {
    id: check.id,
    status: report.status,
    sequence: report.sequence,
    ...(report.summary !== undefined ? { summary: report.summary } : {}),
    ...(report.detailsUrl !== undefined ? { detailsUrl: report.detailsUrl } : {}),
    now: nowIso,
  });
  if (!applied.success) return { kind: "error", message: "Could not record the report" };
  if (applied.data.applied) {
    logger.info("Check report applied", {
      checkId,
      changeId: check.changeId,
      name: check.name,
      status: report.status,
    });
    return { kind: "ok", applied: true, check: applied.data.check };
  }

  // The guarded UPDATE matched nothing: another report or a re-run won the
  // race after the read above. Answer from what is stored now.
  const current = await getCheckRun(env.DB, logger, checkId);
  if (!current.success || current.data === null) {
    return { kind: "error", message: "Could not read the check run" };
  }
  const latest = current.data;
  if (report.sequence <= latest.check.lastSequence) {
    return { kind: "ok", applied: false, check: latest.check };
  }
  return {
    kind: "conflict",
    code: latest.superseded ? "CHECK_SUPERSEDED" : "CHECK_TERMINAL",
    message: latest.superseded
      ? "A newer run of this check has replaced this one"
      : `This check already finished as ${latest.check.status}`,
    check: latest.check,
  };
}

/**
 * Flip every check run that is past its deadline to `errored` (#414). Runs on
 * the five-minute cron.
 *
 * This is bookkeeping, not the safety property: the merge gate already blocks
 * on a `queued` or `running` required check, so a runner that never reports
 * cannot make a change mergeable whether or not this has run. What the sweep
 * adds is a terminal state a person can read and re-run.
 */
export async function sweepOverdueChecks(
  env: Env,
  logger: Logger,
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const result = await expireOverdueChecks(env.DB, logger, now.toISOString());
  const expired = result.success ? result.data : 0;
  if (expired > 0) logger.warn("Expired check runs past their deadline", { expired });
  return { expired };
}
