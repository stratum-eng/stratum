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
