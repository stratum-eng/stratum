/**
 * The `deploy:` section of `.stratum/ci.yaml` (#416): the steps the executor
 * runs, per environment, for a commit that has merged.
 *
 * ```yaml
 * deploy:
 *   environments:
 *     - name: staging
 *       steps:
 *         - name: migrate
 *           run: npx wrangler d1 migrations apply app --remote --env staging
 *         - name: deploy
 *           run: npx wrangler deploy --env staging
 *     - name: production
 *       requiresApproval: true
 *       steps: [...]
 *       rollback:
 *         - name: rollback
 *           run: npx wrangler rollback "$STRATUM_ROLLBACK_VERSION" --env production -m rollback
 * ```
 *
 * It is read from the tree of the MERGED commit, never from a change: by the
 * time anything here runs, the commit has passed every gate the project has,
 * and `.stratum/ci.yaml` is protected configuration, so the pipeline that
 * deploys a commit is one a second person approved.
 *
 * Like the CI half of the file this parser refuses rather than repairs. An
 * unknown key fails the whole section, because the key most likely to be
 * mistyped is `requiresApproval`, and a pipeline that silently dropped it
 * would ship to production without the person it was meant to wait for.
 *
 * Unlike the CI half, a broken section does not block merges. Deploys run
 * after a merge, and blocking the merge gate on them would change what the
 * gate means; the same reasoning as `sanitizeDeploys`. A broken section
 * becomes a visible failed deployment instead, and nothing is deployed.
 */
import YAML from "yaml";
import {
  CI_INSTANCE_TYPES,
  type CiInstanceType,
  DEFAULT_CI_JOB_TIMEOUT_MINUTES,
  DEFAULT_CI_STEP_TIMEOUT_MINUTES,
  MAX_CI_ALLOW_HOSTS,
  MAX_CI_JOB_TIMEOUT_MINUTES,
  MAX_CI_RUN_LENGTH,
  MAX_CI_STEPS,
  MAX_CI_STEP_TIMEOUT_MINUTES,
} from "../evaluation/ci-config";
import { CHECK_NAME_PATTERN, CHECK_NAME_RULE } from "../evaluation/limits";

/** Most environments one pipeline may declare. Each is a deployment row per merge. */
export const MAX_DEPLOY_ENVIRONMENTS = 8;

/**
 * An environment's name is its deployment row's `name`: the identity that
 * history, supersession and per-environment serialization group by. The same
 * rule as a `deploys:` entry's name, so the two can never be told apart by
 * shape — a clash between them is reported instead.
 */
export const DEPLOY_ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** One command of a pipeline. The same shape as a CI step, minus `optional`. */
export interface DeployPipelineStep {
  name: string;
  /** A bash script, run with `set -eo pipefail` at the repository root. */
  run: string;
  timeoutSeconds: number;
}

/** One environment: where a commit is deployed, and what doing so runs. */
export interface DeployEnvironment {
  name: string;
  /** When true, the deployment waits at `pending_approval` for a person. */
  requiresApproval: boolean;
  steps: DeployPipelineStep[];
  /**
   * What a rollback to a recorded version runs instead of `steps`. Optional:
   * without it a rollback re-runs `steps` at the earlier commit.
   */
  rollback?: DeployPipelineStep[];
}

/** A validated `deploy:` section. Always a fresh object, never the parsed YAML. */
export interface DeployPipeline {
  /** In promotion order: a commit reaches an environment only after the one before it succeeded. */
  environments: DeployEnvironment[];
  /** Wall-clock limit for one environment's job, enforced from outside the container. */
  timeoutSeconds: number;
  /** Omitted means the executor's default size. */
  instance?: CiInstanceType;
  /** Exact hostnames added to the executor's allowlist for this project's deploy jobs. */
  allowHosts: string[];
}

export type DeployPipelineParse =
  /** The file has no `deploy:` section. Not an error: most projects have none. */
  | { status: "absent" }
  | { status: "ok"; pipeline: DeployPipeline }
  | { status: "malformed"; reason: string };

const SECTION_KEYS = new Set(["environments", "timeoutMinutes", "instance", "network"]);
const ENVIRONMENT_KEYS = new Set(["name", "requiresApproval", "steps", "rollback"]);
const STEP_KEYS = new Set(["name", "run", "timeoutMinutes"]);
const NETWORK_KEYS = new Set(["allow"]);

