# Monetization and BYOK

**Status:** research / proposal, now **partly superseded by what shipped**. The
metering, entitlement, enforcement and BYOK machinery described below is in the
tree — see `docs/CURRENT_CAPABILITIES.md` for what exists,
`docs/adr/008-llm-provider-byok-threat-model.md` for the threat model as
implemented, and `docs/REMAINING_WORK.md` for what is still open. Where this
document and those disagree, they are right and this is the earlier thinking.
Pricing, plan definitions and payment remain unimplemented, and a self-hoster's
behavior is still unchanged: every allowance is unlimited unless a billing
service is configured.

This document scopes how Stratum charges for hosted usage without withholding
code from the open-source repository, what the free tier costs the operator, and
how a project supplies its own model credentials (BYOK) instead of consuming a
hosted allowance.

It exists because [`ROADMAP.md`](../../ROADMAP.md) carries **Multi-tenancy and
billing** as an open operational item with "per-change cost tracking already
exists and provides the metering foundation", and that foundation needs a design
before it grows a payment integration around it.

---

## 1. The constraint the license already set

[`LICENSING.md`](../../LICENSING.md) settled two things that decide most of this
design, and re-litigating them here would be wasted effort.

The server is **AGPL-3.0-or-later**. Anyone may fork it, delete a paywall, and
run it — commercially. §13 only obliges them to publish the modified source.
That is not a loophole to close; it is the deal the project made deliberately at
v0.3.0. Any monetization plan that depends on a self-hoster being unable to
remove a check is already broken, so no plan below depends on that.

There is a **CLA** ([`CLA.md`](../../CLA.md)), so dual licensing is available,
and `LICENSING.md` already advertises commercial terms. That is a second revenue
line that requires no code split at all, and it is worth more than it looks:
a large share of enterprises run an OSS policy that flatly refuses AGPL
dependencies. For those buyers the product is not a feature — it is the license.

What follows from that: **sell operations and terms, not code.** The hosted
instance sells the thing a fork cannot copy — running it, on someone else's
Cloudflare bill, with backups tested and an SLA. The commercial license sells
the thing the AGPL cannot give. Neither requires a proprietary `ee/` directory,
and both survive a fork.

### The one gap to close first

Trademark is the only enforcement lever the AGPL leaves against a hosted
competitor, and the repository does not currently exercise it. There is no
`TRADEMARK.md`, and "Stratum" is not reserved anywhere in the licensing docs.
A fork may run the code; it may not call itself Stratum or use the mark to sell
against you. Registering the mark and adding a short trademark policy is cheap,
takes a week, and should land before any of the engineering below.

---

## 2. What actually costs money

The honest basis for a paywall is marginal cost to the operator plus scarcity of
a shared resource. Sorted by both, using what the code already meters and bounds:

**Unbounded per-change spend.** The LLM evaluator (`src/evaluation/llm-evaluator.ts`)
runs on the Workers AI binding — the operator's neurons, not the author's. It is
invoked from `runEvaluation` in `src/services/change-flow.ts`, **synchronously at
change creation**, with a per-call input bound of `MAX_DIFF_CHARS_CEILING`
(100,000 chars) and no bound at all on how many times a user may create a change.
This is the single largest exposure and the obvious first thing to meter.

**Shared scarce capacity.** Deployments are worse than expensive — they are
serialized. `MAX_DEPLOY_CONCURRENCY = 1` in `src/deploy/limits.ts`, and the
comment there explains it cannot be raised without first cutting the per-deploy
memory peak. One free user's deploy queue is therefore in front of a paying
customer's. Same shape, less severe, for the import queue and the merge queue
Durable Object.

**Sandbox milliseconds.** Bounded per run by `MAX_TOTAL_BUDGET_MS`
(`src/evaluation/limits.ts`), unbounded in count. Currently theoretical: the
`[[sandboxes]]` binding is commented out at `wrangler.toml:156`, so nothing
executes code on any deploy today. It becomes the second-largest exposure the
day that binding is enabled.

**Bytes that never go away.** Git objects on Artifacts and R2, backup blobs
(`BACKUP_RETENTION`, default 14 runs), and D1 rows — `events`, `audit_log`,
`provenance`, `cost_records`. The roadmap's "D1 hot/cold rotation" item is the
same problem seen from the operations side; retention tiers are the same lever
seen from the pricing side, and they should be designed together rather than
twice.

