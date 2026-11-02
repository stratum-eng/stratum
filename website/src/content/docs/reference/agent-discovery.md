---
title: Agent discovery
description: Every machine-readable entry point Stratum publishes, what each one contains, and how an agent should walk them.
---

Stratum treats agents as first-class users, so everything a human can find in
these docs an agent can find in a machine-readable form. This page is the map.

## Start here

An agent that knows nothing but the domain should walk this order:

1. **DNS** — `_index._agents.usestratum.dev` (SVCB) points at the origin that
   serves the discovery documents.
2. **`/.well-known/ai-catalog.json`** — the ARD manifest. One document listing
   every capability, each with a media type and a URL.
3. Follow the entry that matches the task.

An agent that already has an HTML page can skip step 1: every page carries the
catalogue in an RFC 8288 `Link` header and an in-page `<link rel="ai-catalog">`.

## The entry points

| Path | Format | What it is |
|---|---|---|
| [`/.well-known/ai-catalog.json`](/.well-known/ai-catalog.json) | ARD manifest | Every capability Stratum publishes, with representative queries for semantic indexing |
| [`/.well-known/api-catalog`](/.well-known/api-catalog) | RFC 9727 linkset | Service description and documentation links for the REST API |
| [`/.well-known/mcp/server-card.json`](/.well-known/mcp/server-card.json) | MCP server card | The remote MCP endpoint's URL, how to authenticate to it, and its tool list |
| [`/.well-known/agent-skills/index.json`](/.well-known/agent-skills/index.json) | Agent Skills Discovery v0.2.0 | SKILL.md artifacts with `sha256` digests |
| [`/auth.md`](/auth.md) | Markdown | The agent registration contract, in prose |
| [`/openapi.yml`](/openapi.yml) | OpenAPI 3.1 | The complete REST API contract |
| [`/llms.txt`](/llms.txt), [`/llms-full.txt`](/llms-full.txt) | Plain text | Documentation index and complete corpus |
| [`/sitemap-index.xml`](/sitemap-index.xml) | XML | Every page |

All of them are served with `Access-Control-Allow-Origin: *`, so an agent running
in a browser on another origin can read them directly.

## Markdown instead of HTML

Any documentation page returns its Markdown source when you ask for it:

```bash
curl -H "Accept: text/markdown" https://docs.usestratum.dev/guides/getting-started/
```

Appending `.md` to the path works too, and survives intermediary caches that
ignore `Vary: Accept`.

## Skills

Three SKILL.md artifacts cover the things agents actually need to do. Verify the
`sha256` digest from the index against what you download.

- [`stratum-merge-gate`](/.well-known/agent-skills/stratum-merge-gate/SKILL.md) —
  get a change through the evaluation gates, and read the verdict when one blocks
- [`stratum-mcp`](/.well-known/agent-skills/stratum-mcp/SKILL.md) — connect an
  MCP client and use the tool set
- [`stratum-agent-identity`](/.well-known/agent-skills/stratum-agent-identity/SKILL.md) —
  obtain a credential and understand its limits

## WebMCP

Documentation pages register [WebMCP][webmcp] tools on load, so a browser agent
can call the site instead of scraping it: `search_stratum_docs`,
`read_stratum_doc`, `list_stratum_docs`, `get_stratum_api_spec`, and
`get_stratum_agent_auth`. The registration is a no-op in browsers without
`navigator.modelContext`.

## DNS-AID

[DNS-AID][dnsaid] records under the `_agents` namespace let an agent find the
discovery origin without a prior HTTP request:

```text
_index._agents.usestratum.dev.  3600 IN SVCB 1 docs.usestratum.dev. (
                                     alpn="h2,http/1.1" port=443
                                     mandatory=alpn,port
                                     key65280="/.well-known/ai-catalog.json" )
```

`key65280` carries the draft's `well-known` parameter, which has no IANA
allocation yet and so travels in RFC 9460's private-use range. The zone must be
signed with DNSSEC before these records are relied on — discovery records tell an
agent where to send credentials, and unsigned they are trivially spoofable.

The records are kept in
[`website/dns/agents.zone`](https://github.com/stratum-eng/stratum/blob/main/website/dns/agents.zone),
with apply and verification steps in the README beside it.

## OAuth metadata, and why it is not here

The MCP endpoint at `app.usestratum.dev/mcp` is an OAuth 2.1 protected resource,
and `https://app.usestratum.dev` is its authorization server. The two documents a
client needs are published on **that** origin, not this one:

- `https://app.usestratum.dev/.well-known/oauth-protected-resource` — RFC 9728
- `https://app.usestratum.dev/.well-known/oauth-authorization-server` — RFC 8414

That split is not an oversight. Both specs have a client *derive* the URL from an
origin it already holds — the protected resource's in RFC 9728 §3, the issuer's in
RFC 8414 §3 — and both derivations land on `app.usestratum.dev`, which these docs
do not serve. A copy published here would be found only by agents that already
knew to look for it, while every spec-compliant client kept getting a 404 from the
origin that actually matters. So the docs origin names them absolutely, in the
[server card](/.well-known/mcp/server-card.json), and serves neither itself.

An agent needs none of this in advance. `POST /mcp` with no credential; the `401`
carries a `WWW-Authenticate` header naming the protected-resource document, which
points at the authorization server, which offers dynamic client registration. The
whole flow bootstraps from the endpoint URL alone.

## What Stratum does not publish

There is **no `/.well-known/openid-configuration`**, on either origin. Stratum's
access tokens are opaque and it is not an OpenID Connect provider: no `jwks_uri`,
no ID token, nothing to validate offline. Every token is checked against the
database on the call that presents it, which is what makes revocation take effect
on the next request rather than at the next expiry.

There is **no client-credentials grant**, and none is planned. Every MCP grant
starts with a human at a consent screen, because an agent's authority in Stratum
is derived from a person's and that link is the point.

The **REST API is not itself OAuth-protected**. Its credentials are opaque bearer
tokens minted out-of-band by a human account holder, described in
[`/auth.md`](/auth.md). An `mcp:*` access token is accepted there too — a grant
carries its user's authority on every surface — but there is no second OAuth flow
to discover for REST.

Publishing endpoints that do not exist would send agents into a handshake that
cannot complete, which is worse than the metadata being absent — and it is
precisely the class of confidently-wrong machine output Stratum exists to gate.

[webmcp]: https://webmachinelearning.github.io/webmcp/
[dnsaid]: https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/
