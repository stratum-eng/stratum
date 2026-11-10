/**
 * `.stratum/ci.yaml` (#415, ADR 012): the steps the first-party CI executor
 * runs for a change.
 *
 * The file is read from the project's BASE branch, never from the change, for
 * the reason the policy file is: a change must not be able to choose the gate
 * it is judged by. What that protects is the LIST — which steps exist, what
 * command each one starts, how long it may run, which are optional. It does
 * not protect what a command does once it starts: `npm test` runs whatever the
 * change's `package.json` says. Path rules and approvals in the policy file
 * are what cover that, and the user guide says so in as many words.
 *
 * Unlike the policy parser this one refuses rather than repairs. An unknown
 * key, an out-of-range timeout or a mistyped flag fails the whole file, and a
 * failed file blocks merges (`configError`). The policy parser clamps because
 * it has years of files in the wild to stay compatible with; this format has
 * none, and for a gate "I ignored the line I did not understand" is the wrong
 * default — `optinal: true` and `timeout: 5` would both silently mean
 * something the author did not write.
 */
import YAML from "yaml";
import { CHECK_NAME_PATTERN, CHECK_NAME_RULE } from "./limits";

/** Where the file lives, relative to the repository root. */
export const CI_CONFIG_PATH = ".stratum/ci.yaml";

/** Most steps one file may declare. Each is a check run and a line on the change page. */
export const MAX_CI_STEPS = 16;

/**
 * Longest `run` script. Far above the policy file's one-line `command` because
 * a step is a script, run by `bash` inside a container, not an argv Stratum
 * tokenizes — but still bounded, since the whole list travels in one signed
 * dispatch.
 */
export const MAX_CI_RUN_LENGTH = 4000;

/** A step's own time limit when it sets none, and the bounds on one it sets. */
export const DEFAULT_CI_STEP_TIMEOUT_MINUTES = 10;
export const MAX_CI_STEP_TIMEOUT_MINUTES = 120;

/** The whole job's wall-clock limit when the file sets none, and its bounds. */
export const DEFAULT_CI_JOB_TIMEOUT_MINUTES = 30;
export const MAX_CI_JOB_TIMEOUT_MINUTES = 120;

/** Most hostnames `network.allow` may add to the executor's default allowlist. */
export const MAX_CI_ALLOW_HOSTS = 16;

/**
 * Container sizes a file may ask for, smallest first. These are the names the
 * Durable Object Container API accepts at start time; the executor refuses any
 * above its configured maximum, so asking is not getting.
 */
export const CI_INSTANCE_TYPES = [
  "lite",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
] as const;
export type CiInstanceType = (typeof CI_INSTANCE_TYPES)[number];

/** One step: a named command, and the check run that reports it. */
export interface CiStep {
  /** The check name. Follows the same rule as a `checks` evaluator's names. */
  name: string;
  /** A bash script. Run with `set -eo pipefail` at the repository root. */
  run: string;
  timeoutSeconds: number;
  /** False only when the file says `optional: true`. */
  required: boolean;
}

/** A validated `.stratum/ci.yaml`. Always a fresh object, never the parsed YAML. */
export interface CiConfig {
  steps: CiStep[];
  /** Wall-clock limit for the whole job, enforced from outside the container. */
  timeoutSeconds: number;
  /** Omitted means the executor's default size. */
  instance?: CiInstanceType;
  /** Exact hostnames added to the executor's default egress allowlist. */
  allowHosts: string[];
  /**
   * SHA-256 of everything above, in a fixed order. Stored on each check run
   * this config dispatches, so the merge gate can tell that the steps a
   * revision was tested with are the steps the base declares NOW — same names
   * with a different command is a different gate.
   */
  digest: string;
}

export type CiConfigParse =
  | { status: "ok"; config: CiConfig }
  | { status: "malformed"; reason: string };

const TOP_LEVEL_KEYS = new Set(["version", "steps", "timeoutMinutes", "instance", "network"]);
const STEP_KEYS = new Set(["name", "run", "timeoutMinutes", "optional"]);
const NETWORK_KEYS = new Set(["allow"]);

/**
 * A public DNS hostname, lowercase, with an alphabetic top-level label. That
 * shape excludes everything an allowlist entry must not be: an IP literal, a
 * wildcard, a port, a scheme, a path, and a single-label internal name.
 */
const HOSTNAME_PATTERN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Is this a plain object, as a YAML mapping parses to: not null and not a list? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first key of `source` the schema does not allow, so a typo is refused, not ignored. */
function unknownKey(source: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(source).find((key) => !allowed.has(key));
}

/** A whole number of minutes inside `[1, max]`, as seconds; or why not. */
function minutes(raw: unknown, field: string, fallback: number, max: number): number | string {
  if (raw === undefined) return fallback * 60;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > max) {
    return `${field} must be a whole number of minutes from 1 to ${max}`;
  }
  return raw * 60;
}