**Near zero.** Everything else. The change flow itself, reviews, issues, orgs and
teams, the CLI, `/mcp`, git clone and push, webhooks, API tokens, and the
deterministic evaluators (`diff-evaluator`, `secret-scanner`) are Worker CPU on
requests that are already rate-limited. Gating any of these recovers no money
and costs the project its reputation. They stay free, permanently, for everyone.

That last paragraph is the load-bearing one. The credible version of this
paywall meters four things — model tokens, sandbox time, deploy slots, stored
bytes — and leaves the product alone.

---

## 3. Tier shape

Concrete allowances are deliberately omitted; §7 says to measure before setting
them. What matters now is which axis each tier moves along.

**Free.** Unlimited public projects and unlimited collaborators on them. A small
number of private projects. A monthly platform-LLM allowance sized to a few dozen
real changes. Sandbox off. One deploy target. A storage cap. Short retention on
events and audit entries. Community support. **BYOK available** — see §5.

**Pro**, per seat. Private projects unlimited, a real platform-LLM allowance,
sandbox on, deploys, 90-day retention, a higher rate-limit bucket, priority in
the deploy and import queues, email support.

**Team**, per seat. Orgs, teams, per-project permission grants (a roadmap item
today), SSO, one-year audit retention with export, self-serve backup restore,
higher concurrency, an SLA.

**Enterprise self-managed.** A commercial license per `LICENSING.md`, support,
and no usage metering whatsoever, because it runs on their infrastructure.

Two notes on the boundaries. Do not put SSO alone behind the top tier as the
only reason to reach it — the "SSO tax" is the most reliably resented pattern in
this market. It belongs in Team alongside SCIM, audit export, and permission
grants, as one item in a coherent administrative bundle rather than the toll.
And free-tier caps must be **hard**, with an explicit top-up, not silent
overage: Workers AI and queue time are real spend and a loop is one script away.
Paid tiers get soft overage with alerts, because a blocked merge on a paying
customer's release day is worth more than the overage.

---

## 4. Enforcement architecture

The pattern to copy is already in the repository. `src/beta/gate.ts` is a
cloud-only hook that lives in the AGPL tree, calls out to a service that is not
in this repository, and is **completely inert when its environment variables are
unset** — which is the default, so self-hosters are unaffected and the code that
does the gating is still readable by everyone. Generalize exactly that.

### 4.1 Entitlements

A new `src/billing/entitlements.ts` defines the interface and ships a default
implementation that grants everything:

```ts
export type LimitKey =
  | "llm_tokens_month"
  | "sandbox_ms_month"
  | "deploys_month"
  | "storage_bytes"
  | "private_projects"
  | "requests_per_minute"
  | "retention_days";

export interface Entitlements {
  plan: string;                         // "self-hosted" by default
  limits: Record<LimitKey, number>;     // -1 = unlimited
}

export interface EntitlementsProvider {
  forOwner(ownerId: string, kind: "user" | "org"): Promise<Entitlements>;
}
```

`UnlimitedEntitlements` is the default and returns `-1` for every key. A
`RemoteEntitlements` provider activates only when `BILLING_SERVICE_URL` and
`BILLING_SERVICE_SECRET` are set, mirroring `betaGateEnabled`. Plan definitions,
Stripe, invoices, dunning, and the customer portal all live behind that URL, in
the same private cloud layer that already hosts the referral service. None of it
belongs in this repository, and none of it needs to be.

**Fail direction, and why it differs from the beta gate.** `validateInviteCode`
fails *closed* — a service outage must not let ungated users through a signup
wall. Entitlements must fail *open*, to the last cached value or to the free
tier, because a billing-service outage that blocks a paying customer's merge is
a strictly worse failure than a few minutes of unmetered usage. Cache in
`env.STATE` with a short TTL and a stale-while-error read. Write this asymmetry
into the module's doc comment; it will otherwise be "fixed" by someone applying
the beta gate's convention.

### 4.2 Metering

There are two counters with different jobs, and conflating them is the classic
way to build a billing system that is both slow and wrong.

`cost_records` (migration 021) stays the **durable ledger**. It is already
written by `recordCosts` from `runEvaluation`, already carries
`llm_tokens | sandbox_ms | git_ops` and an `estimated` flag, and it is what an
invoice or a dispute is reconciled against. It needs two additive migrations:

- **`owner_id`** — the table records `project`, `project_id`, `change_id`, and
  `workspace`, but nothing identifying who pays. Every per-customer aggregate is
  impossible until this exists, and backfilling it later means joining through
  namespaces for historical rows. Add it before the volume grows.
- **`source`** (`'platform' | 'byok'`) — §5 needs to attribute usage that must
  not be charged. Without it, BYOK tokens are indistinguishable from hosted ones
  in the ledger.

