/**
 * The operator's LLM provider allowlist, parsed from the `LLM_PROVIDERS` var.
 *
 * This is the **only** place a provider endpoint may be named. A project's
 * `.stratum/policy.yaml` may SELECT one of these by name and can never supply a
 * `baseUrl` (PRD §7): a base URL a repository's own policy chose would turn the
 * operator's Worker into a request-forgery primitive aimed at whatever host the
 * policy names, and the prompt it would receive contains the diff.
 *
 * Every URL rule below is checked once, here, at parse time — not per request.
 * Per-request checking would re-validate an immutable value on the hot path and,
 * worse, would mean a bad entry is discovered by the first project unlucky
 * enough to select it rather than by the operator who wrote it.
 */
import type { Env } from "../types";
import type { Logger } from "../utils/logger";
import { privateHostReason } from "../utils/validation";

/**
 * Wire protocols the evaluator can speak, one per HTTP implementation in
 * `llm-provider.ts`. A third kind needs a class before it can be a value here.
 */
export const LLM_PROVIDER_KINDS = ["anthropic", "openai-compatible"] as const;
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

const KIND_SET = new Set<string>(LLM_PROVIDER_KINDS);

/** One operator-configured provider. Credentials are deliberately absent: they
 * live per project in `project_secrets`, never in an environment variable that
 * every project's policy can select. */
export interface ConfiguredLlmProvider {
  name: string;
  kind: LlmProviderKind;
  baseUrl: string;
}

/** Provider name to definition. Empty means "Workers AI only" — the default. */
export type LlmProviderCatalog = ReadonlyMap<string, ConfiguredLlmProvider>;

/** Parsing either yields a catalog or says why the operator's config is unusable. */
export type LlmProvidersParse =
  | { status: "ok"; providers: LlmProviderCatalog }
  | { status: "invalid"; reason: string };

/** Fields an `LLM_PROVIDERS` entry may carry. */
const ENTRY_KEYS = new Set(["name", "kind", "baseUrl"]);

/**
 * Provider names are as narrow as deploy names, and for the same reason: a
 * policy file selects one by name, and the name is echoed into log lines,
 * evaluation reasons, and the derived secret name.
 */
const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Enough for every provider one instance realistically fronts; bounds the parse. */
const MAX_PROVIDERS = 16;

const EMPTY_CATALOG: LlmProviderCatalog = new Map();

/**
 * The `project_secrets` name holding this provider's credential.
 *
 * Derived rather than configured so an entry cannot name an arbitrary secret:
 * `LLM_PROVIDERS` is operator config, but making the secret *name* configurable
 * would let one provider entry read a credential a project stored for something
 * else entirely. `PROVIDER_NAME_PATTERN` guarantees the result matches
 * `SECRET_NAME_PATTERN` (`^[A-Z][A-Z0-9_]{0,63}$`) — an uppercased 32-char
 * name plus the suffix is 40.
 */
export function providerSecretName(providerName: string): string {
  return `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/**
 * Why this host must not be fetched, or null when it is fine.
 *
 * A thin alias for `privateHostReason` (`utils/validation.ts`), which is the
 * one host filter in the codebase and is also what `validateWebhookUrl` uses.
 * This used to be a second implementation, and the two drifted exactly as a
 * duplicated security filter always does: this copy missed CGNAT, the
 * `.internal` suffix (GCP's metadata endpoint is `metadata.google.internal`),
 * everything in `fe80::/10` not literally spelled `fe80`, and the
 * IPv4-compatible IPv6 form `[::127.0.0.1]`, which the URL parser hands on as
 * `[::7f00:1]`.
 *
 * Kept as a named export because the reason is interpolated into the operator's
 * config error, and because the allowlist is where this rule is *enforced*:
 * every URL rule is checked once, at parse time, not per request.
 */
export function blockedHostReason(hostname: string): string | null {
  return privateHostReason(hostname);
}

/** A validated `baseUrl`, normalized, or why the entry cannot be used. */
type BaseUrlCheck = { ok: true; baseUrl: string } | { ok: false; reason: string };

function checkBaseUrl(name: string, raw: unknown): BaseUrlCheck {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: `provider "${name}": "baseUrl" is required and must be a string` };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `provider "${name}": "baseUrl" is not a valid absolute URL` };
  }

  if (url.protocol !== "https:") {
    // Not tidiness: the request carries the project's API key and the diff.
    return {
      ok: false,
      reason: `provider "${name}": "baseUrl" must use https, not ${url.protocol.replace(":", "")}`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: `provider "${name}": "baseUrl" must not embed credentials` };
  }
  if (url.search !== "" || url.hash !== "") {
    return {
      ok: false,
      reason: `provider "${name}": "baseUrl" must not carry a query string or fragment`,
    };
  }
  const blocked = blockedHostReason(url.hostname);
  if (blocked) {
    return {
      ok: false,
      reason: `provider "${name}": "baseUrl" host is not reachable from an allowlist — ${blocked}`,
    };
  }

  // Normalized, never the raw string. `https://host#` and `https://host?` both
  // pass the two emptiness checks above — the parser reports an empty hash and
  // an empty search for them — while the bytes the operator wrote would put the
  // provider's `/messages` path inside a fragment or a query. Origin plus path
  // is what `href` would give minus exactly those two, and the trailing slash
  // goes because the provider classes append an absolute path.
  return { ok: true, baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, "") };
}

