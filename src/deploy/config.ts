import type { DeployConfig, DeployRejection, DeployTargetName } from "../evaluation/types";

/** Targets the deploy runner can drive, in the order they are listed to users. */
export const DEPLOY_TARGETS = ["cloudflare-pages", "cloudflare-workers", "vercel"] as const;

const DEPLOY_TARGET_SET = new Set<string>(DEPLOY_TARGETS);

/** Deploy names are used as a stable identity across merges, so they are as narrow as a slug. */
const DEPLOY_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Matches the env-var shape every supported provider expects. */
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Fields a `deploys:` entry may carry. Anything else is rejected — see `sanitizeDeploys`. */
const DEPLOY_ENTRY_KEYS = new Set(["name", "target", "secrets", "dir", "requiresApproval"]);

const MAX_SECRETS_PER_DEPLOY = 16;
const MAX_DIR_LENGTH = 255;

/**
 * Most `deploys:` entries one policy file may declare.
 *
 * Siblings from one merge run sequentially inside a single Worker invocation,
 * sharing its CPU, memory and subrequest budget, and every entry — accepted or
 * rejected — becomes a persisted `deployments` row. Without a cap a policy file
 * could turn one merge into an unbounded number of rows and provider calls.
 */
const MAX_DEPLOY_ENTRIES = 16;

/** Longest policy-supplied value echoed into a rejection reason (which is persisted and rendered). */
const MAX_QUOTED_LENGTH = 64;

export interface SanitizedDeploys {
  /** Entries that passed every rule, as fresh objects. */
  accepted: DeployConfig[];
  /** Entries that did not, each with a reason to persist as a failed deployment. */
  rejected: DeployRejection[];
}

/**
 * Validate the `deploys:` list from a policy file.
 *
 * Returns **both** halves: accepted entries and rejected ones with reasons.
 * Rejections are returned rather than logged because a deploy the author wrote
 * and that never runs means production silently stopped updating; the caller
 * persists each one as a `failed` deployment row so it is visible in the UI.
 *
 * Deliberately *unlike* `evaluators`, where a single unusable entry fails the
 * whole file closed and blocks merges (see the comment at
 * `policy-loader.ts`'s dropped-entry check). The asymmetry is intentional: an
 * evaluator is a gate, so losing one has to stop the merge, whereas a deploy
 * runs *after* the merge — blocking merges on a bad deploy entry would change
 * the merge gate's behavior, which is out of this feature's scope. Reporting a
 * named failed deployment delivers the same visibility without that blast
 * radius. Do not "fix" this into a `configError`.
 *
 * Pure: no logger, no I/O, no mutation of `raw`. Every returned object is newly
 * allocated, so a returned policy shares no identity with the parsed file.
 */
