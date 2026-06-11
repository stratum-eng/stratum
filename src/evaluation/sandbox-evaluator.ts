import type { SandboxBinding } from "../types";
import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

function parseDiffFiles(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  const lines = diff.split("\n");
  let currentPath: string | null = null;
  const contentLines: string[] = [];

  const flush = () => {
    if (currentPath !== null) {
      files.set(currentPath, contentLines.join("\n"));
    }
  };

  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      flush();
      currentPath = line.slice(6);
      contentLines.length = 0;
    } else if (
      currentPath !== null &&
      !line.startsWith("--- ") &&
      !line.startsWith("diff ") &&
      !line.startsWith("index ") &&
      !line.startsWith("@@ ")
    ) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        contentLines.push(line.slice(1));
      }
    }
  }

  flush();
  return files;
}

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

export class SandboxEvaluator implements Evaluator {
  constructor(private sandbox: SandboxBinding) {}

  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting sandbox evaluation");

    const config = policy.evaluators.find((e) => e.type === "sandbox") as
      | { type: "sandbox"; command?: string; timeoutMs?: number }
      | undefined;

    if (!config) {
      logger.info("No sandbox evaluator configured");
      return ok({ score: 1.0, passed: true, reason: "No sandbox evaluator configured" });
    }

    const command = config.command ?? "npm test";
    const timeoutMs = config.timeoutMs ?? 60_000;
    const minScore = policy.minScore ?? 0.7;

    logger.debug("Sandbox config", { command, timeoutMs });

    const files = parseDiffFiles(diff);
    let sb: Awaited<ReturnType<SandboxBinding["create"]>> | null = null;

    try {
      sb = await this.sandbox.create();
      logger.debug("Sandbox created");

      for (const [path, content] of files) {
        await sb.writeFile(path, content);
      }
      logger.debug("Files written to sandbox", { fileCount: files.size });

      const runStartedAt = Date.now();
      const result = await sb.run(command, { timeout: timeoutMs });
      const sandboxMs = Date.now() - runStartedAt;
      logger.debug("Sandbox command completed", { exitCode: result.exitCode, sandboxMs });

      let score: number;
      if (result.exitCode === 0) {
        score = 1.0;
      } else {
        const parsed = parseTestOutput(result.stdout, result.stderr);
        score = parsed ?? 0.0;
      }

      const passed = score >= minScore;
      const reason = (result.stdout + result.stderr).slice(0, 500).trim();

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