/** One entry of `steps`, validated; or the reason it is not a step, naming its index. */
function parseStep(raw: unknown, index: number): CiStep | string {
  const at = `steps[${index}]`;
  if (!isRecord(raw)) return `${at} is not a step (expected 'name' and 'run')`;
  const stray = unknownKey(raw, STEP_KEYS);
  if (stray !== undefined) {
    return `${at} has an unrecognized field '${stray.slice(0, 40)}' (allowed: name, run, timeoutMinutes, optional)`;
  }
  if (typeof raw.name !== "string" || !CHECK_NAME_PATTERN.test(raw.name)) {
    return `${at}.name ${CHECK_NAME_RULE}`;
  }
  if (typeof raw.run !== "string" || raw.run.trim() === "") {
    return `${at} ('${raw.name}') has no 'run' command`;
  }
  // A NUL cannot survive being written into a script file, so the command the
  // container ran would not be the one the file declares.
  if (raw.run.length > MAX_CI_RUN_LENGTH || raw.run.includes("\0")) {
    return `${at} ('${raw.name}') 'run' must be at most ${MAX_CI_RUN_LENGTH} characters and contain no NUL`;
  }
  const timeoutSeconds = minutes(
    raw.timeoutMinutes,
    `${at}.timeoutMinutes`,
    DEFAULT_CI_STEP_TIMEOUT_MINUTES,
    MAX_CI_STEP_TIMEOUT_MINUTES,
  );
  if (typeof timeoutSeconds === "string") return timeoutSeconds;
  if (raw.optional !== undefined && typeof raw.optional !== "boolean") {
    return `${at}.optional must be true or false`;
  }
  return { name: raw.name, run: raw.run, timeoutSeconds, required: raw.optional !== true };
}

/** Hex SHA-256 of the config's canonical form. Field order is part of the format. */
async function digestOf(config: Omit<CiConfig, "digest">): Promise<string> {
  const canonical = JSON.stringify({
    steps: config.steps.map((step) => [step.name, step.run, step.timeoutSeconds, step.required]),
    timeoutSeconds: config.timeoutSeconds,
    instance: config.instance ?? null,
    allowHosts: config.allowHosts,
  });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parse and validate the bytes of a `.stratum/ci.yaml`.
 *
 * Never throws: every failure, including a YAML alias cycle or a parser
 * exception, comes back as `malformed` with a reason written for the person
 * who has to fix the file.
 */
export async function parseCiConfig(content: string): Promise<CiConfigParse> {
  const malformed = (reason: string): CiConfigParse => ({ status: "malformed", reason });
  try {
    let parsed: unknown;
    try {
      parsed = YAML.parse(content);
    } catch (e) {
      return malformed(e instanceof Error ? e.message : "YAML parse error");
    }
    if (!isRecord(parsed)) return malformed("the file must be a mapping with a 'steps' list");

    const stray = unknownKey(parsed, TOP_LEVEL_KEYS);
    if (stray !== undefined) {
      return malformed(
        `unrecognized field '${stray.slice(0, 40)}' (allowed: version, steps, timeoutMinutes, instance, network)`,
      );
    }
    if (parsed.version !== undefined && parsed.version !== 1) {
      return malformed("'version' must be 1");
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return malformed("'steps' must be a non-empty list");
    }
    if (parsed.steps.length > MAX_CI_STEPS) {
      return malformed(
        `'steps' declares ${parsed.steps.length} steps; at most ${MAX_CI_STEPS} are allowed`,
      );
    }
    const steps: CiStep[] = [];
    for (const [index, raw] of (parsed.steps as unknown[]).entries()) {
      const step = parseStep(raw, index);
      if (typeof step === "string") return malformed(step);
      if (steps.some((existing) => existing.name === step.name)) {
        return malformed(`step '${step.name}' is declared twice; a step name is a check name`);
      }
      steps.push(step);
    }

    const timeoutSeconds = minutes(
      parsed.timeoutMinutes,
      "timeoutMinutes",
      DEFAULT_CI_JOB_TIMEOUT_MINUTES,
      MAX_CI_JOB_TIMEOUT_MINUTES,
    );
    if (typeof timeoutSeconds === "string") return malformed(timeoutSeconds);

    let instance: CiInstanceType | undefined;
    if (parsed.instance !== undefined) {
      const wanted = CI_INSTANCE_TYPES.find((name) => name === parsed.instance);
      if (wanted === undefined) {
        return malformed(`'instance' must be one of ${CI_INSTANCE_TYPES.join(", ")}`);
      }
      instance = wanted;
    }

    const allowHosts: string[] = [];
    if (parsed.network !== undefined) {
      if (!isRecord(parsed.network)) return malformed("'network' must be a mapping with 'allow'");
      const strayNetwork = unknownKey(parsed.network, NETWORK_KEYS);
      if (strayNetwork !== undefined) {
        return malformed(
          `'network' has an unrecognized field '${strayNetwork.slice(0, 40)}' (allowed: allow)`,
        );
      }
      const allow = parsed.network.allow;
      if (allow !== undefined) {
        if (!Array.isArray(allow)) return malformed("'network.allow' must be a list of hostnames");
        if (allow.length > MAX_CI_ALLOW_HOSTS) {
          return malformed(
            `'network.allow' lists ${allow.length} hostnames; at most ${MAX_CI_ALLOW_HOSTS} are allowed`,
          );
        }
        for (const host of allow as unknown[]) {
          if (typeof host !== "string" || !HOSTNAME_PATTERN.test(host)) {
            return malformed(
              "'network.allow' entries must be exact lowercase hostnames such as registry.example.com: no scheme, port, path, wildcard or IP address",
            );
          }
          if (!allowHosts.includes(host)) allowHosts.push(host);
        }
      }
    }

    const config: Omit<CiConfig, "digest"> = { steps, timeoutSeconds, allowHosts };
    if (instance !== undefined) config.instance = instance;
    return { status: "ok", config: { ...config, digest: await digestOf(config) } };
  } catch (e) {
    return malformed(e instanceof Error ? e.message : String(e));
  }
}

/** Names of every step, in file order. */
export function ciStepNames(config: CiConfig): string[] {
  return config.steps.map((step) => step.name);
}

/** Names of the steps a merge must see `passed`: all but the ones marked optional. */
export function requiredCiStepNames(config: CiConfig): string[] {
  return config.steps.filter((step) => step.required).map((step) => step.name);
}
