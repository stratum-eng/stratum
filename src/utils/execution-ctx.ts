import type { Context } from "hono";

/**
 * Hono's `c.executionCtx` getter throws (rather than returning undefined) when
 * no ExecutionContext was supplied to `fetch()` — true for most unit tests and
 * some non-Workers runtimes. Mirrors Hono's own internal pattern for reading it
 * defensively so callers can schedule work with `waitUntil` when available and
 * fall back to awaiting inline otherwise.
 */
export function getWaitUntil(c: Context): ((promise: Promise<unknown>) => void) | undefined {
  try {
    return c.executionCtx?.waitUntil?.bind(c.executionCtx);
  } catch {
    return undefined;
  }
}
