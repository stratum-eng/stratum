### Added
- **A "Deploy to Cloudflare" button.** The README now carries one, and the repository
  meets the contract behind it: the top-level `wrangler.toml` deploys as a template
  on someone else's account, `npm run deploy` applies the D1 migrations by binding
  name before publishing, `.dev.vars.example` lists every secret the setup page
  should ask for, and `package.json` describes each binding, var and secret in
  `cloudflare.bindings`. Cloudflare clones the repo into the user's own GitHub or
  GitLab account, provisions D1/KV/R2/Queues/Durable Objects/Workers AI, and wires up
  Workers Builds so later pushes redeploy. Cloudflare Artifacts is a private beta and
  is not auto-provisioned, so the button still requires an account with Artifacts
  access; `docs/developer/deployment.md` covers that and the rest of the gaps.

### Fixed
- **A renamed Worker no longer breaks its own Durable Object bindings.** The
  top-level `wrangler.toml` pinned `script_name = "stratum"` on all three Durable
  Object bindings, which is this Worker's own classes referring to themselves by a
  name a self-hoster is free to change — and once changed, the binding pointed at a
  script that does not exist and the deploy failed. The named environments still pin
  it; their names are fixed.
- **A first deploy of the template no longer fails on a missing dead-letter queue.**
  `dead_letter_queue = "stratum-deploys-dlq"` is a bare queue name rather than a
  binding, so nothing provisions it, and `wrangler deploy` fails outright on a bound
  queue that does not exist. It is commented out of the top-level config, with the
  `wrangler queues create` line to turn it back on; production and staging are
  unchanged.
- **The deployment guide's production commands.** It documented a bare
  `npx wrangler deploy` for production, which publishes the top-level *template*
  config — placeholder resource IDs included — over the Worker named `stratum`, the
  production Worker. Both the deploy and the migration command now pass
  `--env=production`.