/** Same shape as `network.allow` in the CI half: one exact public hostname. */
const HOSTNAME_PATTERN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether a parsed YAML value is a mapping, as opposed to a list or a scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first key of `source` that is not allowed, shortened for a message. */
function strayKey(source: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(source)
    .find((key) => !allowed.has(key))
    ?.slice(0, 40);
}

/** A whole number of minutes inside `[1, max]`, as seconds; or why not. */
function minutes(raw: unknown, field: string, fallback: number, max: number): number | string {
  if (raw === undefined) return fallback * 60;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > max) {
    return `${field} must be a whole number of minutes from 1 to ${max}`;
  }
  return raw * 60;
}

/** Validate one list of steps (`steps` or `rollback`), or say what is wrong with it. */
function parseSteps(raw: unknown, at: string): DeployPipelineStep[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return `${at} must be a non-empty list of steps`;
  if (raw.length > MAX_CI_STEPS) {
    return `${at} declares ${raw.length} steps; at most ${MAX_CI_STEPS} are allowed`;
  }
  const steps: DeployPipelineStep[] = [];
  for (const [index, entry] of (raw as unknown[]).entries()) {
    const where = `${at}[${index}]`;
    if (!isRecord(entry)) return `${where} is not a step (expected 'name' and 'run')`;
    const stray = strayKey(entry, STEP_KEYS);
    if (stray !== undefined) {
      return `${where} has an unrecognized field '${stray}' (allowed: name, run, timeoutMinutes)`;
    }
    if (typeof entry.name !== "string" || !CHECK_NAME_PATTERN.test(entry.name)) {
      return `${where}.name ${CHECK_NAME_RULE}`;
    }
    if (steps.some((step) => step.name === entry.name)) {
      return `${at} declares step '${entry.name}' twice`;
    }
    if (typeof entry.run !== "string" || entry.run.trim() === "") {
      return `${where} ('${entry.name}') has no 'run' command`;
    }
    if (entry.run.length > MAX_CI_RUN_LENGTH || entry.run.includes("\0")) {
      return `${where} ('${entry.name}') 'run' must be at most ${MAX_CI_RUN_LENGTH} characters and contain no NUL`;
    }
    const timeoutSeconds = minutes(
      entry.timeoutMinutes,
      `${where}.timeoutMinutes`,
      DEFAULT_CI_STEP_TIMEOUT_MINUTES,
      MAX_CI_STEP_TIMEOUT_MINUTES,
    );
    if (typeof timeoutSeconds === "string") return timeoutSeconds;
    steps.push({ name: entry.name, run: entry.run, timeoutSeconds });
  }
  return steps;
}

/** Validate one environment, or say what is wrong with it. */
function parseEnvironment(raw: unknown, index: number): DeployEnvironment | string {
  const at = `deploy.environments[${index}]`;
  if (!isRecord(raw)) return `${at} is not an environment (expected 'name' and 'steps')`;
  const stray = strayKey(raw, ENVIRONMENT_KEYS);
  if (stray !== undefined) {
    return `${at} has an unrecognized field '${stray}' (allowed: name, requiresApproval, steps, rollback)`;
  }
  if (typeof raw.name !== "string" || !DEPLOY_ENVIRONMENT_NAME.test(raw.name)) {
    return `${at}.name must be lowercase letters, digits and dashes, starting with a letter, at most 32 characters`;
  }
  let requiresApproval = false;
  if (raw.requiresApproval !== undefined) {
    // A quoted "false" is truthy, and this field decides whether a deploy can
    // reach an environment without a person. Never coerced.
    if (typeof raw.requiresApproval !== "boolean") {
      return `${at}.requiresApproval must be true or false`;
    }
    requiresApproval = raw.requiresApproval;
  }
  const steps = parseSteps(raw.steps, `${at}.steps`);
  if (typeof steps === "string") return steps;
  const environment: DeployEnvironment = { name: raw.name, requiresApproval, steps };
  if (raw.rollback !== undefined) {
    const rollback = parseSteps(raw.rollback, `${at}.rollback`);
    if (typeof rollback === "string") return rollback;
    environment.rollback = rollback;
  }
  return environment;
}

/**
 * Validate an already-parsed `deploy:` value.
 *
 * Never throws. `undefined` and `null` are `absent`; anything else is either a
 * usable pipeline or `malformed` with a reason written for the person who has
 * to fix the file.
 */
