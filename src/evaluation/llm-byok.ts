/**
 * Resolving the LLM provider an evaluation runs on: the operator's Workers AI
 * binding, or the project's own credential against an operator-configured
 * endpoint (BYOK).
 *
 * Two rules shape everything here, and both are PRD §6/§7:
 *
 * 1. **Never fall back to `env.AI`.** A BYOK misconfiguration that quietly ran
 *    on Workers AI would put the spend back on the operator's bill — the exact
 *    hole BYOK closes — and would be a gate that silently stops gating. Every
 *    failure below is fail-closed with a distinct reason instead.
 * 2. **Skip the credential load entirely when no BYOK provider is named.**
 *    That is the overwhelmingly common case, and the load is a D1 read plus a
 *    100k-iteration PBKDF2 derivation on the change-creation path, which
 *    already does two clones and a diff.
 */
import { DEPLOY_SECRET_KEY_MISSING, loadSecretValues } from "../storage/project-secrets";
import type { Env, ProjectEntry } from "../types";
import type { Logger } from "../utils/logger";
import { AnthropicProvider, type LlmProvider, OpenAiCompatibleProvider } from "./llm-provider";
import { llmProviderCatalog, providerSecretName } from "./llm-providers";
import type { EvalPolicy, LlmEvaluatorConfig } from "./types";

/** Env slice the resolution needs. Named rather than `Env` so the credential
 * path's dependencies are visible at a glance. */
export type LlmByokEnv = Pick<Env, "DB" | "DEPLOY_SECRET_KEY" | "LLM_PROVIDERS">;

export type LlmProviderSelection =
  /** No BYOK provider named — the caller uses Workers AI, as it always has. */
  | { status: "platform" }
  /** Run on the project's credential; cost samples from this run are `byok`. */
  | { status: "byok"; provider: LlmProvider; providerName: string }
  /** The named provider cannot be used. The gate fails closed on this reason,
   * and never on `env.AI`. */
  | { status: "unavailable"; reason: string };

/**
 * Every `llm` entry in the policy.
 *
 * `filter`, not `find`, and the difference is a fail-open. `LLMEvaluator` reads
 * the FIRST `llm` entry, while `buildEvaluators` constructs an evaluator for
 * EVERY one — so resolving a provider from the first entry alone meant
 * `[{llm}, {llm, provider: anthropic}]` produced two evaluators on `env.AI`,
 * with no error and no log: a policy that asked to run on its own key silently
 * running on the operator's. `sanitizeLlmConfig` now rejects a second entry at
 * parse time, and {@link resolveLlmProvider} refuses to choose between them for
 * any policy that reaches it another way (a KV-cached one, say).
 */
export function llmConfigsOf(policy: EvalPolicy): LlmEvaluatorConfig[] {
  return policy.evaluators.filter((entry): entry is LlmEvaluatorConfig => entry.type === "llm");
}

/**
 * Resolve the provider for this policy, loading the project's credential only
 * when the policy names one.
 *
 * The plaintext credential is used in exactly one place: an `Authorization` (or
 * `x-api-key`) header on the provider request. `loadSecretValues` is the only
 * read path for a secret value in the codebase and is held to the same rule as
 * the deploy runner — no route returns it, renders it, or logs it. That an
 * HTTP request *triggers* this resolution is not the same thing as the value
 * being route-reachable.
 *
 * "Used in one place" is not the same as "reaches one place", and the
 * difference was a live leak: `new Headers()` throws a `TypeError` that quotes
 * the offending value, so a stored credential containing CR, LF or NUL became
 * an error message, then an `EvalResult.reason`, then a rendered line on a
 * world-readable change page. Both ends are now closed — the store rejects
 * control characters (`storage/project-secrets.ts`) and the provider builds its
 * headers outside the try, mapping a failure to a constant that interpolates
 * nothing (`llm-provider.ts`).
 *
 * **There is deliberately no MCP surface for writing the credential this
 * reads** (PRD §4c). `stratum_set_provider_key` looks like an obvious gap and
 * is ruled out on purpose: a provider key must never pass through a model's
 * context window, and §7's threat model rests on credentials and endpoints not
 * being selectable by the wrong party. The write surface is the web UI or the
 * CLI — the same rule that keeps agent tokens from submitting review verdicts.
 */
export async function resolveLlmProvider(
  env: LlmByokEnv,
  project: ProjectEntry,
  policy: EvalPolicy,
  logger: Logger,
): Promise<LlmProviderSelection> {
  const configs = llmConfigsOf(policy);
  if (configs.length > 1) {
    // Never "pick the first one". Which entry wins decides whose bill the run
    // lands on, and a policy that cannot say is a policy this must refuse.
    return {
      status: "unavailable",
      reason: `policy declares ${configs.length} "llm" evaluator entries; at most one is allowed, so no provider could be resolved`,
    };
  }

  const providerName = configs[0]?.provider;
  // The skip. Nothing below this line runs for a project that never opted in.
  if (providerName === undefined) return { status: "platform" };

  const configured = llmProviderCatalog(env, logger).get(providerName);
  if (!configured) {
    // Unreachable through `parsePolicyContent`, which rejects an unknown name
    // and fails the whole file closed. Kept because this function must be safe
    // to call with a policy from anywhere — a KV-cached one written before the
    // operator's allowlist changed, say — and the fallback must be a refusal.
    return {
      status: "unavailable",
      reason: `policy names LLM provider "${providerName}", which is not configured in LLM_PROVIDERS`,
    };
  }

  const secretName = providerSecretName(providerName);
  const loaded = await loadSecretValues(env.DB, logger, env, {
    projectId: project.id,
    names: [secretName],
  });

  if (!loaded.success) {
    // `DEPLOY_SECRET_KEY` unset is an operator misconfiguration with a specific
    // remedy, and it is the coupling PRD Open Question 4 accepted: BYOK reuses
    // the deploy secret key, so rotating that key blocks BYOK merges until the
    // provider keys are re-entered. Named explicitly so the reader is not left
    // guessing which of the two subsystems broke.
    if (loaded.error.code === DEPLOY_SECRET_KEY_MISSING) {
      return {
        status: "unavailable",
        reason: `project secret ${secretName} cannot be decrypted because the operator has not configured DEPLOY_SECRET_KEY`,
      };
    }
    return {
      status: "unavailable",
      reason: `project secret ${secretName} could not be read (${loaded.error.code})`,
    };
  }

  if (loaded.data.missing.includes(secretName)) {
    return {
      status: "unavailable",
      reason: `project secret ${secretName} is not set for this project; add it before selecting the "${providerName}" provider`,
    };
  }
  if (loaded.data.undecryptable.includes(secretName)) {
    return {
      status: "unavailable",
      reason: `project secret ${secretName} could not be decrypted; DEPLOY_SECRET_KEY was rotated or the value was restored from another project, so it must be re-entered`,
    };
  }

  const apiKey = loaded.data.values.get(secretName);
  if (apiKey === undefined) {
    // Belt and braces: `loadSecretValues` reports every unresolved name in one
    // of the two lists above, so this is not reachable — but the alternative to
    // checking is constructing a provider with `undefined` for a credential.
    return {
      status: "unavailable",
      reason: `project secret ${secretName} did not resolve to a value`,
    };
  }

  const provider =
    configured.kind === "anthropic"
      ? new AnthropicProvider(configured.baseUrl, apiKey)
      : new OpenAiCompatibleProvider(configured.baseUrl, apiKey);

  return { status: "byok", provider, providerName };
}
