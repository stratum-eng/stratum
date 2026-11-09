import type { Env } from "../types";
import { type Result, err, ok } from "./result";

/**
 * Every Durable Object binding this Worker declares.
 *
 * The one list `tests/durable-object-jurisdiction.test.ts` checks against
 * `wrangler.toml` and `src/types.ts`, so a fifth class cannot be bound without
 * being routed through {@link durableObjectNamespace}.
 */
export const DURABLE_OBJECT_BINDINGS = [
  "MERGE_QUEUE",
  "REPO_DO",
  "MAGIC_LINK_LIMITER",
  "USAGE_METER",
] as const satisfies readonly (keyof Env)[];

export type DurableObjectBinding = (typeof DURABLE_OBJECT_BINDINGS)[number];

/**
 * The jurisdictions Cloudflare documents for Durable Objects
 * (https://developers.cloudflare.com/durable-objects/reference/data-location/).
 *
 * `fedramp-high` appears in `@cloudflare/workers-types` but not on that page,
 * so it is not accepted: this setting exists to back a residency claim, and a
 * value nobody can point to documentation for does not back one.
 */
export const DO_JURISDICTIONS = ["eu", "us", "fedramp"] as const;

export type DoJurisdiction = (typeof DO_JURISDICTIONS)[number];

/**
 * Parses `DO_JURISDICTION`.
 *
 * Unset and the empty string both mean "no restriction" — the default, and
 * what every existing deployment runs with. Anything else must match a
 * documented jurisdiction exactly: `EU`, ` eu` and `europe` are errors rather
 * than being normalised or ignored, because the failure this guards against is
 * an operator who believes a residency restriction is on when it is not.
 *
 * @param raw - The `DO_JURISDICTION` variable as configured
 * @returns The jurisdiction, `null` when none is configured, or why the value is unusable
 */
export function parseDoJurisdiction(
  raw: string | undefined,
): Result<DoJurisdiction | null, string> {
  if (raw === undefined || raw === "") return ok(null);
  const match = DO_JURISDICTIONS.find((jurisdiction) => jurisdiction === raw);
  if (match) return ok(match);
  return err(
    `DO_JURISDICTION is ${JSON.stringify(raw)}, which is not a Durable Object jurisdiction. Use one of ${DO_JURISDICTIONS.map((jurisdiction) => `"${jurisdiction}"`).join(", ")} (lowercase, no whitespace), or unset it to run without a restriction.`,
  );
}

/** Thrown by {@link durableObjectNamespace} when `DO_JURISDICTION` is unusable. */
export class DurableObjectJurisdictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableObjectJurisdictionError";
  }
}

/**
 * The only way this codebase obtains a Durable Object namespace.
 *
 * With `DO_JURISDICTION` set, it returns the jurisdiction-restricted
 * subnamespace, so every id derived from it and every object reached through it
 * runs and stores data inside that jurisdiction. That is a *different set of
 * objects* from the unrestricted namespace: the same name maps to a different
 * id, so switching this on for a deployment that already has Durable Object
 * state leaves that state behind (docs/user-guide/trust.md, "Deploying
 * EU-only").
 *
 * It exists as a single choke point because a jurisdiction applied at most call
 * sites is worth nothing — one forgotten `env.REPO_DO.idFromName()` puts a
 * repository's ref state outside the region with no error anywhere. The guard
 * test fails on any direct use of a binding outside this file.
 *
 * Throws on an invalid `DO_JURISDICTION` instead of returning a `Result`, which
 * is deliberate and the exception to "errors are values" here: several callers
 * treat an unavailable namespace as "feature off" and carry on (the magic-link
 * limiter fails open by design), so an error value would be one `if` away from
 * running unrestricted. Failing closed is the only safe reading of a mistyped
 * residency setting. HTTP requests never get this far — the config guard
 * answers 503 first — so this is what stops queue consumers and cron handlers.
 *
 * @param env - Worker bindings
 * @param binding - Which Durable Object binding to resolve
 * @returns The namespace to address objects through, or `undefined` when the binding is absent
 * @throws DurableObjectJurisdictionError when `DO_JURISDICTION` is set to an unsupported value
 */
export function durableObjectNamespace<K extends DurableObjectBinding>(
  env: Pick<Env, K | "DO_JURISDICTION">,
  binding: K,
): Env[K] {
  const parsed = parseDoJurisdiction(env.DO_JURISDICTION);
  if (!parsed.success) throw new DurableObjectJurisdictionError(parsed.error);
  const namespace = env[binding];
  if (!namespace || parsed.data === null) return namespace;
  // `us` is documented and accepted by the runtime, but the pinned
  // `@cloudflare/workers-types` predates it in `DurableObjectJurisdiction`.
  // Asserted here, once, rather than widening every caller.
  const jurisdiction = parsed.data as DurableObjectJurisdiction;
  return namespace.jurisdiction(jurisdiction) as Env[K];
}
