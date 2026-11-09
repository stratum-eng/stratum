# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-09

### Breaking
- **Stratum is no longer MIT-licensed.** The server, the web UI, `docs/`, and the
  `website/` sources are now **AGPL-3.0-or-later**; the `@stratum-eng/cli` and `@stratum-eng/agent` packages are
  **Apache-2.0**, chosen over MIT for its express patent grant. Everything
  released through v0.2.0 stays MIT and always will — anyone holding that code
  keeps their MIT rights in it, forks included. The new terms apply from this
  commit forward. [`LICENSING.md`](LICENSING.md) is the authoritative account.

  The split follows the line that matters to a user: what you run *as a service*
  is copyleft, what you run *inside your own pipeline* is not. A CLI invoked from
  your CI, or the reference agent forked into your automation, should never raise
  a question about the license of the code it operates on.

  **What this changes for you if you self-host:** running an unmodified Stratum,
  nothing at all. If you modify it and other people reach your instance over a
  network, AGPL §13 asks you to offer them that version's source — point the new
  `STRATUM_SOURCE_URL` constant in `src/version.ts` at the repository holding
  your changes and the page footer carries the offer. Nothing in the license
  reaches the repositories Stratum hosts, the changes it evaluates, your policy
  file, or anything that speaks to the REST API, the CLI, or `/mcp`. Commercial
  use, including running Stratum as a paid service, remains permitted.

  One carve-out: the agent skill files published under
  `website/public/.well-known/agent-skills/` stay **MIT**. They exist to be
  fetched and pasted into other people's agents, they contain no
  implementation, and copyleft on a discovery artifact would discourage exactly
  the copying they are published for.

  Contributions now carry a [CLA](CLA.md), confirmed by a checkbox in the pull
  request template. Contributors keep their copyright; the agreement adds the
  right to license contributions under other terms, without which no commercial
  license for Stratum could exist. Contributions merged before this change were
  made under MIT and stay that way.
- **The sandbox evaluator no longer runs npm lifecycle scripts.** Dependency installs now pass
  `--ignore-scripts`, because the evaluated tree is untrusted and a `preinstall`/`postinstall`
  would otherwise execute before any human review. Projects whose build genuinely needs them
  (native modules, a `prepare` step) opt back in with `allowInstallScripts: true` on the
  `sandbox` evaluator in `.stratum/policy.yaml`. Note the usual symptom is *not* a failing
  install: a native module installs unbuilt and then fails when the test command loads it.
- **The default sandbox install timeout drops from 120s to 90s**, so the per-phase defaults sum
  to exactly the new total budget and an unconfigured project is never truncated.
- Re-evaluating an existing change (`POST /changes/:id/evaluate`) runs under the new default, so
  a change that passed before this release may fail on re-evaluation.
- **Evaluation runs off the request path.** On an instance with the new evaluation
  queue (the hosted one has it), `POST /api/projects/{name}/changes` answers `202`
  with the change in a new `evaluating` status and no verdict, and
  `POST /api/changes/{id}/evaluate` re-enqueues and answers `202` the same way.
  Poll `GET /api/changes/{id}` until the status becomes `accepted` or
  `needs_changes`. API clients that read `eval` from the creation response must
  handle its absence. Without the queue, or if enqueueing fails, evaluation runs
  inline and the responses are unchanged (`201` / `200` with the verdict). The UI
  shows `evaluating` with a Refresh link (it reloads itself only for signed-out
  viewers, so a draft comment is never lost); the MCP tools and the CLI and
  reference agent understand it too (`stratum change create --wait`).
- **A change still `evaluating` cannot be merged**, even with `force` — the merge
  answers `409 EVALUATION_PENDING`. Nor can one whose evaluation ended without a
  verdict (`409 EVALUATION_MISSING`); re-evaluate it first. Once the verdict is
  recorded, merge protection behaves exactly as before.
- **Approvals wait for the verdict.** `approve` on an `evaluating` change answers
  `409 EVALUATION_PENDING`, and an approval is recorded only if the change is
  still as the reviewer loaded it — otherwise `409 REVIEW_STALE`. A
  `request_changes` made while evaluation is pending is kept: the change lands on
  `needs_changes` even if the evaluation passes.
- **Promoting during a re-evaluation** answers `409 EVALUATION_PENDING`; the
  GitHub PR is still opened and linked, and promoting again re-pushes to it.

### Added
- **Browser analytics, opt-in and redacted.** `app.usestratum.dev` and the docs
  site sent no browser events at all, so pageviews, autocaptured interactions
  and rageclicks were invisible and the docs-to-signup funnel could not be
  measured. Setting the new `POSTHOG_PUBLIC_KEY` var enables PostHog's SDK in
  the browser; the docs site reads the same variable at build time. Core Web
  Vitals and dead-click tracking are **not** included: posthog-js implements
  both in chunks it downloads at runtime, and those downloads are blocked so
  that the only script a user receives is the pinned one served from your own
  origin. It is a **separate switch from `POSTHOG_API_KEY`** on
  purpose: enabling server-side telemetry has never meant running third-party
  JavaScript in your users' browsers or sending their IP addresses anywhere,
  and it still does not. Unset, no analytics script is served to anyone.
  The same promise the server makes is kept in the browser: URLs are rewritten
  to route patterns, page titles and referrers are dropped, clicked-element
  text and attributes are masked, unrecognised properties are dropped rather
  than forwarded, Do Not Track and Global Privacy Control are respected, and
  session replay is not shipped. No feature-flag request is made either: that
  call is not a captured event, so the redaction cannot reach it, and PostHog
  builds its body from stored properties that include the first URL of the
  session. The SDK is version-pinned and served from your
  own origin through `/_ph/*`, which keeps it under your Content-Security-Policy
  and stops content blockers biasing the numbers. `docs/user-guide/faq.md`
  documents every browser event and every guarantee, and a test fails the build
  if that list and the code disagree.

- **`ui_click` names the control that was clicked.** Masking element text and
  attributes is what keeps repository and file names out of autocaptured
  events, and it also leaves `$autocapture` able to say a button was clicked
  but never which one. Navigation and the main actions now carry a `data-ph`
  attribute — `nav-settings`, `project-tab-deployments` — whose value is a
  literal in Stratum's own source; `ui_click` reports that value in `element`
  and nothing else, and any value that is not a plain `[a-z][a-z0-9-]*` token
  is dropped in the browser, so a name built from a repository or file name
  cannot be reported even by mistake. It is the one browser event Stratum sends
  itself rather than configuring PostHog to send.
- **Every response offers its own source.** A footer carrying the running
  version, the license, and a link to the source now renders in the shared
  layout and on every standalone document — sign-in, sign-up, OAuth consent, the
  magic-link verify page, and the webhook-created page — because an offer only a
  signed-in user could see is not the one AGPL §13 asks of an operator running a
  modified instance. For callers who never receive HTML at all, every response
  also carries `Link: …; rel="license"` and `X-Source-Code` headers, so an agent
  driving Stratum over `/mcp` or the REST API is offered the source too — set
  both before and after the handler runs, because a handler returning a raw
  `Response` (as `/mcp` does on its main paths) replaces the context response
  and does not inherit buffered headers. Git smart-HTTP responses are left
  untouched. Self-hosters running modifications
  repoint `STRATUM_SOURCE_URL` in `src/version.ts`; there is nothing else to
  configure.
- **Stratum can deploy a merged change.** A new `deploys:` block in
  `.stratum/policy.yaml` names one or more deploys, each with a `target`
  (`cloudflare-pages`, `cloudflare-workers`, or `vercel`), an optional `dir` to
  publish, the `secrets` it needs, and an optional `requiresApproval` gate.
  After a change merges *and* the post-merge check declines to revert it, the
  merged tree is read at the pinned merge commit — configuration and code are
  therefore provably the same commit — and published to the provider. Every
  attempt is a row you can see: status, reason, provider URL, duration, and (for
  project writers) a redacted log tail, on a new deployments page and at
  `GET /api/projects/{namespace}/{slug}/deployments`. `deployment.requested`,
  `deployment.succeeded` and `deployment.failed` are subscribable from a project
  webhook.

  Credentials live in a new **per-project secret store**, encrypted with AES-GCM
  under a `DEPLOY_SECRET_KEY` the instance holds as a Wrangler secret, with the
  project id and secret name bound as additional authenticated data. There is no
  read path: no API, UI, or CLI surface returns a stored value, and only the
  deploy runner decrypts one. Managing secrets requires a project admin who is
  **not** an agent — an agent token is refused on every secret route even when
  its owner owns the project, because a deploy credential is the one thing an
  agent identity is never trusted with. Approving a gated deployment likewise
  refuses agent identities; as with a human review verdict, that means "not an
  agent", not "a human at a keyboard" — a user's scoped API token and MCP OAuth
  grants are accepted. A finished deployment can be retried as a new attempt,
  which carries the originating change id so a change reverted in the meantime
  is still refused.

  The honest boundaries, documented rather than buried: **there is no build
  step** — v1 publishes the tree exactly as committed, so commit your built
  output or use the `vercel` target, which builds the uploaded source remotely.
  There are no preview deploys of unmerged changes, no rollback (retrying an
  earlier successful deployment is the recovery path), and no Netlify support. A
  `vercel` deployment recorded as `succeeded` means **accepted for build**:
  Vercel builds asynchronously and Stratum deliberately does not poll it. The
  `cloudflare-pages` target is implemented against Workers Static Assets rather
  than Pages Direct Upload, whose asset endpoints are absent from Cloudflare's
  public API reference. Without the optional `CLOUDFLARE_WORKERS_SUBDOMAIN`
  secret a Cloudflare deploy succeeds with no URL. And a project that only wants
  deploys must still write an `evaluators:` block, because a policy file without
  one is malformed and blocks every merge. Limits (16 `deploys:` entries per
  policy file, 2,000 files, 25 MiB total, 10 MiB per file) are enforced before
  the first provider request, so a deploy never publishes half a tree. Full reference:
  [Deployments](docs/user-guide/deployments.md).
- **`stratum login` signs you in through the browser.** The CLI had one way to
  authenticate — `--key`, with a token you first created by hand in the settings
  UI and pasted into a terminal. It now runs the OAuth 2.1 authorization-code
  flow that native apps use (RFC 8252): it registers itself as a public client,
  proves possession of the code with PKCE, and receives the redirect on a
  loopback listener bound to an ephemeral port on `127.0.0.1`. There is no token
  to create and none to paste, and the grant appears under **Settings →
  Connected applications** alongside your editors, revocable like any other.
  This uses the authorization server Stratum already ran for MCP clients; no
  server-side change was needed. `--read-only` requests a read-only session, and
  the **granted** scope (not the requested one) is printed at login and by
  `stratum status`, so a narrowed grant is visible immediately rather than at the
  first write. Sessions renew themselves silently.
- **`stratum logout`.** Revokes the session with the host, then clears the local
  credential — and still clears it locally when the host cannot be reached.
  Revocation is reported as delivered, never as confirmed: RFC 7009 §2.2 has the
  server answer `200` whether or not anything matched.

- **Display name and username editing on Settings.** The Account section now
  has a display name (free-form, shown in the header instead of the username,
  changeable any time) and, while the account owns no projects, a username
  form. The username is the namespace every project URL, clone URL and backing
  repository is keyed under, so while any project exists it is fixed and the
  page says so instead of offering a form; the signup forms now say the same.
  Migration `045_user_display_name.sql` adds the column, and
  `046_namespace_claims.sql` adds the D1 table that records each project's
  namespace before its entry is written, so a rename and a project creation
  that cross cannot both go through; a record is trusted for 15 minutes, so
  the username form can take that long to reappear after the last project is
  deleted.
- **Browsers now report Content Security Policy violations to the server.**
  Every page's policy names `/csp-report` (via `report-to` and, for browsers
  without the Reporting API, `report-uri`), and the Worker logs each report at
  warn with the blocked URL, the directive and the user agent. Query strings
  are stripped before logging. A CSP block happens entirely in the browser, so
  until now the server could not see one: the MCP consent redirect that Chrome
  refused for every user showed up in the logs as a healthy flow. It would now
  show up as a warning within seconds of the first click.
