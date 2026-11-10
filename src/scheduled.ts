import { runBackup } from "./backup/run-backup";
import { sweepPushMirrors } from "./github/mirror";
import { sweepDeletionJobs } from "./queue/deletion-runner";
import { sweepStaleEvents } from "./queue/event-consumer";
import { runImportSweep } from "./queue/import-sweep";
import { runTtlSweep } from "./queue/ttl-sweep";
import { syncAllProjects } from "./routes/sync";
import { sweepOverdueChecks } from "./services/check-runs";
import { sweepOverdueDeployments } from "./services/deploy-reports";
import { runEvaluationHealthCheck } from "./services/evaluation-health";
import { sweepStuckEvaluations } from "./services/evaluation-run";
import { purgeExpiredAgentSignups } from "./storage/agent-signups";
import { cleanupOldImports } from "./storage/imports";
import { sweepExpiredAuthorizationCodes } from "./storage/oauth";
import { purgeExpiredOidcStates } from "./storage/sso";
import type { Env } from "./types";
import type { Logger } from "./utils/logger";

export type ScheduledJob =
  | "event-sweep"
  | "deletion-sweep"
  | "import-sweep"
  | "backup"
  | "ttl-sweep"
  | "project-sync"
  | "import-cleanup"
  | "oauth-code-sweep"
  | "oidc-state-purge"
  | "agent-signup-purge"
  | "evaluation-sweep"
  | "check-deadline-sweep"
  | "mirror-sweep"
  | "deploy-report-sweep"
  | "evaluation-health";

/** How long a finished import job is kept before `import-cleanup` prunes it. */
const IMPORT_RETENTION_DAYS = 30;

/**
 * Cron → jobs routing. Backup runs on its OWN trigger (`0 4 * * *`), isolated
 * from the 06:00 housekeeping: a single Worker invocation has a ~15-minute
 * wall-clock budget, and a slow `project-sync` sharing that budget could starve
 * or truncate the DR-critical backup. Keeping them on separate crons gives each
 * the full invocation budget.
 *
 * `import-sweep` is safe on the 5-minute tick despite that reasoning: it is one
 * indexed query plus at most `SWEEP_BATCH_LIMIT` small writes, and recovery
 * speed is the point — the job it reaps is one a user is staring at.
 *
 * `oauth-code-sweep` rides the same tick for the same reason: it is one bounded
 * SELECT plus a chunked DELETE, and its warning — authorization codes that
 * expired without being redeemed — is a signal about a connection someone is
 * trying to make right now.
 *
 * `evaluation-health` rides the 06:00 housekeeping: at most four model calls
 * and two counting queries, once a day, which is as often as its alert is
 * worth reading.
 *
 * `evaluation-sweep` (#412) is the same shape — one indexed query, a bounded
 * batch of conditional writes and queue sends — and the change it recovers is
 * one whose author is waiting on a verdict.
 *
 * `check-deadline-sweep` (#414) is a single indexed UPDATE: check runs still
 * `queued` or `running` past their deadline become `errored`.
 *
 * `mirror-sweep` (#417) re-sends push-mirror nudges the queue lost: one indexed
 * query and a bounded batch of queue sends. With no mirror queue bound it
 * pushes a few mirrors inline instead, which is the only way they move then.
 *
 * `deploy-report-sweep` (#416) is one indexed query and a conditional write per
 * row it finds: a pipeline deployment the CI executor never reported on is
 * failed, so it stops holding its environment.
 */
export function jobsForCron(cron: string): ScheduledJob[] {
  switch (cron) {
    case "*/5 * * * *":
      return [
        "event-sweep",
        "deletion-sweep",
        "import-sweep",
        "oauth-code-sweep",
        "evaluation-sweep",
        "check-deadline-sweep",
        "mirror-sweep",
        "deploy-report-sweep",
      ];
    case "0 4 * * *":
      return ["backup"];
    case "0 6 * * *":
      return [
        "ttl-sweep",
        "project-sync",
        "import-cleanup",
        "oidc-state-purge",
        "agent-signup-purge",
        "evaluation-health",
      ];
    default:
      return [];
  }
}

export type JobRunners = Record<ScheduledJob, (env: Env, logger: Logger) => Promise<unknown>>;

const JOB_RUNNERS: JobRunners = {
  "event-sweep": (env, logger) => sweepStaleEvents(env, logger),
  "deletion-sweep": (env, logger) => sweepDeletionJobs(env, logger),
  "import-sweep": (env, logger) => runImportSweep(env, logger),
  backup: (env, logger) => runBackup(env, logger, new Date().toISOString()),
  "ttl-sweep": (env, logger) => runTtlSweep(env, logger),
  "project-sync": (env) => syncAllProjects(env),
  "oidc-state-purge": (env, logger) => purgeExpiredOidcStates(env.DB, logger),
  "agent-signup-purge": (env, logger) => purgeExpiredAgentSignups(env.DB, logger),
  "import-cleanup": (env, logger) => cleanupOldImports(env.DB, IMPORT_RETENTION_DAYS, logger),
  "oauth-code-sweep": (env, logger) => sweepExpiredAuthorizationCodes(env.DB, logger),
  "evaluation-sweep": (env, logger) => sweepStuckEvaluations(env, logger),
  "check-deadline-sweep": (env, logger) => sweepOverdueChecks(env, logger),
  "mirror-sweep": (env, logger) => sweepPushMirrors(env, logger),
  "deploy-report-sweep": (env, logger) => sweepOverdueDeployments(env, logger),
  "evaluation-health": (env, logger) => runEvaluationHealthCheck(env, logger),
};

/**
 * Dispatch the jobs for a cron event. Each job is registered independently with
 * `waitUntil` (rather than a single `Promise.all`) so one failing job cannot
 * reject the others. `waitUntil` and `runners` are injected so this stays
 * unit-testable without executing the real jobs.
 */
export function runScheduledJobs(
  cron: string,
  env: Env,
  logger: Logger,
  waitUntil: (promise: Promise<unknown>) => void,
  runners: JobRunners = JOB_RUNNERS,
): void {
  for (const job of jobsForCron(cron)) {
    waitUntil(runners[job](env, logger));
  }
}