export function sanitizeDeploys(raw: unknown): SanitizedDeploys {
  const accepted: DeployConfig[] = [];
  const rejected: DeployRejection[] = [];

  if (raw === undefined || raw === null) return { accepted, rejected };

  if (!Array.isArray(raw)) {
    rejected.push({ name: null, reason: "'deploys' must be a list of deploy entries" });
    return { accepted, rejected };
  }

  const seenNames = new Set<string>();

  // The excess is reported as one rejection rather than one per entry: a file
  // declaring thousands of deploys must not turn into thousands of failed rows.
  // Rejected, not thrown — the caller persists this like any other rejection.
  let entries = raw;
  if (raw.length > MAX_DEPLOY_ENTRIES) {
    entries = raw.slice(0, MAX_DEPLOY_ENTRIES);
    rejected.push({
      name: null,
      reason: `deploys: at most ${MAX_DEPLOY_ENTRIES} entries are allowed, but ${raw.length} were declared; entries ${MAX_DEPLOY_ENTRIES + 1}-${raw.length} were not run`,
    });
  }

  entries.forEach((entry, index) => {
    const at = `deploys[${index}]`;

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      rejected.push({ name: null, reason: `${at}: entry must be a mapping` });
      return;
    }

    const source = entry as Record<string, unknown>;
    const issues: string[] = [];

    // An unrecognized key is a rejection, not a warning. The whitelist rebuild
    // below would otherwise discard `requireApproval` (missing "s") in silence
    // — turning a deploy the author gated behind an approval into one that
    // ships straight to production. The cost is that an entry using a field a
    // future release adds is rejected here rather than half-applied; for a
    // credentialed production deploy that is the safer direction, and the
    // reason names the field so the fix is obvious.
    const unknownKeys = Object.keys(source).filter((key) => !DEPLOY_ENTRY_KEYS.has(key));
    if (unknownKeys.length > 0) {
      const plural = unknownKeys.length === 1 ? "" : "s";
      issues.push(`unrecognized field${plural} ${unknownKeys.map(quoted).join(", ")}`);
    }

    let name: string | null = null;
    if (typeof source.name !== "string") {
      issues.push(`"name" is required and must be a string`);
    } else if (!DEPLOY_NAME_PATTERN.test(source.name)) {
      issues.push(
        `"name" ${quoted(source.name)} must match ${DEPLOY_NAME_PATTERN.source} (lowercase letters, digits and dashes, max 32 chars)`,
      );
    } else {
      name = source.name;
      if (seenNames.has(name)) {
        issues.push(`duplicate deploy name ${quoted(name)}`);
      }
      // Recorded even when this entry is rejected for another reason: two
      // entries sharing a name is ambiguous whichever one is at fault.
      seenNames.add(name);
    }

    let target: DeployTargetName | null = null;
    if (typeof source.target !== "string") {
      issues.push(`"target" is required and must be one of ${DEPLOY_TARGETS.join(", ")}`);
    } else if (!DEPLOY_TARGET_SET.has(source.target)) {
      issues.push(
        `unknown target ${quoted(source.target)} (expected one of ${DEPLOY_TARGETS.join(", ")})`,
      );
    } else {
      target = source.target as DeployTargetName;
    }

    let secrets: string[] | undefined;
    if (source.secrets !== undefined) {
      if (!Array.isArray(source.secrets)) {
        issues.push(`"secrets" must be a list of secret names`);
      } else if (source.secrets.length > MAX_SECRETS_PER_DEPLOY) {
        issues.push(`"secrets" may name at most ${MAX_SECRETS_PER_DEPLOY} secrets`);
      } else {
        const invalid = source.secrets.filter(
          (value) => typeof value !== "string" || !SECRET_NAME_PATTERN.test(value),
        );
        if (invalid.length > 0) {
          issues.push(
            `invalid secret name${invalid.length === 1 ? "" : "s"} ${invalid.map(quoted).join(", ")} (expected ${SECRET_NAME_PATTERN.source})`,
          );
        } else {
          secrets = source.secrets.map((value) => value as string);
        }
      }
    }

    let dir: string | undefined;
    if (source.dir !== undefined) {
      if (typeof source.dir !== "string") {
        issues.push(`"dir" must be a string`);
      } else {
        const trimmed = source.dir.trim();
        const problem = dirProblem(trimmed);
        if (problem) issues.push(problem);
        else dir = trimmed;
      }
    }

    let requiresApproval = false;
    if (source.requiresApproval !== undefined) {
      if (typeof source.requiresApproval !== "boolean") {
        // A string "false" is truthy, and this field decides whether a deploy
        // can reach production without a human — coercion is not acceptable here.
        issues.push(`"requiresApproval" must be a boolean`);
      } else {
        requiresApproval = source.requiresApproval;
      }
    }

    if (issues.length > 0 || target === null || name === null) {
      rejected.push({ name, reason: `${at}: ${issues.join("; ")}` });
      return;
    }

    const config: DeployConfig = { name, target, requiresApproval };
    // Copied, never aliased: the accepted config must not share an array with
    // the parsed policy file.
    if (secrets) config.secrets = [...secrets];
    if (dir !== undefined) config.dir = dir;
    accepted.push(config);
  });

  return { accepted, rejected };
}

/**
 * Why a `dir` is unusable, or null if it is fine.
 *
 * `dir` selects which part of the merged tree is uploaded, so traversal out of
 * the repo root is the thing being prevented: `..` or an absolute path would
 * let a policy file choose bytes the change never contained.
 */
function dirProblem(dir: string): string | null {
  if (dir === "") return `"dir" must not be empty`;
  if (dir.length > MAX_DIR_LENGTH) return `"dir" must be at most ${MAX_DIR_LENGTH} characters`;
  // A NUL can truncate the path for a consumer that hands it to a C-backed API.
  if (dir.includes("\0")) return `"dir" must not contain a null byte`;
  if (dir.startsWith("/") || dir.startsWith("\\")) return `"dir" must be relative (no leading "/")`;
  // Backslash is split on as well: a repo can legitimately contain a file whose
  // name has one, and treating "a\\..\\b" as a single segment would let it past.
  if (dir.split(/[/\\]/).includes("..")) return `"dir" must not contain ".."`;
  return null;
}

/** Render a policy-supplied value into a reason string without letting it set the reason's size. */
function quoted(value: unknown): string {
  const rendered = typeof value === "string" ? value : String(value);
  return rendered.length > MAX_QUOTED_LENGTH
    ? `"${rendered.slice(0, MAX_QUOTED_LENGTH)}…"`
    : `"${rendered}"`;
}
