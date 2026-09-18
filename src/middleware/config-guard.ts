import type { MiddlewareHandler } from "hono";
import { parseLlmProviders } from "../evaluation/llm-providers";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

/**
 * Returns a human-readable error when the RepoDO / R2 fast-path config is
 * incoherent, else null.
 *
 * Flipping `REPO_DO_ENABLED` to "true" without binding the `REPO_OBJECTS` R2
 * bucket is a silent footgun (ADR 004): workspace staging no-ops and the merge
 * fast path throws "REPO_OBJECTS not bound" only at merge time. Production binds
 * no REPO_OBJECTS today, so enabling the flag there without adding the binding
 * would break merges — this makes that misconfiguration detectable up front.
 */
export function repoDoConfigError(
  env: Pick<Env, "REPO_DO_ENABLED" | "REPO_OBJECTS">,
): string | null {
  if (env.REPO_DO_ENABLED === "true" && !env.REPO_OBJECTS) {
    return (
      "REPO_DO_ENABLED is 'true' but the REPO_OBJECTS R2 bucket is not bound — " +
      "the merge fast path will throw at merge time and workspace staging silently " +
      "no-ops. Add the [[env.<env>.r2_buckets]] REPO_OBJECTS binding or set " +
      "REPO_DO_ENABLED='false'."
    );
  }
  return null;
}

/**
 * Returns a human-readable error when entitlement enforcement is switched on
 * without the service it enforces against, else null.
 *
 * Structurally the same footgun as `REPO_DO_ENABLED` above, one step quieter:
 * `ENTITLEMENTS_ENFORCE=1` with no `BILLING_SERVICE_URL` throws nothing and
 * breaks nothing — every owner resolves to `UnlimitedEntitlements` and every
 * decision admits. That is enforcement that looks on in the dashboard and does
 * nothing in production, which is worse than being off, because nobody goes
 * looking for a limit they believe is already applied.
 *
 * `BILLING_SERVICE_SECRET` is not checked here: it is a Wrangler secret rather
 * than a var, so a deploy that has the URL and not the secret is an operational
 * state to fix, not a config file to reread — and `entitlementsEnabled` already
 * treats it as off.
 */
export function entitlementsConfigError(
  env: Pick<Env, "ENTITLEMENTS_ENFORCE" | "BILLING_SERVICE_URL" | "BILLING_SERVICE_SECRET">,
): string | null {
  if (env.ENTITLEMENTS_ENFORCE !== "1") return null;
  // BOTH, because `entitlementsEnabled` requires both: with the URL set and the
  // secret missing the seam reports itself off, every check returns `inert()`,
  // and an operator who believes they switched enforcement on gets silence.
  // Naming only the URL — as this did — meant the one misconfiguration hardest
  // to notice from the outside was the one the guard did not report.
  const missing: string[] = [];
  if (!env.BILLING_SERVICE_URL) missing.push("BILLING_SERVICE_URL");
  if (!env.BILLING_SERVICE_SECRET) missing.push("BILLING_SERVICE_SECRET");
  if (missing.length > 0) {
    // Joined rather than concatenated: mixing a template literal with `+` trips
    // biome's useTemplate, and the autofix for it is one unreadable line.
    return [
      `ENTITLEMENTS_ENFORCE is '1' but ${missing.join(" and ")}`,
      `${missing.length === 1 ? "is" : "are"} not set — no plan limits can be`,
      "fetched, so every owner resolves to unlimited and every enforcement point",
      "admits. Set BILLING_SERVICE_URL as a var and BILLING_SERVICE_SECRET as a",
      "secret for the [env.<env>] block, or unset ENTITLEMENTS_ENFORCE.",
    ].join(" ");
  }
  return null;
}

/**
 * Returns a human-readable error when `LLM_PROVIDERS` is set but unusable, else
 * null.
 *
 * Loud on purpose, and the reason Open Question 3 settled on a typed parse: a
 * malformed allowlist silently disables BYOK, and the projects that opted in
 * discover it as blocked merges naming a provider the operator believes is
 * configured. Unset is not a problem — it is the default, and it means Workers
 * AI only.
 */
export function llmProvidersConfigError(env: Pick<Env, "LLM_PROVIDERS">): string | null {
  const parse = parseLlmProviders(env.LLM_PROVIDERS);
  if (parse.status === "invalid") {
    // One template literal rather than concatenation: `useTemplate` rejects
    // mixing an interpolated piece with `+`, and the sibling above can use plain
    // strings only because it interpolates nothing.
    return `LLM_PROVIDERS is set but could not be parsed (${parse.reason}) — no BYOK provider is available, so every policy selecting one blocks merges until this is fixed. Correct the value or unset it to run on Workers AI.`;
  }
  return null;
}

// Log the config problems at most once per isolate rather than on every request.
let hasLoggedConfigError = false;

/**
 * Surfaces an incoherent RepoDO/R2, entitlements or LLM-provider configuration
 * loudly in Workers Logs on the first request after a bad deploy, instead of
 * only when a later merge throws — or, for entitlements, never. Non-fatal:
 * reads and the UI still work in every case, so we log rather than reject the
 * request.
 */
export const configGuardMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!hasLoggedConfigError) {
    // Set before the checks, not inside the `problems.length` branch: a
    // correctly configured deploy has no problems to log, so the flag would
    // never be set and every request would re-run all three — including
    // `llmProvidersConfigError`, which `JSON.parse`s `LLM_PROVIDERS`. The
    // config cannot change within an isolate, so one evaluation answers for
    // its whole life either way.
    hasLoggedConfigError = true;
    const problems = [
      repoDoConfigError(c.env),
      entitlementsConfigError(c.env),
      llmProvidersConfigError(c.env),
    ].filter((problem): problem is string => problem !== null);
    if (problems.length > 0) {
      const logger = createLogger({ component: "config-guard" });
      for (const problem of problems) logger.error(problem);
    }
  }
  await next();
};
