/**
 * Time limits for the sandbox evaluator, shared by the evaluator itself and by
 * the policy loader that clamps user-supplied values.
 *
 * They live in their own module because the two consumers sit on opposite sides
 * of a dependency edge: `policy-loader` importing them from `sandbox-evaluator`
 * would make a config loader depend on an evaluator implementation.
 */

/** Timeout for the scored command when a policy does not set one. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Timeout for dependency install (and for the in-sandbox binary decode step)
 * when a policy does not set one.
 *
 * Lowered from 120s so the two per-phase defaults sum to exactly
 * `DEFAULT_TOTAL_BUDGET_MS`. At 120s an unconfigured project could have its
 * scored command truncated by the budget through no choice of its own, which
 * would make truncation the norm rather than the exception.
 */
export const DEFAULT_INSTALL_TIMEOUT_MS = 90_000;

/**
 * Total wall-clock a single sandbox evaluation may spend before it fails
 * closed, covering the tree read, materialization, install, and the scored
 * command.
 *
 * Chosen to sit under a 180s-class proxy deadline with headroom. It is a
 * judgement, not a measurement: this repo configures no request timeout
 * (`wrangler.toml` has no `[limits]` block) and the real ceiling is workerd's
 * own request duration limit.
 */
export const DEFAULT_TOTAL_BUDGET_MS = 150_000;

/** The scored command when a policy does not set one. */
export const DEFAULT_COMMAND = "npm test";

/** Floor for any per-phase timeout a policy may request. */
export const MIN_PHASE_TIMEOUT_MS = 1_000;

/**
 * Ceiling for any per-phase timeout a policy may request.
 *
 * Deliberately below `MAX_TOTAL_BUDGET_MS` so no single phase can claim an
 * entire evaluation's budget by configuration alone.
 */
export const MAX_PHASE_TIMEOUT_MS = 120_000;

/** Floor for a policy-supplied total budget. */
export const MIN_TOTAL_BUDGET_MS = 5_000;

/** Ceiling for a policy-supplied total budget. */
export const MAX_TOTAL_BUDGET_MS = 150_000;

/** Longest `command` string a policy may supply, to bound what gets executed and logged. */
export const MAX_COMMAND_LENGTH = 500;

/**
 * How long the `llm` evaluator waits for a verdict when a policy does not set
 * `timeoutMs`. Matches the providers' own transport timeout, so an unconfigured
 * project behaves exactly as it did before the evaluator had a deadline of its
 * own — the difference is that expiry is now a failing verdict the evaluator
 * names, not a transport error from whichever layer happened to give up first.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

/**
 * Bounds for a policy-supplied `llm.timeoutMs`. The same window the other
 * per-evaluator timeouts are clamped to: a policy file is repository content,
 * and an unbounded number there is an unbounded hold on a queue consumer.
 */
export const MIN_LLM_TIMEOUT_MS = MIN_PHASE_TIMEOUT_MS;
export const MAX_LLM_TIMEOUT_MS = MAX_PHASE_TIMEOUT_MS;

/**
 * The deadline an `llm` config asks for, clamped again at the point of use.
 * `sanitizeLlmConfig` already clamps a policy-supplied value, but a config can
 * reach an evaluator by other routes (a test, a future caller), and a
 * non-finite or huge number there would be an unbounded hold on the evaluation
 * consumer.
 */
export function llmTimeoutMs(config: { timeoutMs?: number } | undefined): number {
  const raw = config?.timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.min(MAX_LLM_TIMEOUT_MS, Math.max(MIN_LLM_TIMEOUT_MS, Math.floor(raw)));
}
