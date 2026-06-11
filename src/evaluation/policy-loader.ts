import YAML from "yaml";
import { readFileFromRepo } from "../storage/git-ops";
import type { Logger } from "../utils/logger";
import type { EvalPolicy, MergePolicy } from "./types";

const DEFAULT_POLICY: EvalPolicy = {
  evaluators: [{ type: "diff" }],
  requireAll: true,
  minScore: 0.7,
};

export async function loadPolicy(
  remote: string,
  token: string,
  logger: Logger,
): Promise<EvalPolicy> {
  const yamlPolicy = await readAndParsePolicy(
    remote,
    token,
    ".stratum/policy.yaml",
    "yaml",
    logger,
  );
  if (yamlPolicy) return yamlPolicy;

  const jsonPolicy = await readAndParsePolicy(remote, token, "stratum.config.json", "json", logger);
  if (jsonPolicy) return jsonPolicy;

  return DEFAULT_POLICY;
}

async function readAndParsePolicy(
  remote: string,
  token: string,
  path: string,
  format: "json" | "yaml",
  logger: Logger,
): Promise<EvalPolicy | null> {
  try {
    const contentResult = await readFileFromRepo(remote, token, path, logger);
    if (!contentResult.success) return null;

    const content = contentResult.data;
    if (content === null || content === undefined) return null;

    let parsed: unknown;
    try {
      parsed = format === "json" ? JSON.parse(content) : YAML.parse(content);
    } catch {
      return null;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("evaluators" in parsed) ||
      !Array.isArray((parsed as Record<string, unknown>).evaluators)
    ) {
      return null;
    }

    const merge = sanitizeMergePolicy((parsed as Record<string, unknown>).merge);
    const { merge: _unsanitized, ...policy } = {
      ...DEFAULT_POLICY,
      ...(parsed as Partial<EvalPolicy>),
    };
    return merge ? { ...policy, merge } : policy;
  } catch {
    return null;
  }
}

/** Keep only well-typed merge-protection fields from user-supplied config. */
function sanitizeMergePolicy(raw: unknown): MergePolicy | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const merge: MergePolicy = {};

  if (
    typeof source.requiredApprovals === "number" &&
    Number.isInteger(source.requiredApprovals) &&
    source.requiredApprovals >= 0
  ) {
    merge.requiredApprovals = source.requiredApprovals;
  }
  if (
    Array.isArray(source.requiredEvaluators) &&
    source.requiredEvaluators.every((entry) => typeof entry === "string")
  ) {
    merge.requiredEvaluators = source.requiredEvaluators;
  }
  if (typeof source.allowForce === "boolean") {
    merge.allowForce = source.allowForce;
  }

  return Object.keys(merge).length > 0 ? merge : null;
}
