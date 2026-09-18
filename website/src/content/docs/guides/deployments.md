---
title: "Deployments"
description: "Publish the merged tree to Cloudflare or Vercel after a change lands — the deploys: policy block, encrypted project secrets, the approval gate, limits, and what v1 does not do."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/deployments.md"
---

Stratum can publish the merged tree to a hosting provider after a change lands.
You declare deploys in the same `.stratum/policy.yaml` that gates your merges,
store the provider credential once as a project secret, and every subsequent
merge that survives the post-merge check publishes automatically.

This is deliberately small. It is **not a CI system**: there is no build step,
no preview environment, and no rollback. Read
[Limitations](#limitations-read-this-before-you-rely-on-it) before you point
production at it.

## Quickstart

Zero to a live deploy. Step 1 is once per instance, steps 2–4 once per project;
after that merging is the whole workflow. Each step links to its reference
section for the detail this skips.

### 1. Confirm the instance can deploy — once, by whoever runs it

Two things the application cannot provision for itself, and neither failure is
obvious from the UI:

| Missing | What you see |
|---|---|
| `DEPLOY_SECRET_KEY` | Storing a secret fails; every deploy fails with `DEPLOY_SECRET_KEY is not configured on this instance…` |
| the `DEPLOY_QUEUE` binding | **Nothing at all** — a merge never enqueues a deploy, so no row is written and no error is shown |

```bash
wrangler secret put DEPLOY_SECRET_KEY --env production
wrangler queues create stratum-deploys
wrangler queues create stratum-deploys-dlq
```

On an instance you do not operate, ask its operator — there is no way to check
from the UI. Detail, including why rotating the key is destructive:
[Operating a Stratum instance](#operating-a-stratum-instance-with-deploys-enabled).

### 2. Collect the provider values

The secret **names** are fixed — the deploy reads these exact names from the
project store.

**Cloudflare** (`cloudflare-pages` and `cloudflare-workers`):

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → **Custom token**. One permission is enough: **Account ▸ Workers Scripts ▸ Edit**. Shown once — copy it immediately. |
| `CLOUDFLARE_ACCOUNT_ID` | The id in any dashboard URL: `dash.cloudflare.com/<account-id>/…` |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | **Workers & Pages** → your `<subdomain>.workers.dev`. Optional, but without it the deploy succeeds and records **no URL**. |

**Vercel**:

| Secret | Where to get it |
|---|---|
| `VERCEL_TOKEN` | Vercel → **Account Settings → Tokens**. |
| `VERCEL_PROJECT_ID` | The Vercel project's **Settings → General → Project ID**, or `vercel project ls`. |
| `VERCEL_TEAM_ID` | Optional, but required in practice for a team-scoped token — without it the API resolves against your personal account. |

### 3. Store them on the project

*Project → Settings → Deploy secrets*, or:

```bash
curl -X PUT https://app.usestratum.dev/api/projects/@acme/site/secrets/CLOUDFLARE_API_TOKEN \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value":"…"}'
```

Must be a project admin, and **not an agent** — agent tokens are refused on
every secret route. There is no read path: nothing returns a stored value.
More: [Storing a secret](#storing-a-secret).

### 4. Declare the deploy

Commit one of these as `.stratum/policy.yaml`. **The `evaluators:` block is not
optional** — a policy file without it is malformed, and a malformed policy
blocks *every merge in the project*, with an error about evaluators that will
not obviously point back here. See
[Before you start](#before-you-start-your-policy-still-needs-evaluators).

```yaml
# Static site: publishes ./public as committed.
evaluators:
  - type: diff
deploys:
  - name: site
    target: cloudflare-pages
    dir: public
    secrets: [CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID]
```

Do **not** add `CLOUDFLARE_WORKERS_SUBDOMAIN` to that `secrets:` list. Naming a
secret there makes it *required*, which turns the optional "no URL on the row"
outcome into a failed deploy. The target loads it anyway when it is stored.

```yaml
# Worker script: uploads the .js/.mjs files in the tree.
evaluators:
  - type: diff
deploys:
  - name: api
    target: cloudflare-workers
    secrets: [CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID]
```

```yaml
# Vercel: uploads the source; Vercel builds it. Human approval before it ships.
evaluators:
  - type: diff
deploys:
  - name: production
    target: vercel
    requiresApproval: true
    secrets: [VERCEL_TOKEN, VERCEL_PROJECT_ID]
```

Remember there is **no build step**: Cloudflare targets publish the tree as
committed, so commit your built output. `vercel` is the exception — it uploads
the source and Vercel builds it.

### 5. Merge a change, then watch it

Deploys run after a merge survives the post-merge check — not on the merge
event itself, so a change that gets auto-reverted never deploys. Watch it at
*Project → Deploys*. First run reaches `succeeded`, `failed`, or
`pending_approval` if you set `requiresApproval`.

## If your first deploy didn't work

Matched against the exact text a deployment records, so you can search for what
you actually see.

| What you see | What it means | Fix |
|---|---|---|
| **No deployment row at all** | The merge never enqueued: the post-merge check reverted or failed the merge, or the instance has no `DEPLOY_QUEUE` binding | Check the post-merge check passed (or is not configured); then step 1 |
| **No deployment row, but the merge looks fine** | A bound `DEPLOY_QUEUE` can still fail on `send`. The request is then written to the event outbox, which a five-minute cron sweeps and forwards, so the row appears late rather than never | Wait out one sweep. If the outbox write failed too the request is genuinely gone, and the log says so: `Post-merge deploy request could not be made durable and is lost`. There is no row to retry, so merge again or deploy out of band |
| **No deployment row, and the merge went through `merge-batch`** | Expected. `merge-batch` (`src/routes/changes.ts:898`) never calls `enqueueMergeDeploy` — it runs no post-merge check and enqueues no deploy, by design: the batch path merges many changes in one push | **No post-merge recovery exists.** Approve and Retry both act on an existing row (`notFound("Deployment", id)` otherwise), and the deployments API has no route that creates one. Merge through the single-change path when you want a deploy |
| Status `skipped` | There was nothing configured to deploy at that commit — no policy file, or a policy with no `deploys:` entries | Check `.stratum/policy.yaml` is committed on the **default branch** and declares `deploys:`. `skipped` never means an error |
| `Missing project secret: X — add it in project settings` | The policy names a secret the store doesn't have | Add it (step 3); names are case-sensitive |
| `DEPLOY_SECRET_KEY is not configured on this instance…` | Instance prerequisite missing | Step 1 |
| `Could not decrypt project secret… may have been rotated` | `DEPLOY_SECRET_KEY` changed after the secret was stored | Re-enter every secret for the project — there is no re-encryption path |
| `Policy file … is present but invalid` | YAML didn't parse, or `evaluators:` is missing | Fix the file; note this also blocks merges |
| `Could not read the tree at <sha>` | The merge commit is unreachable — force-push, auto-revert, or re-import | Merge again; the commit is pinned, so Stratum will not deploy a different tree |
| `403`/`401` from the provider | Token lacks permission, or is scoped to the wrong account/team | Cloudflare: **Workers Scripts ▸ Edit**. Vercel: set `VERCEL_TEAM_ID` for a team token |
| `503 DEPLOY_QUEUE_UNAVAILABLE` on Approve or Retry | No `DEPLOY_QUEUE` binding | Step 1 |
| `succeeded` but no URL on the row | `CLOUDFLARE_WORKERS_SUBDOMAIN` isn't stored | Store it — the deploy itself worked |
| `succeeded` but the site is unchanged (Vercel) | `succeeded` means **accepted for build**; Stratum does not poll | Check the build in Vercel — a post-handoff build failure is invisible here |

## Before you start: your policy still needs `evaluators:`

**A `.stratum/policy.yaml` that has a `deploys:` block but no top-level
`evaluators:` array is treated as malformed, and a malformed policy blocks
every merge in the project.** The policy parser requires `evaluators` to be
present and to be an array; anything else is a parse failure, and a parse
failure fails the merge gate closed:

> Policy file .stratum/policy.yaml is present but invalid (missing or non-array
> 'evaluators'); merges are blocked until it is fixed.

That is intended behaviour for the merge gate, but it means "I only want
deploys" is not a configuration you can write. If you have no opinion about
evaluation, declare the cheap default explicitly:

```yaml
# The minimum viable deploy-only policy. `evaluators:` is REQUIRED — a policy
# file without it is malformed and blocks all merges.
evaluators:
  - type: diff

deploys:
  - name: site
    target: cloudflare-pages
    dir: public
```

The secret scanner runs on every change regardless of what this file says, so a
lone `diff` evaluator is not "no gate at all".

The same rule applies to the JSON form, `stratum.config.json`. Stratum reads
`.stratum/policy.yaml` first and, only if it is absent, `stratum.config.json`.
A file that is present but broken is an answer — Stratum does not fall through
to the other one.

## How a deploy is triggered

1. A change merges.
2. The post-merge smoke check runs (if the policy configures one). A failing
   check auto-reverts the merge.
3. **Only if the post-merge check did not revert or fail**, Stratum enqueues a
   deploy of the merge commit. A deploy is never triggered from the
   `change.merged` event, because that event fires before the check runs.
4. The deploy consumer reads the tree **at the pinned merge commit** and parses
   the policy out of *those* bytes. Configuration and code are therefore always
   from the same commit: a policy change that lands after your merge cannot
   retroactively change how your merge deploys.
5. One `deployments` row is created per `deploys:` entry, and each entry is run
   in turn.

Things that do **not** trigger a deploy:

- A merge that the post-merge check reverted.
- `POST /api/projects/{name}/changes/merge-batch` — batch merges run neither the
  post-merge check nor a deploy.
- A push straight to the project's default branch (deploys hang off the change
  merge path).
- An instance with no `DEPLOY_QUEUE` binding configured.

Before it runs, the deploy re-reads the change's status and the project's
deletion state. A change that was reverted between the merge and the deploy is
refused, and so is a project that is being deleted.

## The `deploys:` configuration reference

`deploys:` is a top-level list in `.stratum/policy.yaml`. Each entry is a
mapping:

```yaml
deploys:
  - name: marketing-site        # required
    target: cloudflare-pages    # required
    dir: dist                   # optional
    secrets:                    # optional
      - CLOUDFLARE_API_TOKEN
      - CLOUDFLARE_ACCOUNT_ID
    requiresApproval: false     # optional, default false
```

| Field | Required | Rules |
|---|---|---|
| `name` | yes | `^[a-z][a-z0-9-]{0,31}$` — lowercase letters, digits and dashes, max 32 characters. It is this deploy's stable identity across merges, and it is what supersession and the deployments list group by. Must be unique within the file. |
| `target` | yes | One of `cloudflare-pages`, `cloudflare-workers`, `vercel`. |
| `dir` | no | Repo-relative directory to publish. Must be relative (no leading `/`), contain no `..` segment and no null byte, max 255 characters. The prefix is stripped, so `dir: dist` publishes `dist/index.html` as `index.html`. Omit it to publish the whole tree. |
| `secrets` | no | Up to 16 secret names, each `^[A-Z][A-Z0-9_]{0,63}$`. Naming a secret here makes it **required**: a declared name that is not stored fails the deploy. You do not have to list the target's own secrets — they are loaded either way. |
| `requiresApproval` | no | Boolean (a quoted `"false"` is rejected, not coerced). `true` holds the deployment at `pending_approval` until someone approves it. |

**A policy file may declare at most 16 `deploys:` entries.** Anything beyond
the sixteenth is not run and is reported as a single `failed` deployment row
naming how many were declared — siblings run sequentially inside one Worker
invocation, so an unbounded list would be an unbounded merge.

**Unknown fields are rejected, not ignored.** An entry containing
`requireApproval` (missing the "s") is refused with a reason naming the field,
rather than being silently rebuilt without it — which would turn a deploy you
gated behind an approval into one that ships straight to production.

### A rejected entry becomes a visible failed deployment

Bad `deploys:` configuration does not block your merge, and it is not dropped
in silence either: each rejected entry is recorded as a `failed` deployment row
carrying the reason (`deploys[0]: unknown target "netlify" (expected one of
cloudflare-pages, cloudflare-workers, vercel)`). A deploy that was written and
never runs means production quietly stopped updating, so it is reported where
you will see it — on the project's Deployments page.

### The malformed-policy row is a post-merge fallback, not the merge block

A policy file that fails to parse at all produces one `failed` deployment row
(named `(unresolved)`) pointing at the file. That row is **not** the merge gate
reporting itself — it is a separate, later check, and the distinction matters
because the two look at different commits:

- **Before the merge**, the gate parses the project's *current* policy. A file
  that does not parse blocks the merge outright, and no deployment row exists
  because no merge happened.
- **After a merge**, the deploy runner re-parses the policy out of the *pinned
  merge commit's* tree, so configuration and code always come from the same
  commit. If **that** commit's policy is the unparseable one, there is nothing
  to deploy and nothing to name, so the failure is recorded as an
  `(unresolved)` row reading `Policy file .stratum/policy.yaml is present but
  invalid (…); no deploy configuration could be read from it.` rather than
  being dropped in silence.

The two reads happen at different times against different trees, so they can
disagree — which is exactly when this row shows up. Treat it as "the commit
that was deployed had a broken policy", not as a second copy of the merge
error. Fixing the project's current policy unblocks merges; it does not
retroactively change a row already recorded against an older commit, and it
does not re-run that deploy. Retry it once the fix is merged.

## Targets and their secrets

All three targets are first-class. Secrets are read from the project's secret
store by these exact names.

### `cloudflare-pages` — a static site on Cloudflare

| Secret | | Meaning |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | **required** | API token with Workers Scripts edit permission on the account. |
| `CLOUDFLARE_ACCOUNT_ID` | **required** | The account that owns the Worker. |
| `CLOUDFLARE_WORKER_NAME` | optional | Script name to publish as. Defaults to the deploy's `name`. |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | optional | Your account's `workers.dev` subdomain. Without it the deployment **succeeds with no URL** (see below). |

**This target is implemented against Workers Static Assets, not Pages Direct
Upload.** The `target:` name is the user-facing name for "publish my static
site on Cloudflare" and is unchanged, but the implementation uploads an asset
manifest and publishes a Worker with an `assets` binding and no `main_module`.
Two reasons: Pages Direct Upload's asset endpoints (the upload-token,
check-missing and asset-upload calls Wrangler drives) are not in Cloudflare's
public API reference, so implementing it would mean guessing at a surface that
carries a production credential; and Cloudflare itself steers new projects to
Workers rather than Pages. The practical consequences are that the deployment
appears in your Cloudflare account as a **Worker**, not as a Pages project, and
that Pages-specific features (preview branches, the Pages dashboard) do not
apply.

Content types are set at upload time from the file extension, which is what
visitors are served. An unrecognized extension is uploaded as
`application/octet-stream`.

### `cloudflare-workers` — a Worker script

| Secret | | Meaning |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | **required** | As above. |
| `CLOUDFLARE_ACCOUNT_ID` | **required** | As above. |
| `CLOUDFLARE_WORKER_NAME` | optional | Script name. Defaults to the deploy's `name`. |
| `CLOUDFLARE_WORKER_MAIN_MODULE` | optional | Entry-point path within the deployed tree. |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | optional | Your `workers.dev` subdomain; without it the deployment succeeds with no URL. |

Only `.js` and `.mjs` files are uploaded, as ES modules. Everything else in the
selected tree (a README, a lockfile) is skipped, and the count of skipped files
is reported on the deployment. If no module is found, the deploy fails.

Without `CLOUDFLARE_WORKER_MAIN_MODULE`, the entry point is the first of
`worker.js`, `worker.mjs`, `index.js`, `index.mjs`, `src/index.js`,
`src/index.mjs` present in the tree; if none is, the deploy fails and names the
candidates. When you do set it, it is validated against the tree — a typo fails
with a reason instead of deploying some other file.

The upload sends a pinned `compatibility_date` (currently `2026-08-20`) rather
than the current date, so redeploying the same commit cannot silently change
its runtime behaviour.

### `vercel` — build and host on Vercel

| Secret | | Meaning |
|---|---|---|
| `VERCEL_TOKEN` | **required** | Vercel API token. |
| `VERCEL_PROJECT_ID` | **required** | The Vercel project to deploy into. |
| `VERCEL_TEAM_ID` | optional | Required in practice for a team-scoped token — without it the API resolves the token against your personal account. |

The whole tree is inlined (base64) into a single `POST /v13/deployments` with
`target: production`, rather than uploaded file-by-file: one provider request
instead of one per file, which is what the Worker's subrequest budget can
afford. Base64 inflates the payload by about a third, so the 25 MB tree limit
becomes roughly a 33 MB request body — that is this target's binding
constraint.

**A `vercel` deployment recorded as `succeeded` means "accepted for build".**
Vercel answers as soon as it has queued the deployment (`readyState: QUEUED`)
and builds asynchronously; Stratum does **not** poll for the result, because
polling would hold a queue message open for the length of somebody else's
build. The provider's state at hand-off and its deployment id are recorded in
the row's reason, e.g. `provider state at hand-off: QUEUED (the provider
finishes asynchronously; Stratum does not poll it); provider deployment
dpl_…`. A build that fails **after** hand-off is visible in Vercel, not in
Stratum. If the API returns `ERROR`, `CANCELED` or `BLOCKED` outright, the
deployment is recorded as `failed`.

### When a deployment has no URL

The Cloudflare targets derive the deployment URL from
`CLOUDFLARE_WORKERS_SUBDOMAIN`, because the account's `workers.dev` subdomain
is not part of the API surface these targets were written against and inventing
a lookup for it would be a guess. **If you do not store that secret, the deploy
still succeeds — it just records no URL.** Store it if you want a clickable
link on the deployments page.

Note that `CLOUDFLARE_WORKERS_SUBDOMAIN` lives in the secrets table for
uniformity, but it is not confidential: it is a public hostname component,
written verbatim into the deployment's `url`. Treat it as configuration that
happens to be stored beside your credentials, not as a credential.

## Storing a secret

Secrets are per project, encrypted at rest (AES-GCM, with the project id and
secret name bound as additional authenticated data), and there is **no read
path** — no API, UI or CLI surface returns a stored value. Two things decrypt
them: the deploy runner, and the `llm` evaluator when a project brings its own
model key ([Getting started](/guides/getting-started/#bringing-your-own-model-key)).

- **In the UI:** *Project → Settings → Deploy secrets*. Add by name and value;
  delete by name. Values are never rendered back.
- **Over the API:**

  ```bash
  curl -X PUT https://app.usestratum.dev/api/projects/@acme/site/secrets/CLOUDFLARE_API_TOKEN \
    -H "Authorization: Bearer $STRATUM_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"value":"…"}'
  ```

Rules:

- Names must match `^[A-Z][A-Z0-9_]{0,63}$`.
- Values are capped at 4096 bytes. The storage layer imposes no minimum, but an
  empty value is not useful: the settings form rejects it outright, and a
  target reads an empty required secret as missing and fails the deploy.
- Writing an existing name replaces it.
- Every write and delete is recorded in the audit trail (`secret.written`,
  `secret.deleted`).

**Only a project admin who is not an agent may manage secrets.** An agent token
is refused on every secret route, even when the agent's owner is the project
owner: deploy credentials are the one thing an agent identity is never trusted
with. Deleting the project deletes its secrets and its deployment history.

## The approval gate

With `requiresApproval: true`, the merge creates the deployment at
`pending_approval` and nothing is uploaded. Someone then presses **Approve** on
the deployment page, or calls `POST /api/deployments/{id}/approve`; the row
moves to `queued`, is enqueued, and runs.

Approving requires project **write** access and a **user** identity. An agent
token (`stratum_agent_…`) sets no user id and is refused.

**Be precise about what that buys you.** The guarantee is "not an agent
identity" — exactly the same guarantee, and the same limitation, as a human
review verdict. A user's scoped API token and an MCP OAuth grant both
authenticate as the user and are both accepted. It is therefore **not**
evidence that a human was at a keyboard: an automation running under your token
can approve a deploy. If your threat model needs a real human, this gate does
not provide one.

Approval is single-use and safe to double-click: the status flip is a
conditional update, so a second approver gets `409 DEPLOYMENT_NOT_PENDING`
rather than a second deployment of the same commit.

## Retry

A finished deployment can be re-run from the **Retry** button or
`POST /api/deployments/{id}/retry`. This creates a *new attempt row* for the
same commit with `attempt` incremented, and enqueues it; the original row is
kept, so the history shows both.

- Only a terminal deployment (`succeeded`, `failed`, `superseded`, `skipped`)
  can be retried. Retrying a `queued`, `running` or `pending_approval` row is
  refused with `409 DEPLOYMENT_NOT_RETRYABLE` — for `pending_approval` in
  particular, allowing it would route straight around the approval gate,
  because a retry row starts `queued`.
- Retry requires project write access, and unlike approve it **does** accept an
  agent identity.
- The originating change id is carried onto the retry, so the "was this change
  reverted?" check still applies. Retrying a change that has since been
  reverted is refused.
- Two people retrying at once is safe: the second gets
  `409 DEPLOYMENT_RETRY_EXISTS`.
- A retry counts as the *newest* intent for that deploy name, even when the
  commit it re-runs is old — an operator re-running an earlier commit is
  asserting that they want it live.

Retry is also the closest thing to a rollback — see
[Limitations](#limitations-read-this-before-you-rely-on-it).

## Deployment statuses

| Status | Meaning |
|---|---|
| `pending_approval` | `requiresApproval: true` and nobody has approved it yet. Nothing has been uploaded. |
| `queued` | Waiting for the deploy consumer to pick it up. |
| `running` | A consumer holds a lease on the row and is uploading. |
| `succeeded` | The provider accepted the deployment. For `vercel`, this means **accepted for build**, not "live" — see above. |
| `failed` | Anything that went wrong, with a reason: a rejected `deploys:` entry, an unreadable tree, a missing or undecryptable secret, `DEPLOY_SECRET_KEY` unset, a limit exceeded, a provider 4xx/5xx, an unreachable provider. |
| `superseded` | A newer merge of the same deploy `name` took over. Either this row had not started when the newer one ran, or the newer one had already succeeded by the time this one reached the front of the queue — in which case this deployment is refused rather than published, so an out-of-order delivery cannot put the older commit back into production. |
| `skipped` | **Only one thing:** there was nothing configured to deploy — no policy file at that commit, or a policy with no `deploys:` entries. Every operator error is `failed`, never `skipped`. |

`succeeded`, `failed`, `superseded` and `skipped` are terminal.

A deploy that hits a provider error also stores a **log tail**: the provider's
response, with every secret value substituted out, truncated to 16 KiB.
Redaction always runs on the full text before truncation, so a secret cannot
survive by straddling the cut. The log tail is served **only to project
writers** — never on the public read path, and never in a list response for a
reader who cannot write.

Deployments also emit events you can subscribe to with a project webhook:
`deployment.requested`, `deployment.succeeded`, `deployment.failed`.

## Limits

Every limit is checked **before the first provider request goes out** — a
deploy that uploaded half a tree and then failed would leave the site in a
state nobody asked for. Limits are applied to the tree *after* `dir` narrowing,
so they judge the bytes actually being uploaded.

| Limit | Value |
|---|---|
| Files per deployment | 2,000 |
| Total bytes per deployment | 25 MiB |
| Bytes per file | 10 MiB |
| Provider HTTP requests per deployment | 2,048 |
| Stored log tail | 16 KiB |
| Deployment lease / queue visibility timeout | 15 minutes |
| Secret value | 4,096 bytes |
| Secrets named per deploy entry | 16 |
| `deploys:` entries per policy file | 16 |

Exceeding one is a `failed` deployment naming the number, e.g. `too many files:
2431 exceeds the 2000-file deploy limit`. An empty selection is also a failure
(`no files found under "dist" at this commit — check the deploy's "dir"`), not
a silent no-op.

Sibling deploys from one merge run **sequentially**, not concurrently: they
share one Worker invocation's CPU, memory and subrequest budget.

## Operating a Stratum instance with deploys enabled

Self-hosters need three things beyond the default deployment:

1. **`DEPLOY_SECRET_KEY` must be set as a Wrangler secret.** It is the master
   key every project secret is derived from. Without it, storing a secret fails
   and every deploy fails with `DEPLOY_SECRET_KEY is not configured on this
   instance, so deploy secrets cannot be decrypted.`

   ```bash
   wrangler secret put DEPLOY_SECRET_KEY --env production
   ```

   **Rotating it makes every stored secret undecryptable.** There is no
   re-encryption path: after a rotation, deploys fail with `Could not decrypt
   project secret…` and every project must re-enter its values. That now reaches
   further than deploys — a project whose policy names an LLM provider reads its
   provider key from the same store, so a rotation blocks the **merge gate** on
   those projects until the key is re-entered, not just their deployments.

2. **The queues must exist**, and the `DEPLOY_QUEUE` binding must be
   configured. Without the binding, merges simply never enqueue a deploy, and
   approve/retry answer `503 DEPLOY_QUEUE_UNAVAILABLE`.

   ```bash
   wrangler queues create stratum-deploys
   wrangler queues create stratum-deploys-dlq
   ```

3. **The dead-letter queue has no consumer.** `stratum-deploys-dlq` is
   configured as the DLQ for `stratum-deploys`, but nothing reads it: a message
   that exhausts its retries lands there and **sits for manual inspection**.
   Nothing alerts, and no deployment row is written by the DLQ itself. This is
   a deliberate v1 choice, not an oversight — but it means "the queue is
   healthy" is something an operator has to check, not something Stratum
   reports.

   In practice a message only reaches the DLQ for an *indeterminate* failure
   (D1 or KV unavailable, the project unreadable). A failed deployment is a
   result, not a delivery failure, and is acked with a `failed` row rather than
   retried; a malformed message is acked and logged.

The staging environment uses `stratum-deploys-staging` and
`stratum-deploys-dlq-staging` so its messages can never be handed to the
production consumer.

## API

| Route | Access |
|---|---|
| `GET /api/projects/{namespace}/{slug}/secrets` | Project admin, agents refused. Names and metadata only — never values. |
| `PUT /api/projects/{namespace}/{slug}/secrets/{name}` | Project admin, agents refused. |
| `POST /api/projects/{namespace}/{slug}/secrets` | Form-friendly create/replace (`name`, `value` in the body). |
| `DELETE /api/projects/{namespace}/{slug}/secrets/{name}` | Project admin, agents refused. |
| `POST /api/projects/{namespace}/{slug}/secrets/{name}/delete` | Form-friendly delete. |
| `GET /api/projects/{namespace}/{slug}/deployments` | Anyone who can read the project. `logTail` is included only for writers. Filters: `name`, `status`, `limit` (default 50, max 200), `offset`. |
| `GET /api/deployments/{id}` | Anyone who can read the deployment's project; unknown or unreadable ids answer 404 alike. |
| `POST /api/deployments/{id}/approve` | Project writer, **user identity required**. |
| `POST /api/deployments/{id}/retry` | Project writer; agents allowed. |

In the UI, deployments live at `/{namespace}/{slug}/deployments`, and secrets
under *Settings*.

Full request and response schemas are in the
[OpenAPI specification](/reference/openapi/); see also
[the endpoint reference](/reference/endpoints/).

## Limitations (read this before you rely on it)

These are design boundaries of v1, not bugs:

- **No build step.** Stratum deploys the tree **exactly as committed**. There
  is no `npm install`, no bundler, no framework build. If your site needs a
  build, commit the built output (and point `dir:` at it) or use a provider
  that builds for you — `vercel` builds the uploaded source remotely, the two
  Cloudflare targets do not.
- **No preview deploys.** Only merged commits deploy. There is no way to
  publish an unmerged change for review.
- **No rollback.** There is no "revert to the previous deployment" button. The
  recovery path is to **retry an earlier successful deployment** of the same
  commit, or to merge a revert change and let that deploy. Neither is
  instantaneous.
- **Netlify is not supported.** The three targets above are the whole list.
- **The approval gate refuses agent identities, not automation.** It accepts a
  user's scoped API token and MCP OAuth grants. See
  [The approval gate](#the-approval-gate).
- **A deploy-only project still needs an `evaluators:` block**, or every merge
  is blocked. See
  [the top of this page](#before-you-start-your-policy-still-needs-evaluators).
- **Secret redaction is literal-substring matching.** A provider that echoes a
  credential back in some encoded or transformed form (URL-encoded, hashed,
  split across a JSON boundary) would not be caught, which is part of why the
  log tail is writers-only.
- **No per-project deploy quota.** Nothing rate-limits how often a project
  deploys beyond the limits table above.
- **Deployment history has no retention policy.** Rows accumulate until the
  project is deleted.

## See also

- [CI Integration (Bring Your Own CI)](/guides/ci-integration/) — what Stratum does
  and does not execute
- [Getting Started](/guides/getting-started/) — the policy file and the merge gate
- [FAQ](/guides/faq/)
