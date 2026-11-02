import { runBackup } from "./backup/run-backup";
import { sweepDeletionJobs } from "./queue/deletion-runner";
import { sweepStaleEvents } from "./queue/event-consumer";
import { runImportSweep } from "./queue/import-sweep";
import { runTtlSweep } from "./queue/ttl-sweep";
import { syncAllProjects } from "./routes/sync";
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
  | "oidc-state-purge";

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
 */
export function jobsForCron(cron: string): ScheduledJob[] {
  switch (cron) {
    case "*/5 * * * *":
      return ["event-sweep", "deletion-sweep", "import-sweep", "oauth-code-sweep"];
    case "0 4 * * *":
      return ["backup"];
    case "0 6 * * *":
      return ["ttl-sweep", "project-sync", "import-cleanup", "oidc-state-purge"];
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
  "import-cleanup": (env, logger) => cleanupOldImports(env.DB, IMPORT_RETENTION_DAYS, logger),
  "oauth-code-sweep": (env, logger) => sweepExpiredAuthorizationCodes(env.DB, logger),
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
