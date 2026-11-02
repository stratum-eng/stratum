# ADR 008: LLM Provider Seam and BYOK Threat Model

## Status

Accepted. Records the threat model for the `llm` evaluator's provider seam and
for bring-your-own-key (BYOK), shipped alongside usage metering and
entitlements.

It lives here rather than in the design document it came from, for the reason
ADR 007 exists: a threat model buried in a product document dies with that
document, and the guards below only stay correct while the reasoning behind them
is readable by whoever next edits `policy-loader.ts` or `llm-providers.ts`.

## Context

Until this change the `llm` evaluator had exactly one place to send a diff: the
instance's Workers AI binding. The endpoint was not configurable, so no part of
`.stratum/policy.yaml` could influence which host the Worker talked to.

Two things changed that.

**A provider seam.** `LlmProvider` now has three implementations —
`WorkersAiProvider` (the default, byte-identical to the previous behavior),
`AnthropicProvider`, and `OpenAiCompatibleProvider`. The last two speak HTTP to
a URL.

**BYOK.** A project may run the merge gate on its own credential instead of the
operator's account, by naming a provider in its policy file and storing a key in
`project_secrets`. That is a feature the operator's own cost model wants — it is
how a project that needs a better reviewer model stops charging the operator for
it — and it is also the point at which repository content starts influencing an
outbound request.

Everything below follows from that last sentence. **The policy file is
repository content**: it is authored in a workspace, by a human or by an agent,
and it is exactly the kind of input this platform exists to gate.

### Who the attacker actually is

Getting this wrong produces guards against the wrong thing, so it is worth
stating precisely.

An earlier draft of this model said "anyone who can open a change can edit the
policy". Two facts in the tree contradict it:

1. **Policy loads from the project's DEFAULT BRANCH.** `runChangeEvaluation`
   calls `loadPolicy(project.remote, …, projectDefaultBranch(project), …)`
   (`src/services/change-flow.ts`), not from the workspace under evaluation. A
   proposed edit to `.stratum/policy.yaml` therefore **never governs its own
   evaluation**. It takes effect only after it merges, behind whatever approvals
   the current policy requires, and `.stratum/policy.yaml` is in
   `PROTECTED_CONFIG_FILES`, so a change touching it is flagged
   (`touches_protected_config`) and cannot be force-merged.
2. **Opening a change requires `canWriteProject`** (`src/routes/changes.ts`).
   The actor is already a collaborator trusted with write access, not an
   anonymous passer-by.

So the reachable threats are:

- **(a) A self-serve project OWNER**, on a multi-tenant instance, using the
  operator's Worker as an SSRF or exfiltration proxy against a host of their
  choosing. They need no privilege escalation at all — they own the project and
  can merge whatever they like into their own default branch. On the hosted
  instance, signing up is the entire cost of becoming this attacker.
- **(b) A compromised or careless writer** whose policy edit lands at merge —
  the ordinary insider case, bounded by review rather than by the loader.

Both are bounded by the same control, but a junior reader who believes the
threat is "the change being evaluated right now" will build guards in the wrong
place and leave the real one open.

**The writer-only assumption is load-bearing, and it expires.** Everything above
rests on `canWriteProject` gating change creation. The day Stratum supports open
contribution — a fork-and-propose flow from someone with no write access — an
untrusted party can propose a policy file, and the second control below (a
policy may not name an endpoint) stops being defense in depth and becomes the
only thing standing between an anonymous submission and the operator's Worker.
Flagged here so it is a known dependency and not a surprise.

## Decision

### 1. A policy may SELECT a provider by name. It may never supply a URL.

The endpoint set is closed and operator-owned. `LLM_PROVIDERS` is an environment
variable holding a list of `{ name, kind, baseUrl }` entries;
`.stratum/policy.yaml` carries `provider: <name>` and nothing else. `baseUrl` is
not read from the policy file at any level of validation — it is not a
restricted field, it is not a field at all.

This is the control the whole model rests on. A `baseUrl` chosen by repository
content turns the Worker into a request-forgery primitive aimed at whatever host
the policy names, and the request it would make carries the diff and the policy
in its body. No amount of URL validation makes "the attacker picks the
destination" safe, because a legitimate destination is indistinguishable from an
attacker-controlled one that answers the same protocol.

An unrecognized provider name is a **rejection, never a fallback**. See control
4 for why it blocks rather than degrades.

### 2. Every URL rule is checked once, at configuration parse time

`llmProviderCatalog` validates each `LLM_PROVIDERS` entry when it is parsed, not
per request: `https` only, no embedded credentials, no query string or fragment,
a name matching `^[a-z][a-z0-9-]{0,31}$`, at most 16 entries, and a host that
passes the private-address filter. The stored `baseUrl` is **normalized** to
origin-plus-path, because `https://host#` and `https://host?` both pass an
emptiness check on `hash`/`search` while burying the provider's appended
`/messages` path inside a fragment or a query.

