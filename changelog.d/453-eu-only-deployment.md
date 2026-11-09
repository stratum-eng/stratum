### Added
- **`DO_JURISDICTION`: restrict every Durable Object to a Cloudflare jurisdiction.**
  Set it to `eu`, `us` or `fedramp` and all four Durable Object classes run and
  store data only inside that jurisdiction. It is off unless set, and it is for a
  **new** deployment: a restricted namespace addresses different objects, so
  turning it on later leaves existing Durable Object state unreachable. A value
  that is not a supported jurisdiction answers `503` to every request instead of
  running unrestricted.
- **A documented procedure for an EU-only self-hosted deployment**, in the Trust
  page: creating D1, R2, KV, Artifacts and Queues with a jurisdiction, turning
  off `workers.dev` and preview URLs, and configuring Regional Services, with a
  commented sample for each setting in `wrangler.toml`.

### Changed
- **The Trust page's data-residency section now says, per execution path, what
  is covered and by which setting, and what Cloudflare gives no guarantee for.**
  Queue consumers and cron handlers remain in the second group: nothing
  constrains where they run, so an EU-only deployment keeps stored data, Durable
  Objects and (with Regional Services) HTTP handling in the EU, but cannot
  promise that all processing happens there.
