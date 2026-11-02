import type { EvalPolicy, EvaluatorConfig } from "./types";

/**
 * Fields whose *name* says the value is a credential.
 *
 * Matched on the key rather than the value because there is no reliable way to
 * recognise a secret by its bytes, and this runs on repository content: whatever
 * a user wrote in the policy file, under whatever key they chose.
 *
 * Stems, not spellings. Plurals are normalized by {@link isCredentialWord}, so
 * `token` covers `tokens` and `apiKey` covers `apiKeys` and `access_tokens`
 * without either having to be listed. `auth` is here on its own because it is
 * one of the most common credential key names there is, and listing only
 * `authorization` let it through.
 */
const CREDENTIAL_WORDS = new Set([
  "secret",
  "token",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "credential",
  "cred",
  "auth",
  "authorization",
  "authorisation",
  "bearer",
  "key",
  "apikey",
  "signature",
  "sig",
  "hmac",
  "pat",
  "otp",
]);

/**
 * Split a field name into words on camelCase and separator boundaries, so
 * `apiKey`, `api_key` and `API-KEY` are all recognised while `monkeys` — which
 * merely contains "key" — is not.
 */
function words(key: string): string[] {
  return key
    .split(/[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/**
 * Whether one word of a field name names a credential.
 *
 * The trailing-`s` rule is what makes `tokens`, `apiKeys` and `passwords`
 * behave like their singulars. It is deliberately only a *stem* test and not a
 * substring one, because the property the strip list must keep is that
 * `keystone` and `monkeys` survive: `monkeys` stems to `monkey`, which is not a
 * credential word, while a substring match would strip both.
 */
function isCredentialWord(word: string): boolean {
  if (CREDENTIAL_WORDS.has(word)) return true;
  return word.endsWith("s") && CREDENTIAL_WORDS.has(word.slice(0, -1));
}

/** Keys stripped wherever they appear in the policy, regardless of shape. */
function isStrippedKey(key: string): boolean {
  // The provider *name* is not a credential, but it names the operator's
  // infrastructure to a third party the operator did not choose — and the model
  // has no use for it. It costs nothing to withhold, and withholding it is what
  // makes adding a provider to a policy free against
  // `MAX_POLICY_CONTEXT_CHARS`: the serialized policy does not grow, so a
  // project that fits today cannot start failing its gate closed by opting into
  // BYOK.
  if (key === "provider") return true;
  return words(key).some(isCredentialWord);
}

/**
 * Bounds on the walk, so a hostile policy file cannot make sanitization
 * expensive (or produce an output larger than the input).
 *
 * The depth bound doubles as the cycle guard: a YAML alias cycle
 * (`a: &x {b: *x}`) is a perfectly well-formed file and an infinite structure,
 * and the walk below would otherwise not terminate on one.
 */
const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const MAX_ARRAY_ITEMS = 256;
const DEPTH_ELISION = "[omitted: policy nesting limit]";
const SIZE_ELISION = "[omitted: policy size limit]";

interface Budget {
  left: number;
}

/** Recursively rebuild `value` without any credential-shaped key. */
function stripValue(value: unknown, depth: number, budget: Budget): unknown {
  if (budget.left <= 0) return SIZE_ELISION;
  budget.left -= 1;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return DEPTH_ELISION;

  if (Array.isArray(value)) {
    const kept: unknown[] = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => stripValue(item, depth + 1, budget));
    if (value.length > MAX_ARRAY_ITEMS) kept.push(SIZE_ELISION);
    return kept;
  }

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isStrippedKey(key)) continue;
    if (budget.left <= 0) break;
    out[key] = stripValue(nested, depth + 1, budget);
  }
  return out;
}

/**
 * Strip credentials from a policy before it leaves the Worker (serialized into
 * an LLM prompt, or a webhook request body).
 *
 * This is the last thing that runs before the policy is handed to a third
 * party, so it strips by key shape rather than by known field, **recursively,
 * over the whole policy object** — not just over the top level of each
 * evaluator entry, which is all it used to do. Both of the holes that left are
 * real: `parsePolicyContent` spreads unknown ROOT keys onto the policy, so an
 * `apiKey:` written at the top of `.stratum/policy.yaml` reached the model
 * prompt and the policy-supplied webhook URL (a host the policy file chose);
 * and `sanitizeEvaluator` copies an entry of an unmodelled `type` through
 * whole, so a credential nested one level inside such an entry — an object or
 * an array, exactly the copy-through case the strip list exists for — was
 * untouched.
 *
 * `webhook.secret` is the field this was originally written for: it signs
 * outgoing requests and must never appear in a payload itself.
 *
 * Note what this is *not*: a defence against the model seeing secrets in the
 * diff. The diff is the thing being reviewed, and `redactSecrets`
 * (`deploy/redact.ts`) is explicit that literal-substring redaction is a
 * backstop. The structural control is upstream — provider output never reaches
 * `EvalResult.reason` (`llm-evaluator.ts`).
 */
export function sanitizePolicy(policy: EvalPolicy): EvalPolicy {
  const stripped = stripValue(policy, 0, { left: MAX_NODES });
  const base =
    typeof stripped === "object" && stripped !== null && !Array.isArray(stripped)
      ? (stripped as Record<string, unknown>)
      : {};
  return {
    ...base,
    // Restated rather than trusted: `evaluators` is typed as an array and both
    // callers serialize the result, so a policy large enough to exhaust the
    // node budget must still hand back the shape the type promises.
    evaluators: Array.isArray(base.evaluators) ? (base.evaluators as EvaluatorConfig[]) : [],
  } as EvalPolicy;
}
