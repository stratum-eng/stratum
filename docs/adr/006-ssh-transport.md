# ADR 006: SSH Transport for Git

## Status

Proposed — **exploration only, not pursued now**. HTTPS smart-HTTP (ADR 005)
is the supported transport; this ADR records what an SSH transport would take
so the decision can be revisited on demand. ADR 005 already called this out:
"Smart-HTTP only at first; SSH transport is explicitly out of scope (Workers
have no raw TCP listener)."

## Context

`git clone git@host:owner/repo.git` is the default muscle memory for many
developers, and some environments (locked-down HTTPS proxies, existing SSH
key infrastructure, tooling that assumes SSH remotes) prefer or require it.
Stratum currently serves git exclusively over smart HTTP
(`src/routes/git-http.ts`): `info/refs`, `git-upload-pack`, and
`git-receive-pack` on the Worker, authenticated with API keys over HTTP
Basic. The user-guide FAQ states plainly: "SSH transport is not supported
(Workers have no raw TCP listener)."

### Why SSH cannot live in the Worker

- **No inbound raw TCP.** Cloudflare Workers accept HTTP(S) requests; there
  is no way for a Worker to listen on port 22 (or any raw TCP port) for
  inbound connections. The SSH protocol cannot be terminated in the Worker
  at all.
- **The storage backend speaks smart-HTTP only.** Repositories live on
  Cloudflare Artifacts, addressed as
  `https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`
  and accessed with short-lived tokens minted via the `ARTIFACTS` binding
  (`freshRepoToken` in `src/storage/git-ops.ts`). There is no SSH endpoint
  anywhere in the storage plane, so any SSH front end must translate to
  smart-HTTP anyway.

So SSH support necessarily means a **separate always-on service** in front
of the existing HTTP plane — exactly the "large operational departure from
the Workers-only architecture" that ADR 005's alternatives section rejected.

## Decision

**Do not build SSH transport now.** Smart HTTP covers clone, fetch, and push
(workspace push and the gated default-branch push), works with stock git and
credential helpers, and has produced no demand signal strong enough to
justify running a stateful, always-on SSH service. Revisit when concrete
demand appears (users blocked by HTTPS-hostile environments, enterprise SSH
key policies). The exploration below is the record of what "yes" would look
like.

## Exploration: what an implementation would require

### Hosting the SSH endpoint

The SSH daemon must run somewhere that accepts raw TCP:

| Option | Pros | Cons |
| --- | --- | --- |
| **Cloudflare Containers** | Stays in the Cloudflare account/tooling; scales to zero; close to the Worker for the bridge hop | Newer platform; per-instance pricing; still an always-on-ish footprint for interactive SSH latency; TCP ingress specifics to validate |
| **Small VM (e.g. one $5-tier instance)** | Boring, well-understood sshd/ops story; trivial to run a custom SSH server binary | A second deployment target outside `wrangler deploy`; patching, monitoring, host-key custody, HA are all manual; single region unless multiplied |

Either way the cost is dominated by operations, not compute: a git-SSH
bridge is tiny, but it is a new stateful service with its own uptime, host
keys, and security patching — for a transport the HTTP proxy already covers
functionally.

### Auth design sketch

- **SSH public keys mapped to Stratum users.** A new table (D1) of
  `(user_id, key_fingerprint, public_key, name, created_at)`.
- **Key-management API**: `POST /api/users/me/keys` to add a key (plus list
  and delete), sitting alongside the existing API-key management in
  settings. (This endpoint does not exist today; it would be new surface.)
- **Fingerprint → user resolution.** At SSH auth time the bridge computes
  the offered key's fingerprint and resolves it to a Stratum user; the
  resolved identity then goes through the same project authorization checks
  the HTTP router applies (read for `upload-pack`, write for
  `receive-pack`).

### Backend bridge

After SSH auth succeeds, the bridge executes the requested git service by
proxying to Artifacts, exactly as the HTTP proxy does today in
`src/routes/git-http.ts`:

- Mint a short-lived, scope-appropriate Artifacts token per operation with
  `freshRepoToken` (read for `git-upload-pack`, write for
  `git-receive-pack`); tokens carry an embedded `?expires=` and are never
  persisted or exposed to the client.
- Authenticate upstream with HTTP Basic as `x:<secret>`, where the secret
  is `extractTokenSecret(token)` (the portion before `?expires=`) — the
  same header construction the HTTP proxy's `basicAuthHeader` uses.
- Pipe the SSH channel's stdin/stdout to the smart-HTTP
  `git-upload-pack` / `git-receive-pack` endpoints (protocol translation:
  SSH git speaks the same pack protocol, framed differently).

The bridge would either call the Worker's existing `/@ns/slug.git/*` routes
with a service credential, or (preferably) reuse the Worker as the single
authorization point so the SSH path cannot drift from the HTTP path's
policy decisions — in particular the push gate.

### Scope parity

- **Read-only first**: `git-upload-pack` (clone/fetch) for projects and
  workspaces is the low-risk slice.
- **Push follows the HTTP gate decision**: workspace push proxies verbatim;
  a default-branch push on the project remote must route through the same
  gated-push flow as ADR 005 slice 2b (`GIT_PUSH_GATED_ENABLED`), never
  around it.

## Consequences

### Positive (if built)

- `git@` remotes work; SSH-key-only environments can use Stratum natively.

### Negative

- A second, stateful, always-on service outside the Workers deployment
  model: host-key custody, patching, monitoring, and scaling all become
  ongoing obligations.
- A second auth surface (SSH keys) beside API keys, with its own lifecycle
  UI and revocation story.
- A second transport that must track every future change to the push gate.

## Open questions

- **Host key rotation**: how to rotate the server host key without
  triggering `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED` for every
  user; publish fingerprints where?
- **Rate limiting / abuse**: the HTTP path inherits the Worker's rate
  limiting; the SSH bridge would need its own connection and auth-attempt
  limits.
- **Demand**: no quantified demand yet. What signal (support requests,
  adoption blockers) justifies the standing cost?

## Alternatives Considered

- **Do nothing (chosen)**: HTTPS smart-HTTP suffices for clone, fetch, and
  push today.
- **Vend Artifacts tokens for direct SSH-ish access**: not possible —
  Artifacts itself is smart-HTTP only, and vending tokens was already
  rejected in ADR 005.

## Related Decisions

- [ADR 005: Native `git push` via a Smart-HTTP Proxy](005-git-smart-http-proxy.md)
  — establishes the HTTP transport, the token-minting bridge pattern this
  ADR would reuse, and the original SSH out-of-scope note.

## References

- `src/routes/git-http.ts` — smart-HTTP proxy (auth, `proxyUpstream`,
  `basicAuthHeader`)
- `src/storage/git-ops.ts` — `freshRepoToken`, `extractTokenSecret`
- `docs/user-guide/faq.md` — "SSH transport is not supported"
