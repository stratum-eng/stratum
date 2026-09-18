# CI Integration (Bring Your Own CI)

Stratum has **no native CI runner** — there are no workflow files, no hosted
build agents, and no GitHub Actions replacement. What Stratum *does* run for
you is its evaluation and merge pipeline, and it gives you a small, fixed set
of ways to get code executed as part of that pipeline. This page inventories
them honestly and shows how to wire an external CI system you host into the
evaluation gate.

## The complete code-execution inventory

Stratum causes code to run in exactly four places, all driven by
`.stratum/policy.yaml`. The first three run inside Stratum's own pipeline; the
fourth hands your code to a hosting provider that runs it:

> [!IMPORTANT]
> **Two of these four need the Cloudflare Sandboxes binding, and it is not
> enabled — on the hosted instance or by default anywhere.** `[[sandboxes]]` is
> commented out in every environment of the repository's `wrangler.toml`,
> because Sandboxes is a gated beta.
>
> That makes **1. the sandbox evaluator** and **3. `merge.postMergeCommand`**
> unavailable unless you self-host *and* have Sandboxes access *and* uncomment
> the binding. The consequence is not cosmetic: a policy naming the `sandbox`
> evaluator does not skip it, it **fails closed** — score 0, failed. How far
> that reaches depends on two policy settings:
>
> - Under the default `requireAll: true`, the aggregate verdict is
>   `every(passed)` (`src/evaluation/composite-evaluator.ts:63-65`), so the
>   failed `sandbox` result sinks it. The change lands in `needs_changes` and
>   **every merge in that project is blocked** until you remove the evaluator.
>   The one exception is `merge.allowForce: true`, which is off by default
>   (force is deny-by-default, `changes.ts:477-480`) and which lets a writer
>   force *other* changes past the failed evaluator — but **not the policy edit
>   that removes it**: `.stratum/policy.yaml` is protected config, and force is
>   refused on a change that touches it (`changes.ts:483-488`). So force is not
>   a way out of this particular trap.
> - Under `requireAll: false` the aggregate is `some(passed)`, so another
>   passing evaluator still carries it — *unless* `sandbox` is named in
>   `merge.requiredEvaluators`, which is checked per evaluator
>   (`src/merge/protection.ts:59-65`) and blocks the merge on its own either way.
>
> See [the sandbox evaluator](#1-the-sandbox-evaluator) for why it behaves that
> way.
>
> Neither **2. the `webhook` evaluator** nor **4. `deploys:`** needs the
> Sandbox binding, but they are not equally ready. The webhook evaluator needs
> only a reachable `https://` endpoint you host and its `url` in the policy.
> `deploys:` needs deployment setup first: a supported `target`, that
> provider's credentials in the project secret store, an instance-level
> `DEPLOY_SECRET_KEY` to decrypt them, and a `DEPLOY_QUEUE` binding — without
> those a deployment fails or is never enqueued. See
> [Deployments](deployments.md). If you want tests gating your merges today,
> the webhook evaluator is the supported route.

### 1. The sandbox evaluator

The `sandbox` evaluator (`src/evaluation/sandbox-evaluator.ts`) materializes
the **full workspace tree at the evaluated commit** — the same tree the merge
would land — into a fresh Cloudflare Sandbox and runs a command there (default
`npm test`, default timeout 60s, configurable via `command` and `timeoutMs`).
If the tree carries a `package.json` it installs first, using `npm ci` when a
lockfile is present and `npm install` otherwise, and passing `--ignore-scripts`
unless the policy opts in (see below). Exit code 0 scores 1.0; otherwise the
test output is parsed for `N passed / M failed` counts to derive a partial
score.

**npm lifecycle scripts are disabled by default.** The evaluated tree is
authored by an agent or by anyone who can push to the workspace, so its
`package.json` could declare `preinstall`/`install`/`postinstall` — which would
run before any human has reviewed the change. Installs therefore pass
`--ignore-scripts`. If your build genuinely needs them (native modules, a
`prepare` step), opt back in:

```yaml
evaluators:
  - type: sandbox
    allowInstallScripts: true
```

Note that a native module will usually *install* fine with scripts ignored and
then fail later, when the test command tries to load the unbuilt binary — so an
opaque `.node` load error in your suite is the symptom to look for. Because
`.stratum/policy.yaml` is a protected config file, flipping this flag requires
a human approval and cannot be force-merged.

**Every evaluation has a total time budget** (`totalBudgetMs`, default 150s)
covering the tree read, dependency install, and the command. Each phase is
granted whatever is left, and exhausting the budget returns a failing verdict
whose reason names the phase — `sandbox budget exceeded (install)` — rather
than hanging until your client times out. The per-phase defaults (90s install,
60s command) sum to exactly the budget, so you only encounter it if you have
raised a timeout or your repo is genuinely slower than the budget allows.

It **requires the optional `SANDBOX` binding**. If a policy names a `sandbox`
evaluator and the binding is absent, the evaluator does not silently
disappear — it is replaced with an "unavailable" evaluator that returns
score 0 / failed (see `buildEvaluators` in `src/services/change-flow.ts`).
In other words, it **fails closed**.

The evaluator's `diff` argument is ignored on purpose: an earlier version
reconstructed a pseudo-tree from the diff's `+` lines, which could not run a
real suite — no base tree, no untouched sources, no `package.json` unless it
happened to change. The tree is read from the repo instead.

It is still not a general CI environment — one command, one timeout, no
matrix, no artifacts, no caching between runs — but it does run against real
sources rather than a reconstruction.

### 2. The `webhook` evaluator — your CI, called synchronously

The `webhook` evaluator (`src/evaluation/webhook-evaluator.ts`) is the
bring-your-own-CI hook: Stratum POSTs the change to an HTTPS endpoint you
host, and your endpoint returns the verdict. The full contract is documented
[below](#the-webhook-evaluator-contract).

### 3. `merge.postMergeCommand` — post-merge smoke in a sandbox

After a merge, the policy's `merge.postMergeCommand` (if set) runs in a
Cloudflare Sandbox against the **full merged tree** (`src/merge/post-merge.ts`),
with a default timeout of 60s (`postMergeTimeoutMs`). On failure the merge is
automatically reverted unless `merge.autoRevert: false`. Like the sandbox
evaluator, this requires the `SANDBOX` binding; without it the check is
skipped with a warning.

### 4. `deploys:` — publishing the merged tree to a provider

After a merge survives the post-merge check, each entry in the policy's
`deploys:` list uploads the merged tree to a hosting provider —
Cloudflare (static assets or a Worker script) or Vercel — using credentials
stored in the project's encrypted secret store. Stratum does not execute that
code itself; the provider does, once it is published.

There is **no build step**: the tree is deployed exactly as committed. Commit
your built output, or use the `vercel` target, which builds the uploaded source
remotely. A deploy can be gated behind an approval
(`requiresApproval: true`), and a failed one can be retried, but there is no
rollback and no preview environment. See
[Deployments](deployments.md) for the full configuration reference, the
per-target secrets, and the limits.

That's it. Everything else — building artifacts, scheduled jobs, matrix runs,
artifact retention — must live in a system you run outside Stratum.

## The webhook evaluator contract

Configure it in `.stratum/policy.yaml`:

```yaml
evaluators:
  - type: webhook
    url: https://ci.example.com/stratum-eval
    secret: <shared-secret>   # optional; enables HMAC signing — see the warning
    timeoutMs: 10000          # optional; default 10000 (10s)

merge:
  requiredEvaluators: ["secret_scan", "webhook"]
```

> **`secret` is a literal in a committed file.** `EvaluatorConfig` types it as
> `secret?: string` (`src/evaluation/types.ts`) and the policy loader performs
> no environment or secret-store lookup, so the only way to enable HMAC signing
> today is to write the value into `.stratum/policy.yaml` — where every reader
> of the repository can see it. There is no `.dev.vars` or Wrangler-secret
> indirection for this field; adding one is an implementation change, not
> configuration. Until then, treat a signed webhook as authenticating *the
> repository*, not a confidential channel, and rotate the value if the repo's
> readership changes.

### Request (Stratum → your endpoint)

- `POST` with `Content-Type: application/json`.
- Body: `{"diff": "<unified diff of the change>", "policy": {...}, "baseSha": "<commit>"}`
  — the policy object is the parsed evaluation policy, so your endpoint can
  read its own config from `policy.evaluators`. It is passed through
  `sanitizePolicy` first (`src/evaluation/sanitize-policy.ts`), which strips
  `secret` from every webhook evaluator entry, so no receiver sees any
  evaluator's signing secret — including its own. Provision your receiver's
  copy of the secret out of band; do not expect to read it from the payload.
- `baseSha` is the commit the diff was computed against, resolved from the
  same clone that produced the diff. **Check out that exact commit and apply
  the diff to it.** Do not apply the diff to your mirror's current default
  branch: the branch can advance between diff generation and delivery, and
  `git apply` will often succeed anyway wherever the context lines still
  match — producing a pass or fail for a tree the change never proposed.
- `baseSha` is **omitted**, not null, when Stratum had no base to name. Treat
  its absence as "I cannot reproduce this" and reject the request rather than
  falling back to your branch tip.
- `baseSha` is inside the signed body, so it cannot be swapped in transit —
  **but only when `secret` is configured**, because that is what produces the
  `X-Stratum-Signature` header at all. Without a secret nothing about the
  payload is authenticated, and an unsigned receiver must be reached over
  `https://` so the transport protects what the HMAC otherwise would.
- The field is additive: a receiver written against the earlier
  `{diff, policy}` contract keeps working, and simply keeps the failure mode
  described above.
- If `secret` is set, the header `X-Stratum-Signature: sha256=<hex>` carries
  an HMAC-SHA256 of the exact request body, keyed with the secret. Verify it
  before trusting the payload.
- The URL must target a **public host over http/https** — localhost, private
  IP ranges, `.internal`/`.local` names, and bare single-label hostnames are
  rejected and the evaluation fails closed (score 0). Redirects are **not
  followed**; a 3xx counts as failure.

One property of the current contract is worth knowing before you point a
receiver at it. This section describes what ships today.

- **`http://` URLs are accepted**, and even a configured HMAC authenticates the
  body without encrypting it. Over plain HTTP the diff, the policy, and
  `baseSha` travel in cleartext, and an unsigned request over plain HTTP is
  neither authenticated nor confidential — anyone on the path can substitute the
  base the suite runs against. Use an `https://` URL and terminate TLS in front
  of your receiver; treat that as required, not advisory, when no secret is set.

### Response (your endpoint → Stratum)

Reply `200 OK` with JSON:

```json
{ "score": 0.95, "passed": true, "reason": "142 tests passed" }
```

- `score`: number (aggregated with the other evaluators' scores — averaged
  when `requireAll` is on, the default; max otherwise).
- `passed`: boolean verdict.
- `reason`: human-readable explanation shown in the change's evidence.

Any non-2xx status is recorded as a failed evaluation
(`Webhook failed: HTTP <status>`).

### The timeout constraint (important)

The call is **synchronous**: evaluation runs at change-creation time, inside
the request, and the webhook is aborted after `timeoutMs` (default **10
seconds**). There is **no async callback API today** — your CI must produce
its verdict within the request window. Practical approaches:

- Keep the webhook check fast (lint, typecheck, focused smoke tests) and
  raise `timeoutMs` moderately for slower suites.
- Pre-warm workers/caches on your CI host so a run doesn't pay cold-start.
- Run the long suite out-of-band and have the webhook return the verdict for
  the most recent equivalent state — accepting the staleness tradeoff.

A timed-out or errored webhook surfaces as an external-service error for that
evaluator, and a `merge.requiredEvaluators` entry for `webhook` will keep the
change unmergeable until a re-evaluation passes.

## Wiring your CI to the contract

The endpoint's job is narrow: authenticate the request, decide, and answer in
the verdict shape. A sketch of just that part:

```js
// Sketch — the contract, not a deployable receiver. See the note below.
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.STRATUM_WEBHOOK_SECRET;

/** Constant-time check of the `sha256=<hex>` header against the raw body. */
function signatureValid(rawBody, header) {
  if (!SECRET) return true; // no secret configured: Stratum sends no signature
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", SECRET).update(rawBody).digest();
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// rawBody is the exact bytes Stratum sent — verify before parsing, since
// re-serializing JSON would change what you are authenticating.
if (!signatureValid(rawBody, headers["x-stratum-signature"])) {
  respond(401, { error: "bad signature" });
} else {
  const { diff, policy, baseSha } = JSON.parse(rawBody);
  if (!baseSha) {
    // Nothing to reproduce against — a verdict here would describe a tree the
    // change never proposed. Fail loudly rather than guessing at a base.
    respond(400, { error: "payload carries no baseSha" });
  } else {
    // `yourCi` must check out baseSha and apply the diff to THAT commit.
    const verdict = await yourCi(diff, policy, baseSha);
    respond(200, {
      score: verdict.score,     // 0..1, as in the contract above
      passed: verdict.passed,   // boolean — this is what gates the merge
      reason: verdict.reason,   // shown in the change UI
    });
  }
}
```

**What this deliberately leaves out.** `yourCi` is where the change under
evaluation actually gets built and tested, and that is the part this guide does
not attempt to specify. Applying a diff and running its test suite means
executing attacker-controlled code: `git apply` alone can introduce hooks and
`.gitattributes` filters, and a test suite can do anything. Doing that safely is
an infrastructure problem — separate user and PID namespaces so the workload
cannot read the receiver's environment, a fresh filesystem per evaluation so one
change cannot observe or poison another, resource and time bounds, no ambient
credentials, no reachable cloud metadata — and it is not something a copyable
snippet can be trusted to get right. Run it on disposable, least-privileged
infrastructure you already trust for untrusted builds. Issue #281 tracks writing
that guidance up properly.

Two constraints worth knowing before you build it: the response must arrive
inside the timeout window described above, and the receiver should sit behind
TLS you terminate yourself — the body carries the change diff.

### Using GitHub Actions as the executor

GitHub Actions cannot answer a synchronous webhook directly (a dispatched
workflow run is asynchronous), so the common pattern in **layer mode** is to
not use the webhook evaluator at all: keep the repo synced to GitHub, let
Actions run on the promoted PR as usual, and let humans review there. If you
want Actions *inside* the Stratum gate, you need a small always-on receiver
(like the sketch above) that runs the same checks the workflow does — or that
proxies to a pre-warmed self-hosted runner — within the timeout window.

## What's missing vs GitHub Actions

To set expectations, Stratum has none of the following today:

- Workflow definitions (`.github/workflows`-style pipelines, triggers, steps)
- Hosted or self-hosted runner management
- Matrix builds
- Build artifacts (upload/download/retention)
- Dependency/build caching
- Scheduled jobs (cron workflows)
- A general secrets store *for evaluators*. Stratum does have an encrypted
  per-project secret store, but only two things read it: the deploy runner, and
  the `llm` evaluator when a policy names a provider to bring its own key to
  ([Getting started](getting-started.md#bringing-your-own-model-key)). Nothing
  interpolates it into a policy file — the webhook evaluator's `secret` still
  lives literally in `.stratum/policy.yaml`.
- Deployment *environments* — no staging/production separation, no
  per-environment variables, no environment protection rules. What exists is a
  flat list of named deploys, each optionally gated by a single approval
  (`requiresApproval: true`), plus a retry. There is no rollback, no preview
  deploy of an unmerged change, and no build step. See
  [Deployments](deployments.md).
- Status-check aggregation — Stratum does not collect external CI check
  results the way a GitHub PR's checks tab does. An external system reports a
  verdict only by answering the webhook evaluator synchronously; a check that
  reports anywhere else is invisible to the gate.

If you need those, run a real CI system and connect it via the webhook
evaluator (for gating) or via GitHub sync in layer mode (for everything else).

## See also

- [Deployments](deployments.md) — the `deploys:` policy block, targets, secrets, and limits
- [FAQ: Does Stratum replace GitHub Actions?](faq.md#does-stratum-replace-github-actions)
- `docs/CURRENT_CAPABILITIES.md` — the authoritative current state