/**
 * Parse `LLM_PROVIDERS`, rejecting the whole document on the first problem.
 *
 * All-or-nothing rather than "keep the entries that parsed", because a
 * half-applied allowlist is the failure this is meant to prevent: an operator
 * who typo'd one entry would get merges blocked on the projects selecting it
 * with nothing anywhere saying why. One rejection with a reason is louder, and
 * `llmProvidersConfigError` puts it in the logs on the first request after a
 * bad deploy.
 *
 * An unset (or blank) value is not an error — it is the default, and it means
 * Workers AI only.
 */
export function parseLlmProviders(raw: string | undefined): LlmProvidersParse {
  if (raw === undefined || raw.trim() === "") return { status: "ok", providers: EMPTY_CATALOG };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "invalid",
      reason: `LLM_PROVIDERS is not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    };
  }

  if (!Array.isArray(parsed)) {
    return { status: "invalid", reason: "LLM_PROVIDERS must be a JSON array of provider objects" };
  }
  if (parsed.length > MAX_PROVIDERS) {
    return {
      status: "invalid",
      reason: `LLM_PROVIDERS declares ${parsed.length} providers; at most ${MAX_PROVIDERS} are allowed`,
    };
  }

  const providers = new Map<string, ConfiguredLlmProvider>();

  for (const [index, entry] of parsed.entries()) {
    const at = `LLM_PROVIDERS[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { status: "invalid", reason: `${at} must be an object` };
    }
    const source = entry as Record<string, unknown>;

    const unknownKeys = Object.keys(source).filter((key) => !ENTRY_KEYS.has(key));
    if (unknownKeys.length > 0) {
      // Rejected rather than ignored: a misspelled key here is silently
      // dropped configuration on a security boundary, and `baseURL` for
      // `baseUrl` is exactly the typo an operator would not notice.
      return {
        status: "invalid",
        reason: `${at} has unrecognized field(s) ${unknownKeys.map((k) => `"${k}"`).join(", ")}`,
      };
    }

    if (typeof source.name !== "string" || !PROVIDER_NAME_PATTERN.test(source.name)) {
      return {
        status: "invalid",
        reason: `${at}: "name" must match ${PROVIDER_NAME_PATTERN.source} (lowercase letters, digits and dashes, max 32 chars)`,
      };
    }
    const name = source.name;
    if (providers.has(name)) {
      return { status: "invalid", reason: `${at}: duplicate provider name "${name}"` };
    }

    if (typeof source.kind !== "string" || !KIND_SET.has(source.kind)) {
      return {
        status: "invalid",
        reason: `provider "${name}": "kind" must be one of ${LLM_PROVIDER_KINDS.join(", ")}`,
      };
    }

    const url = checkBaseUrl(name, source.baseUrl);
    if (!url.ok) return { status: "invalid", reason: url.reason };

    providers.set(name, {
      name,
      kind: source.kind as LlmProviderKind,
      baseUrl: url.baseUrl,
    });
  }

  return { status: "ok", providers };
}

/**
 * The parse memoized for the isolate's lifetime, keyed on the raw value so a
 * test (or a rebind) that changes it is not served a stale catalog.
 */
let cached: { raw: string | undefined; parse: LlmProvidersParse } | null = null;

/** Drop the memoized parse. Exists for tests; production rebinds per isolate. */
export function resetLlmProviderCache(): void {
  cached = null;
}

function parseCached(raw: string | undefined): LlmProvidersParse {
  if (cached === null || cached.raw !== raw) cached = { raw, parse: parseLlmProviders(raw) };
  return cached.parse;
}

/**
 * The catalog for this environment, or an empty one when the config is unusable.
 *
 * Empty-on-invalid is the fail-closed direction, not a silent disable: an empty
 * catalog means every policy naming a provider is rejected by
 * `sanitizeLlmConfig`, which fails the policy file closed and blocks merges with
 * a reason that NAMES the unconfigured provider — the rejection it records is
 * carried into `parsePolicyContent`'s malformed reason, so the person fixing the
 * file is not left with a bare count of unusable entries. Projects on Workers AI
 * — which is every project that never opted into BYOK — are untouched by an
 * operator's typo. The typo itself is reported by `llmProvidersConfigError` and
 * logged here on the isolate's first parse.
 */
export function llmProviderCatalog(
  env: Pick<Env, "LLM_PROVIDERS">,
  logger?: Logger,
): LlmProviderCatalog {
  const hadCache = cached !== null && cached.raw === env.LLM_PROVIDERS;
  const parse = parseCached(env.LLM_PROVIDERS);
  if (parse.status === "invalid") {
    if (!hadCache) {
      logger?.error("LLM_PROVIDERS is invalid; BYOK providers are unavailable", undefined, {
        reason: parse.reason,
      });
    }
    return EMPTY_CATALOG;
  }
  return parse.providers;
}