- **MCP connections leave a readable trail in the logs.** The consent screen
  being shown, the authorization code being issued, and the tokens being
  issued share a short code id, so a code that was minted and never redeemed
  is one log query away. A five-minute sweep deletes expired authorization
  codes (nothing removed them before) and logs a warning naming the clients
  when any expired unredeemed, which is the signature of consent succeeding
  and delivery failing. The MCP endpoint logs the `initialize` handshake at
  info with the client's self-reported name and version, and any tool call
  that ran and failed at warn with the tool name and the error the model was
  shown; both were previously debug lines the default level dropped.
- **Signing up with GitHub or Google now asks you to choose a username.** The
  callbacks used to mint the account on the spot, naming it after the GitHub
  handle or the email's local part — and a username is the namespace every
  project URL, clone URL, and backing repository is keyed on, so it cannot be
  changed afterwards. A first-time identity is now parked (verified email and,
  for GitHub, the account to link; fifteen minutes, in KV, bound to an httpOnly
  cookie) and lands on `/auth/signup/complete` to pick a name, with the handle
  prefilled as a suggestion and live availability feedback. Nothing is written
  until the form comes back; signing in to an existing account is unchanged.
  The same page collects an invite code while the closed beta is on, so OAuth
  signup is no longer refused under the gate — it presents a code like the
  magic-link form does, and is admitted (codes minted, emailed) the same way.
- **Invite codes you can actually find.** Settings, under Account, shows your
  account identity — username, email, member since, and any linked GitHub
  account — plus the invite codes issued to your account, each with a share
  link and whether it has been redeemed. (This first shipped as a separate
  `/profile` page, since folded into Settings; the URL redirects.) Codes
  previously existed only in the one email sent at signup, which
  is best-effort and skipped entirely when the instance has no email binding
  configured, so a lost or never-sent email meant unreachable codes; they can now
  be read back from the referral service on demand. The listing keys off
  `REFERRAL_SERVICE_URL` alone rather than `BETA_GATE`, so codes minted while the
  gate was on stay visible to their owners after signups reopen, and an
  unreachable service reports itself as such instead of rendering as "you have no
  codes". Requires the referral service to serve
  `GET /api/referral/codes?userId=…` (contract in `wrangler.toml`). On an
  instance with no referral service — every ungated self-hosted deployment — the
  page still renders its account details, just without the invite section. Like
  `/settings`, it is session-only: an API token cannot enumerate your codes.
- **The MCP server is now remote, served by the Worker at `/mcp`.** Streamable
  HTTP, stateless — no session id, no Durable Object, so any isolate answers any
  request. Connecting a client is a URL (`claude mcp add --transport http
  stratum https://…/mcp`) instead of a clone, a build, and a hand-copied token.
  All eighteen tools are unchanged in name and behaviour; they now run against
  the real API route handlers in-process (`src/mcp/dispatch.ts`) rather than
  over the network, so every authorization check, evaluation gate and refusal is
  the REST API's own rather than a reimplementation of it. Accepts the two
  older protocol revisions alongside `2025-06-18`, and handles JSON-RPC batches
  for the revisions that allow them.
- **Stratum is now an OAuth 2.1 authorization server**, for `/mcp`. Dynamic
  client registration (RFC 7591) at `/oauth/register`, mandatory PKCE with
  `S256` only, 60-second single-use authorization codes, one-hour access tokens,
  rotating 30-day refresh tokens capped at an absolute 180-day grant lifetime,
  RFC 7009 revocation, and RFC 8414/9728 discovery documents built from the
  request origin so a self-hosted instance advertises itself with nothing to
  configure. An editor is connected with a browser consent screen; no Stratum
  credential is ever pasted into a client config.

  Reuse of a spent credential is treated as a compromise signal on both halves
  of the flow, per OAuth 2.1 §4.3.1 and RFC 9700 §4.14: a replayed
  authorization code and a replayed (already-rotated) refresh token each revoke
  every token the grant produced. A redemption that merely *fails validation* —
  wrong client, wrong verifier, wrong redirect URI — leaves the code untouched,
  so observing one is not enough to disrupt the rightful client.
- **Connected applications in settings.** Every authorized MCP client is listed
  with its self-declared name, client id, granted access and last use, and can
  be disconnected in one click — which revokes the access token and the ability
  to refresh at once.
- **`stratum_mcp_` access tokens are a first-class credential kind** in
  `authMiddleware`, resolved on every request like user and agent tokens, with
  `mcp:write` mapping to `read_write` and anything else to `read`. Two refusals
  are specific to a delegated credential and enforced before routing: an OAuth
  grant cannot reach `/api/admin/*` (even for the instance administrator, whom
  `resolveAdminAuth` would otherwise authorize on an `ADMIN_EMAIL` match), and
  cannot rotate the never-expiring legacy API key.
- **CLI and MCP server guides.** Dedicated documentation for `@stratum-eng/cli`
  (`docs/user-guide/cli.md`) and the MCP server (`docs/user-guide/mcp.md`),
  published at `/guides/cli/` and `/guides/mcp/` — configuration, the full
  command/tool surface (including `project delete` and `account delete`, which
  the package README omitted), the commit path's 2,000-file/25 MB caps and its
  inability to express deletions, and exactly which MCP tools an agent token
  can use. Also corrects the `stratum_review_change` tool description, which
  claimed agents can submit `request_changes` verdicts: the server refuses
  every review verdict from an agent token (`src/routes/reviews.ts` requires a
  user), so an agent's feedback channel is change comments.
- **Enterprise single sign-on (OIDC) per organization.** An org admin or owner
  configures one OIDC connection with `PUT /api/orgs/{slug}/sso`, proves ownership
  of its email domains with a DNS TXT record, and enables it. Members then sign in
  at `/auth/sso` with the org slug or their work email (authorization code + PKCE);
  first-time users on a verified domain are provisioned into the org. Requires the
  `SSO_ENCRYPTION_SECRET` secret; the SSO endpoints answer `501` without it. SSO
  does not yet lock out the other sign-in methods.
- **SCIM 2.0 user provisioning at `/scim/v2`.** Each SSO connection gets its own
  `stratum_scim_*` bearer token. Identity providers can create, adopt, update, and
  deactivate users. Deactivation is reversible: it disables every credential the
  account holds and deletes its browser sessions. Reactivation restores the
  account's tokens, agents, and OAuth grants; the user signs in again for a new
  session. SCIM Groups are not implemented.
- **Organization audit log.** Org admins and owners can read their org's audit
  trail at `GET /api/orgs/{slug}/audit` (filter by action, actor, and time
  range; cursor-paginated) and download it as NDJSON at
  `GET /api/orgs/{slug}/audit/export` for windows of up to 90 days. Events about
  the org, its SSO/SCIM configuration, and projects it owns are scoped to it;
  plain members get `403` and non-members `404`. Events recorded before this
  release are not attributed to an org and stay in the instance-wide view.
- **More events are audited:** org creation, members added and removed, member
  role changes, teams created and deleted, and team membership changes.
- **Failed authentication is audited** when the attempt identifies a real
  account or org: a revoked or expired API token or MCP OAuth token, a token or
  agent whose account is disabled or being deleted, a reused or expired magic
  link, and SSO callbacks refused after reaching an org's connection. Unknown
  credentials are not recorded, and repeats for the same credential or account
  are collapsed to one entry per minute.
- **Passkeys as a second factor.** Add a passkey (WebAuthn: Touch ID, Windows
  Hello, a password manager, or a security key) at **Settings → Security**. After
  that, signing in with a magic link, GitHub, Google, or SSO also asks for the
  passkey before the session starts. Your first passkey comes with ten one-time
  recovery codes, shown once, so a lost device does not lock you out. Passkeys can
  be renamed and removed. Managing them requires a recent sign-in. The JSON API is
  at `/api/users/me/passkeys`.
