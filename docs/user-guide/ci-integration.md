# CI Integration (Bring Your Own CI)

Stratum has **no native CI runner** — there are no workflow files, no hosted
build agents, and no GitHub Actions replacement. What Stratum *does* run for
you is its evaluation and merge pipeline, and it gives you exactly three ways
to execute code as part of that pipeline. This page inventories them honestly
and shows how to wire an external CI system you host into the evaluation gate.

## The complete code-execution inventory

Stratum can execute code in exactly three places, all driven by
`.stratum/policy.yaml`:

### 1. The sandbox evaluator

The `sandbox` evaluator (`src/evaluation/sandbox-evaluator.ts`) writes the
added lines of the change's diff into a fresh Cloudflare Sandbox and runs a
command there (default `npm test`, default timeout 60s, configurable via
`command` and `timeoutMs`). Exit code 0 scores 1.0; otherwise the test
output is parsed for `N passed / M failed` counts to derive a partial score.

It **requires the optional `SANDBOX` binding**. If a policy names a `sandbox`
evaluator and the binding is absent, the evaluator does not silently
disappear — it is replaced with an "unavailable" evaluator that returns
score 0 / failed (see `buildEvaluators` in `src/services/change-flow.ts`).
In other words, it **fails closed**.

Note the sandbox sees only the diff's added lines reconstructed as files, not
a full checkout — it is a smoke-check, not a full CI environment.

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

That's it. Everything else — building artifacts, deploying, scheduled jobs —
must live in a system you run outside Stratum.

## The webhook evaluator contract

Configure it in `.stratum/policy.yaml`:

```yaml
evaluators:
  - type: webhook
    url: https://ci.example.com/stratum-eval
    secret: <shared-secret>   # optional; enables HMAC signing
    timeoutMs: 10000          # optional; default 10000 (10s)

merge:
  requiredEvaluators: ["secret_scan", "webhook"]
```

### Request (Stratum → your endpoint)

- `POST` with `Content-Type: application/json`.
- Body: `{"diff": "<unified diff of the change>", "policy": {...}}` — the
  policy object is the parsed evaluation policy, so your endpoint can read
  its own config from `policy.evaluators`.
- If `secret` is set, the header `X-Stratum-Signature: sha256=<hex>` carries
  an HMAC-SHA256 of the exact request body, keyed with the secret. Verify it
  before trusting the payload.
- The URL must target a **public host over http/https** — localhost, private
  IP ranges, `.internal`/`.local` names, and bare single-label hostnames are
  rejected and the evaluation fails closed (score 0). Redirects are **not
  followed**; a 3xx counts as failure.

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

## Worked example: a generic webhook CI receiver

Any HTTPS service works. A minimal Node receiver that applies the diff to a
checkout, runs tests, and answers the verdict:

```js
// stratum-ci-receiver.mjs — run on your own infrastructure
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const SECRET = process.env.STRATUM_WEBHOOK_SECRET;
const REPO_DIR = process.env.REPO_DIR; // a clone kept in sync with the project

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    // 1. Verify the HMAC signature
    const expected = "sha256=" +
      createHmac("sha256", SECRET).update(body).digest("hex");
    const got = req.headers["x-stratum-signature"] ?? "";
    if (got.length !== expected.length ||
        !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
      res.writeHead(401).end();
      return;
    }

    // 2. Apply the diff and run the checks — fast ones only: the whole
    //    request must finish inside Stratum's timeoutMs window.
    const { diff } = JSON.parse(body);
    let result;
    try {
      execFileSync("git", ["-C", REPO_DIR, "checkout", "-f", "main"]);
      writeFileSync("/tmp/change.diff", diff);
      execFileSync("git", ["-C", REPO_DIR, "apply", "/tmp/change.diff"]);
      execFileSync("npm", ["test", "--prefix", REPO_DIR], { timeout: 8000 });
      result = { score: 1, passed: true, reason: "tests passed" };
    } catch (e) {
      result = { score: 0, passed: false,
                 reason: String(e.stdout || e.message).slice(0, 500) };
    } finally {
      execFileSync("git", ["-C", REPO_DIR, "checkout", "-f", "."]);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
}).listen(8080);
```

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
- A secrets store for CI (the webhook `secret` lives in the policy file)
- Deployment environments, approvals-per-environment, or deploy gates

If you need those, run a real CI system and connect it via the webhook
evaluator (for gating) or via GitHub sync in layer mode (for everything else).

## See also

- [FAQ: Does Stratum replace GitHub Actions?](faq.md#does-stratum-replace-github-actions)
- `docs/CURRENT_CAPABILITIES.md` — the authoritative current state