Parse-time is deliberate. Re-validating an immutable value on the hot path costs
something and buys nothing, and worse, a per-request check means a bad entry is
discovered by the first project unlucky enough to select it rather than by the
operator who wrote it.

### 3. One private-host filter, shared with the webhook evaluator

Host filtering is `privateHostReason` in `src/utils/validation.ts`, and both the
provider allowlist and `validateWebhookUrl` call it. It rejects loopback,
link-local, RFC1918, CGNAT (`100.64/10`), the `.internal` and `.local` suffixes
(GCP's metadata endpoint is `metadata.google.internal`), and IPv6 equivalents,
classifying bracketed literals by mask rather than by their spelling.

This began as two implementations and they drifted, which is what a duplicated
security filter always does. The provider copy missed CGNAT, `.internal`,
everything in `fe80::/10` not literally spelled `fe80`, and the IPv4-compatible
IPv6 form `[::127.0.0.1]` — which the URL parser hands on as `[::7f00:1]`. The
webhook copy had the last two as well, so unifying them **closed a pre-existing
SSRF gap in the webhook evaluator**, which is worth recording: the fix belongs
to a path nobody set out to change.

### 4. `sanitizeLlmConfig` is a whitelist, and it fails the file closed

`sanitizeLlmConfig` (`src/evaluation/policy-loader.ts`) replaced a copy-through.
It keeps four keys — `provider`, `model`, `threshold`, `maxDiffChars` — and
resolves `provider` against the operator's catalog at parse time. Anything else
in the entry, `baseUrl` included, is dropped with a warning. A policy may
declare **at most one** `llm` entry, and `model` is **required** whenever
`provider` is set.

Rejecting an entry fails the **whole policy file** closed and blocks merges.
That is the opposite of what a rejected `deploys:` entry does two files away
(`src/deploy/config.ts`, whose comment says "do not fix this"), and the asymmetry
is deliberate: a deploy runs *after* the merge, so a bad entry costs a failed
deployment row, whereas an `llm` entry is a **gate**, and a gate that cannot run
must not pass. An unresolvable provider name is precisely a gate that cannot
run.

Two of these rules are fail-open closures rather than tidiness:

- **One `llm` entry.** `LLMEvaluator` read the *first* `llm` entry while
  `buildEvaluators` constructed an evaluator for *every* one, so
  `[{llm}, {llm, provider: …}]` ran twice on the operator's Workers AI account
  with no error and no log — a policy that asked to run on its own key silently
  running on the operator's.
- **`model` required with `provider`.** The default model id is a Workers AI
  slug, and posting it to Anthropic or an OpenAI-compatible endpoint fails every
  call. Inventing a per-kind default would silently choose a model — and a price
  — on the project's behalf.

### 5. Credential handling fails closed, with no `env.AI` fallback

Credentials live in `project_secrets` (AES-GCM, `(project_id, name)` as AAD, no
route-reachable read path). The secret name is **derived** from the provider
name (`anthropic` → `ANTHROPIC_API_KEY`) rather than configured, so an
`LLM_PROVIDERS` entry cannot point at a credential the project stored for
something else.

Every failure — `DEPLOY_SECRET_KEY` unset, the secret missing, the row
undecryptable, the provider name unresolvable, a redirect — fails the gate with
its own distinct reason. **None of them falls back to the Workers AI binding.**
Falling back would put the spend back on the operator's bill, which is the hole
BYOK closes, and would be a gate that silently stops gating.

The credential load is skipped entirely when the policy names no provider, which
is the overwhelmingly common case and matters because the load is a D1 read plus
a 100k-iteration PBKDF2 derivation on the change-creation path.

### 6. Redirects are refused

The provider fetch uses `redirect: "manual"` and treats any 3xx as a failed
evaluation. The allowlist binds the host a request is **sent** to; a redirect
from an allowlisted host moves the prompt — the diff and the policy — to a host
nobody validated, and on 307/308 the body goes with it. `x-api-key` is not a
header the Fetch spec strips cross-origin, so the project's own credential
follows. The webhook evaluator in the same directory already refused to follow
redirects, for exactly this reason.

### 7. Prompt sanitization is recursive over the whole policy

The serialized policy is part of the prompt (`llm-evaluator.ts`), so anything in
`.stratum/policy.yaml` is sent to the provider verbatim. `sanitizePolicy` used
to strip `webhook.secret` alone, then one level inside each evaluator entry —
while `parsePolicyContent` spreads unknown root keys onto the policy. A
credential written at the top of the file, or nested inside an entry of an
unmodelled type, reached both the review model and the body POSTed to a
policy-supplied webhook URL, which is an attacker-chosen host.

It now strips recursively over the whole policy, with depth and size bounds, on
field **names** (`secret`, `token`, `auth`, `apiKey`, `hmac`, `sig`, `pat`, …,
with plurals stemmed) rather than on values — there is no reliable way to
recognise a secret by its bytes. `keystone` and `monkeys` survive; `tokens` and
`apiKeys` do not.

Two boundaries on this, stated so they are not mistaken for guarantees:

- **`redactSecrets` is the backstop, not the control.** Its own doc comment says
  literal-substring redaction is defeated by a base64 or JSON-escaped echo. The
  actual control is structural and already in the file: **provider output never
  reaches `EvalResult.reason`.**
- **An oversize policy fails the gate closed.** `policyContext` is capped at
  `MAX_POLICY_CONTEXT_CHARS` (8,000), so adding a provider block to an already
  large policy can block merges on a project that worked yesterday. That is the
  safe direction, and it is a real operational edge, not a theoretical one.

### 8. The provider block must live in a protected config file

Extending `PROTECTED_CONFIG_FILES` was considered and cut: the check is
whole-file, and `.stratum/policy.yaml` is already covered in full, provider
block included. The requirement is the inverse and it is a constraint on future
work — **the provider block must never move to a third file the protected-config
flag does not cover.**

Its actual shape is worth repeating from ADR 007, because this ADR leans on it:
`diffTouchesProtectedConfig` is a substring match for
`diff --git a/.stratum/policy.yaml b/.stratum/policy.yaml`. A rename, non-default
diff prefixes, or a path requiring git quoting would defeat it.

## What is explicitly NOT defended

- **DNS rebinding.** The host in `baseUrl` is resolved by the runtime at request
  time, after the allowlist validated the *name*. A name that passes the private
  address filter and then resolves to a private address defeats the filter. There
  is no resolve-then-pin primitive available to a Worker's `fetch`, so the filter
  is a check on the configured name, not on the packet's destination. It is
  mitigated in practice by the endpoint set being operator-configured rather than
  attacker-supplied — which is control 1 doing the work again.
- **A malicious operator.** Everything here protects the operator from the
  projects on their instance, not the projects from their operator. An operator
  configures the endpoint list, holds `DEPLOY_SECRET_KEY`, and runs the Worker
  that decrypts and uses a project's provider credential. A project trusting an
  instance with a key is trusting whoever runs it; nothing in this design changes
  that, and pretending otherwise would be worse than saying it.
- **The provider itself.** The diff and the policy are sent to the endpoint the
  operator configured. Its logging, retention and jurisdiction are the operator's
  choice and the project's risk to accept.
- **A project owner spending their own credit.** Any project *writer* can drain
  the owner's provider credit by opening changes. It is bounded by
  `evaluations_per_hour`, deliberately not lifted by BYOK, and by nothing else;
  BYOK adds no approval step in front of the spend. Documented at the point of
  configuration (`docs/user-guide/getting-started.md`), where a reader who assumes
  "my own key means no limits" would otherwise file the ceiling as a bug.

## Residual risks accepted

- **`LLM_PROVIDERS` is trusted input.** It is operator configuration and is
  validated, but a misconfigured entry — a proxy that fans out, an endpoint that
  logs prompts — is not something the parser can detect. Staging exists to
  exercise a new entry before production, where a bad one shows up only as blocked
  merges on the projects selecting it.
- **BYOK couples the merge gate to `DEPLOY_SECRET_KEY` rotation.** Rotating that
  key already makes every stored deploy secret undecryptable
  (`wrangler.toml`); it now also blocks the gate on every BYOK project until each
  re-enters its provider key. This widens the blast radius of a documented
  operation rather than introducing an undocumented one.
- **Token accounting is per response, not per provider.** An OpenAI-compatible
  endpoint that omits `usage` puts that response back on the `~4 chars/token`
  estimate, marked `estimated` on the cost record. A provider that reports
  *wrong* counts is believed.
- **There is no MCP surface for writing a provider key, and there must not be.**
  `stratum_set_provider_key` looks like an obvious gap to anyone extending the
  tool list; it is ruled out because a credential must never pass through a
  model's context window, and this model rests on credentials not being
  selectable by the wrong party. The write surface is the web UI or the CLI —
  the same line that keeps agent tokens from submitting review verdicts.

## Alternatives considered

**Allow `baseUrl` in the policy, validated per request.** Rejected. It is the
threat, not a configuration convenience; see control 1. Every validation scheme
proposed for it reduces to "the attacker picks the destination and we check that
the destination looks normal".

**Make the secret name configurable per provider entry.** Rejected: it would let
one provider entry read a credential a project stored for an unrelated purpose.
Derivation from the provider name makes the mapping total and unguessable-free.

**Fall back to Workers AI when BYOK cannot run.** Rejected as the defining
fail-open of this feature. It restores the operator's bill, and it converts a
gate that cannot run into a gate that passes.

**Treat an unresolvable provider as a dropped evaluator rather than a policy
error.** Rejected for the reason in control 4: a merge gate that quietly stops
existing is the top risk of the whole change.