The **hot counter** that gates a request is separate. It must not lose
increments under concurrency, which rules out the read-modify-write on KV that
`src/middleware/rate-limit.ts` currently performs — that race is acceptable for a
per-minute request limiter and is not acceptable for anything that gates spend.
The codebase already has the right precedent: `MagicLinkRateLimiter`, described
in `src/types.ts` as "serialized magic-link send counters". Add a `UsageMeter`
Durable Object per owner on the same model, reconciled against `cost_records` by
the existing scheduled handler.

The rule to state once and follow: **Durable Object for anything that gates
spend, KV for anything that gates request rate.**

### 4.3 Where the checks go

Four call sites, and one design decision inside the first.

*Before the LLM evaluator runs*, in `buildEvaluators` or at the top of
`LLMEvaluator.evaluate`. The decision is what an exhausted allowance means for a
merge *gate*. Silently skipping the evaluator is a governance hole — a policy
that requires AI review would stop requiring it the moment someone ran out of
credit, which is the worst possible failure for the product's entire premise.
Instead, mirror the existing behavior in that file for an oversize policy
context: return `ok()` with `passed: false` and a reason naming the cause and
both remedies (upgrade, or add your own key). That is already the established
shape at `llm-evaluator.ts` and it converts honestly.

*Before claiming a deploy message*, in the queue consumer, so a free-tier deploy
never occupies the single concurrency slot ahead of a paid one.

*At import and at `git-receive-pack`*, for storage bytes. Pushes already flow
through the rate limiter deliberately (`isExemptGitRead` exempts only the read
side), so the hook point exists.

*At private-project creation*, for the count.

And `rateLimitMiddleware`'s `defaultLimit` becomes entitlement-derived rather
than the current binary `isAuthenticated ? 1000 : 60`.

---

## 5. BYOK

BYOK is the feature that makes this a capacity limit rather than a paywall on
the open-source project, and it should ship *before* any cap is enforced. A free
user who supplies a key gets unlimited AI review, bounded only by request rate.
That framing is both true and the honest thing to say publicly.

### 5.1 The agent already does it

`agent/src/llm.ts` calls the Anthropic API directly with the user's own
`ANTHROPIC_API_KEY`, from the user's own machine, under Apache-2.0. The most
expensive model work in the whole system — actually writing the code — already
never touches the server and never will. Say so in the pricing page; it removes
the first objection before it is raised.

### 5.2 What is missing: server-side evaluator BYOK

`LLMEvaluator` takes an `AiBinding` in its constructor and is hard-wired to
Workers AI. Introducing a provider seam is a small refactor that is worth doing
for its own sake, independent of billing — it is what lets a self-hoster use a
frontier model, or a local vLLM, for their merge gate.

```ts
export interface LlmProvider {
  run(model: string, messages: Message[]): Promise<{ text: string; usage?: Usage }>;
}
```

Three implementations: `workers-ai` wrapping the existing binding and remaining
the default so nothing changes for anyone; `anthropic`; and `openai-compatible`,
which covers OpenAI, OpenRouter, Groq, Together, and self-hosted vLLM in one.
A real provider also returns real token counts, which retires the
`~4 chars/token` estimate and the `estimated: true` flag on those cost samples.

### 5.3 Key storage — already built

`project_secrets` (migration 047) is the right store and needs no redesign. It
is AES-GCM with `(project_id, name)` bound as additional authenticated data, so
a row copied to another project fails to decrypt rather than authorizing against
the wrong account; it is write-only by construction with no read path reachable
from any route; and `SECRET_NAME_PATTERN` already accepts `ANTHROPIC_API_KEY`
and `OPENAI_API_KEY` unchanged. The evaluator gets a `loadSecretValues` path
alongside the deploy runner's, held to the same rule: not reachable from a
route.

The one extension needed is scope. `SecretScope` in `src/utils/crypto.ts` is
project-shaped, and a team will want one key for an org rather than one per
project. Add an org-scoped variant of the AAD; do not widen the existing one.

### 5.4 The security problem, which is the real work here

`.stratum/policy.yaml` is **repository content**. Anyone who can open a change
can propose an edit to it. Adding a `provider` and `baseUrl` to the evaluator
config therefore hands an attacker a request forgery primitive on the Worker,
and the body of that request is the diff — the customer's source code, plus
whatever the secret scanner was about to catch.

Three mitigations, all mandatory:

