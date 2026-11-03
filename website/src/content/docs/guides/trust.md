---
title: "Trust, Security Architecture, and Data Residency"
description: "Security architecture, subprocessors, encryption, backups, data residency, and compliance status — what the code does today."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/trust.md"
---

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

To report a vulnerability, follow [`SECURITY.md`](https://github.com/stratum-eng/stratum/blob/main/SECURITY.md).

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
| [Queues](https://developers.cloudflare.com/queues/) | `EVENTS_QUEUE`, `IMPORT_QUEUE`, `DEPLOY_QUEUE`, `EVALUATION_QUEUE` | `stratum-events`, `stratum-imports`, `stratum-deploys`, `stratum-evaluations` (+ DLQs) | Transient job messages: event delivery, imports and syncs, post-merge deploys, evaluation runs (a change id and a run id — never the diff) |
| [Workers AI](https://developers.cloudflare.com/workers-ai/) | `AI` | — | Inference for the `llm` evaluator (default model `@cf/meta/llama-3.1-8b-instruct`) |
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
your code. See [CI Integration](/guides/ci-integration/).

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
| **PostHog** (server-side) | Product analytics | Pseudonymous events: route patterns, status codes, latencies, enums, scores; `distinct_id` is the internal user id (or an owner's id for agent traffic). Stratum never puts its own records into events — no account names, emails, repository paths or URLs, diffs, or file contents. **One exception:** `mcp_request` events for an MCP `initialize` carry `client_name` and `client_version`, copied from the connecting client's self-reported `clientInfo` and truncated to 64 characters each (`src/mcp/outcome.ts`). They are free text chosen by the client, so they can contain anything a client puts there, including a name, email, path, or URL. The same off switches suppress them. The exhaustive list is in the [FAQ](/guides/faq/#what-exactly-is-sent) | Sends to `https://app.posthog.com` when the `POSTHOG_API_KEY` secret is set | Per account: **Settings → Privacy**. Per instance: `STRATUM_TELEMETRY_DISABLED = "true"` in each env's `[vars]`, or leave `POSTHOG_API_KEY` unset |
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
| **Your webhook evaluator endpoint** | A `webhook` evaluator in `.stratum/policy.yaml` | The diff, the policy (signing secrets stripped), and `baseSha`. See [CI Integration](/guides/ci-integration/#the-webhook-evaluator-contract) |
| **Your outbound webhook URLs** | A project webhook subscription | Event payloads for that project |
| **Cloudflare (your account) or Vercel** | A `deploys:` entry in the policy | The merged tree, uploaded with the project's own credentials. See [Deployments](/guides/deployments/) |
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
| Webhook *evaluator* `secret` | A literal in `.stratum/policy.yaml` — visible to every reader of the repository (see [CI Integration](/guides/ci-integration/#the-webhook-evaluator-contract)) | — |

Repository contents, issue and comment text, email addresses, and the rest of
the relational data have no application-level encryption; they rely on
Cloudflare's storage encryption.

Whether `BACKUP_ENCRYPTION_SECRET` is set on the hosted instance is not visible
from the repository (secrets are set out of band with `wrangler secret put`); the
backup runbook requires it in production.

## Backups and retention

### Backups

The backup subsystem (`src/backup/`, documented in
[`docs/runbooks/backup-restore.md`](https://github.com/stratum-eng/stratum/blob/main/docs/runbooks/backup-restore.md)) writes to
the `BACKUPS` R2 bucket:

- **When:** daily from its own cron, `0 4 * * *` (UTC), in production, plus on
  demand through an admin endpoint. Staging has no backup cron.
- **What:** one NDJSON dump per D1 table, the project and workspace registry
  records from KV, and a Git pack of the reachable history of **project**
  repositories. Each run snapshots at most `MAX_REPOS_PER_RUN` (default 25)
  projects, taking the projects least recently attempted first. A repository
  over `MAX_BACKUP_BYTES` (default 128 MiB) is skipped. A skipped or failed
  repository still counts as attempted and moves to the back of the rotation.
- **Not backed up: workspace repositories.** The repo pass iterates projects
  only (`listProjects` in `src/backup/run-backup.ts`). Workspace forks, which
  hold unmerged work, are not snapshotted. Their KV registry records are backed
  up, but their Git contents are not. Commits that have not been merged into the
  project are not in any backup.
- **Retention:** the newest `BACKUP_RETENTION` runs (default **14**) are kept,
  and older runs are pruned by the backup job itself. On-demand runs count
  toward this number the same way scheduled runs do. A run counts once its
  `_manifest.json` is written, which means only that the run finished, **not
  that it is restorable**. A run where a table, the KV export or a repository
  failed still writes its manifest with `healthy: false` and still takes a
  slot, so a stretch of failed runs can prune the last good one (#401). Before
  relying on a run, check `healthy` in its manifest or the `backup.run` audit
  entry, and alert on unhealthy runs. Neither that nor the restore plan's
  `restorable` result proves that a given repository has a pack: `healthy`
  ignores repositories skipped for exceeding `MAX_BACKUP_BYTES` (they are
  listed under `repos.skipped` in the run manifest), and `restorable` is
  computed for the whole run and checks only repositories that wrote a
  manifest. To confirm one repository, look for its pack in a retained run.

**Retention has to cover the rotation, or some repositories have no backup.**
Each run stores packs only for the projects in that run's slice. With `P`
projects, a project's most recent pack is up to `ceil(P / MAX_REPOS_PER_RUN)`
runs old, and only the last `BACKUP_RETENTION` runs survive pruning. With the
defaults (25 per run, 14 runs), the retained runs hold at most 14 × 25 = **350**
distinct projects:

- **Up to 350 projects:** every project that snapshotted successfully has at
  least one retained pack. That pack can be up to `ceil(P / 25)` daily runs old,
  so a repository restore can lose up to that many days of merged history.
  Example: 300 projects give a 12-run rotation, so the worst case is about 12
  days.
- **Over 350 projects:** some projects have no Git pack in any retained run at
  any given time. Their pack was pruned before the rotation came back around to
  them.

Operators should keep `BACKUP_RETENTION ≥ ceil(P / MAX_REPOS_PER_RUN)`, with
margin for growth and for skipped or failed repositories, which never produce a
pack. Two settings can change: raise `MAX_REPOS_PER_RUN`, which shortens the
rotation and the restore-point age but is bounded by the backup invocation's
roughly 15-minute budget, or raise `BACKUP_RETENTION`, which costs R2 storage.
The code does not check this inequality or warn when it fails.
- **Not in any backup:** `DEPLOY_SECRET_KEY` and the other Wrangler secrets. The
  `project_secrets` rows are backed up as ciphertext only.
- **Restore** has a documented, tested path in the runbook.

### Retention of live data

| Data | Retention |
|------|-----------|
| Accounts, projects, repositories, changes, issues | Until deleted by the user or owner |
| Account deletion (`DELETE /api/users/me`) | Deletes the account and its owned projects (including their Artifacts repositories), revokes tokens and sessions, and anonymizes contributions to other people's projects. See [Users API](/reference/endpoints/#delete-account) |
| Import job records | Pruned after 30 days by the daily housekeeping cron |
| Workspaces | Swept by the daily TTL sweep when they expire |
| Rate-limit counters, OAuth state, caches in KV | Short KV TTLs (minutes to a day) |
| Workers Logs | Cloudflare's retention for the account's plan; not configured by Stratum |
| PostHog events | PostHog's retention for the project. Opting out stops future events; it does not delete past ones |

**Deletion does not reach backups.** A deleted account or project remains in
backups until those runs age out of `BACKUP_RETENTION` (about two weeks with the
defaults, sooner if extra on-demand runs are taken). It also does not delete
PostHog events or log lines already written.

## Data residency

### What the hosted instance configures today

**No jurisdiction is configured for any resource.** `wrangler.toml` sets no
`jurisdiction` on any binding, no location hint, and no
[Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/),
and no code calls `.jurisdiction()` on a Durable Object namespace. Concretely, as
reported by the Cloudflare API on 2026-11-02:

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

Per Cloudflare's documentation as of this writing — check the linked pages for
current status, because these features change:

| Primitive | Strong guarantee available | Best-effort only | Notes |
|-----------|----------------------------|------------------|-------|
| D1 | [Jurisdiction](https://developers.cloudflare.com/d1/configuration/data-location/) `eu`, `us`, `fedramp` | Location hints (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`) | Set at creation only; cannot be changed later |
| R2 | [Jurisdiction](https://developers.cloudflare.com/r2/reference/data-location/) `eu`, `us`, `fedramp` | Location hints | Set at bucket creation; the Worker binding must name the jurisdiction |
| Artifacts | [Namespace jurisdiction](https://developers.cloudflare.com/artifacts/guides/data-localization/) `eu`, `us` | — | Set at namespace creation; applies to every repo in it |
| Durable Objects | [Jurisdiction](https://developers.cloudflare.com/durable-objects/reference/data-location/) `eu`, `us`, `fedramp` via `namespace.jurisdiction()` | Location hints | A code change in Stratum, not configuration; object ids are still logged outside the jurisdiction |
| Workers KV | [Jurisdiction](https://developers.cloudflare.com/kv/reference/data-location/) controls where data is *durably stored* | — | Values can still be cached outside the jurisdiction |
| Worker execution, TLS termination | [Regional Services](https://developers.cloudflare.com/data-localization/how-to/workers/), part of the Data Localization Suite (Enterprise). It applies **only to HTTP requests on the Worker's custom domain** | — | It does not cover the `*.workers.dev` hostname, Queue consumers, Cron Triggers, or outgoing subrequests, and Worker code and secrets are still deployed globally. See the next section |

### What an EU-only self-hosted deployment would take

None of this is done or tested; it is the list of what would have to be true.

1. Create the D1 database, R2 bucket(s), KV namespace, and Artifacts namespace
   with `jurisdiction: eu` — all four are creation-time settings, so an
   existing instance would need a migration, not a config change.
2. Add `jurisdiction = "eu"` to each `[[r2_buckets]]` binding.
3. Change the Durable Object call sites to go through
   `namespace.jurisdiction("eu")` — this is a code change in Stratum.
4. Disable or relocate everything outside Cloudflare: leave PostHog unset (or
   point `POSTHOG_HOST` at PostHog's EU cloud), keep `LLM_PROVIDERS` to
   providers with suitable terms, and decide about Google Fonts.
5. If request processing must also stay in-region, the storage steps above
   are not enough. See the next section: Regional Services covers only part of
   Stratum's execution.

### Why Regional Services alone does not make processing EU-only

According to [Cloudflare's Workers data-localization page](https://developers.cloudflare.com/data-localization/how-to/workers/),
Regional Services applies to the custom domain configured for a Worker. It
**does not apply to Queues or Cron Triggers**, it does not extend to outgoing
subrequests, and Worker code and secrets are deployed to every data center even
when execution is regionalized. Stratum's production configuration has
execution paths in every one of those categories:

| Execution path | In production `wrangler.toml` | Covered by Regional Services on the custom domain? | What EU-only processing would need |
|----------------|-------------------------------|----------------------------------------------------|------------------------------------|
| HTTP on `app.usestratum.dev` | `routes = [{ pattern = "app.usestratum.dev", custom_domain = true }]` | Yes, if configured for that hostname | Regional Services set to an EU region on the hostname |
| HTTP on `*.workers.dev` | `workers_dev = true` (kept for deploy smoke tests) | **No** | `workers_dev = false`, with the smoke tests moved to the custom domain. Otherwise the same API is reachable unregionalized |
| Queue consumers | `stratum-events`, `stratum-imports`, `stratum-deploys`, which handle event delivery, imports and syncs, and post-merge deploys | **No** | Cloudflare documents no regional control for consumer execution. The data these consumers touch must be protected by storage jurisdictions, and the consumers themselves should be treated as running anywhere |
| Cron Triggers | `0 4 * * *` (backup), `0 6 * * *` (housekeeping, sync), `*/5 * * * *` (outbox and import sweeps) | **No** | Same as Queues: no documented regional control. The backup cron reads every D1 table and every project repository, so it processes the full dataset wherever it runs |
| Durable Objects | Four classes, no jurisdiction | Not by Regional Services | `namespace.jurisdiction("eu")` at every call site, which is a code change |
| Outbound subrequests | OAuth, PostHog, BYOK LLM providers, deploy targets, webhooks, Git hosts | **No** | Choose EU-hosted endpoints, or disable each one |
| Workers AI | `[ai]` binding for the `llm` evaluator | Not documented as covered | Unverified. Treat inference as running outside the region, or do not use the `llm` evaluator |

So a deployment can keep its **stored** data in the EU with jurisdictions,
and keep its **custom-domain request handling** in the EU with Regional
Services. With today's Cloudflare features and Stratum's design, it cannot
guarantee that **every computation** over that data happens in the EU, because
background work runs on queues and crons. Anyone making an EU-only processing
claim would need Cloudflare to confirm regional execution for those triggers,
or would need Stratum to move that work onto primitives that support it.

## Compliance status

Stated plainly:

- **No SOC 2 report, no ISO 27001 certification**, and no other third-party
  attestation exists for Stratum.
- **No Data Processing Agreement (DPA) template** is published, and there is no
  published subprocessor-change notification process.
- **No SLA** for availability, support response, or breach notification. The
  only published commitment is the vulnerability-report acknowledgement window in
  [`SECURITY.md`](https://github.com/stratum-eng/stratum/blob/main/SECURITY.md).
- Cloudflare's and PostHog's own certifications cover their platforms; they do
  not extend to Stratum's application code or operations.

What exists today, and can be pointed to in a review:

- The source code is public ([AGPL-3.0-or-later](https://github.com/stratum-eng/stratum/blob/main/LICENSING.md)), so every
  claim on this page can be checked against the implementation.
- Private vulnerability reporting through GitHub Security Advisories.
- An audit log of sensitive operations (sessions, token and agent lifecycle,
  webhooks, and similar — `src/storage/audit.ts`), documented account erasure,
  and a tested backup and restore runbook.
- A threat model for the sandbox evaluator
  ([ADR 007](https://github.com/stratum-eng/stratum/blob/main/docs/adr/007-sandbox-evaluator-threat-model.md)) and for BYOK LLM
  providers ([ADR 008](https://github.com/stratum-eng/stratum/blob/main/docs/adr/008-llm-provider-byok-threat-model.md)).
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
- **Technical prerequisites that are code changes:** an EU-jurisdiction
  deployment path (above), backup purge on account deletion or a documented
  maximum, self-hosted fonts, and a published log-retention setting.

## See also

- [`SECURITY.md`](https://github.com/stratum-eng/stratum/blob/main/SECURITY.md) — reporting a vulnerability
- [FAQ: Can I turn off telemetry?](/guides/faq/#can-i-turn-off-telemetry) — the exhaustive telemetry event list
- [`docs/runbooks/backup-restore.md`](https://github.com/stratum-eng/stratum/blob/main/docs/runbooks/backup-restore.md) — backup contents, encryption, and restore
- [Deployments](/guides/deployments/) — the project secret store and `DEPLOY_SECRET_KEY`
- [`docs/developer/architecture.md`](https://github.com/stratum-eng/stratum/blob/main/docs/developer/architecture.md) — the full technical architecture
