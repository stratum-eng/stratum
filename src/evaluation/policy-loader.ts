import YAML from "yaml";
import { readFileFromRepo } from "../storage/git-ops";
import type { Logger } from "../utils/logger";
import type { EvalPolicy } from "./types";

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

    return { ...DEFAULT_POLICY, ...(parsed as Partial<EvalPolicy>) };
  } catch {
    return null;
  }
}
