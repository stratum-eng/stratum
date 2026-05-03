import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { ok } from "../utils/result";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

const DEFAULT_MAX_LINES = 500;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_FORBIDDEN_PATTERNS = ["*.lock", "node_modules/", ".env"];

function matchesGlob(pattern: string, path: string): boolean {
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(path) || new RegExp(escaped).test(path);
  }
  return path.includes(pattern);
}

function parseAddedFilePaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const path = line.slice(6);
      if (path) paths.push(path);
    }
  }
  return paths;
}

function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) count++;
    if (line.startsWith("-") && !line.startsWith("---")) count++;
  }
  return count;
}

function countFiles(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) count++;
  }
  return count;
}

export class DiffEvaluator implements Evaluator {
  async evaluate(
    diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting diff evaluation");

    const config = policy.evaluators.find((e) => e.type === "diff");
    if (!config || config.type !== "diff") {
      logger.info("No diff config found, passing by default");
      return ok({ score: 1.0, passed: true, reason: "No diff config found, passing by default." });
    }

    const maxLines = config.maxLines ?? DEFAULT_MAX_LINES;
    const maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES;
    const forbiddenPatterns = config.forbiddenPatterns ?? DEFAULT_FORBIDDEN_PATTERNS;
    const requiredPatterns = config.requiredPatterns ?? [];
    const minScore = policy.minScore ?? 0.7;

    const violations: string[] = [];
    const addedPaths = parseAddedFilePaths(diff);
    const changedLines = countChangedLines(diff);
    const fileCount = countFiles(diff);

    logger.debug("Diff stats", { changedLines, fileCount, addedPaths: addedPaths.length });

    if (changedLines > maxLines) {
      violations.push(`Changed lines (${changedLines}) exceeds maxLines (${maxLines})`);
    }

    if (fileCount > maxFiles) {
      violations.push(`File count (${fileCount}) exceeds maxFiles (${maxFiles})`);
    }

    for (const pattern of forbiddenPatterns) {
      for (const path of addedPaths) {
        if (matchesGlob(pattern, path)) {
          violations.push(`File "${path}" matches forbidden pattern "${pattern}"`);
          break;
        }
      }
    }

    for (const pattern of requiredPatterns) {
      const matches = addedPaths.some((path) => matchesGlob(pattern, path));
      if (!matches) {
        violations.push(`No added file matches required pattern "${pattern}"`);
      }
    }

    const score = Math.max(0.0, 1.0 - violations.length * 0.25);
    const passed = score >= minScore;
    const reason =
      violations.length === 0 ? "Diff passed all checks." : `Diff failed: ${violations.join("; ")}`;

    if (violations.length > 0) {
      logger.info("Diff evaluation found violations", { violationCount: violations.length, score });
      return ok({ score, passed, reason, issues: violations });
    }

    logger.info("Diff evaluation complete", { score, passed });
    return ok({ score, passed, reason });
  }
}
