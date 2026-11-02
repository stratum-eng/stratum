### Changed
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