- **Organizations can require a second factor.** An org admin sets
  `PUT /api/orgs/{slug}/security` `{"requireSecondFactor": true}`. A member's
  session that has not passed a second factor then gets
  `403 SECOND_FACTOR_REQUIRED` on **that org's** projects and org endpoints, with
  a link to set up a passkey. Members' personal projects, other organizations,
  and account settings are never affected. A session that signed in through the
  org's own SSO satisfies that org's requirement (the IdP's MFA is trusted).
- **Members can leave an organization.** `DELETE /api/orgs/{slug}/members/{own
  id}` works for any member, including when the org's policy blocks them. The
  owner cannot leave.
- New audit events: `passkey.registered`, `passkey.renamed`, `passkey.removed`,
  `second_factor.succeeded`, `recovery_code.used`, `recovery_codes.regenerated`,
  and `org.second_factor_policy_changed` (in the org's audit log). A failed
  second factor is recorded as `auth.failed` (method `passkey` or
  `recovery_code`), with the same once-a-minute deduplication as other failed
  sign-ins.
- Optional `APP_URL` setting binds passkeys to one origin on instances reachable
  under more than one hostname.
- **Trust and data-residency page.** It documents Stratum's architecture, the
  subprocessors it uses, where data is stored (no jurisdiction is set today), what
  is encrypted, and how backups are retained. It states plainly that there is no
  SOC 2, ISO, DPA or SLA yet. See `docs.usestratum.dev/guides/trust/`.
- **Guide: running a webhook-evaluator executor safely.** It covers process and
  filesystem isolation for each evaluation, time and size limits that fit inside
  the evaluator timeout, keeping credentials out of reach of the code under
  evaluation, git-specific hazards, and reference setups. See
  `docs.usestratum.dev/guides/webhook-executor/`.
- **A webhook's signing secret can now be regenerated in place.** The webhooks page has a
  "Regenerate secret" button on each webhook (with a confirm), backed by
  `POST /api/projects/{namespace}/{slug}/webhooks/{id}/regenerate-secret`. The new secret
  is shown once, exactly as on creation, and the webhook keeps its id, configuration and
  delivery history — previously a lost secret meant deleting and recreating the webhook.
  The old secret stops working immediately, so update your receivers with the new one.
  Each regeneration is recorded in the audit log as `webhook.secret_rotated`.
- **API tokens can be limited to one project or one organization.** When
  creating a token (Settings → API tokens, or `POST /api/users/me/tokens` with
  `project: "@owner/repo"` or `org: "slug"`), you can bind it to a single
  project, or to the projects an organization owns. A bound token answers every
  other project — public ones included — exactly as if it did not exist, over
  the API, MCP, and git alike, and it cannot reach account-level endpoints
  (usage, token and agent creation, organization administration, bulk import,
  the admin API, the web UI), which refuse it with `403
  TOKEN_BINDING_EXCLUDES_ROUTE`. A project-bound token cannot create projects;
  an organization-bound one can only create them in its organization. Binding is
  independent of the read/write scope, and existing tokens are unchanged:
  without a binding a token stays account-wide. The settings token list now
  shows what each token can reach. Requires migration 057.
- **`changelog.d/` fragment files replace direct `## [Unreleased]` edits.** Every PR
  that needs a changelog entry now adds one new file under `changelog.d/` instead of
  editing the shared `Unreleased` section — the single most frequent source of PR
  merge conflicts in this repo. `npm run release:prepare` folds every fragment into
  `Unreleased` (inferring the version bump from their groups, same as before) before
  cutting the release, then deletes the fragments it consumed. `npm run release:check`
  validates fragment structure too, and now also rejects an `Unreleased` entry written
  above the first `### Group` heading, which would otherwise be dropped from the cut
  release without a word. Existing `Unreleased` content and already-open PRs that still
  edit it directly keep working unchanged, so long as each entry sits under a group —
  fragments are an additional source folded in at release time, not a forced migration.
  See `changelog.d/README.md`.
- **Bring your own model for the merge gate.** The `llm` evaluator has only ever
  been able to call the instance's Workers AI binding, so the reviewer model was
  the operator's choice and the tokens were the operator's bill. A project can
  now run that gate on its own account: the operator lists named providers in a
  new `LLM_PROVIDERS` variable (`anthropic`, or anything OpenAI-compatible), the
  project stores its key in the same encrypted per-project secret store deploys
  already use, and `.stratum/policy.yaml` names the provider it wants:

  ```yaml
  evaluators:
    - type: llm
      provider: anthropic
      model: claude-sonnet-4-5
      threshold: 0.7
  ```

  Self-hosting, this is yours to configure and costs you nothing to ignore:
  with `LLM_PROVIDERS` unset — the default — the binding is the only option and
  every path below is inert.

  Three things are worth knowing before you switch. **A policy may never name a
  URL**, only select a provider the operator configured, because a base URL
  chosen by repository content turns the Worker into a request-forgery
  primitive pointed at a host of the author's choosing — the `llm` entry is a
  whitelist of `provider`, `model`, `threshold` and `maxDiffChars`, and
  `model` is required whenever `provider` is set. **Everything fails closed**:
  an unconfigured provider name, a missing or undecryptable key, an instance
  with no `DEPLOY_SECRET_KEY`, or a provider that answers with a redirect fails
  the gate with a reason saying which, and never quietly falls back to the
  operator's binding. And **any project writer can spend the owner's credit** by
  opening changes; the hourly evaluation ceiling still applies, and your own key
  does not lift it. Rotating `DEPLOY_SECRET_KEY` — already documented as making
  every stored deploy secret undecryptable — now also blocks the gate on BYOK
  projects until each re-enters its key. The threat model is
  `docs/adr/008-llm-provider-byok-threat-model.md`.

- **See what you are spending.** A new `/settings/usage` page shows this
  account's consumption against its allowances for the current period, what is
  left, and when it resets; `GET /api/users/me/usage` and a nineteenth MCP tool,
  `stratum_get_usage`, return the same figures, so an agent that can see 12% of
  its allowance left can batch its changes or ask its human instead of
  discovering the wall by hitting it. Crossing 80% of a meter raises a banner and
  sends one email per crossing. Spend on a project's own provider key is reported
  separately and never counted against an allowance. The billing surface is
  **read-only everywhere** — no endpoint and no tool can raise a limit, buy
  capacity, or store a provider key, for the same reason agent tokens cannot
  submit review verdicts. Self-hosted, the page reads "unlimited" and no banner
  or email is ever sent.

- **Metered allowances — inert unless you connect a billing service.** Stratum
  can now check usage against a plan: an entitlements seam behind
  `BILLING_SERVICE_URL` + `BILLING_SERVICE_SECRET`, a `UsageMeter` Durable Object
  holding the monthly counters and a bucketed sliding `evaluations_per_hour`
  window, and checks at the LLM evaluator, the deploy consumer, the request
  limiter and private-project creation. **With those two variables unset — every
  self-hosted deployment — none of it does anything**: every allowance reads as
  unlimited, the meter binding is never touched, and nothing can be refused. Even
  configured, every decision is observe-only (recorded, then admitted) unless
  `ENTITLEMENTS_ENFORCE=1`. Plan definitions and payment live outside this
  repository. One design note that outlives the billing service: a limit is
  checked against the **person who ran the evaluation**, not the project's owner,
  so an allowance follows you across your own and your organizations' projects,
  and creating another organization does not hand you a fresh one. The one
  exception is an organization whose plan is positively known to pool usage:
  its projects draw on the organization's allowance instead. A private project
  you create in an organization that does not pool counts against your own
  limit; organizations you are merely a member of never do. No backfill is
  needed or possible: nothing before this release recorded who was charged for
  an organization's private project, so those count only toward an organization
  that pools, and personal private projects count as before.
- **Organizations can restrict access to their own networks.** An org admin sets
  `PUT /api/orgs/{slug}/security` `{"ipAllowlist": ["203.0.113.0/24", "2001:db8::/32"]}`
  (IPv4 and IPv6, up to 100 ranges). Requests from outside those ranges then get
  `403 IP_NOT_ALLOWED` on **that org's** projects (including git clone and push,
  and MCP tool calls), on its `/api/orgs/{slug}/` endpoints, and on linking,
  unlinking or moving a GitHub App installation for the org. This applies to
  every credential: sessions, API tokens, agent tokens, and OAuth grants.
  Members' personal projects, other organizations, anonymous reads of public
  projects, the SSO sign-in flow, and SCIM are not affected. An empty list,
  which is the default, means no restriction. Saving a list that excludes your
  own address is refused (`409 IP_ALLOWLIST_SELF_LOCKOUT`) unless you send
  `"allowSelfLockout": true`. See the new "Organization IP allowlists" guide.
- New audit events in the org's audit log: `org.ip_allowlist_changed`, and
  `org.ip_access_denied`, which is sampled to at most one entry per member per
  org every 10 minutes.
- **Import a repository straight into an organization.** `POST /api/projects/@org/repo/import`
  now accepts an organization namespace when you have write access to that organization
  (an org admin, or a member of a team with write permission), and the project is owned by
  the organization, as if it had been created with `"org"`. A read-only member, a
  non-member, or an organization that doesn't exist gets `403`. Retrying, cancelling and
  deleting the import, and manually syncing the project, follow the same rule. A private
  import counts toward the private-project limit just as creating one there does.
- **MCP tools to create and import projects.** `stratum_create_project` and
  `stratum_import_project` (both with an optional `org`) and `stratum_get_import_status`.
- **MCP tools for the rest of the change loop.** `stratum_evaluate_change` re-runs a
  change's gates, `stratum_comment_change` and `stratum_list_change_comments` give agents
  their feedback channel, `stratum_promote_change` opens the GitHub PR,
  `stratum_get_sync_status` and `stratum_sync_project` keep an imported project current,
  and `stratum_list_branches` lists branches.
- **MCP tools for organizations.** `stratum_create_org`, `stratum_list_orgs`,
  `stratum_get_org`, `stratum_add_org_member`, `stratum_remove_org_member`,
  `stratum_create_team`, `stratum_list_teams` and `stratum_add_team_member`. They call the
  same routes as the REST API, so the same people can do the same things. A read-only
  (`mcp:read`) grant can use every list and get tool but none of the tools that change
  anything.
- `GET /api/users/me` now includes the caller's `username`.
- **`stratum_workspace_remote`: push to a workspace from a local checkout over MCP.**
  The new MCP tool (and `POST /api/workspaces/{namespace}/{slug}/workspaces/{name}/remote-credential`
  behind it) returns the workspace's git remote and a short-lived `stratum_git_`
  credential, so an agent can `git push` instead of sending whole files through
  `stratum_commit`, with no long-lived token set up out of band. The credential works
  only for `git fetch` and `git push` on that one workspace, and is refused on the
  project URL, other workspaces, the REST API and `/mcp`. It lasts an hour at most,
  never outlives the credential that minted it, and stops working the moment that
  credential is revoked. Minting needs write access (an `mcp:read` grant is refused)
  and is audited as `workspace_remote.credential_minted`. Requires D1 migration 065.
- **MCP connections can act as an agent, so MCP work has agent provenance.** The
  consent screen now asks who the application connects as: a new agent (the
  default, named after the application, e.g. "Claude Code on my-laptop"), one of
  your existing agents, or you. A connection bound to an agent works as that
  agent, acting for you. Changes it opens show the agent in their provenance and
  in the activity feed, and every agent-token rule applies: no merge, reject,
  review verdict or issue triage. An agent created on the consent screen has no
  token of its own, so disconnecting the application, or the connection reaching
  its 180-day limit, ends the agent's access too. `stratum_whoami`
  (`GET /api/users/me`) reports `actingAs: "agent"` with the agent and its owner,
  or `actingAs: "user"`.
- **Sign up straight from "connect your editor".** When adding Stratum's MCP server
  sends a first-time visitor to sign in, the page now offers **Create an account**,
  and verifying the signup email returns them to the consent screen instead of
  the dashboard. An `invite` parameter on the client's authorization URL pre-fills the
  invite code on instances running the invite gate. A sign-in link requested from
  the same page also returns to the consent screen.
- **`stratum signup` in the CLI.** An agent can sign its human up in one command:
  `stratum signup --email you@example.com --username you [--invite CODE] [--agent-name NAME]`.
  It prints the code the human types on the approval page, waits for them to approve from the
  email, and stores the new agent token the same way `stratum login --key` does. It exits
  non-zero with a clear message when the address already has an account (use `stratum login`),
  the username is taken, the invite code is invalid, or the request expires.
- **`timeoutMs` for the `llm` evaluator** (default 30s, clamped to 1s–120s). A model
  that has not answered by then fails the gate closed with score 0.
- **Every evaluator runs under its own deadline**, so one that hangs fails closed on
  its own and the others still report. A run whose consumer never reports back is
  re-dispatched by the five-minute sweep, and failed closed (`needs_changes`,
  "Evaluation did not complete") after two re-dispatches.
- **Pinned projects in every backup run.** Set `BACKUP_PINNED_PROJECTS` to a
  comma-separated list of `@namespace/slug` projects, and each backup run
  snapshots them in addition to the rotating slice. They do not use up any
  `MAX_REPOS_PER_RUN` slots, and they are never snapshotted twice in one run.
  The run manifest lists them under `repos.pinned`. Malformed entries are
  skipped with a warning, and unknown entries are listed under
  `repos.pinnedMissing`. The backup runbook now also has a quarterly restore
  drill and a drill log.
- **Import a project's GitHub issues into its issue tracker.** Project admins can
  run it from the **Import GitHub issues** card in project settings, or with
  `POST /api/projects/{namespace}/{slug}/issues/import/github`. It copies each
  issue's title, body, state, labels, timestamps and comments, links every
  imported issue and comment back to GitHub, and skips pull requests. Authors
  with a linked Stratum account are attributed to it; others are shown by their
  GitHub login. `#123` references are rewritten to the imported numbers. The
  import runs in the background, waits out GitHub rate limits, and is safe to
  re-run: it updates what it already imported instead of duplicating it, so it
  can catch a project up right before switching over. Public repositories only
  for now. It needs a GitHub credential that may act for the project's owner,
  the same as every other GitHub call: a linked GitHub App installation or an
  operator binding. Requires D1 migration `071_github_issue_import.sql`.
- **Agents can sign their humans up.** `POST /api/agent-signup` takes an email, a username,
  and the agent's name, emails that address an approval link that names the agent, and gives
  the agent a short code to show its human. Following the link and typing the code creates the
  account (same invite gate and username rules as the signup form) and
  signs the person in; the agent, polling `POST /api/agent-signup/poll`, then receives its
  own agent token under the new account. The code is never emailed, so nobody can get an
  account approved for an address that isn't theirs. Nothing is created until approval, an
  address that already has an account is refused rather than attached to, and the send caps
  of the web form apply. Operators can turn it off with `AGENT_SIGNUP_DISABLED=1`.
- **Outbound GitHub calls can authenticate as a GitHub App.** Set `GITHUB_APP_ID` and
  `GITHUB_APP_PRIVATE_KEY` (PKCS#8) and Stratum uses a short-lived installation token for
  project sync, pushing and opening promoted PRs, and evaluation verdict comments and commit
  statuses, instead of one instance-wide personal access token.
- **GitHub App installations are linked to the Stratum account they serve.** A project uses an
  installation only when that installation is linked to the project's owner. Link one from the
  app's setup page (`/github/app/setup`) or `POST /api/github/installations/{id}/link`; only the
  GitHub user who installed the app can link it. An org admin whose session does not meet the
  org's second-factor policy cannot link to, unlink from, or move a link away from that org until
  they sign in with a passkey (`SECOND_FACTOR_REQUIRED`).
- **Each GitHub repository has one canonical Stratum project.** Webhook events reach, and
  promotions and evaluation reports come from, only the first authorized project to act on the
  repository. A project that merely names the repository in its source URL gets neither. A
  promotion from another project answers `409`.
- **Admins can restore a repository from a backup.**
  `POST /api/admin/restore/{runTs}/repos/{projectId}` recreates a project's repository
  from a backup run, and needs `force` to overwrite one that exists. With
  `{ "drill": true }` it restores to a scratch repository, compares every ref with the
  backup, and deletes it, without touching the project's repository. Every attempt is
  audited as `backup.repo_restore`. Database and KV restore have no route yet.

### Fixed
- **`api_request` reported the wrong route for most pages.** `routePath(c, -1)`
  returns the last *registered* route matching a path, not the one that
  answered it, and `uiRouter`'s `/:namespace/:slug` catch-all is mounted last —
  so `/auth/signup`, `/settings`, `/new` and others were all recorded as
  `/:namespace/:slug`. Route breakdowns and the `surface` derived from them
  were correspondingly wrong. Both patterns are source-code literals, so
  nothing private was ever exposed; the data was simply mislabelled. Historical
  events are not corrected.
- **A post-merge deploy cannot be lost or run twice.** Four fixes to the new
  deployment path, all invisible until they bite: the deploy queue ran two
  messages per isolate, and two concurrent Vercel deploys exceeded the isolate's
  memory before a terminal status could be written, stranding rows at `running`
  (`max_concurrency` is now 1); the runner had no deadline, so its storage lease
  could expire mid-upload and let a second consumer publish the same commit (it
  now gives up strictly before the lease can); a queue send that failed silently
  dropped the deploy — after a merge there was no row to recover at all, and
  after approve or retry the row sat `queued` forever while the response advised
  a retry that could not work (the request is now recorded durably and picked up
  by the existing five-minute sweep); and several rejected `deploys:` entries
  collapsed into one row, so only one of their reasons survived — a rejection
  sharing a name with a valid entry could even take that entry's row and stop it
  deploying. Every rejected entry now gets its own `failed` row.

- **The CLI credential file is now `0600` in a `0700` directory on existing
  installs, not only new ones.** It holds a bearer token in plaintext, and
  earlier releases left it world-readable at `0644`. Passing `mode` to
  `writeFile`/`mkdir` does not fix an existing file — POSIX honours `mode` only
  when the call creates the node — so the write now goes through a temp file and
  `rename`, which replaces the inode and carries the right permissions with it.
- **A `stratum` session can no longer be destroyed by running two commands at
  once.** Refresh tokens rotate on every use, and presenting a retired one is
  treated as theft: the server revokes the whole grant, logging you out
  everywhere. Two processes refreshing concurrently both held the same token, so
  parallel commands after an idle hour would systematically do exactly that.
  Rotation now takes a cross-process lock and re-reads the stored credential
  inside it, so a process that waited adopts the winner's token instead of
  replaying its own.
- **A crash or `^C` while the CLI wrote its credential no longer loses the
  session.** The file was truncated in place, and after a rotation the new
  refresh token exists only on disk, so a torn write was unrecoverable. Writes
  are now atomic.
- **The CLI refuses to send credentials over plaintext or off-origin.** `--host`
  must be `https` (loopback excepted), and every endpoint named in a host's
  OAuth discovery document must share that host's origin, so a tampered document
  cannot redirect the authorization code or refresh token elsewhere.
- **OAuth requests no longer hang indefinitely.** Every call in the login and
  refresh path carries a timeout; without one, an unreachable host hung not just
  `login` but every command, because a refresh re-enters discovery.
- **A stray request to the CLI's loopback port no longer cancels a login.** Any
  page open in the browser can reach `127.0.0.1`; a request with a mismatched
  `state` is now ignored and the listener keeps waiting, per RFC 8252.
- **A failed token refresh reports its actual cause.** A network failure was
  reported as `session expired`, sending users to re-authenticate over a problem
  that re-authenticating could not fix.
- **The header fits a phone.** Signed in, the nav's five links were laid out in
  one unwrappable row, so below about 460px the row ran past the viewport, the
  page scrolled sideways, and the wordmark and "logout" were clipped off either
  edge. Below 640px the links now collapse behind a "menu" button next to the
  wordmark and open as a full-width list beneath it. The toggle is a checkbox
  driven purely by CSS, so it works with scripts disabled and keeps its place in
  the tab order. Wider screens, the signed-out header and the docs site's header
  (which shares this stylesheet) are unchanged.
- **Settings tables and the invite table fit a phone.** The API token,
  connected-app and agent tables were not in the sideways-scrolling wrapper the
  invite table used, so a settings page with two tokens was 741px wide at a
  390px viewport. All four now scroll inside the card. The invite share link,
  which was allowed to break at any character and wrapped to 300px-tall rows,
  stays on one line inside that scroll; an email in the Account list wraps
  instead of running past the card edge.
- **Claude Code can connect to the MCP server.** `claude mcp add` registers
  `http://localhost:<port>/callback` as its OAuth redirect, and the
  authorization server refused the name outright — only the loopback IP
  literals were accepted — so every registration from the CLI failed with
  `invalid_redirect_uri` before a browser ever opened. `localhost` is now
  accepted as loopback (every current browser resolves it internally, without
  DNS), and a loopback redirect may use a different port at authorization time
  than the one it registered with, as RFC 8252 §7.3 requires of a server that
  serves native apps. Nothing else about redirect matching is relaxed: host,
  path, query and scheme are still compared exactly, and `localhost` and
  `127.0.0.1` do not stand in for each other.
- **Approving an MCP connection in Chrome, Edge or Safari now completes it.**
  The consent screen shipped the site-wide `form-action 'self'` policy, and
  those browsers enforce that directive against the redirect that answers the
  consent form, not just against the form's own action. Clicking Allow minted
  an authorization code the browser then refused to deliver to the client, so
  the page sat there and the connector never connected. Firefox does not check
  redirects, which is why the flow appeared to work in one browser and not
  another. Naming the client's registered redirect origin turned out not to be
  enough either: the browsers apply the directive to every hop of the redirect
  chain, and Claude's callback redirects onward again, so the connection still
  stalled on a consent page that appeared to reload. The consent page now
  carries no `form-action` at all; it has no user-controlled markup and its
  only form targets `/oauth/authorize`, so the directive protected nothing
  there. Every other response keeps `'self'`.
- **The consent screen's Allow button no longer looks disabled.** It used
  near-black text on the deep-navy accent; it now uses the same colour pair as
  every other primary button.
- **The MCP `401` challenge names the scopes the endpoint needs**
  (`scope="mcp:read mcp:write"`, RFC 6750 §3). A client that takes its scope
  from the challenge asks for read and write up front rather than authorizing
  read-only and failing on its first commit. A client that asks for nothing
  still gets `mcp:read`.
- Approvals are dismissed when the evaluated **base** moves, not only when the
  tip does. A change re-evaluated against a newer base kept approvals that were
  granted against different code.
- **Import jobs can no longer wedge forever.** A scheduled sweep now moves stalled imports to a
  terminal state on its own — previously recovery only ran if somebody happened to open the
  project's progress page, so an abandoned job could show "Import in Progress" with a `CANCELLING`
  badge indefinitely. A cancel that never finished lands in `cancelled`; anything else that stopped
  progressing becomes `failed` with an explanatory error. Jobs that were never picked up off the
  queue are reaped too, under a longer grace period.
- **Stall detection never actually fired.** Both the sweep and the existing on-demand recovery
  compared `updated_at` against SQLite's `datetime('now', …)`, which formats timestamps with a
  space, while every job row stores an ISO-8601 string. Compared as text, `'T'` sorts after `' '`,
  so no row matched until the UTC date itself rolled over — silently delaying recovery by up to a
  day. Both now compare ISO instants, and migration 043 normalises any legacy timestamps.
- **The import status `syncing` was never actually saved.** It was missing from the `import_jobs`
  status constraint, so the write the queue consumer makes when a sync begins failed silently on
  every run and the job kept reading as `queued` long after it had started. The constraint now
  admits every status the code can produce (migration 043), and the write reports failures instead
  of discarding them.
- A cancellation that the sweep finished is now recognised as cancelled by the queue consumer, which
  previously treated it as a failure — emailing the user about a failure they never had and, on the
  sync path, restarting the work they had cancelled.
- An import in its sync phase now shows as in progress, with a spinner, a Cancel button and live
  updates. Because `syncing` could never previously be stored, the progress card had no case for it
  and would have rendered a running import as though nothing were happening.
- On-demand stall recovery now updates the job it actually selected. It picked the stalest row but
  wrote back by project, which resolves to the newest row — so on a project with more than one
  import it could fail a healthy running job and leave the wedged one in place.
- **"Sync Now" no longer appears on an empty repository**, where it sat next to "Not synced" and an
  in-progress import badge — three claims that could not all be true at once. It still appears when
  the file listing merely failed, which is when it is most needed.
- `STRATUM_TELEMETRY_DISABLED` had no effect on `deploy:production` or `deploy:staging`. It was
  declared only under top-level `[vars]`, which named wrangler environments replace rather than
  inherit, so self-hosters who set it were still sending telemetry. It is now declared per
  environment.
- The active-token cap counted expired tokens, so a user whose tokens had all
  lapsed could not create a replacement without first revoking each dead row by
  hand. Expired and revoked tokens now both free their slot.
- **The backup format and restore now handle repositories whose only refs are
  tags.** A snapshot of a repository with an unborn `HEAD` but with tags now keeps
  its tags and every object only they reach, instead of being reported `empty`, and
  its repo manifest simply omits `tipSha`. Restoring it recreates the tags without
  inventing a default branch, and the restore plan accepts a manifest that has no
  `tipSha` but does carry tags. The scheduled backup still clones the default
  branch first, so a remote with no default branch still fails at the clone and is
  recorded as an error for that repository. Existing backups, which always record a
  `tipSha`, restore exactly as before. Repositories with neither commits nor tags are
  still skipped as `empty`.
- **An organization's second-factor policy now also applies when a credential is created.** A
  session that had not met an org's "require a second factor" policy could still create an
  API token, an agent token, a new legacy key or an MCP/CLI connection. These are never asked
  for a second factor when used, so they then reached that org's projects. Creating any
  credential that could reach the org is now refused with `403 SECOND_FACTOR_REQUIRED` until
  the session meets the policy: an unbound token, a token bound to the org or one of its
  projects (public ones included), an agent, a rotated legacy key, or OAuth consent. A token bound to your own
  projects, or to an org without the policy, can still be created. Credentials created before
  the policy was turned on are unaffected; review and revoke them from Settings if needed.
- **Staged-tree copies can now be expired in R2.** The copy of each workspace
  commit that the fast merge path keeps now lives under its own `staged-sha/`
  prefix, so a bucket lifecycle rule can expire it. That covers copies for
  rejected changes, intermediate commits and abandoned workspaces. Merges still
  delete their own copy right away. **Operators must add the rule to each bucket
  bound as `REPO_OBJECTS`.** Until they do, copies still accumulate. See
  `docs/runbooks/staged-tree-retention.md`.
- **A policy with more than one `webhook` evaluator now contacts every receiver.** Each
  `webhook` entry built its own evaluator but re-derived its configuration at evaluation
  time by searching the policy for the first entry of that type, so a policy declaring
  two receivers sent both requests to the first URL, signed both with the first secret,
  and applied the first entry's `timeoutMs` to both — while the second receiver was
  never contacted and nothing logged a word about it. Each evaluator is now handed the
  entry it was built for.
- **A failing evaluator can no longer be masked by a passing duplicate of the same
  type.** `requiredEvaluators` read the single latest `eval_runs` row per evaluator type,
  so when one type ran more than once in the same evaluation — two webhook receivers, two
  `diff` evaluators — only one verdict reached the merge gate, and a change one receiver
  had rejected could merge. Every run of a type in the newest evaluation round is now
  folded with AND, matching the rule the manual-conflict-resolution path already applied.
  A later passing re-evaluation still clears an earlier failure.
- **An evaluation round is now identified rather than inferred from its timestamp.**
  `eval_runs` rows carry a `round_id` (migration 048) shared by every run of one
  evaluation pass. Round identity was previously "these rows share a `ran_at`", which
  two passes can do — a change's initial evaluation and a re-evaluation, or two
  concurrent `POST /changes/:id/evaluate` calls, since that route takes no lock — and
  reading them as one round could AND a superseded failure into a later passing round,
  leaving the change blocked until someone re-evaluated again. Rows written before the
  migration keep the old timestamp grouping.
- **A manual conflict resolution can no longer be committed onto a base it was not
  evaluated against.** The resolution route evaluated the proposed content against one
  clone of the project, then `resolveConflict` took a second clone and committed onto
  whatever tip that one saw. If a push landed on the default branch in between, the
  resolution was committed cleanly on top of content the evaluator suite had never seen —
  no error, and the audit record named the evaluated revision as the commit's parent when
  it was not. The evaluated base is now pinned through to the commit, and a project that
  moved is refused with `409 STALE_PROJECT` ("re-resolve against the current revision")
  instead of being silently committed. That covers the narrow race as well as the common
  case: if the project moves between the check and the push, the remote refuses the
  commit, and that rejection now reports `STALE_PROJECT` too rather than a `502` that
  reads as an upstream outage. `accept-project` and `accept-workspace` re-stage content
  already committed on one side of the conflict and are unaffected.
- **`npm run release:prepare` now bumps `package-lock.json` along with `package.json`.**
  The lockfile's root `version` and `packages[""].version` were never updated, so they
  fell one release further behind on every cut. Only those two fields are edited;
  dependencies are not re-resolved. `npm run release:check` (which the Release
  workflow runs) now fails when either lockfile version disagrees with
  `package.json`.
- **The test suite passes on every Node version `engines` claims to support.** Opening an
  issue was the one place in `src/` that used numbered SQL parameters (`?1`, `?9`), which
  `node:sqlite` — the engine behind the D1 test harness — cannot bind on older 22.x
  releases: on 22.14.0 the statement throws `column index out of range`, taking 43 tests
  red on a clean checkout while CI's floating `node-version: "22"` resolved to a newer
  release and stayed green. The statement now uses anonymous `?` placeholders and binds
  the three reused values twice, which every 22.x binds and D1 has always accepted. A new
  `Unit Tests (engines floor)` PR check runs the whole suite at exactly the declared
  floor (22.13.0) so the supported range cannot drift silently again, and a `.nvmrc`
  points `nvm use` at a supported major.
- **Google sign-in works outside production.** Only `[env.production.vars]` declared
  `GOOGLE_REDIRECT_URI`, and the Google routes require it, so `/auth/google` answered
  `501` on staging and under `wrangler dev` however the secrets were set — named
  environments replace top-level `[vars]` rather than inheriting them. Staging and
  local now declare their own callback.
- **A Google sign-in returns to the page it started from.** `/auth/google` now accepts
  `?next=` the way `/auth/github` already did, carried through the round trip on the
  OAuth state record and honoured by the callback and by the username step a new
  account goes through. It previously always landed on `/` unless the MCP consent
  screen had remembered a destination.
- **A policy file is bounded, and an unusable `llm` entry says why.**
  `evaluators:` now takes at most 16 entries, the cap `deploys:` has always had
  and for the same reason — one merge must not amplify into an unbounded number
  of external calls. An entry that names a provider must also name a `model`,
  since the default is a Workers AI model id that fails every call against any
  other provider. The merge-blocking reason now names the provider (or the field)
  that made the entry unusable instead of only counting entries. A verdict
  truncated at the provider's token cap records the tokens the provider reported
  for it, rather than recording a charged call as free.
- **A deploy refusal can no longer overwrite a deployment that is running.** The
  paths that write a terminal status without claiming the row first — a failed
  guard, a superseded commit, and now an exhausted allowance — run before
  `claimDeployment`, and `running` is not a terminal status, so a redelivery of
  the same message could land `failed` on a row another delivery was mid-deploy
  on and clear its lease. Those writes are now refused against a claimed row,
  and the `deployment.failed` event they emit is withheld when the write does
  not land: an event announcing a failure for a deploy that is about to succeed
  is the one a webhook consumer acts on.
- **The commented `LLM_PROVIDERS` example carries the API version path.** The
  provider appends `/messages` (or `/chat/completions`) to `baseUrl`, so the
  `https://api.anthropic.com` shown in `wrangler.toml` would have 404'd on every
  call; it is `https://api.anthropic.com/v1` now. A `baseUrl` is also stored
  normalized, so a trailing `#` or `?` — both of which pass the "no fragment, no
  query" check — cannot swallow the path the provider appends.
- **A project's overview page no longer takes 30–45 seconds to load.** When its cached
  snapshot had expired — which, after seven days, was every project — the page cloned the
  repository three times per view, once each for the file list, the commit log, and the
  README, spending ~24s of CPU on a modest repository and approaching the Workers CPU limit.
  It now reads all three from a single clone and caches the result against the exact commit
  it describes. A later view reuses that cache only when its commit matches the branch tip
  advertised for that request, so views of an unchanged branch skip the clone entirely and a
  push or merge is picked up on the next view.
- **`deployment.succeeded` and `deployment.failed` are emitted only once the terminal
  status is actually recorded.** The deploy runner emitted the terminal event even
  when writing the deployment's terminal status to the database failed, or when the
  row had already been finished by another owner. Webhook consumers could then act on
  an outcome the deployment record did not show (the row stayed `running`). No event
  is emitted now unless the write landed; the failure is logged instead.
- **The private-project limit now applies to imports.** Importing a repository
  (`POST /api/projects/{namespace}/{slug}/import`) and bulk import
  (`POST /api/bulk-import`) both check the account's private-project limit, as
  creating a project already did. A bulk import checks the whole batch at once:
  if its private repositories would go past the limit, it answers `403` and
  imports none of them. Public repositories and projects that already exist do
  not count.
- **Bulk import rejects ambiguous batches.** An entry whose `visibility` is
  neither `private` nor `public`, or two entries that would import into the same
  project, now get `400` instead of being accepted.
- **Concurrent creations can no longer go past the private-project limit.**
  Creating, importing or bulk-importing private projects at the same time could
  admit more than the plan allows, because each request counted existing
  projects before the others had written theirs. Bulk import made this much
  larger: several batches sent back to back were each checked against the same
  starting total. Each admitted creation now holds its place until its project
  is written or fails, so a second request sees it. A held place that is never
  released lapses after 3 minutes for a single creation or import, and after 15
  minutes for a bulk import. If the usage meter cannot be reached, the limit is checked against
  existing projects only, as before.
- **Backup retention no longer prunes the last healthy run.** Retention used to keep
  the newest `BACKUP_RETENTION` complete runs whether or not they were restorable, so
  a stretch of failed runs (a misconfigured secret, an R2 permissions change) could
  leave only unrestorable backups. It now reads `healthy` from each run's manifest:
  unhealthy runs no longer take `BACKUP_RETENTION` slots (they still age out after
  that many complete runs), and the newest healthy run is always kept. Worst-case
  backup storage can therefore reach about twice the retention window. Manifests without a `healthy`
  field count toward the window as before. If a manifest cannot be read from R2,
  that run prunes nothing.
- Change creation latency no longer depends on how long the evaluators take, and
  the `llm` evaluator can no longer hold a request open without bound.
- **The docs and agent skills no longer say evaluation runs synchronously at change
  creation.** On an instance with an evaluation queue, a new change comes back
  `evaluating` and its verdict lands afterwards, and an agent following the old
  `stratum-merge-gate` skill would act before it arrived. A gated `git push` still
  evaluates on the request.
- **Two published files still said MIT after the AGPL relicense**: the source-repository
  link description in the docs site's `llms.txt`, and the `license` field of the MCP
  server card at `/.well-known/mcp/server-card.json`. Both now say `AGPL-3.0-or-later`.
- `docs/api/openapi.yml` reported `info.version: 1.0.0`; it now tracks the release
  version (`0.2.0`). `@stratum-eng/agent` was still at `0.1.0` and moves to `0.2.0`
  alongside `@stratum-eng/cli`.
- `agent/README.md` told readers to `npx @stratum-eng/agent`, which is not published;
  both client READMEs now say to build from source until it is.
- `AGENTS.md` claimed `pr-checks.yml` ends in a staging deploy and smoke test. It
  deliberately deploys nothing; the description now matches the workflow.
- The machine-readable documentation index at `docs.usestratum.dev/index.md` was
  missing the Deployments, Authentication, and Error codes pages.
- **A project's overview page no longer stalls for several seconds after every push.** The
  per-commit view cache added in #379 was only ever served for the branch's current tip, so
  the first view after any push or merge waited for a full clone (8s on a modest repository).
  The page now shows the last cached view straight away, with a note naming the commit it
  shows, and refreshes the cache in the background, so the next view is current. Only a
  branch that has never been viewed waits for a clone. A burst of viewers starts one refresh
  between them, not one each. The page's other independent lookups (import progress, sync
  status, write access, snapshot) now run in parallel, not one after another.
- **Signing up no longer ends on a "page not found".** Confirming a new account
  from the email link now opens the dashboard, which shows how to create or import
  a first project. An agent-initiated signup opens Settings, with a notice saying
  whether the agent's request was approved. A plain signup, and an approved
  agent signup, used to redirect to `/welcome`, which does not exist; an agent
  signup that missed the hand-off already went to Settings, and now says whether
  the request expired or approving it failed, and how to connect the agent
  instead.

### Security
- **The closed-beta gate can no longer be routed around by an SSO signup.** The
  gate is enforced on the `/auth/signup/complete` form every OAuth signup passes
  through, and that check held — but `upsertGitHubUser` still carried a branch
  that *created* an account outright, and the only thing keeping the GitHub
  callback out of it was a second copy of the same lookup, in a different file,
  under a comment asserting the branch was unreachable. Two copies of one
  decision is a gate that opens the moment they disagree, and a callback is
  exactly where a matching rule gets tweaked (an email normalized, a soft-deleted
  account skipped). The lookup now lives in one place: `signInGitHubUser` matches
  by GitHub id or verified email, links the identity, and creates nothing — an
  identity with no account comes back as `null` and the callback parks it for the
  gated form. Account creation for every signup method — magic link, GitHub,
  Google — now has exactly one door. No behaviour changes for a live deployment:
  the create branch was already dead, and sign-in is untouched.
- **GitHub sign-in no longer trusts an unverified email.** The callback picked
  the primary address, verified or not, and fell back to *any* address on the
  account. That address then matched (and linked to) an existing Stratum
  account, so anyone could add a victim's email to their own GitHub profile,
  leave it unverified, and sign in as the victim; it also created new accounts
  under addresses nobody had proven. Only a verified address is used now, for
  matching and for creation alike, and an account with none is refused (`422`).
  The closed-beta path already worked this way; the open-signup path did not.
- **Minting an agent token from the settings form requires a browser session.**
  `POST /settings/agents` and `POST /settings/agents/:id/delete` loaded the user
  but never checked *how* they authenticated, so a scoped `read_write` API token
  could post to the form and receive a fresh agent token — a credential that
  outlives the token that minted it, which is exactly the circularity #254 closed
  for `/settings/tokens`. Both are now behind the same session-only guard.
  This closes the browser form only: `POST /api/agents` and
  `DELETE /api/agents/:id` still accept any authenticated caller, so the
  capability is not gone. Closing that too is a breaking change for automation
  that provisions agents with an API token, and is left as a deliberate decision
  rather than folded into this change.
- **Webhooks are scoped on project id alone (#235).** `webhookBelongsToProject`
  and `listWebhooks` still matched `project_id = ? OR (project_id IS NULL AND
  project = ?)`, so a pre-migration-025 row could be read, modified and
  delivered to by a same-named project in another namespace. `listWebhooks` now
  takes the project id rather than its name, so a name-scoped lookup is not
  expressible at the call site, and `createWebhook` requires `projectId` so no
  new unstamped row can undo the backfill.
- Policy files are now validated per evaluator, not just spread onto the defaults. `sandbox` and
  `webhook` timeouts are clamped into range, `sandbox.command` is rejected if it is blank,
  over-length, or contains a newline (which a shell would read as a second command), a `webhook`
  entry without a `url` is dropped, and malformed `evaluators` entries are dropped instead of
  crashing evaluator construction. An out-of-range value is clamped with a warning; it does not
  block merges.
- **`minScore` is clamped to `[0, 1]` and replaced when rejected.** Previously the raw value from
  the policy file survived validation, so `minScore: -.inf` (or the string `"-5"`) made
  `score >= minScore` true for every score — accepting changes whose evaluators had all scored 0.
- A policy containing an unusable evaluator entry now fails the merge gate closed with a
  `configError` rather than dropping that entry and proceeding on the survivors. Silently removing
  one gate while its siblings remain would let a change through on the rest — a `webhook` whose
  `url` was typo'd previously reached the evaluator and blocked. An unrecognised evaluator *type*
  is unaffected; it is still passed through and rejected downstream.
- A YAML alias cycle in a policy file no longer causes the whole file to be treated as absent.
  Serializing a rejected entry for a log line could throw, and the fallback silently discarded the
  file's `merge` protection — dropping `requiredApprovals` and re-enabling force-merge.
- Sandbox evaluation of a pinned commit no longer clones a workspace's entire reachable
  history into memory: `readRepoFiles` now clones shallow and grows the fetch window only
  as far as needed to reach the pinned commit, capped at 500 commits, instead of an
  unbounded full-history clone (#246).
- Every network call in `src/storage/git-ops.ts` — `git clone`, `git fetch`, `git push`,
  and `git getRemoteInfo` (clone, tag enumeration/fetches, workspace merge fetches and
  pushes, pinned-commit deepening, GitHub sync, backup restore) — now has a wall-clock
  timeout, so a stalling remote can no longer hold a request open indefinitely (#332).
- `readTreeAtCommit` now caps the total bytes it will materialize across a commit's tree
  at 50 MB, on top of the existing 10 MB per-file cap — bounds tree *size*, independent of
  the history-depth bound #246 already added (#333).
- Backup restore's rollback no longer deletes a freshly restored repo when a push merely
  timed out rather than being confirmed rejected — a timeout doesn't cancel the underlying
  push, so it could still land after the timeout fired, and deleting on that ambiguous a
  signal risked destroying already-landed `main`/tags. `pushMain`/`pushTags` now surface a
  distinctly-coded `PUSH_TIMEOUT` error so the caller can tell the two cases apart (#332).
- **A scoped token can no longer mint a credential that outlives its own
  revocation.** `POST /settings/rotate-token` and `POST /api/users/me/rotate-token`
  refuse a scoped token, because the legacy key they mint never expires and cannot
  be revoked individually. Browser sessions and the legacy credential itself still
  rotate, so existing automation is unaffected.
- **Token management requires a browser session, not an API token.** A
  `read_write` token that could mint siblings and revoke them would make
  revocation circular. `GET /settings` requires a session too — it previously
  rendered token metadata to a caller the JSON routes refused.
- **Docs said agent tokens were "short-lived".** They are not: the `agents` table
  has no expiry column and `getAgentByToken` performs no expiry check, so an
  agent token is valid until the agent is deleted. The claim appeared in the
  README, the getting-started guide, the FAQ, `CURRENT_CAPABILITIES.md`, and the
  published authentication reference, and would have led an operator to assume a
  leaked agent token lapsed on its own.
- **A disabled account cannot authenticate by any route.** Legacy and scoped API
  tokens, MCP OAuth access tokens, agent tokens, session cookies, git over HTTPS,
  and every sign-in flow (magic link, GitHub, Google, SSO, and completing a parked
  OAuth signup) refuse it.
- **GitHub sign-in links to an existing account only through a verified email,**
  and never links onto a disabled or deleting account.
- **The audit log is append-only at the database.** Updates and deletes on
  `audit_log` are rejected by triggers, except the account-erasure rewrite of an
  erased person's actor id to `deleted-user`.
- API tokens, the legacy API key, agent tokens, MCP OAuth grants, SCIM tokens,
  and git over HTTPS are **not** subject to the second factor. They are not all
  scoped: the legacy key and agent tokens carry full account access. Revoke,
  rotate, or disable any you no longer trust.
- **Recovery codes** are 12 characters (about 59 bits). They are stored as
  per-user hashes, keyed with HMAC when the optional `RECOVERY_CODE_PEPPER`
  secret is set. Each code works once.
- **`POST /api/changes/{id}/github-pr` checks write access before reporting the
  change's state.** A caller without write access used to learn whether a
  change was accepted from the `400` it got; it now gets the same refusal as
  for any other change.
- **Closed an open redirect in post-login destinations.** The same-origin check on
  `next` examined the path as written, but the redirect used the path after URL
  normalization, which resolves dot segments: `/auth/github?next=/.//evil.example`
  passed the check and then sent a freshly signed-in user to `//evil.example`. The
  normalized path is now checked as well, for every sign-in route.
- **A project secret can no longer escape through an error message.** A stored
  value containing CR, LF or NUL made the outbound provider request's header
  construction throw a `TypeError` that quotes the offending value; that message
  became an evaluation reason, which is persisted on the change and rendered —
  world-readably, for a public project. Both ends are closed: the store rejects
  control characters in a value, and the provider builds its headers where a
  failure maps to a constant that interpolates nothing.
- **The LLM provider request no longer follows redirects.** The allowlist
  validates the host a request is *sent* to; a 3xx from an allowlisted host used
  to move the prompt (the diff and the policy) to an unvalidated one, re-sending
  the body on 307/308 with the project's `x-api-key` attached, which the Fetch
  spec does not strip cross-origin. A redirect is now a failed evaluation.
- **Credential stripping covers the whole policy, recursively.** Fields whose
  name says "credential" were removed only from the top level of each evaluator
  entry, so one written at the top of `.stratum/policy.yaml`, or nested inside an
  entry of an unmodelled type, reached the review model and the body POSTed to a
  policy-supplied webhook URL. The word list also missed common names —
  `auth`, plurals such as `tokens` and `apiKeys`, `pwd`, `pat`, `hmac`, `sig` —
  while keeping innocuous ones like `keystone`.
- **One host filter, not two — which also closed a pre-existing SSRF hole in the
  webhook evaluator.** The LLM provider allowlist had its own copy of the
  private-address check, and it had drifted: CGNAT (`100.64/10`), the
  `.internal`/`.local` suffixes (GCP's metadata endpoint is
  `metadata.google.internal`), everything in `fe80::/10` not spelled `fe80`, and
  IPv4-compatible IPv6 (`[::127.0.0.1]`, which the URL parser rewrites to
  `[::7f00:1]`) all got through. Both callers now share one filter, which
  expands an IPv6 literal rather than matching its spelling. The webhook
  evaluator's URL check — which has shipped for far longer, and accepts a URL
  straight from `.stratum/policy.yaml` — had the last two gaps too, so a
  `webhook` entry pointed at `[::127.0.0.1]` or at `feb0::…` used to reach the
  loopback and link-local addresses it was written to refuse. Both are refused
  now. The filter also refuses the non-global ranges that are neither RFC 1918
  nor obviously local — IPv4 multicast, `240.0.0.0/4` (nominally reserved, and
  used for real internal addressing inside more than one cloud provider), the
  RFC 2544 benchmark block, `192.0.0.0/24` and the TEST-NETs; IPv6 multicast
  (`ff02::1` is all-nodes on the local link), site-local, and `2001:db8::/32`.
  The bare-label rule moved into that shared filter as well: `metadata` is
  the metadata endpoint's short name on both AWS and GCP, DNS is what makes it
  an address, and the webhook check had the rule while the provider allowlist
  did not.
- **A policy declaring two `llm` entries is refused.** The BYOK provider was
  resolved from the first entry while an evaluator was built for every entry, so
  `[{llm}, {llm, provider: …}]` silently ran twice on the operator's Workers AI
  bill — the fail-open this work exists to prevent. Both the parser and the
  provider resolution now refuse rather than choosing one.
- The shared outbound-host filter now rejects the non-global IPv6 ranges it was
  still accepting: discard-only (`100::/64`), IETF protocol assignments
  (`2001::/23`, which covers benchmarking and Teredo), 6to4 (`2002::/16`) and
  the NAT64 prefixes (`64:ff9b::/96`, `64:ff9b:1::/48`). The IPv4 half already
  refused its equivalents, so webhook delivery and BYOK provider URLs were
  applying two different rules through one filter.
- **Webhook evaluators can sign with a project secret instead of a literal in
  the policy file.** A `webhook` entry in `.stratum/policy.yaml` now accepts
  `secretRef: <NAME>`, resolved at evaluation time from the project's encrypted
  secret store (the one deploys use). A literal `secret` is readable by anyone
  with repository read access — and by the code under evaluation — so anyone
  could forge a signature your receiver accepts. If you used one, store the value
  as a project secret, switch to `secretRef`, and rotate it. A reference that
  does not resolve (missing, empty, undecryptable, or no `DEPLOY_SECRET_KEY`)
  fails the evaluation closed without contacting the receiver; it never sends
  unsigned or signs with an empty key. The name must start with `WEBHOOK_`, so a
  policy cannot sign with a deploy credential or a BYOK provider key; any other
  name fails the policy file closed.
- The client address for the allowlist comes only from `CF-Connecting-IP`.
  `X-Forwarded-For` is never read. A request with no client address is refused
  by a restricted org.
- The consent-screen destination is bound to the magic link server-side and only
  honoured in the browser that requested the link. Opening the link on another
  device signs you in but shows "you're signed up; reconnect your editor" rather
  than presenting a consent screen to whoever opened it. The destination must be
  same-origin and exactly `/oauth/authorize`.
- **Account deletion now erases the user from the whole audit log.** Previously only the
  actor was anonymized, so an entry could still name the erased account by id or email as
  its subject or as a complete value in its detail. Every such reference is now rewritten
  to `deleted-user`; an identifier inside longer free text, and usernames, are not.
  Migration 069 replaces the append-only trigger so the database also allows those subject
  and detail rewrites, only for an account that is being deleted, and still rejects every
  other edit and every delete. The existing rewrite of an actor to `deleted-user` is
  unchanged and does not check for a deleting account.
- **A scoped API token or OAuth grant can no longer create agents.** `POST /api/agents`
  mints an agent token, which never expires and is not tied to the credential that
  created it, so a scoped token or an MCP client's OAuth grant that could call it would
  survive its own revocation. It now returns `403 SESSION_REQUIRED` for those callers,
  the same rule the legacy-key rotate routes already follow. Browser sessions and the
  legacy API key are unaffected; the settings page already required a session.
- **A username can no longer be taken over an organization's or another account's
  namespace.** Users and organizations share the `@name` namespace, but renaming an
  account (and signing up) only checked other usernames. Renaming to an org's slug, or
  to a name whose namespace still held another account's projects, gave the account a
  namespace it did not own, and the import routes, which authorize by that namespace,
  then accepted it. Renames, signups, org creation and `GET /api/users/check-username` now
  treat an org slug, a live project claim, or existing projects under `@name` as taken.
  The user/org check also sits inside the rename's `UPDATE` and the org's `INSERT`, so a
  concurrent rename and org creation cannot both claim the same name.
- **The OAuth authorize endpoint is no longer an open redirect.** Client registration is
  open, so anyone could register a client whose redirect URI was their own site and then
  link users to `/oauth/authorize` with a malformed request, which bounced them straight
  to that site from Stratum's domain. Invalid authorization requests (bad
  `response_type`, PKCE, scope or resource) and a declined consent now show a Stratum
  page naming the OAuth error, with a "Return to <host>" link that carries the error and
  `state` back to the client only when the user chooses to follow it.

### Changed
- **Product analytics now answers questions instead of just counting requests.**
  Telemetry sent two events with almost no properties: a request event carrying
  a route pattern, and a repository-activity event carrying only its type, the
  actor type, and a project id. It could count merges; it could not say what
  fraction of changes pass evaluation, what reviewers decide, which deploy
  targets fail, which MCP tools agents actually call, or how anyone signed up.
  Four new events (`mcp_request`, `auth_completed`, `error_occurred`,
  `background_job_completed`) and per-type properties on the `stratum.*` events
  close that. `api_request` gains `surface` and `actor_type`, and every event
  now carries an `environment` label so staging traffic stops polluting
  production's numbers — set `STRATUM_ENVIRONMENT` in each `[env.<name>.vars]`
  block (named environments do not inherit top-level `[vars]`). The privacy
  rule is unchanged and now enforced in one place: every property is either a
  source-code literal or a bounded value, never a name, path, URL, title, ref,
  or free-text message. `docs/user-guide/faq.md` lists every event and every
  property exhaustively, and a test fails the build if that list and the code
  disagree.
- **An agent no longer counts as a person in analytics.** Every agent token had
  its own `distinctId`, so PostHog minted a person profile per credential —
  splitting one human's history across several profiles, inflating the billed
  person count, and making every user count, funnel, and retention curve wrong
  by however many agents happened to be running. An agent acts under its
  owner's account (the owner's opt-out already governs it), so its events are
  now attributed to that owner, with the agent's own id carried as `agent_id`
  so the breakdown is not lost.
- **Domain events are dated from when the activity happened.** They were dated
  from when the queue consumer exported them, which a retry or the five-minute
  stale sweep can delay well past the fact — skewing every time series toward
  whenever the queue drained. The outbox row's own timestamp is now sent.
- **Every event carries `$lib_version`**, so a change in a metric can be tied to
  the release that caused it instead of guessed against deploy times.
- **A person profile now has something on it.** `signup_provider` is recorded
  once per account, as `$set_once`, so a cohort like "accounts that signed up
  with GitHub in August" is expressible — previously a person was an opaque id
  with no properties at all. Email, username, and display name are still never
  sent.
- **Analytics property names are now consistently snake_case.** The `stratum.*`
  events sent `projectId` and `actorType`; they now send `project_id` and
  `actor_type`, matching `latency_ms` and every new property. Dashboards built
  on the old names need updating — an insight can bridge the gap with
  `coalesce(properties.project_id, properties.projectId)`.
- **The per-account telemetry opt-out is now structurally impossible to skip.**
  It lived at each `capture()` call site rather than in the client, which is how
  the queue exporter originally shipped without honouring it at all. A new
  `AnalyticsTracker` cannot be constructed without a resolved preference, so a
  call site cannot forget one it never has to know about. Behaviour for existing
  call sites is unchanged, including failing closed when the preference cannot
  be read.
- **`stratum login --host <url>` without `--key` now opens a browser** instead of
  prompting for a key. Scripts that piped a key into the prompt must pass
  `--key` (or set `STRATUM_HOST` and `STRATUM_API_KEY`). Without a TTY the
  command now refuses with a message naming both, rather than spawning a browser
  nobody can see or hanging on a prompt nobody can answer.
- **A lone `STRATUM_HOST` no longer retargets a browser session.** It still
  overrides the host for an API-token credential, but an OAuth grant belongs to
  the server that issued it, so pointing one at a different host is now refused
  with an explanatory error instead of sending that host a token it did not
  issue. Set `STRATUM_API_KEY` alongside it, or run `stratum login --host …`.
- **`cli/` requires Node 20+** (was 18). The loopback listener relies on
  `server.close()` dropping idle keep-alive connections, which is Node 19+
  behaviour; 18 was declared but never tested.
- **Profile is folded into Settings.** The two pages opened with the same
  Account card and each pointed at the other for the rest. Settings now holds
  everything — identity, invite codes, privacy, tokens, connected apps, agents,
  danger zone — with jump links under the heading, and `/profile` redirects to
  it. The header drops the *profile* link, marks the link for the page you are
  on, and shows the display name when one is set.
- **Settings copy is shorter and the page reads on a phone.** The four
  paragraphs of help copy are each a sentence or two; the analytics list sits
  behind an "exactly what is sent" disclosure. The help copy, list, checkbox
  and forms get the spacing the global reset had removed, the native select
  and checkbox are styled to match the inputs, form controls and the phone
  menu's rows are at least 40px tall, card headings are `h2` under the page's
  `h1`, and dates read "Sep 2, 2026" instead of a locale-dependent "9/2/2026".
  Rotate and Disable on the legacy key are plain buttons: red is reserved for
  the danger zone.
- **OAuth and MCP route logs carry the request id.** The routes built their
  own loggers and dropped the id the auth middleware minted, so a middleware
  rejection and the route's own line for the same request could not be joined.
- **The MCP consent screen is shorter.** It leads with the question (allow
  *this application* to access Stratum as *you*), the permissions it is asking
  for, and the two buttons, with the host it returns you to on one line. The
  full redirect address, the note that application names are self-declared, and
  where to disconnect later are under a collapsible **Where this request came
  from** instead of above the buttons.
- **The MCP request body is capped at 8 MB**, below the REST API's 25 MB commit
  limit. A tool call is buffered, parsed, re-serialized into an internal request
  and parsed again, so a body near the REST limit would cost more than a Workers
  isolate's entire 128 MB budget — which is shared with every concurrent request
  that isolate serves. A commit that does not fit belongs on the git remote.
- **All three sign-in paths now honour one post-login destination.** The
  magic-link flow read a `redirect_after_login` cookie nothing set, GitHub
  threaded a `next` parameter, and Google always went to `/`. A flow that sends
  an unauthenticated user to sign in — the MCP consent screen, for one — has to
  get them back to the request they interrupted whichever button they used, so
  the cookie is now written and consumed by a shared helper with one
  open-redirect check (`src/utils/post-login-redirect.ts`). GitHub's `next`
  still wins when present.
- `isScopedTokenCaller` is now `cannotMintLegacyCredential`, and covers OAuth
  grants as well as scoped tokens.
- **The docs site and the app share one header.** `docs.usestratum.dev` was rendering
  Starlight's default header — a different wordmark, typeface, height and link treatment from
  the one at `app.usestratum.dev`, so the two halves of the product did not look related.
  The docs site now renders the app's header: the same `stratum` wordmark, chrome and accent
  links, with search, theme and GitHub controls sized to sit on it, plus a `sign in` link back
  to the app. It is shared rather than copied — `src/ui/nav-css.ts` owns the rules and
  `website/scripts/mirror-header.mjs` generates the site's `header.css` from them, with the
  docs build and the test suite failing on a stale copy.
- **The docs home is a documentation page, not a second landing page.** It dropped the
  six marketing feature cards, then the splash hero itself: `docs.usestratum.dev/` now
  renders with the sidebar like every other page, opens with what the site is, and points
  at the three guides and three reference pages a reader starts from — the pitch lives at
  `usestratum.dev`, which the page links to. The header wordmark goes there too, the way
  the app's wordmark goes to the app, and a new "Overview" sidebar entry keeps the docs
  home reachable. `public/index.md`, the hand-maintained Markdown twin agents read, matches.
- Repository-activity analytics events no longer carry `project`, the concrete project name; they
  carry the opaque `projectId` instead. Dashboards grouping on `project` must switch to
  `projectId` — old `project` references receive no new data. Events for projects created before
  `projectId` dual-write carry no project property at all, so they group under nothing rather
  than under a name.
- `GET /api/admin/audit` now returns `nextCursor` for pagination and accepts
  `org`, `since`, `until`, and `cursor` filters. Existing `action`, `actor`, and
  `limit` parameters and the `entries` field are unchanged.
- **The signed-in name in the top bar is now an account menu.** Profile, settings and logout
  sit under your name instead of as separate links in the bar; "new project" stays in the bar.
  The menu needs no JavaScript, works from the keyboard, and on phones opens in place inside
  the existing menu.
- **Form errors now show inline, under the field they are about.** The new-project and import
  form, the settings forms (display name, username, API tokens, agents), the webhook form and
  the deploy-secret form no longer pop the browser's validation bubbles. A refused submission
  comes back with the reason under the field and the field marked invalid for screen readers.
  The new-project, import, settings and webhook forms also come back with what you submitted
  still filled in, including an API token's scope and project or organization limit and every
  checked webhook event. The deploy-secret form shows the reason but does not refill. Values are
  only ever refilled from the submission itself, never from a link, so nobody can send you a
  form that is already filled in. Submitting the new-project form with a malformed or
  already-used name, or an import with an unsupported URL, now gets the form back instead of a
  raw JSON error; API callers still get JSON.
- **Every cost record now names who pays for it, and LLM token counts are the
  real ones.** `cost_records` gains `owner_id`, `owner_type` and `source`
  (`platform` or `byok`), and a new `usage_periods` table keeps the owner-scoped
  monthly totals those roll up into — migrations 053 and 054, applied like any
  other. Attribution is **always on**, self-hosted included, because it is a
  ledger rather than a paywall: expect a small number of additional D1 writes per
  evaluated change, and a `USAGE_METER` Durable Object binding in `wrangler.toml`
  that is created on deploy and never contacted unless a billing service is
  configured. Token accounting stopped guessing at the same time: Workers AI
  reports `prompt_tokens`/`completion_tokens` and those are now recorded as-is,
  where every LLM cost record used to be a `~4 chars/token` estimate. The
  estimate survives only as a per-response fallback for a provider that omits the
  counts, and a record built that way still says `estimated`.
- **SCIM user lookups are faster for large organizations.** `GET /scim/v2/Users` now
  filters (`userName eq` / `externalId eq`) and pages (`startIndex` / `count`) in the
  database, instead of loading every user in the connection's scope and filtering in
  memory. The `userName eq` and `externalId eq` lookups identity providers run during
  every sync now use an index rather than reading the whole scope. Results, ordering, `totalResults`, and filter matching rules are unchanged.
- `GET`/`PUT /api/orgs/{slug}/security` responses, and org objects from
  `/api/orgs/{slug}`, now include `ipAllowlist`. `GET /api/orgs` omits it, since
  that path is not restricted to an org's networks. `PUT` accepts `requireSecondFactor` and `ipAllowlist`
  independently, so either can be sent alone.
- The OAuth consent screen now lists what a read-write MCP grant covers, including project
  creation and import and organization management.
- **New MCP connections act as an agent by default.** Such a connection can open
  changes, push and comment, but cannot merge, reject, approve or list your
  projects, because those actions are reserved for you. To keep the previous
  behaviour, choose "Me" on the consent screen.
- **Settings → Connected applications shows who each connection acts as.**
  Connections made before this release keep acting as you and are labelled
  "You (no agent provenance)". Reconnect to choose an agent.
- **Audit entries about a member name them in `detail.userId`, not `subject`.** Org and
  team membership events now carry the org or team id as `subject`, and SCIM provisioning
  events carry the SSO connection id. Entries written before this release keep the user id
  in `subject`; filter on `detail.userId` to find newer ones.
- **Approvals are made by a signed-in human.** An `approve` review verdict now needs a browser
  session (or the legacy user key). Scoped API tokens and OAuth grants, which is what MCP
  clients and `stratum login` use and what agents are handed, get `403 SESSION_REQUIRED` with
  the change's URL to approve on instead. They can still request changes and comment, which can
  only block a merge. `stratum change review --verdict approve` and the MCP
  `stratum_review_change` tool now point you to the browser.
- **Repository pages, file views and commit history no longer clone the repository.** They
  now read through the Artifacts read API (`log`, `readTree`, `readFile`) instead of
  downloading and unpacking the repository inside the Worker. Directory listings are
  stored under their Git tree hash, so after a push only the directories on the changed
  paths are read again; on a repository the size of Stratum's that is a few calls instead
  of 44. If the read API fails, or a tree has more than 500 uncached directories, the page
  falls back to cloning as before. Each native read also checks that the repository it
  opened is the one the project's remote names.
- The self-hosting docs now say Stratum needs the Workers Paid plan.
- **Upgrade note: `GITHUB_TOKEN` now needs operator bindings.** The instance personal access
  token is used only for projects whose owner is bound to the repository's GitHub owner in
  `GITHUB_ALLOWED_OWNERS`, as comma-separated `githubOwner=org:<orgId>` or
  `githubOwner=user:<userId>` entries. Bindings name stable ids, never `@namespace` names,
  which can be renamed or deleted and reclaimed. Find an org's id with `GET /api/orgs/{slug}`
  or `SELECT id FROM orgs WHERE slug = '...'`. An instance that relies on `GITHUB_TOKEN` must
  add these bindings when upgrading, or GitHub sync, PR promotion and evaluation reports stop
  for its projects. The former `GITHUB_APP_ALLOWED_OWNERS` is still read, but a bare owner (or
  any other form) is now ignored instead of admitting every project. A caller the GitHub App refuses never falls
  back to the personal access token.
- **The npm packages moved to the `@stratum-eng` scope.** `@stratum/cli` and
  `@stratum/agent` are now `@stratum-eng/cli` and `@stratum-eng/agent` — the
  `@stratum` scope on npm belongs to an unrelated owner. Install and `npx`
  invocations change accordingly (`npx @stratum-eng/agent ...`); nothing else
  about the packages, their binaries (`stratum`, `stratum-agent`), or their APIs
  changes. Neither package was ever published under the old names, so there is
  nothing to migrate off.
- **Stratum describes itself as the open-source, agent-first code forge everywhere.**
  The README, docs site, OpenAPI `info`, package manifests, CLI `--help`, agent-skill
  discovery files, and the signup page all carried different one-liners ("governance
  layer", "code collaboration platform for the AI engineering era", "code hosting for
  the AI engineering era", "agent operations platform"). They now share one: Stratum is
  the open-source, agent-first code forge, with the GitHub layer as the adoption path.
  The second run mode is called **forge mode** in every document (it was "alternative
  mode" in the guides and "standalone forge" in the README), and the deep-link anchor
  in the getting-started guide changed accordingly.
- The trust page no longer calls the restore path tested end to end. Its restore functions
  have tests, but the live push has to be proven by a drill on staging.
- **Every page responds roughly a quarter of a second faster.** The request rate
  limiter counted each request in KV, with a read and an awaited write before any route
  ran — about 250ms even for the stylesheet. Standard limits now use Cloudflare's
  native rate limiting, which keeps counts in memory at each location; limits with no
  matching binding (a plan's own rate, or a self-host without the bindings) still use
  the KV counter. The stylesheet and favicon are no longer rate limited. Limits are now
  approximate per Cloudflare location, and a successful response no longer reports
  `X-RateLimit-Remaining` or `X-RateLimit-Reset`; a `429` still carries `Retry-After`.
- **The stylesheet is cached.** Pages link it at a content-versioned URL served with a
  one-year immutable cache, so later page views no longer download it again.
- **Fonts load in parallel with the stylesheet** instead of after it: the font is linked
  from the page head with pre-connected origins rather than `@import`ed from the CSS.
- **The dashboard reads only your own projects.** It used to read every project in the
  instance and then filter to yours; it now lists your namespace and your organizations'
  namespaces, and reads nothing at all for a signed-out visitor.

### Removed
- **The standalone `mcp/` package (`@stratum/mcp`).** It was a stdio process
  that wrapped the REST API over the network — 609 lines holding no state,
  touching no local git, and offering nothing the Worker could not do itself,
  in exchange for a clone-and-build install. The remote endpoint replaces it
  outright; the CI job that built and smoke-tested it is gone with it.
- **Agent discovery metadata on the docs site.** `docs.usestratum.dev` now publishes an ARD
  capability manifest (`/.well-known/ai-catalog.json`), an Agent Skills Discovery v0.2.0 index
  with three `SKILL.md` artifacts and `sha256` digests, `/auth.md` describing the agent
  registration contract, and WebMCP tools registered on page load. DNS-AID SVCB records live
  in `website/dns/agents.zone` for the operator to publish.
  The docs site itself publishes no OAuth authorization-server, OIDC, or RFC 9728
  protected-resource document: RFC 9728 metadata is resolved from the API origin, which these
  docs do not serve, so advertising it here would send agents to a URL that cannot answer
  them. The app origin does now serve both discovery documents — see the MCP entry above.
- **Multi-branch support (#181).** Create, list and delete branches on a project
  (`GET/POST/DELETE /api/projects/:ns/:slug/branches`), browse any of them with
  `?ref=` on the files, content and log endpoints and in the web UI, and switch
  between them from a no-JavaScript branch switcher. Branch creation is the
  enabling piece: no path previously put a second `refs/heads/*` on a project
  repo, so there was nothing to list. A new branch can only start from a commit
  the repository already holds, so creating one can never introduce content.
  Backups now record branch refs and restore rebuilds them.
- **The diff's base commit reaches CI (#274).** Evaluation webhooks now carry
  `baseSha`, the commit the diff was actually taken against, so a receiver can
  apply the hunks to the right revision instead of guessing at whatever the
  default branch happened to be when the request landed.
- **Delete import.** A failed or cancelled import can be dismissed from the project page, clearing
  its import chrome. Only that job is removed, so the project's import history — and the clone
  depth the next sync reads from it — is preserved.
- Finished import jobs are now pruned after 30 days by the daily housekeeping cron. Nothing had
  been pruning them. The most recent job per project is always kept, because that is the row the
  next sync reads its clone depth from.
- **Per-user telemetry opt-out.** Settings → Privacy now has a switch to stop sending product
  analytics for your account, alongside a plain-language disclosure of exactly what is sent.
  An agent inherits its owner's choice. Telemetry remains on by default; the existing
  instance-wide `STRATUM_TELEMETRY_DISABLED` still overrides every account's preference.
- **Named, scoped, expiring API tokens.** Mint any number of named tokens from
  Settings, each `read` or `read_write`, each with an optional 1-365 day expiry,
  each revocable on its own and each showing when it was last used. A read-only
  token still clones over git but is refused on every write — enforced before
  routing on the HTTP method, and on the resolved scope at all four git write
  entry points, so a route added later inherits the rule.
- **`POST /api/users/me/legacy-token/disable`** (and a button in Settings) turns
  off the single unnamed key accounts were given before scoped tokens existed.
  Named tokens are unaffected. Move anything still using the legacy credential
  onto a named token first — disabling cannot be undone.
- **A total time budget for sandbox evaluation** (`totalBudgetMs`, default 150s). The per-phase
  timeouts were independent, so nothing bounded their sum and an evaluation could hold a
  synchronous request open past any client or proxy deadline. Each phase is now granted
  `min(configured, budget remaining)`, and exhausting the budget returns a failing verdict whose
  reason names the phase (`sandbox budget exceeded (install)`) instead of hanging. See
  [ADR 007](docs/adr/007-sandbox-evaluator-threat-model.md), which also documents what the
  Cloudflare Sandbox binding is and is not relied upon to isolate.
- `allowInstallScripts` on the `sandbox` evaluator config.
- **Docs for the last few weeks of shipping.** New guides for
  [code review](docs/user-guide/code-review.md) (line-anchored threads, replies,
  resolve/unresolve, and the three review verdicts) and
  [issues](docs/user-guide/issues.md) (triage, labels, assignee, search, and
  auto-close on merge), neither of which was documented anywhere; API references
  for both; a rewritten troubleshooting guide covering the failure modes that
  actually ship today (scoped-token refusals, wedged imports, sandbox budget
  exhaustion, `--ignore-scripts`, dismissed approvals); and the token, branch,
  and sync error codes added to the error reference.
- **The contributor rule from #344 now names the generated-docs workflow.** That PR
  required user-facing changes to update the public docs in the same PR, pointing
  contributors at `website/src/content/docs/`. Those pages are now generated, so
  AGENTS.md and the PR template say to edit the canonical page under `docs/user-guide/`
  or `docs/api/` and run `sync:guides` instead. Its "goes stale silently since nothing
  fails a build over it" caveat no longer applies — `check:guides` fails CI on drift.
- **The docs site now publishes the CI integration guide, and the guide and
  reference pages are generated from `docs/` rather than hand-mirrored.**
  `website/scripts/mirror-docs.mjs` renders them; the mirrors are committed, and
  CI runs `npm run check:guides` before the site build so drift fails rather
  than deploying a stale page. The two copies had drifted in
  both directions: the published authentication page still described the
  pre-scoped-token model, and the published FAQ and import guide were each
  missing whole sections.

### Deprecated
- **The webhook evaluator's literal `secret` field.** It still signs requests
  for now, and logs a warning each time. When an entry sets both `secret` and
  `secretRef`, `secretRef` wins and the literal is ignored — never used as a
  fallback.

## [0.2.0] - 2026-08-29

### Security
- Workspace commit/delete now require project write access (was unauthenticated in practice).
- Bulk import enforces own-namespace ownership (no more namespace squatting).
- Merge gate binds the merged code to the evaluated revision across every backend; force-merge
  is now **deny-by-default** (opt in with `merge.allowForce: true`).
- Magic-link tokens are single-use atomically (moved to D1); webhook SSRF filter blocks
  obfuscated IP encodings; malformed policy files fail the merge gate closed.

### Breaking
- **Force merge is deny-by-default.** Existing projects **without** a policy file that relied on
  `?force=true` will now have it rejected. Set `merge.allowForce: true` in `.stratum/policy.yaml`
  to restore it.

### Added
- **A release process.** `CHANGELOG.md` is now the source of truth for the version:
  `npm run release:prepare` moves `Unreleased` into a dated section, infers the SemVer
  bump from which groups are present, rewrites the compare links, and bumps
  `package.json`; the `Release` workflow tags the result and publishes a GitHub release
  whose notes are that section. `npm run release:check` (and `npm test`) fail on a
  changelog that would produce a dead link. See `docs/developer/releasing.md`.
- **Gated `git push` (ADR 005 slice 2b), staging-flagged.** With
  `GIT_PUSH_GATED_ENABLED`, pushing to a project's default branch lands the pack
  on a server-managed workspace fork and opens an eval-gated change through the
  same pipeline as the REST route (now extracted to
  `src/services/change-flow.ts`); the client gets a truthful per-ref `ng`
  carrying the change id and eval verdict — main only moves through the merge
  gate. On staging, off in production until validated end-to-end.
- `.stratum/policy.yaml` for this repository — the dogfood merge policy (diff
  limits, LLM review at 0.6, one human approval, fresh-base required,
  force-merge denied).
- Split/unified diff toggle on the change review page — instant, pure-CSS switch
  (no client-side JavaScript, no reload; GitHub/GitLab need a full reload).
- `git push` to a project URL now fails **in-protocol**: the receive-pack
  advertisement is served, and each ref update is answered with a legible `ng`
  report-status plus sideband guidance pointing at workspace remotes — instead of
  an opaque HTTP 403. The pkt-line/report-status machinery
  (`src/utils/git-protocol.ts`) is the groundwork for the gated default-branch
  push (ADR 005 slice 2b, #115).
- Complete OpenAPI 3.1 specification (`docs/api/openapi.yml`): 72 paths / 91
  operations generated from the route code, replacing the 4-path stub.
- Real user documentation: a full getting-started walkthrough and a 15-question
  FAQ (`docs/user-guide/`).
- `@stratum/mcp` (`mcp/`): MCP server exposing the full eval-gated change flow —
  projects, workspaces, commits, changes, reviews, merges, and issues — so any
  MCP-capable agent or editor (Claude Code, Cursor, Zed, Copilot, custom agents)
  can work against Stratum without a bespoke integration.
- Secret scanner now covers 25+ credential patterns (GitHub fine-grained PATs, GitLab,
  Slack, Stripe, OpenAI, Anthropic, Google, npm, PyPI, Hugging Face, SendGrid, Twilio,
  Azure, private-key blocks, JWTs, connection-string credentials) plus Shannon-entropy
  detection for generic high-entropy credentials in keyword context.
- LLM evaluator: review window is configurable via `maxDiffChars` in the policy
  (default raised 8k → 24k chars, capped at 100k); truncated evaluations say so in
  their result issues; the evaluator now sends a real reviewer system prompt.

- Open-source onboarding: `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`,
  issue and pull-request templates.
- Enforced test-coverage thresholds in `vitest.config.ts`.
- High-frequency agent commits via the Durable-Object SQLite hot index (ADR 004).

### Changed

- **Production signup is open.** The closed-beta invite gate is off in the
  production config (`BETA_GATE = "0"`); staging keeps it on so the invite path
  stays exercised. Takes effect on the next production deploy.
- **LLM evaluator fails closed.** An unparseable model response now scores 0 and blocks,
  instead of inferring a 0.8 score from "LGTM" prose. Non-finite scores (JSON
  `1e999`) fail closed rather than clamping to a pass, and `maxDiffChars` is
  floored/bounded to [1000, 100k] so a tiny or fractional window can never send
  the model an empty diff.
- README repositioned around the control plane: Stratum is the governance layer
  for AI-written code on top of wherever code lives, usable from any agent or
  editor.
- CLI and MCP clients reject project references with extra path segments instead
  of silently truncating; the MCP client enforces a request deadline (default
  120s) so a stalled API can't hang a tool call forever.

## [0.1.0] - 2026-06-11

### Added
- Initial platform: Git hosting on Cloudflare Artifacts, workspace forking, evaluation-gated
  changes, GitHub import/sync, server-rendered web UI, email and GitHub OAuth authentication,
  API tokens, agent identities, and provenance tracking.

[Unreleased]: https://github.com/stratum-eng/stratum/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/stratum-eng/stratum/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/stratum-eng/stratum/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/stratum-eng/stratum/releases/tag/v0.1.0
