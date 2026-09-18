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
import type { LlmProviderCatalog } from "./llm-providers";
import type {
  EvalPolicy,
  EvaluatorConfig,
  LlmEvaluatorConfig,
  MergePolicy,
  SandboxEvaluatorConfig,
} from "./types";

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

/**
 * Most `evaluators:` entries one policy file may declare.
 *
 * The `deploys:` sibling has had `MAX_DEPLOY_ENTRIES` from the start and for
 * the same reason, which applies at least as strongly here: every entry runs
 * inside one Worker invocation, sharing its CPU, memory and subrequest budget,
 * and an `llm` or `webhook` entry is an outbound call. Without a cap a policy
 * file amplifies one merge into an unbounded number of provider requests.
 *
 * Unlike a rejected deploy entry this fails the whole file closed, the way
 * every other unusable evaluator entry does: an evaluator is a gate, and
 * quietly running the first sixteen of a hundred gates is not "most of the
 * policy", it is a policy nobody wrote.
 */
export const MAX_EVALUATOR_ENTRIES = 16;

/**
 * Most `llm` entries one policy file may declare.
 *
 * One, because two cannot be resolved: `LLMEvaluator` reads the first entry's
 * model and threshold while `buildEvaluators` builds an evaluator for every
 * entry, so `[{llm}, {llm, provider: x}]` used to mean two runs on the
 * operator's Workers AI bill from a policy that asked for one on its own key.
 * Rejecting the file is the only answer that does not silently pick one.
 */
const MAX_LLM_ENTRIES = 1;

/**
 * The operator's provider allowlist, as the policy parser sees it.
 *
 * Defaulted to empty rather than made required so a caller that forgets to pass
 * one blocks BYOK policies instead of admitting them: an empty catalog resolves
 * no provider name, and an unresolved name fails the file closed.
 */
