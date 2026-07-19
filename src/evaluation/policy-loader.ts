import YAML from "yaml";
import { readFileFromRepo } from "../storage/git-ops";
import type { Logger } from "../utils/logger";
import type { EvalPolicy, MergePolicy } from "./types";

const DEFAULT_POLICY: EvalPolicy = {
  evaluators: [{ type: "diff" }],
  requireAll: true,
  minScore: 0.7,
};

type PolicyLoad =
  | { status: "ok"; policy: EvalPolicy }
  | { status: "absent" }
  | { status: "malformed"; reason: string };

export async function loadPolicy(
  remote: string,
  token: string,
  logger: Logger,
): Promise<EvalPolicy> {
  const yaml = await readAndParsePolicy(remote, token, ".stratum/policy.yaml", "yaml", logger);
  if (yaml.status === "ok") return yaml.policy;
  if (yaml.status === "malformed")
    return malformedPolicy(".stratum/policy.yaml", yaml.reason, logger);

  const json = await readAndParsePolicy(remote, token, "stratum.config.json", "json", logger);
  if (json.status === "ok") return json.policy;
  if (json.status === "malformed")
    return malformedPolicy("stratum.config.json", json.reason, logger);

  return DEFAULT_POLICY;
}

/**
 * A policy file was present but unparseable. Do NOT silently fall back to the
 * permissive default — log loudly and carry a configError so the merge gate
 * fails closed until the file is fixed. Evaluation still runs (on the default
 * evaluators) so the change flow isn't wholly broken by a typo.
 */
function malformedPolicy(path: string, reason: string, logger: Logger): EvalPolicy {
  const configError = `Policy file ${path} is present but invalid (${reason}); merges are blocked until it is fixed.`;
  logger.error("Malformed policy file — failing merge gate closed", undefined, { path, reason });
  return { ...DEFAULT_POLICY, configError };
}

async function readAndParsePolicy(
  remote: string,
  token: string,
  path: string,
  format: "json" | "yaml",
  logger: Logger,
): Promise<PolicyLoad> {
  try {
    const contentResult = await readFileFromRepo(remote, token, path, logger);
    if (!contentResult.success) return { status: "absent" };

    const content = contentResult.data;
    if (content === null || content === undefined) return { status: "absent" };

    let parsed: unknown;
    try {
      parsed = format === "json" ? JSON.parse(content) : YAML.parse(content);
    } catch (e) {
      return { status: "malformed", reason: e instanceof Error ? e.message : "parse error" };
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("evaluators" in parsed) ||
      !Array.isArray((parsed as Record<string, unknown>).evaluators)
    ) {
      return { status: "malformed", reason: "missing or non-array 'evaluators'" };
    }

    const merge = sanitizeMergePolicy((parsed as Record<string, unknown>).merge);
    const {
      merge: _unsanitized,
      configError: _ce,
      ...policy
    } = {
      ...DEFAULT_POLICY,
      ...(parsed as Partial<EvalPolicy>),
    };
    return { status: "ok", policy: merge ? { ...policy, merge } : policy };
  } catch {
    // A read error (not a parse error) — treat as absent so a transient repo-read
    // blip doesn't block every merge.
    return { status: "absent" };
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
  if (typeof source.requireFreshBase === "boolean") {
    merge.requireFreshBase = source.requireFreshBase;
  }
  if (typeof source.postMergeCommand === "string" && source.postMergeCommand.trim()) {
    merge.postMergeCommand = source.postMergeCommand.trim();
  }
  if (
    typeof source.postMergeTimeoutMs === "number" &&
    Number.isFinite(source.postMergeTimeoutMs) &&
    source.postMergeTimeoutMs > 0
  ) {
    merge.postMergeTimeoutMs = source.postMergeTimeoutMs;
  }
  if (typeof source.autoRevert === "boolean") {
    merge.autoRevert = source.autoRevert;
  }

  return Object.keys(merge).length > 0 ? merge : null;
}