export function parseDeploySection(raw: unknown): DeployPipelineParse {
  const malformed = (reason: string): DeployPipelineParse => ({ status: "malformed", reason });
  if (raw === undefined || raw === null) return { status: "absent" };
  if (!isRecord(raw)) return malformed("'deploy' must be a mapping with an 'environments' list");

  const stray = strayKey(raw, SECTION_KEYS);
  if (stray !== undefined) {
    return malformed(
      `'deploy' has an unrecognized field '${stray}' (allowed: environments, timeoutMinutes, instance, network)`,
    );
  }
  if (!Array.isArray(raw.environments) || raw.environments.length === 0) {
    return malformed("'deploy.environments' must be a non-empty list");
  }
  if (raw.environments.length > MAX_DEPLOY_ENVIRONMENTS) {
    return malformed(
      `'deploy.environments' declares ${raw.environments.length} environments; at most ${MAX_DEPLOY_ENVIRONMENTS} are allowed`,
    );
  }
  const environments: DeployEnvironment[] = [];
  for (const [index, entry] of (raw.environments as unknown[]).entries()) {
    const environment = parseEnvironment(entry, index);
    if (typeof environment === "string") return malformed(environment);
    if (environments.some((existing) => existing.name === environment.name)) {
      return malformed(`environment '${environment.name}' is declared twice`);
    }
    environments.push(environment);
  }

  const timeoutSeconds = minutes(
    raw.timeoutMinutes,
    "deploy.timeoutMinutes",
    DEFAULT_CI_JOB_TIMEOUT_MINUTES,
    MAX_CI_JOB_TIMEOUT_MINUTES,
  );
  if (typeof timeoutSeconds === "string") return malformed(timeoutSeconds);

  let instance: CiInstanceType | undefined;
  if (raw.instance !== undefined) {
    instance = CI_INSTANCE_TYPES.find((name) => name === raw.instance);
    if (instance === undefined) {
      return malformed(`'deploy.instance' must be one of ${CI_INSTANCE_TYPES.join(", ")}`);
    }
  }

  const allowHosts: string[] = [];
  if (raw.network !== undefined) {
    if (!isRecord(raw.network)) return malformed("'deploy.network' must be a mapping with 'allow'");
    const strayNetwork = strayKey(raw.network, NETWORK_KEYS);
    if (strayNetwork !== undefined) {
      return malformed(
        `'deploy.network' has an unrecognized field '${strayNetwork}' (allowed: allow)`,
      );
    }
    const allow = raw.network.allow;
    if (allow !== undefined) {
      if (!Array.isArray(allow) || allow.length > MAX_CI_ALLOW_HOSTS) {
        return malformed(
          `'deploy.network.allow' must be a list of at most ${MAX_CI_ALLOW_HOSTS} hostnames`,
        );
      }
      for (const host of allow as unknown[]) {
        if (typeof host !== "string" || !HOSTNAME_PATTERN.test(host)) {
          return malformed(
            "'deploy.network.allow' entries must be exact lowercase hostnames such as app.example.com: no scheme, port, path, wildcard or IP address",
          );
        }
        if (!allowHosts.includes(host)) allowHosts.push(host);
      }
    }
  }

  const pipeline: DeployPipeline = { environments, timeoutSeconds, allowHosts };
  if (instance !== undefined) pipeline.instance = instance;
  return { status: "ok", pipeline };
}

/**
 * Read the `deploy:` section out of the bytes of a `.stratum/ci.yaml`.
 *
 * Looks at that one key and nothing else: whether the CI half of the file is
 * valid is the merge gate's question, asked of the base branch, and a deploy
 * of a merged commit must not be refused over it.
 */
export function parseDeployPipeline(content: string): DeployPipelineParse {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (e) {
    return { status: "malformed", reason: e instanceof Error ? e.message : "YAML parse error" };
  }
  if (parsed === undefined || parsed === null) return { status: "absent" };
  if (!isRecord(parsed)) return { status: "malformed", reason: "the file must be a mapping" };
  try {
    return parseDeploySection(parsed.deploy);
  } catch (e) {
    return { status: "malformed", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The environment after `name` in promotion order, or undefined when it is the last. */
export function nextEnvironment(
  pipeline: DeployPipeline,
  name: string,
): DeployEnvironment | undefined {
  const index = pipeline.environments.findIndex((environment) => environment.name === name);
  return index < 0 ? undefined : pipeline.environments[index + 1];
}
