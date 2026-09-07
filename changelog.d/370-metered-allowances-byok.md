### Added

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
  and creating another organization does not hand you a fresh one.

### Changed

- **Every cost record now names who pays for it, and LLM token counts are the
  real ones.** `cost_records` gains `owner_id`, `owner_type` and `source`
  (`platform` or `byok`), and a new `usage_periods` table keeps the owner-scoped
  monthly totals those roll up into — migrations 048 and 049, applied like any
  other. Attribution is **always on**, self-hosted included, because it is a
  ledger rather than a paywall: expect a small number of additional D1 writes per
  evaluated change, and a `USAGE_METER` Durable Object binding in `wrangler.toml`
  that is created on deploy and never contacted unless a billing service is
  configured. Token accounting stopped guessing at the same time: Workers AI
  reports `prompt_tokens`/`completion_tokens` and those are now recorded as-is,
  where every LLM cost record used to be a `~4 chars/token` estimate. The
  estimate survives only as a per-response fallback for a provider that omits the
  counts, and a record built that way still says `estimated`.

### Fixed

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

### Security

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