const NO_PROVIDERS: LlmProviderCatalog = new Map();

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
  /** Operator-configured LLM providers a policy may select from. Omitted means
   * none are configured, so any policy naming one fails closed. */
  providers: LlmProviderCatalog = NO_PROVIDERS,
): Promise<EvalPolicy> {
  const yaml = await readAndParsePolicy(
    remote,
    token,
    ".stratum/policy.yaml",
    "yaml",
    logger,
    branch,
    providers,
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
    providers,
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
  providers: LlmProviderCatalog = NO_PROVIDERS,
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
    if (declared.length > MAX_EVALUATOR_ENTRIES) {
      return {
        status: "malformed",
        reason: `'evaluators' declares ${declared.length} entries; at most ${MAX_EVALUATOR_ENTRIES} are allowed`,
      };
    }

    // Why each dropped entry was dropped, in the file's own terms. Collected
    // rather than only logged because the count alone ("2 unusable entries")
    // is what the merge gate shows the person who has to fix the file, and a
    // count does not name the provider that is not configured.
    const rejections: string[] = [];
    const evaluators = declared
      .map((entry, index) => sanitizeEvaluator(entry, logger, providers, rejections, index))
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
      const dropped = declared.length - evaluators.length;
      return {
        status: "malformed",
        reason: `${dropped} unusable entr${dropped === 1 ? "y" : "ies"} in 'evaluators'${
          rejections.length > 0 ? `: ${rejections.join("; ")}` : ""
        }`,
      };
    }

    // One `llm` entry, checked here rather than inside `sanitizeLlmConfig`
    // because it is a property of the LIST, not of an entry — and it fails the
    // file closed rather than dropping the extra, so nothing has to decide
    // which of two entries the project meant.
    const llmEntries = evaluators.filter((entry) => entry.type === "llm").length;
    if (llmEntries > MAX_LLM_ENTRIES) {
      return {
        status: "malformed",
        reason: `'evaluators' declares ${llmEntries} 'llm' entries; at most ${MAX_LLM_ENTRIES} is allowed, because a second one would run a second model call on a configuration nothing can choose between`,
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
  providers: LlmProviderCatalog = NO_PROVIDERS,
): Promise<PolicyLoad> {
  try {
    const contentResult = await readFileFromRepo(remote, token, path, logger, branch);
    if (!contentResult.success) return { status: "absent" };

    const content = contentResult.data;
    if (content === null || content === undefined) return { status: "absent" };

    return parsePolicyContent(content, format, logger, providers);
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

/** Fields an `llm` evaluator entry may carry. Everything else is ignored. */
const LLM_CONFIG_KEYS = new Set(["type", "provider", "model", "threshold", "maxDiffChars"]);

/**
 * Longest `model` a policy may name. Generous for every provider's identifiers
 * (`@cf/meta/llama-3.1-8b-instruct`, `anthropic/claude-sonnet-4-5`) and short
 * enough that the value cannot become a payload in its own right.
 */
const MAX_MODEL_LENGTH = 128;

/** Model identifiers across the three providers: slugs with `/`, `.`, `:`, `@`, `-`, `_`. */
const MODEL_PATTERN = /^[A-Za-z0-9._:@/-]+$/;

/**
 * Keep only whitelisted, well-typed fields from a user-supplied `llm` entry,
 * resolving `provider` against the operator's allowlist.
 *
 * Returning null fails the **whole policy file** closed and blocks merges (see
 * the dropped-entry check in `parsePolicyContent`). That is the opposite of
 * what a rejected `deploys:` entry does two files away — `deploy/config.ts`
 * says in as many words "do not fix this" — and the asymmetry is deliberate:
 * a deploy runs *after* the merge, so a bad entry costs a failed deployment
 * row, whereas an `llm` entry is a gate. A gate that cannot run must not pass.
 * An unresolvable provider name is precisely a gate that cannot run, so it
 * blocks rather than degrading to Workers AI on the operator's bill.
 *
 * `baseUrl` is never read here, at any level of validation. The endpoint set is
 * closed and lives in `LLM_PROVIDERS`; a policy may only *select* from it by
 * name. A `baseUrl` in the file is warned about and dropped like any other
 * unrecognized key — see `llm-providers.ts` for why the field cannot exist.
 *
 * @param rejections Collects why an entry was dropped, so the merge-blocking
 *   reason can name the provider instead of only counting entries. Optional:
 *   a caller that only wants the config need not care.
 */
export function sanitizeLlmConfig(
  source: Record<string, unknown>,
  logger: Logger,
  providers: LlmProviderCatalog,
  rejections?: string[],
): LlmEvaluatorConfig | null {
  const config: LlmEvaluatorConfig = { type: "llm" };
  const reject = (reason: string): null => {
    rejections?.push(reason);
    return null;
  };

  for (const key of Object.keys(source)) {
    if (!LLM_CONFIG_KEYS.has(key)) {
      logger.warn("Ignoring unrecognized llm evaluator field", { field: key });
    }
  }

  if (source.provider !== undefined) {
    if (typeof source.provider !== "string") {
      logger.error("Dropping llm evaluator entry whose provider is not a string", undefined, {
        submitted: forLog(source.provider),
      });
      return reject("llm evaluator: 'provider' must be a string naming a configured provider");
    }
    if (!providers.has(source.provider)) {
      logger.error(
        "Dropping llm evaluator entry naming an unconfigured provider — failing the policy closed",
        undefined,
        { provider: forLog(source.provider) },
      );
      return reject(
        `llm evaluator names provider "${forLog(source.provider)}", which this instance has not configured in LLM_PROVIDERS`,
      );
    }
    config.provider = source.provider;
  }

  if (source.model !== undefined) {
    const model = typeof source.model === "string" ? source.model.trim() : "";
    if (model.length === 0 || model.length > MAX_MODEL_LENGTH || !MODEL_PATTERN.test(model)) {
      logger.error("Dropping llm evaluator entry with an unusable model", undefined, {
        submitted: forLog(source.model),
      });
      return reject("llm evaluator: 'model' is not a usable model identifier");
    }
    config.model = model;
  }

  // A BYOK entry must name its model. The default (`@cf/meta/llama-3.1-8b-instruct`)
  // is a Workers AI model id, and posting it to Anthropic or an OpenAI-compatible
  // endpoint fails every single call — a gate that never runs, discovered one
  // merge at a time. Requiring the field is clearer than inventing a default per
  // provider kind, which would silently pick a model (and a price) for the
  // project. Workers AI keeps the default: there the id is the right one.
  if (config.provider !== undefined && config.model === undefined) {
    logger.error("Dropping llm evaluator entry that names a provider but no model", undefined, {
      provider: config.provider,
    });
    return reject(
      `llm evaluator names provider "${config.provider}" but no "model"; a provider entry must name the model to run, since the default is a Workers AI model id`,
    );
  }

  // Clamped, not rejected, for the reason `clampScore` gives: a threshold
  // outside [0,1] is a bounded mistake, and 1.5 (nothing passes) is the safe
  // direction anyway. -5 is not — it would make every model verdict pass — so
  // the clamp is load-bearing rather than cosmetic.
  const threshold = clampScore(source.threshold, logger);
  if (threshold !== undefined) config.threshold = threshold;

  if (typeof source.maxDiffChars === "number" && Number.isFinite(source.maxDiffChars)) {
    // Left unclamped here on purpose: `LLMEvaluator` clamps it against its own
    // floor and ceiling, which are the numbers that actually bound the prompt.
    config.maxDiffChars = source.maxDiffChars;
  } else if (source.maxDiffChars !== undefined) {
    logger.warn("Ignoring policy field that is not a finite number", {
      field: "llm.maxDiffChars",
      submitted: forLog(source.maxDiffChars),
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
function sanitizeEvaluator(
  raw: unknown,
  logger: Logger,
  providers: LlmProviderCatalog,
  rejections: string[],
  index: number,
): EvaluatorConfig | null {
  const at = `evaluators[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    logger.warn("Dropping non-object evaluator entry", { submitted: forLog(raw) });
    rejections.push(`${at} is not an evaluator object`);
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.type !== "string") {
    logger.warn("Dropping evaluator entry without a string type", { submitted: forLog(raw) });
    rejections.push(`${at} has no string 'type'`);
    return null;
  }

  if (source.type === "sandbox") return sanitizeSandboxConfig(source, logger);

  // Replaces the copy-through below for `llm`, which used to hand the parsed
  // object's fields to the evaluator unvalidated — including any `baseUrl` or
  // inline credential the file carried.
  if (source.type === "llm") {
    const entryRejections: string[] = [];
    const llm = sanitizeLlmConfig(source, logger, providers, entryRejections);
    for (const reason of entryRejections) rejections.push(`${at}: ${reason}`);
    return llm;
  }

  if (source.type === "webhook") {
    // `url` is required by the type, so check it rather than asserting it. The
    // evaluator does fail closed on a missing URL, but telling the compiler a
    // value is a `webhook` config when it may have no `url` is exactly the kind
    // of false claim the no-`any` rule exists to prevent.
    if (typeof source.url !== "string") {
      logger.warn("Dropping webhook evaluator entry without a url", {
        submitted: forLog(raw),
      });
      rejections.push(`${at}: webhook evaluator has no 'url'`);
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
