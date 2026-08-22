import { readRepoFiles } from "../storage/git-ops";
import type { SandboxBinding } from "../types";
import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

const DEFAULT_COMMAND = "npm test";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_IN_REASON = 500;

/**
 * Read access to the workspace repo whose tree is being evaluated. Threaded in
 * by `buildEvaluators` so the sandbox runs against the FULL workspace tree
 * (the evaluated commit), not a reconstruction from diff hunks.
 */
export interface SandboxRepoAccess {
  /** The workspace repo remote. */
  remote: string;
  /** A read-scoped token for that remote. */
  token: string;
  /** The evaluated commit sha (pinned as evaluated_sha). HEAD when absent. */
  ref?: string;
}

/** Reads a repo tree into path → contents; injectable for tests. */
export type RepoFilesReader = (
  remote: string,
  token: string,
  logger: Logger,
  ref?: string,
) => Promise<Result<Map<string, string>, AppError>>;

/**
 * Derives a pass ratio from a test runner's own summary line.
 *
 * Scored from the summary rather than the exit code because the exit code is
 * binary: a suite where 99 of 100 tests pass is indistinguishable from one
 * where none do. Both patterns are tried because runners disagree on whether
 * a clean run prints a "failed" count at all — vitest and jest omit it, so
 * "N passed" alone has to be accepted, with `failed` re-matched separately
 * rather than assumed zero from the first pattern.
 *
 * Returns `null`, never 0, when nothing parses: an unrecognised format means
 * the score is *unknown*, and reporting that as a zero would fail a change on
 * the runner's output format instead of on its tests.
 */
function parseTestOutput(stdout: string, stderr: string): number | null {
  const combined = `${stdout}\n${stderr}`;

  const match =
    combined.match(/(\d+)\s+passed[,\s]+(\d+)\s+failed/i) ?? combined.match(/(\d+)\s+passed/i);

  if (match) {
    const passed = Number.parseInt(match[1] ?? "0", 10);
    const failedMatch = combined.match(/(\d+)\s+failed/i);
    const failed = failedMatch ? Number.parseInt(failedMatch[1] ?? "0", 10) : 0;
    const total = passed + failed;
    if (total === 0) return null;
    return passed / total;
  }

  return null;
}

/** The lockfile names `npm ci` accepts. */
const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

/**
 * A lockfile means the dependency tree is already pinned, so `npm ci` installs
 * it verbatim — an evaluation score only means something if every run resolves
 * the same versions. Without one, `npm install` is the best available
 * (unpinned) approximation; without a package.json there is nothing to install,
 * because the repo is not an npm project. `--no-audit --no-fund` skip registry
 * round trips the evaluation has no use for.
 */
export function installCommandFor(files: ReadonlyMap<string, string>): string | null {
  if (!files.has("package.json")) return null;
  const base = NPM_LOCKFILES.some((lockfile) => files.has(lockfile)) ? "npm ci" : "npm install";
  return `${base} --no-audit --no-fund`;
}

export class SandboxEvaluator implements Evaluator {
  constructor(
    private sandbox: SandboxBinding,
    private repo: SandboxRepoAccess,
    private readFiles: RepoFilesReader = readRepoFiles,
  ) {}

