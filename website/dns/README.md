# DNS records for agent discovery

`agents.zone` holds the [DNS-AID][dnsaid] records for `usestratum.dev` —
RFC 9460 ServiceMode SVCB records under the `_agents` underscore namespace that
point agents at Stratum's machine-readable entry points before they make a
single HTTP request.

Nothing here is applied automatically. DNS is registrar state, not build output,
and a bad apply takes the domain down, so publishing is a deliberate operator
action.

## Apply

**Cloudflare dashboard** — DNS → Records → Add record → type `SVCB`, then enter
the name, priority `1`, target, and params exactly as they appear in
`agents.zone`.

**Cloudflare API** — one call per record:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "SVCB",
    "name": "_index._agents.usestratum.dev",
    "ttl": 3600,
    "data": {
      "priority": 1,
      "target": "docs.usestratum.dev.",
      "value": "alpn=\"h2,http/1.1\" port=443 mandatory=alpn,port key65280=\"/.well-known/ai-catalog.json\""
    }
  }'
```

**BIND / any provider that imports zone files** — paste the records from
`agents.zone` into the zone and bump the SOA serial.

## Sign the zone with DNSSEC

Discovery records tell an agent where to send credentials. Unsigned, they are
trivially spoofed by anyone on the resolution path, so the zone **must** be
signed — a validating resolver has to be able to return authenticated data.

On Cloudflare: DNS → Settings → DNSSEC → Enable, then add the resulting DS
record at the registrar for `usestratum.dev`. The zone is not actually protected
until the DS record is published in the parent zone.

## Verify

```bash
# Records resolve, with the expected params.
dig +short _index._agents.usestratum.dev SVCB
dig +short _index._agents.docs.usestratum.dev SVCB
dig +short _api._agents.usestratum.dev SVCB

# DNSSEC. Both must pass — they fail loudly rather than printing nothing, because
# an unsigned zone and a signed one look alike in filtered `dig` output.
dig +dnssec _index._agents.usestratum.dev SVCB @1.1.1.1 \
  | grep -qE '^;;.*flags:[^;]*\bad\b' \
  && echo "OK: resolver returned authenticated data" \
  || echo "FAIL: no ad flag — the zone is not validating"

dig +short usestratum.dev DS | grep -q . \
  && echo "OK: DS published in the parent zone" \
  || echo "FAIL: no DS — the zone is unsigned as far as the internet is concerned"

# Same query over DoH, which is how most agent-side resolvers will ask.
curl -sH 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=_index._agents.usestratum.dev&type=SVCB'
```

`dig` prints unknown SvcParams in the generic `keyNNNNN="..."` form — that is
expected for `key65280` until the draft's `well-known` parameter is registered
with IANA.

## Why `key65280`

The DNS-AID draft defines SvcParamKeys (`well-known`, `cap`, `policy`, `realm`,
…) that IANA has not registered yet. RFC 9460 §14.3.2 reserves 65280–65534 for
private use, which is where an unregistered parameter has to live. `key65280`
carries the draft's `well-known` value. It is deliberately left out of
`mandatory=`: a resolver or client that does not understand the key should still
use the record, and listing it as mandatory would force them to discard it.

[dnsaid]: https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/