1. **`baseUrl` is never taken from the policy file.** The operator sets an
   allowlist in the environment (`LLM_BYOK_ALLOWED_HOSTS`), and the policy may
   only *select* a configured provider by name. This is not negotiable and is
   the reason the config surface is `provider: anthropic` rather than a URL.
2. **Sanitize like `deploys:` already does.** `sanitizeDeploys` in
   `src/deploy/config.ts` is the pattern: build a fresh object, never pass a
   slice of parsed user input downstream, and surface every rejection as a
   visible `deployRejections`-style entry rather than a dropped `logger.warn`.
3. **Tie into the existing protected-config signal.** Migration 039 added
   `changes.touches_protected_config`. A change that edits the evaluator's
   provider block is exactly what that flag is for, and it should require review
   at a level above an ordinary change.

Note also that the key itself is a redaction surface: `src/deploy/redact.ts`
already exists for provider output on `deployments.log_tail`, and provider error
bodies from an LLM call need the same treatment before they reach an
`EvalResult.reason`.

### 5.5 Billing consequence

BYOK usage is recorded with `source = 'byok'` and does not decrement the
`llm_tokens_month` allowance. It is not free to the operator, though — it still
costs a subrequest and Worker wall time — so BYOK moves a project from a token
quota onto the request-rate quota rather than off all quotas. State that plainly
in the docs; a user who discovers it at a 429 will assume they were misled.

### 5.6 The pattern is already the house style

Deploy credentials are BYO (`project_secrets` holds the Vercel and Cloudflare
tokens), and BYO-R2 for backups is a natural next one. "Stratum orchestrates,
you own the accounts it spends against" is a coherent product position, not a
concession, and it is materially easier to sell to a security team than a
platform that proxies everything.

---

## 6. Abuse

*Written while signup was gated by invite codes (`src/beta/gate.ts`), which was
doing the anti-abuse work and hiding the problem. That gate has since lifted —
`app.usestratum.dev` has open signup (`docs/user-guide/faq.md`) — so the
condition this section anticipated is the one in force now, not a future one. The
gate code remains, inert unless an operator configures it.*

A free LLM allowance on an open signup is a target.

The design has an unusual advantage here: the evaluator is not a chat endpoint.
`SYSTEM_PROMPT` is fixed in the source, the output is parsed as a strict verdict
object, and anything else fails closed. It is close to useless as a general
model proxy, which removes the main motive. What remains is ordinary
free-tier farming, handled by keying quota on the **owner** rather than the
project — otherwise forking a project resets the counter — and by keeping the
existing verified-identity signup paths (GitHub, Google, magic link).

---

## 7. Sequencing

Nothing here should ship in the order it was written. The order that matters:

**0. Trademark policy and registration.** Independent of all engineering, and
the only real lever against a hosted fork. Do it first because it has a lead
time.

**1. Measure.** `cost_records` is already being written and
`getProjectCostSummary` in `src/storage/costs.ts` is currently **dead code** —
defined, exported, never called. Add `owner_id` and `source`, then build the
per-owner usage view on top of that existing function. Run it for a month
against real traffic on `app.usestratum.dev` before choosing a single number in
§3. Every allowance in this document is deliberately unspecified for that reason.

**2. Entitlements interface**, with `UnlimitedEntitlements` wired in as the
default. Zero behavior change on merge, which makes it reviewable on its own.

**3. `UsageMeter` Durable Object** plus reconciliation against `cost_records`.
Still no enforcement.

**4. BYOK.** Ships as a feature to self-hosters — pick your own model for the
merge gate — and lands before any cap so the escape hatch predates the wall.

**5. The usage UI.** Non-negotiable prerequisite for step 6. If the first thing
a user learns about a quota is a blocked merge, the quota was a bug report.

**6. Cloud entitlements provider and Stripe**, in the private layer.

**7. Turn on free-tier caps**, announced at least 30 days ahead, with the usage
page live throughout.

---

## 8. What not to do

Stated explicitly, because each of these is the default mistake:

Do not add a license-key check to the AGPL server, or obfuscate any part of it.
It is removable in one commit, it reads as bad faith, and it buys nothing.

Do not move a shipped feature behind the wall. Everything in
`docs/CURRENT_CAPABILITIES.md` shipped under MIT or AGPL. Taking any of it back
costs more in credibility than it can return in revenue. Only *new* hosted
capacity limits, and self-host stays unlimited by default.

Do not degrade the open-source build to make the hosted one look better. The
self-hosted path is the top of the funnel for the commercial license, which is
the higher-margin product of the two.

Do not gate collaborators or public projects. Free multiplayer on public work is
how the product gets seen at all.
