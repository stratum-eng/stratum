# Trust, Security Architecture, and Data Residency

This page is for the people who have to approve hosting source code on Stratum:
security reviewers, procurement, and anyone answering a vendor questionnaire. It
describes what the code and configuration in this repository actually do — where
data lives, who else receives it, what is encrypted and by whom, how backups
work, and what data-residency guarantees exist today. Where something is not
done yet, it says so.

Two deployments are described, and they are not the same thing:

- **The hosted instance** at `app.usestratum.dev`, run by the maintainers from
  the `[env.production]` block of [`wrangler.toml`](https://github.com/stratum-eng/stratum/blob/main/wrangler.toml).
- **A self-hosted instance**, which you run in your own Cloudflare account from
  the same code. You choose its storage locations, its subprocessors (most are
  off unless you configure them), and its secrets.

Everything here is a description of the current code, not a contract. There is
no SLA, no DPA, and no certification today — see
[Compliance status](#compliance-status).

To report a vulnerability, follow [`SECURITY.md`](../../SECURITY.md).

## Architecture at a glance

Stratum is a single [Cloudflare Worker](https://developers.cloudflare.com/workers/)
(`src/index.ts`) plus the Cloudflare storage and messaging primitives it binds
to. There are no servers, containers, or databases outside Cloudflare in the
request path. The bindings, as declared for production in `wrangler.toml`:

| Primitive | Binding | Production resource | What it holds |
|-----------|---------|---------------------|---------------|
| Workers | — | Worker `stratum`, routed at `app.usestratum.dev` | All application code: UI, REST API, `/mcp`, Git smart-HTTP, evaluation, merge |
| [Artifacts](https://developers.cloudflare.com/artifacts/) | `ARTIFACTS` | namespace `stratum-prod` | **Your Git repositories** — every project and every workspace fork, full history |
| [D1](https://developers.cloudflare.com/d1/) | `DB` | database `stratum` | Relational state: accounts, orgs, teams, sessions, API/agent token hashes, changes, reviews and comments, issues, evaluation results, audit log, event outbox, webhooks, deployments, usage counters, encrypted project secrets |
| [Workers KV](https://developers.cloudflare.com/kv/) | `STATE` | one namespace | Project and workspace registry records, short-lived OAuth/consent state, rate-limit counters, and caches (policy, entitlements, repo views) |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) | `MERGE_QUEUE`, `REPO_DO`, `MAGIC_LINK_LIMITER`, `USAGE_METER` | four classes | Merge serialization; per-repo ref authority (SQLite-backed; its fast path is off in production, `REPO_DO_ENABLED = "false"`); magic-link send counters keyed by a digest of the email or by source IP; usage counters |
| [R2](https://developers.cloudflare.com/r2/) | `BACKUPS` | bucket `stratum-backups` | Daily backups — see [Backups and retention](#backups-and-retention) |
| [Queues](https://developers.cloudflare.com/queues/) | `EVENTS_QUEUE`, `IMPORT_QUEUE`, `DEPLOY_QUEUE`, `EVALUATION_QUEUE`, `MIRROR_QUEUE` | `stratum-events`, `stratum-imports`, `stratum-deploys`, `stratum-evaluations` (+ DLQs), `stratum-mirrors` | Transient job messages: event delivery, imports and syncs, post-merge deploys, evaluation runs (a change id and a run id — never the diff), push-mirror nudges (a project id — never repository content) |
| [Workers AI](https://developers.cloudflare.com/workers-ai/) | `AI` | — | Inference for the `llm` evaluator (default model `@cf/meta/llama-4-scout-17b-16e-instruct`) |
| [Email Sending](https://developers.cloudflare.com/email-service/) | `EMAIL` | sender `noreply@app.usestratum.dev` | Outbound mail: magic links, import alerts, usage notices |
| Workers Analytics Engine | `ANALYTICS` | dataset `stratum_requests` | Bound, but no code path currently writes to it |
| Workers Logs and Traces | `[observability]` | — | Application logs (100% sampled) and traces (10% sampled in production) |

Staging (`[env.staging]`) is a separate Worker with its own D1 database, KV
namespace, Artifacts namespace (`stratum-staging`), queues, and backup bucket
(`stratum-backups-staging`). It additionally binds an R2 bucket
`stratum-repo-objects-staging` (`REPO_OBJECTS`) for the RepoDO object plane;
production does not bind it.

The `[[sandboxes]]` binding — which the `sandbox` evaluator and
`merge.postMergeCommand` need to execute code — is **commented out in every
environment**. Neither the hosted instance nor a default self-hosted one runs
your code. See [CI Integration](ci-integration.md).

## Subprocessors and other recipients of data

"Subprocessor" here means a third party that receives data about users or their
code because of how the instance is configured. Each row says what it receives
and how to turn it off. Recipients that only exist because *a project* configured
them — a deploy target, a webhook URL — are listed separately below, because the
project owner, not the operator, decides to send data there.

### Instance-level

| Recipient | Purpose | What it receives | Hosted instance | Off switch |
|-----------|---------|------------------|-----------------|------------|
| **Cloudflare** | Hosting, storage, queues, email delivery, inference, logs | Everything above: repositories, database rows, email addresses (to deliver mail), diffs sent to Workers AI, application logs | Yes — it is the platform | None; Stratum only runs on Cloudflare |
| **PostHog** (server-side) | Product analytics | Pseudonymous events: route patterns, status codes, latencies, enums, scores; `distinct_id` is the internal user id (or an owner's id for agent traffic). Stratum never puts its own records into events — no account names, emails, repository paths or URLs, diffs, or file contents. **One exception:** `mcp_request` events for an MCP `initialize` carry `client_name` and `client_version`, copied from the connecting client's self-reported `clientInfo` and truncated to 64 characters each (`src/mcp/outcome.ts`). They are free text chosen by the client, so they can contain anything a client puts there, including a name, email, path, or URL. The same off switches suppress them. The exhaustive list is in the [FAQ](faq.md#what-exactly-is-sent) | Sends to `https://app.posthog.com` when the `POSTHOG_API_KEY` secret is set. Opt-in for new accounts: signup asks, and an account is created opted out unless the box was ticked (`TELEMETRY_CONSENT_AT_SIGNUP = "true"`); accounts created before that keep their setting | Per account: **Settings → Privacy**. Per instance: `STRATUM_TELEMETRY_DISABLED = "true"` in each env's `[vars]`, or leave `POSTHOG_API_KEY` unset |
| **PostHog** (browser SDK) | Browser analytics | Page views, autocapture, identify — produced by PostHog's SDK | Off: `POSTHOG_PUBLIC_KEY` is commented out in `[env.production.vars]` | Leave `POSTHOG_PUBLIC_KEY` unset (the default) |
| **GitHub** | Sign-in with GitHub (OAuth) | The OAuth exchange; Stratum reads your GitHub profile and email addresses at sign-in. The GitHub access token is used for that request and is **not stored** | Yes | Don't use GitHub sign-in; self-hosters can leave `GITHUB_CLIENT_ID` unset |
| **Google** | Sign-in with Google (OAuth) | The OAuth exchange; Stratum reads your profile from `userinfo` at sign-in | Yes | Same, with `GOOGLE_CLIENT_ID` |
| **Google Fonts** | The UI stylesheet imports JetBrains Mono from `fonts.googleapis.com` | Your browser's request (IP address, user agent) when it loads the stylesheet | Yes | Not configurable today — it is a line in `src/ui/styles.ts` |
| **Your organization's IdP** | Org SSO (OIDC) and SCIM provisioning | The OIDC exchange and SCIM user records your IdP pushes | Only for orgs that configure SSO | Don't configure SSO; without `SSO_ENCRYPTION_SECRET` the SSO surface returns 501 |
| **Referral service** (first-party) | Invite-code listing on `/profile`; admission when the beta gate is on | User id (listing); user id, email, and invite code (admission) | `REFERRAL_SERVICE_URL` is set; `BETA_GATE = "0"`, so only the listing runs | Unset `REFERRAL_SERVICE_URL` |
| **Billing service** (first-party) | Plan entitlements | Owner identifiers | Off: `BILLING_SERVICE_URL` is commented out | Leave it unset (the default for self-hosters) |

The referral and billing services are separate Workers operated by the
maintainers; they are not in this repository, so their storage is not described
here.

**Email.** All outbound mail goes through Cloudflare's `send_email` binding —
there is no third-party email provider (no Resend, SendGrid, or SMTP relay) in
the code. Recipients' email addresses therefore reach Cloudflare, and the
receiving mail servers.

### Project-level (the project owner opts in)

| Recipient | Triggered by | What it receives |
|-----------|--------------|------------------|
| **An LLM provider you bring a key for** (BYOK) | An `llm` evaluator naming a `provider` the operator allowlisted in `LLM_PROVIDERS` | The change's diff (truncated to `maxDiffChars`, default 24,000) and a serialized policy context. **The hosted instance allowlists none**: `LLM_PROVIDERS` is unset, so every `llm` evaluator runs on Workers AI, inside Cloudflare |
| **Your webhook evaluator endpoint** | A `webhook` evaluator in `.stratum/policy.yaml` | The diff, the policy (signing secrets stripped), and `baseSha`. See [CI Integration](ci-integration.md#the-webhook-evaluator-contract) |
| **Your outbound webhook URLs** | A project webhook subscription | Event payloads for that project |
| **Cloudflare (your account) or Vercel** | A `deploys:` entry in the policy | The merged tree, uploaded with the project's own credentials. See [Deployments](deployments.md) |
| **GitHub** | A [push mirror](push-mirror.md) an admin configured on a project | That project's default branch and tags — its full history — pushed to the one repository the admin named, with a GitHub App installation token limited to that repository. A [break-glass resync](push-mirror.md#break-glass-resync-from-github) reads that repository's default branch back, with a read-only token limited to it, and sends nothing |
| **GitHub / GitLab / Bitbucket** | Importing or syncing a project | Anonymous clones of **public** repositories only — imports carry no provider token. GitHub sync and PR promotion use an instance-wide `GITHUB_TOKEN` when the operator sets one |

## What is encrypted, and by whom

### In transit

- **Public endpoints** are served by Cloudflare on custom domains
  (`custom_domain = true`), for which Cloudflare provisions the TLS certificate.
  The application sets `Strict-Transport-Security: max-age=31536000;
  includeSubDomains` on HTTPS responses.
- **Outbound calls** to OAuth providers, PostHog, LLM providers, deploy targets,
  and Git hosts use `https://` URLs. Operator-configured LLM provider URLs must be
  `https` (`parseLlmProviders` rejects anything else).
- **The one exception is yours to control:** a `webhook` evaluator or outbound
  webhook URL may be `http://`. Use `https://` — the payload carries your diff.
- Traffic between the Worker and its bindings stays inside Cloudflare's
  network; Stratum adds no application-layer encryption on that hop.

### At rest — provided by Cloudflare

Stratum does not configure storage-level encryption; it relies on what Cloudflare
provides for each product. Cloudflare documents
[encryption at rest for R2](https://developers.cloudflare.com/r2/reference/data-security/).
For D1, KV, Durable Objects storage, Queues, and Artifacts, consult
Cloudflare's own security documentation and trust materials — this page does not
restate guarantees it has not verified against Cloudflare's published docs.

### At rest — added by Stratum

On top of the platform, the application encrypts or hashes specific fields
before they are written (`src/utils/crypto.ts`, `src/storage/backup-store.ts`):

| Data | Treatment | Key |
|------|-----------|-----|
| Per-project secrets (deploy credentials, BYOK provider keys) | AES-256-GCM, key derived with PBKDF2-SHA256 (100k iterations); the secret's scope is bound as additional authenticated data. Write-only: no route returns a value | `DEPLOY_SECRET_KEY` (Wrangler secret) |
| Org SSO client secrets | AES-256-GCM, PBKDF2-derived key with an SSO-specific salt | `SSO_ENCRYPTION_SECRET` (Wrangler secret) |
| Backup blobs in R2 | AES-256-GCM per blob, PBKDF2-derived key — **only when the secret is set** | `BACKUP_ENCRYPTION_SECRET` |
| Session ids, API tokens, magic-link tokens | Stored as SHA-256 hashes; the plaintext is never persisted | — |
| Outbound webhook signing secrets | Stored in plaintext in D1, because the Worker must sign with them | — |
| Webhook *evaluator* `secret` | A literal in `.stratum/policy.yaml` — visible to every reader of the repository (see [CI Integration](ci-integration.md#the-webhook-evaluator-contract)) | — |

Repository contents, issue and comment text, email addresses, and the rest of
the relational data have no application-level encryption; they rely on
Cloudflare's storage encryption.

Whether `BACKUP_ENCRYPTION_SECRET` is set on the hosted instance is not visible
from the repository (secrets are set out of band with `wrangler secret put`); the
backup runbook requires it in production.

## Backups and retention

### Backups

The backup subsystem (`src/backup/`, documented in
[`docs/runbooks/backup-restore.md`](../runbooks/backup-restore.md)) writes to
the `BACKUPS` R2 bucket:

- **When:** daily from its own cron, `0 4 * * *` (UTC), in production, plus on
  demand through an admin endpoint. Staging has no backup cron.
- **What:** one NDJSON dump per D1 table, the project and workspace registry
  records from KV, and a Git pack of the reachable history of **project**
  repositories. Each run snapshots at most `MAX_REPOS_PER_RUN` (default 25)
  projects, taking the projects least recently attempted first. A repository
  over `MAX_BACKUP_BYTES` (default 128 MiB) is skipped. A skipped or failed
  repository still counts as attempted and moves to the back of the rotation.
  Projects the operator lists in `BACKUP_PINNED_PROJECTS` (comma-separated
  `@namespace/slug`) are snapshotted in **every** run in addition to that
  rotation, and do not use up any of its `MAX_REPOS_PER_RUN` slots. The run
  manifest lists them under `repos.pinned`.
- **Not backed up: workspace repositories.** The repo pass iterates projects
  only (`listProjects` in `src/backup/run-backup.ts`). Workspace forks, which
  hold unmerged work, are not snapshotted. Their KV registry records are backed
  up, but their Git contents are not. Commits that have not been merged into the
  project are not in any backup.
- **Retention:** the newest `BACKUP_RETENTION` runs (default **14**) are kept,
  and older runs are pruned by the backup job itself. On-demand runs count
  toward this number the same way scheduled runs do. A run is complete once its
  `_manifest.json` is written, which means only that the run finished, **not
  that it is restorable**. A run where a table, the KV export or a repository
  failed still writes its manifest, with `healthy: false`. Retention reads that
  flag: unhealthy runs never take one of the `BACKUP_RETENTION` slots (they are
  kept only while they are among the newest `BACKUP_RETENTION` complete runs),
  and the newest healthy run is never pruned, so a stretch of failed runs cannot
  evict the last good backup. Up to `BACKUP_RETENTION` unhealthy runs can be
  retained alongside the healthy ones, so storage can reach twice the window. A manifest with no `healthy` field, or one that cannot be
  decrypted, counts toward `BACKUP_RETENTION` as before. Before relying on a
  run, check `healthy` in its manifest or the `backup.run` audit
  entry, and alert on unhealthy runs. Neither that nor the restore plan's
  `restorable` result proves that a given repository has a pack: `healthy`
  ignores repositories skipped for exceeding `MAX_BACKUP_BYTES` (they are
  listed under `repos.skipped` in the run manifest), and `restorable` is
  computed for the whole run and checks only repositories that wrote a
  manifest. To confirm one repository, look for its pack in a retained run.

**Retention has to cover the rotation, or some repositories have no backup.**
Each run stores packs only for the pinned projects and the projects in that
run's slice. Pinned projects use no rotation slots, so this calculation counts
only the rest. With `P` unpinned projects and no failed or skipped snapshots, a
project's most recent pack is up to `ceil(P / MAX_REPOS_PER_RUN)` runs old. A
failed or skipped attempt still moves the project to the back of the rotation, so
its pack can be a full rotation older for each one. Pruning keeps
the newest `BACKUP_RETENTION` runs that are healthy or of unknown health (an old
or unreadable manifest counts), so fewer than that many healthy runs may survive. When every run
is healthy, the defaults (25 per run, 14 runs) retain 14 × 25 = **350** distinct
unpinned projects, plus any pinned ones. Unhealthy runs retained alongside them
can briefly hold more, but do not plan capacity around that:

- **Up to 350 unpinned projects:** every one that snapshotted successfully has at
  least one retained pack. With no failures, that pack can be up to
  `ceil(P / 25)` daily runs old, so a repository restore can lose up to that many
  days of merged history. Example: 300 unpinned projects give a 12-run rotation,
  so the worst case with no failures is about 12 days.
- **Over 350 unpinned projects:** some of them have no Git pack in any retained run at
  any given time. Their pack was pruned before the rotation came back around to
  them.

Operators should keep `BACKUP_RETENTION ≥ ceil(P / MAX_REPOS_PER_RUN)`, with
margin for growth and for skipped or failed repositories, which never produce a
pack. Two settings can change: raise `MAX_REPOS_PER_RUN`, which shortens the
rotation and the restore-point age but is bounded by the backup invocation's
roughly 15-minute budget, or raise `BACKUP_RETENTION`, which costs R2 storage.
The code does not check this inequality or warn when it fails. A pinned project
is not subject to it, because every run attempts it. It has a pack in each
retained run where its snapshot succeeded, so its restore point is one run old
only while its snapshots keep succeeding. Consecutive failures or skips leave a
gap as long as the streak, and a project over `MAX_BACKUP_BYTES` has no pack at
all.
- **Not in any backup:** `DEPLOY_SECRET_KEY` and the other Wrangler secrets. The
  `project_secrets` rows are backed up as ciphertext only.
- **Restore** is documented in the runbook. A single repository can be restored
  through an admin route, which checks its refs against the backup afterwards. A
  database or KV restore is covered by tests of its restore functions, but
  applying one still takes an operator-deployed admin route, because no built-in
  command exists yet.

### Retention of live data

| Data | Retention |
|------|-----------|
| Accounts, projects, repositories, changes, issues | Until deleted by the user or owner |
| Account deletion (`DELETE /api/users/me`) | Deletes the account and its owned projects (including their Artifacts repositories), revokes tokens and sessions, and anonymizes contributions to other people's projects and audit log entries. See [Users API](../api/endpoints/users.md#delete-account) |
| Import job records | Pruned after 30 days by the daily housekeeping cron |
| Workspaces | Swept by the daily TTL sweep when they expire |
| Rate-limit counters, OAuth state, caches in KV | Short KV TTLs (minutes to a day) |
| Workers Logs | Cloudflare's retention for the account's plan; not configured by Stratum |
| PostHog events | PostHog's retention for the project. Opting out stops future events; it does not delete past ones |

**Deletion does not reach backups.** A deleted account or project remains in
backups until those runs age out of `BACKUP_RETENTION` (about two weeks with the
defaults, sooner if extra on-demand runs are taken). One exception: the newest
healthy run is never pruned, so if every run after it fails, that run, and
anything deleted after it was taken, stays until a later healthy run completes.
After that, it stays until it ages out of the `BACKUP_RETENTION` window, which
can span several later healthy runs.
It also does not delete
PostHog events or log lines already written.

## Data residency

### What the hosted instance configures today

**No jurisdiction is configured for any resource.** `wrangler.toml` sets no
`jurisdiction` on any binding, no location hint, and no
[Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/),
and `DO_JURISDICTION` is unset in every environment, so no Durable Object
namespace is restricted. Concretely, as reported by the Cloudflare API on
2026-11-02:

| Resource | Location | Jurisdiction |
|----------|----------|--------------|
| D1 `stratum` (production) | `ENAM` (Eastern North America) primary; read replication disabled | none |
| R2 `stratum-backups` | `ENAM` | default (unrestricted) |
| Artifacts namespace `stratum-prod` | not set by Stratum | not set in configuration; treat as unrestricted |
| KV `STATE` | global (KV caches reads across Cloudflare's network) | not set in configuration |
| Durable Objects | created near the first request that reaches each object | none |
| Worker execution | the Cloudflare data center nearest each request | none |
| Workers AI inference | Cloudflare's network | not configurable from Stratum |

So the honest summary is: **durable data for the hosted instance is
predominantly in Eastern North America, but nothing guarantees that**, and
request processing, background jobs (queues and crons), KV caching, and Durable
Object placement are not tied to any region. An EU-only (or US-only) hosted offering does not exist today.

### What Cloudflare's primitives can and cannot guarantee

Per Cloudflare's documentation as read on 2026-11-09 — check the linked pages
for current status, because these features change. A **jurisdiction** is a
guarantee Cloudflare documents; a **location hint** is explicitly best-effort
and is not a residency control.

| Primitive | Strong guarantee available | Best-effort only | Notes |
|-----------|----------------------------|------------------|-------|
| D1 | [Jurisdiction](https://developers.cloudflare.com/d1/configuration/data-location/) `eu`, `us`, `fedramp`: the database "only run[s] and store[s] data within" it, and read replicas stay inside it | Location hints (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`): "does not guarantee that D1 runs in your preferred location" | Set at creation only; cannot be added or changed later. A jurisdiction overrides a hint |
| R2 | [Jurisdiction](https://developers.cloudflare.com/r2/reference/data-location/) `eu`, `us`, `fedramp`: objects are "stored within a specific jurisdiction" | Location hints: "a best effort and not a guarantee" | Set at bucket creation and cannot be changed; the Worker binding must name the jurisdiction |
| Artifacts | [Namespace jurisdiction](https://developers.cloudflare.com/artifacts/guides/data-localization/) `eu`, `us`: repo data is "stored and processed only within" it | — | Set at namespace creation; applies to every repo in it; cannot be changed. [A namespace that does not exist is created automatically, unrestricted, by the first repo created in it](https://developers.cloudflare.com/artifacts/concepts/namespaces/) — so it must be created before the first project |
| Durable Objects | [Jurisdiction](https://developers.cloudflare.com/durable-objects/reference/data-location/) `eu`, `us`, `fedramp`: objects "only run and store data within" it | Location hints | In Stratum, the `DO_JURISDICTION` setting (below). A restricted namespace addresses different objects than the unrestricted one. Cloudflare logs each object's id outside the jurisdiction "for billing and debugging purposes" |
| Queues | [Jurisdiction](https://developers.cloudflare.com/queues/configuration/data-location/) `eu`, `us`, `fedramp`: restricts "where Queues stores and processes messages" | — | Set at queue creation; cannot be changed. A dead-letter queue must share its source queue's jurisdiction. **It does not restrict where the consumer Worker runs**: "Workers can produce to and consume from a restricted queue from any location" |
| Workers KV | [Jurisdiction](https://developers.cloudflare.com/kv/reference/data-location/) `eu`, `us`, `fedramp`, for where data is *durably stored* only | — | Set at creation only. "KV data can be cached outside the jurisdiction location on Cloudflare's network" |
| Worker execution, TLS termination | [Regional Services](https://developers.cloudflare.com/data-localization/how-to/workers/), an Enterprise add-on in the Data Localization Suite. It applies **only to HTTP requests on the Worker's custom domain** | — | It does not cover the `*.workers.dev` hostname, Queue consumers, Cron Triggers, or outgoing subrequests, and Worker code and secrets are still deployed globally |
| Logs and metrics | [Customer Metadata Boundary](https://developers.cloudflare.com/data-localization/metadata-boundary/) (Data Localization Suite), `EU` or `US` | — | Controls where Cloudflare stores logs and analytics. With it set to `EU`, the Workers and Durable Objects metrics tabs in the dashboard are empty |
| Workers AI | None documented | — | No location setting appears in Cloudflare's Workers AI documentation, and the [Data Localization compatibility table](https://developers.cloudflare.com/data-localization/compatibility/) marks Workers AI as not compatible with Regional Services |
| Rate limiting bindings | None documented | — | [Counters are kept per Cloudflare location](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) the Worker runs in. No separate location setting is documented |
| Email Sending | None documented | — | No location setting appears in Cloudflare's Email Service documentation. Mail leaves Cloudflare for the recipient's mail server in any case |
| Workers Analytics Engine | None documented | — | Bound by the default configuration, though no code path writes to it |

**Two places where Cloudflare's own pages disagree.** Both matter to anyone
relying on this table, and neither is resolved here:

- The [Data Localization compatibility table](https://developers.cloudflare.com/data-localization/compatibility/)
  (updated 2026-11-06) carries footnotes saying jurisdictional restrictions for
  **Workers KV** and for **D1** are "not supported today". The KV and D1
  product pages linked above (both updated 2026-10-02) document creating each
  with a jurisdiction, and `wrangler` accepts the flag. This page follows the
  product pages. If KV or D1 residency is load-bearing for you, confirm it with
  Cloudflare.
- The [Workers data-localization page](https://developers.cloudflare.com/data-localization/how-to/workers/)
  says Customer Metadata Boundary applies to the `*.workers.dev` subdomain; the
  compatibility table marks `Workers.dev` as not compatible with it. The steps
  below avoid the question by turning `workers.dev` off.

### Deploying EU-only (self-hosted)

These steps configure a **new** deployment so that every control Cloudflare
offers is switched on. Read
[What an EU-only deployment does and does not guarantee](#what-an-eu-only-deployment-does-and-does-not-guarantee)
before relying on the result: two execution paths have no control at all, and
this procedure does not change that.

> **Not verified end to end.** The maintainers do not run an EU-only
> deployment, and none of this has been exercised against a live Cloudflare
> account. `DO_JURISDICTION` is covered by unit tests against a fake namespace;
> what a jurisdiction does once set is Cloudflare's documented behaviour, not
> something this repository tests. Nothing in Stratum checks that the D1
> database, buckets, KV namespace, Artifacts namespace or queues you bind were
> actually created with a jurisdiction — verify each in the Cloudflare
> dashboard or API after creating it.

> **This is for a fresh deployment.** Every storage jurisdiction below is fixed
> at creation, and `DO_JURISDICTION` moves every Durable Object to a different
> object. See [Do not switch an existing deployment](#do-not-switch-an-existing-deployment).

The same steps apply to `us` or `fedramp` by substituting the jurisdiction,
with two exceptions. Artifacts documents only `eu` and `us`. And Customer
Metadata Boundary (step 5) has only `EU` and `US` regions: there is no
`fedramp` value, and a FedRAMP deployment uses `US`.

Do these in order. Steps 1–5 must be finished **before the first deploy**.

**Every name in steps 1 to 3 is the top-level template's**, which is what a
bare `wrangler deploy` binds. A named environment binds different ones: for
`[env.staging]` the bucket is `stratum-backups-staging`, the queues are
`stratum-events-staging` and so on, and the D1 database and KV namespace
have their own ids. Read the names out of the environment you will deploy,
in `wrangler.toml`, and create exactly those. A resource created under
another name is never used, and the deploy either fails or binds an
existing resource that has no jurisdiction.

1. **Create the storage with an EU jurisdiction.** The `--jurisdiction` flag on
   `kv namespace create` and `queues create` needs a recent Wrangler (present in
   4.159.0; absent from 4.86.0, which this repository's lockfile currently
   resolves to), so use `wrangler@latest` for these commands or the REST calls
   on the linked pages.

   ```bash
   npx wrangler@latest d1 create stratum --jurisdiction=eu
   npx wrangler@latest kv namespace create STATE --jurisdiction=eu
   npx wrangler@latest r2 bucket create stratum-backups --jurisdiction=eu
   # Only if you enable REPO_DO_ENABLED, which needs the REPO_OBJECTS bucket:
   npx wrangler@latest r2 bucket create stratum-repo-objects --jurisdiction=eu
   ```

   Do not substitute `--location=weur`. That is a hint, and Cloudflare says it
   is not a guarantee.

   If you created the `stratum-repo-objects` bucket, give it its retention
   rule now. Without one, the staged copies of rejected and abandoned
   workspace trees are kept for ever. The rule and its reasoning are in the
   [staged-tree retention runbook](https://github.com/stratum-eng/stratum/blob/main/docs/runbooks/staged-tree-retention.md);
   for a bucket with a jurisdiction, name it on the command:

   ```bash
   npx wrangler@latest r2 bucket lifecycle add stratum-repo-objects \
     expire-staged-sha staged-sha/ --expire-days 30 --jurisdiction eu
   ```

2. **Create the Artifacts namespace with an EU jurisdiction**, before any
   project exists. If the Worker creates a repository in a namespace that does
   not exist yet, Artifacts creates that namespace for it with **no**
   jurisdiction, and that cannot be changed afterwards.

   ```bash
   curl --request POST \
     "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces" \
     --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
     --header "Content-Type: application/json" \
     --data '{"namespace": "stratum", "jurisdiction": "eu"}'
   ```

   The name must be the one in the `[[artifacts]]` binding of the environment
   you deploy. `stratum` is the top-level template's; a named environment has
   its own (`stratum-staging` for `[env.staging]`). Creating a namespace the
   Worker is not bound to protects nothing: the bound one is still created on
   first use, without a jurisdiction.

3. **Create every queue with an EU jurisdiction.** A dead-letter queue must be
   in the same jurisdiction as its source queue; create them explicitly rather
   than relying on that being inferred.

   ```bash
   for q in stratum-events stratum-imports stratum-deploys stratum-deploys-dlq \
            stratum-evaluations stratum-evaluations-dlq; do
     npx wrangler@latest queues create "$q" --jurisdiction eu
   done
   ```

4. **Edit `wrangler.toml`**, in the environment you will deploy. Each of these
   has a commented sample in the top-level template, which is what a bare
   `wrangler deploy` uses. If you deploy with `--env <name>`, make every change
   below inside `[env.<name>]` instead: a named environment has its own
   bindings, vars, `workers_dev` and `routes`, and the ones shipped in this
   repository set `workers_dev = true`.

   - Put the ids from step 1 in the `[[kv_namespaces]]` and `[[d1_databases]]`
     bindings.
   - Add `jurisdiction = "eu"` to **every** `[[r2_buckets]]` binding. Cloudflare
     requires the binding to name the jurisdiction to reach a bucket that has
     one.
   - If you turn `REPO_DO_ENABLED` on, bind the `stratum-repo-objects` bucket
     from step 1 as `REPO_OBJECTS`, with the jurisdiction. The top-level
     template has no such binding, and creating the bucket does not add one.
     Without it the fast merge path has nowhere to stage trees, and batch
     merges skip changes as not staged.

     ```toml
     [[r2_buckets]]
     binding = "REPO_OBJECTS"
     bucket_name = "stratum-repo-objects"
     jurisdiction = "eu"
     ```
   - Set `DO_JURISDICTION = "eu"` under `[vars]`. If you deploy a named
     environment, set it in that environment's `[env.<name>.vars]` block: named
     environments do not inherit top-level vars, and a value set only at the top
     level leaves the deployed Worker unrestricted with no warning.
   - Set `workers_dev = false` and `preview_urls = false`, and route the Worker
     on a custom domain (`routes = [{ pattern = "…", custom_domain = true }]`),
     all three in the environment you deploy.
     `preview_urls` must be set explicitly: Cloudflare documents that disabling
     the `workers.dev` route "does not disable" version and preview URLs, and
     that omitting `preview_urls` leaves an existing setting unchanged.
   - Remove the `[ai]` binding, or accept that the `llm` evaluator's inference
     has no location guarantee. Without the binding, an `llm` evaluator that
     names no BYOK provider reports itself unavailable instead of running.
   - Leave `[[sandboxes]]` commented out. The sandbox evaluator is not covered
     by `DO_JURISDICTION`, and this page makes no residency statement about it.
   - Optionally remove `[[analytics_engine_datasets]]`. Nothing writes to it.

5. **Settle where logs go, before the first deploy.** Set Customer Metadata
   Boundary to `EU` (Data Localization Suite) if Worker logs must stay in the
   EU, or turn observability off. Turning it off takes two settings, in the
   environment you deploy: `[observability] enabled = false` stops logs, and
   traces have their own switch, `[observability.traces] enabled = false`,
   which the template also has on. Leaving traces on keeps request metadata
   flowing with no boundary. Neither switch stops Workers **metrics**:
   Cloudflare records invocation metrics for every Worker whether or not
   Workers Logs is on, and only Customer Metadata Boundary restricts where
   those are stored. Without the boundary there is no setting in this
   repository that keeps metrics in the EU. Application logs contain identifiers such
   as user and project ids, and the template has observability on, so a
   deployment made before this step writes logs with no boundary from its
   first request or cron run.

6. **Apply the database schema, set up sign-in, deploy, then configure
   Regional Services.** A fresh deployment has no way to sign in: no OAuth
   credentials and no sender address for magic links, so `/health` answers
   and nobody can create an account. Set at least one sign-in method's
   secrets first, following "Secrets Management" in the
   [deployment guide](https://github.com/stratum-eng/stratum/blob/main/docs/developer/deployment.md).
   Each one is also a subrequest to a service outside Cloudflare (step 7).
   The database from step 1 is empty. Apply the migrations to it first
   (`npx wrangler d1 migrations apply <database> --remote`, with `--env <name>`
   for a named environment; see the
   [deployment guide](https://github.com/stratum-eng/stratum/blob/main/docs/developer/deployment.md)),
   or `/health` can answer while everything that reads the database fails.
   Then deploy, and configure
   [Regional Services](https://developers.cloudflare.com/data-localization/regional-services/regional-hostnames/)
   for the custom domain with an EU region. This needs a Cloudflare Enterprise
   plan with the Data Localization Suite; without it, nothing constrains where
   HTTP requests are decrypted and handled, and the rest of this list covers
   storage and Durable Objects only. Do not send real traffic to the domain
   until Regional Services is in place.

7. **Deal with everything outside Cloudflare.** Leave `POSTHOG_API_KEY` and
   `POSTHOG_PUBLIC_KEY` unset, or point `POSTHOG_HOST` at PostHog's EU cloud.
   Keep `LLM_PROVIDERS` to providers whose terms suit you, or leave it unset.
   Decide about Google Fonts, which the UI loads from `fonts.googleapis.com` and
   which is not configurable today. OAuth sign-in, outbound webhooks, deploy
   targets, and Git hosts used for import and sync are all subrequests that
   Regional Services does not cover.

8. **Check it.** Confirm in the Cloudflare dashboard that the D1 database, each
   bucket, the KV namespace, the Artifacts namespace and each queue show the
   jurisdiction. Request `https://<worker>.<subdomain>.workers.dev/health` and
   confirm it no longer answers. Request `/health` on the custom domain: a
   mistyped `DO_JURISDICTION` answers `503` to every request there (below).

#### The `DO_JURISDICTION` setting

`DO_JURISDICTION` accepts `eu`, `us`, or `fedramp` — the jurisdictions
[Cloudflare documents for Durable Objects](https://developers.cloudflare.com/durable-objects/reference/data-location/#supported-locations).
Unset, or set to the empty string, it does nothing; that is the default and
what the hosted instance runs.

When set, every Durable Object namespace the Worker uses — all four classes —
is obtained through `namespace.jurisdiction(<value>)`, in one function
(`durableObjectNamespace` in `src/utils/durable-objects.ts`). A test fails the
build if any code reads a Durable Object binding without going through it.

The value must match exactly. `EU`, `europe`, `weur`, or a value with stray
whitespace is not normalised and is not ignored: **every HTTP request is
answered `503`**, the health check included, and the reason is logged once per
isolate. Queue consumers and cron handlers, which no request reaches, are not
stopped as a whole: a job throws at the point it reaches for a Durable Object,
instead of addressing an unrestricted one, and a job that never touches a
Durable Object (delivering a webhook, for example) still runs. So with a
mistyped jurisdiction the HTTP side is down, and no Durable Object is ever
addressed unrestricted, but background work that needs none continues.

#### Do not switch an existing deployment

**Setting or changing `DO_JURISDICTION` on a deployment that has already run
makes its existing Durable Object state unreachable.** Cloudflare documents
that the same name maps to a different object id in a jurisdiction-restricted
namespace than in the unrestricted one, so every object the Worker addresses
afterwards is a new, empty one. The old objects are **not deleted or moved**:
they stay where they were created, outside the jurisdiction, and nothing in
Stratum can reach them any more — including account and project deletion,
whose purge step addresses the new namespace. Changing the value back makes the
old objects reachable again and the new ones unreachable.

What each class holds, and what switching would do to it:

| Class (binding) | State it holds | Effect of switching |
|-----------------|----------------|---------------------|
| `MergeQueue` (`MERGE_QUEUE`) | Nothing durable. It exists to run one repository's merges one at a time | Nothing is lost. A merge in flight at the moment of the switch is no longer serialized against the next one |
| `RepoDO` (`REPO_DO`) | Only when `REPO_DO_ENABLED = "true"`: each repository's cached `head` commit, and a SQLite index of staged workspace trees that the batch-merge endpoint reads | The cached head starts empty and is rebuilt; correctness does not depend on it. The SQLite index is lost: the batch-merge endpoint reports a workspace committed before the switch as "not staged" and skips it until the workspace is committed again. Single merges do not read that index and are unaffected |
| `MagicLinkRateLimiter` (`MAGIC_LINK_LIMITER`) | The current hour's magic-link send count, one object per email digest and one per source IP | Counts restart at zero, so each address and IP gets one extra hour's allowance |
| `UsageMeter` (`USAGE_METER`) | Only when a billing service is configured: the current month's usage counters, short-window rate counters, and in-flight creation holds, one object per enforcement subject | Enforcement counters restart at zero for the current month, so limits are under-enforced until the month rolls over. The usage ledger in D1 is unaffected. A default self-hosted instance stores nothing here |

The same applies to the storage in step 1: a jurisdiction cannot be added to
an existing D1 database, bucket, KV namespace, Artifacts namespace or queue.
Moving an existing instance means creating new resources and migrating the data
into them, and this repository provides no procedure for that.

### What an EU-only deployment does and does not guarantee

For a deployment configured by the steps above. "Covered" means Cloudflare
documents a guarantee and the named setting turns it on. "No guarantee" means
Cloudflare documents none, and no setting in Stratum creates one.

| Execution path or data | Status | Detail |
|------------------------|--------|--------|
| HTTP on the custom domain: UI, REST API, `/mcp`, Git smart-HTTP | **Covered by Regional Services** (Enterprise add-on), set to an EU region on the hostname | TLS termination and Worker execution for these requests happen in-region. Without Regional Services there is no guarantee |
| HTTP on `*.workers.dev`, and version or preview URLs | **Covered by `workers_dev = false` and `preview_urls = false`** | The hostnames stop existing, so no request can reach the Worker outside the regional hostname. Regional Services does not cover `workers.dev` |
| Durable Objects: execution and storage, all four classes, including their alarms | **Covered by `DO_JURISDICTION = "eu"`** | Cloudflare still logs object ids outside the jurisdiction. The Worker that *calls* an object is not moved by this setting; it runs wherever its own trigger runs |
| D1, R2, Artifacts: storage and processing | **Covered by a jurisdiction set at creation** (and `jurisdiction = "eu"` on each R2 binding) | Not checked by Stratum at run time |
| Queue messages: storage and processing by Queues | **Covered by a jurisdiction set at queue creation** | Covers the messages, not the consumer — see the next row |
| Queue consumers (`stratum-events`, `stratum-imports`, `stratum-deploys`, `stratum-evaluations`) | **No guarantee available**, because Cloudflare states that Regional Services "does not apply to other Worker triggers, like Queues or Cron Triggers", that a restricted queue can be consumed "from any location", and that placement settings "only [affect] the execution of fetch event handlers" | The consumer Worker may run in any Cloudflare data center. It handles event delivery, imports and syncs, post-merge deploys and evaluation runs, so repository contents and database rows read from EU storage can be processed in memory outside the EU. Whatever it writes still lands in EU storage |
| Cron Triggers: `0 4 * * *` (backup), `0 6 * * *` (housekeeping, sync), `*/5 * * * *` (outbox and import sweeps) | **No guarantee available**, for the same reason; Cloudflare says only that scheduled Workers "run on underutilized machines" | The backup cron reads every D1 table and every project repository, so it processes the full dataset wherever it runs |
| Workers KV | **Durable storage covered by a jurisdiction set at creation; cached copies have no guarantee available**, because Cloudflare states KV data "can be cached outside the jurisdiction" | KV holds project and workspace registry records, short-lived OAuth state, and caches. See also the documentation conflict noted above |
| Worker code and secrets at rest | **No guarantee available**, because Cloudflare states they "are deployed globally to all Cloudflare data centers" even under Regional Services | This includes `DEPLOY_SECRET_KEY`, `SSO_ENCRYPTION_SECRET`, `BACKUP_ENCRYPTION_SECRET` and the OAuth client secrets |
| Outbound subrequests: OAuth, PostHog, BYOK LLM providers, deploy targets, webhooks, Git hosts | **No guarantee available**, because Regional Services "does not extend to outgoing subrequests" | Choose EU-hosted endpoints, or disable each one (step 7) |
| Workers AI (`llm` evaluator) | **No guarantee available**, because Cloudflare documents no location control for inference | Remove the `[ai]` binding (step 4) |
| Rate limiting bindings | **No guarantee available** as a separate control, because none is documented | Counters live in the Cloudflare location the Worker runs in, so they follow Regional Services for HTTP requests. The key is a user id, an agent id, or a client IP address |
| Outbound email | **No guarantee available**, because Cloudflare documents no location control for Email Sending | Recipient addresses and message bodies reach Cloudflare's mail infrastructure and then the recipient's mail server |
| Worker logs and traces | **Covered by Customer Metadata Boundary** set to `EU` (Data Localization Suite), or by turning off both `[observability]` and `[observability.traces]` | Without either, there is no guarantee where logs are stored |
| Worker metrics | **Covered by Customer Metadata Boundary** only | The observability switches do not stop invocation metrics. Without the boundary there is **no guarantee available** |
| Sandbox evaluator and `merge.postMergeCommand` | **No statement made** | The `[[sandboxes]]` binding is commented out in every environment and was not assessed. Leave it off |

So such a deployment keeps the data in its **jurisdiction-restricted stores**
(D1, R2, the KV namespace's authoritative copy, Artifacts, queue messages and
Durable Object storage) in the EU, with two exceptions from the table that
are also data at rest: KV's cached copies can sit outside the jurisdiction,
and Worker code and secrets are deployed globally. It runs its **Durable
Objects** in the EU, and — with Regional Services — handles its **HTTP
requests** in the EU. It **cannot** guarantee that every computation over that
data happens in the EU, because queue consumers and cron handlers run wherever
Cloudflare schedules them, and Stratum does a large share of its work there:
imports, syncs, evaluations, post-merge deploys, event delivery, and the
nightly backup. Anyone making an EU-only *processing* claim needs either
Cloudflare's confirmation of regional execution for those triggers, or a
version of Stratum that moves that work into jurisdiction-restricted Durable
Objects, which this one does not do.

## Compliance status

Stated plainly:

- **No SOC 2 report, no ISO 27001 certification**, and no other third-party
  attestation exists for Stratum.
- **No Data Processing Agreement (DPA) template** is published, and there is no
  published subprocessor-change notification process.
- **No SLA** for availability, support response, or breach notification. The
  only published commitment is the vulnerability-report acknowledgement window in
  [`SECURITY.md`](../../SECURITY.md).
- Cloudflare's and PostHog's own certifications cover their platforms; they do
  not extend to Stratum's application code or operations.

What exists today, and can be pointed to in a review:

- The source code is public ([AGPL-3.0-or-later](../../LICENSING.md)), so every
  claim on this page can be checked against the implementation.
- Private vulnerability reporting through GitHub Security Advisories.
- An audit log of sensitive operations (sessions, token and agent lifecycle,
  webhooks, and similar — `src/storage/audit.ts`), documented account erasure,
  and a documented backup and restore runbook. The log is append-only, enforced by
  the database, **except for erasure of personal identifiers**: deleting an
  account rewrites that account's id and email to `deleted-user` where they are
  an entry's actor, its subject, or a complete value in its detail. That is a
  deliberate trade-off: the trail keeps every event, but those fields can no
  longer say which erased person it was. An id or email inside longer free text,
  and usernames, are not rewritten, so such a value can still identify them.
- A threat model for the sandbox evaluator
  ([ADR 007](../adr/007-sandbox-evaluator-threat-model.md)) and for BYOK LLM
  providers ([ADR 008](../adr/008-llm-provider-byok-threat-model.md)).
- Self-hosting: an organization that cannot accept a third-party operator can
  run the same code in its own Cloudflare account under its own agreements with
  Cloudflare.

### Roadmap — not yet done

This section describes work that would be needed. **None of it has started**,
and it is listed so a reviewer can see the gap, not as a commitment or a date.

- **DPA.** A template covering processing purposes, the subprocessor list on this
  page, a change-notification process, international transfer mechanism
  (for example SCCs), breach-notification terms, and deletion on termination
  including backup expiry. This is legal work, not code.
- **SOC 2 Type I, then Type II.** Requires written policies (access control,
  change management, incident response, vendor management, business
  continuity), evidence collection over an observation period for Type II, an
  engagement with an audit firm, and controls this repository does not document
  today: production access reviews, on-call and incident response procedures,
  and periodic restore drills with recorded results.
- **Technical prerequisites that are code changes:** moving queue-consumer and
  cron work into jurisdiction-restricted Durable Objects, which is what an
  EU-only *processing* guarantee would need (the
  [EU-only deployment steps](#deploying-eu-only-self-hosted) cover storage,
  Durable Objects and HTTP only); a run-time check that bound storage actually
  carries a jurisdiction; backup purge on account deletion or a documented
  maximum; self-hosted fonts; and a published log-retention setting.

## See also

- [`SECURITY.md`](../../SECURITY.md) — reporting a vulnerability
- [FAQ: Can I turn off telemetry?](faq.md#can-i-turn-off-telemetry) — the exhaustive telemetry event list
- [`docs/runbooks/backup-restore.md`](../runbooks/backup-restore.md) — backup contents, encryption, and restore
- [Deployments](deployments.md) — the project secret store and `DEPLOY_SECRET_KEY`
- [`docs/developer/architecture.md`](../developer/architecture.md) — the full technical architecture