  /**
   * Runs the configured command against the full evaluated tree in a sandbox.
   *
   * The `_diff` argument is ignored on purpose. The evaluator that this
   * replaced reconstructed a pseudo-tree from the diff's `+` lines, which
   * could not run any real suite — no base tree, no untouched sources, no
   * `package.json` unless it happened to change. The tree is read from the
   * pinned commit instead, so the sandbox holds exactly what the merge would
   * land. The parameter stays because it is part of the `Evaluator` contract
   * shared with the diff-based evaluators.
   *
   * Every failure path scores 0 and `passed: false` rather than returning an
   * error: an evaluation that could not run must not read as one that passed.
   */
  async evaluate(
    _diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting sandbox evaluation");

    const config = policy.evaluators.find((e) => e.type === "sandbox") as
      | { type: "sandbox"; command?: string; timeoutMs?: number; installTimeoutMs?: number }
      | undefined;

    if (!config) {
      logger.info("No sandbox evaluator configured");
      return ok({ score: 1.0, passed: true, reason: "No sandbox evaluator configured" });
    }

    const command = config.command ?? DEFAULT_COMMAND;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const installTimeoutMs = config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    const minScore = policy.minScore ?? 0.7;

    logger.debug("Sandbox config", { command, timeoutMs, installTimeoutMs });

    let sb: Awaited<ReturnType<SandboxBinding["create"]>> | null = null;

    try {
      // Materialize the full workspace tree at the evaluated commit — the same
      // tree the merge would land — so the command runs against real sources,
      // not just the added lines of the diff.
      const filesResult = await this.readFiles(
        this.repo.remote,
        this.repo.token,
        logger,
        this.repo.ref,
      );
      if (!filesResult.success) {
        logger.error("Could not read workspace tree for sandbox", filesResult.error);
        return err(
          new ExternalServiceError(
            "Sandbox",
            `Could not read workspace tree: ${filesResult.error.message}`,
          ) as AppError,
        );
      }
      const files = filesResult.data;

      sb = await this.sandbox.create();
      const instance = sb;
      logger.debug("Sandbox created");

      // The full tree can hold thousands of files; one round trip per file
      // dominates evaluation latency, so write in bounded concurrent batches.
      const WRITE_CONCURRENCY = 16;
      const entries = [...files];
      for (let i = 0; i < entries.length; i += WRITE_CONCURRENCY) {
        await Promise.all(
          entries
            .slice(i, i + WRITE_CONCURRENCY)
            .map(([path, content]) => instance.writeFile(path, content)),
        );
      }
      logger.debug("Files written to sandbox", { fileCount: files.size });

      let sandboxMs = 0;

      const installCommand = installCommandFor(files);
      if (installCommand !== null) {
        const installStartedAt = Date.now();
        const install = await sb.run(installCommand, { timeout: installTimeoutMs });
        sandboxMs += Date.now() - installStartedAt;
        logger.debug("Sandbox install completed", {
          installCommand,
          exitCode: install.exitCode,
        });
        if (install.exitCode !== 0) {
          const output = (install.stdout + install.stderr).slice(0, MAX_OUTPUT_IN_REASON).trim();
          logger.info("Sandbox evaluation failed at dependency install", { installCommand });
          return ok({
            score: 0,
            passed: false,
            reason: `Dependency install (${installCommand}) failed: ${output}`,
            costs: [{ kind: "sandbox_ms", quantity: sandboxMs }],
          });
        }
      }

      const runStartedAt = Date.now();
      const result = await sb.run(command, { timeout: timeoutMs });
      sandboxMs += Date.now() - runStartedAt;
      logger.debug("Sandbox command completed", { exitCode: result.exitCode, sandboxMs });

      let score: number;
      if (result.exitCode === 0) {
        score = 1.0;
      } else {
        const parsed = parseTestOutput(result.stdout, result.stderr);
        score = parsed ?? 0.0;
      }

      const passed = score >= minScore;
      const reason = (result.stdout + result.stderr).slice(0, MAX_OUTPUT_IN_REASON).trim();

      logger.info("Sandbox evaluation complete", { score, passed });
      return ok({ score, passed, reason, costs: [{ kind: "sandbox_ms", quantity: sandboxMs }] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        "Sandbox evaluation failed",
        error instanceof Error ? error : new Error(message),
      );
      return err(
        new ExternalServiceError(
          "Sandbox",
          message,
          error instanceof Error ? error : undefined,
        ) as AppError,
      );
    } finally {
      if (sb !== null) {
        await sb.destroy();
        logger.debug("Sandbox destroyed");
      }
    }
  }
}
