# ADR 005: Native `git push` via a Smart-HTTP Proxy

## Status

Proposed

## Context

Stratum's only write path today is the REST API. The CLI's `stratum commit`
reads staged file *contents* from the local index (`cli/src/git.ts`), POSTs them
as a JSON map to `POST /api/workspaces/:name/commit`, and the Worker turns that
into a server-side `commitAndPush` against the project's backing repo
(`src/routes/workspaces.ts`, `src/storage/git-ops.ts`). There is no
`git remote add origin … && git push`.

Users expect a forge to be a git remote. The absence is a real adoption barrier:
existing repos, CI publish steps, `git push` hooks, and the entire muscle memory
of every developer assume `origin` points at something they can push to.

### Why this is impossible today

1. **The real remote is a Cloudflare Artifacts URL, not a Stratum endpoint.**
   Every project/workspace exposes a `remote` of the form
   `https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`. That
   host *does* speak git smart-HTTP — it is how the Worker clones and pushes
   internally with `isomorphic-git`. But it is an implementation detail of where
   we store bytes, not a public interface.

2. **Auth is a short-lived token only the Worker can mint.** Artifacts access is
   HTTP Basic with `username: "x"`, password = an Artifacts token minted
   server-side from the `ARTIFACTS` binding via `freshRepoToken`
   (`src/storage/git-ops.ts`). Tokens carry an embedded `?expires=` and are
   minted fresh per-operation, then discarded. No route vends them to clients,
   and a client has no way to produce one.

3. **Stratum's own domain hosts no git endpoint.** There are no `info/refs`,
   `git-upload-pack`, or `git-receive-pack` routes anywhere in the Worker
   (`src/index.ts`). You cannot point `origin` at `app.usestratum.dev` either.

4. **Direct pushes would bypass every Stratum invariant.** Even if a user
   smuggled an Artifacts write token into the URL, a raw push to the backing
   repo would skip the change/eval gate, the merge queue, activity events, and
   branch protections — the things that make Stratum more than dumb storage.

## Decision

Add a **git smart-HTTP proxy** mounted on the Stratum domain that authenticates
with Stratum credentials and brokers access to the Artifacts backing repo, so a
Stratum repo can be set as `origin` and pushed to with stock git.

### Endpoints

Mounted under the existing project namespace so URLs read naturally:

```
GET  /@:namespace/:slug.git/info/refs?service=git-upload-pack    # clone/fetch advertise
POST /@:namespace/:slug.git/git-upload-pack                      # clone/fetch
GET  /@:namespace/:slug.git/info/refs?service=git-receive-pack   # push advertise
POST /@:namespace/:slug.git/git-receive-pack                     # push
```

Clone/push URL: `https://app.usestratum.dev/@alice/my-project.git`.

### Authentication

Reuse the existing API-key system — no new credential type. Git sends
credentials via HTTP Basic; we accept the API key as the password (username
ignored), mirroring how Artifacts itself is addressed:

```
git remote add origin https://x:<stratum_user_…>@app.usestratum.dev/@alice/my-project.git
```

The proxy validates the key (same path as the REST middleware), authorizes the
caller against the project (read for `upload-pack`, write for `receive-pack`),
then mints a fresh Artifacts token with `freshRepoToken` and proxies upstream.
The Artifacts token never leaves the Worker.

### Push semantics — the gate stays

A `receive-pack` push does **not** write the project's `main` ref directly.
Instead the proxy lands the incoming pack on a server-managed workspace ref and
funnels it through the existing change → eval → merge-queue pipeline, so a
`git push` produces exactly the same artifacts as `stratum commit` followed by a
change:

- Push to the project's default branch → create (or update) a change against an
  auto-named workspace, run evaluation, and either fast-forward or enqueue on the
  `MergeQueue` per existing policy. A rejected eval surfaces to the client as a
  non-zero `git push` exit with the reason in the sideband progress stream.
- Push to `refs/heads/<workspace>` → commit straight to that workspace ref
  (the workspace-commit path), no gate, matching `stratum commit`.

This keeps the invariant that nothing reaches a protected ref without passing the
gate, while making `git push` a first-class producer.

## Consequences

### Positive

- Stratum becomes a real git remote: existing repos, CI, and tooling work
  unchanged.
- No new credential surface — API keys already exist and are already scoped.
- Pushes inherit eval/merge-queue/activity/protection for free; the gate is not
  bypassable.
- Symmetric with `stratum commit`: same backing operations, two front doors.

### Negative

- **Streaming is the hard part.** `receive-pack`/`upload-pack` bodies can be
  large and the protocol is half-duplex; Workers cannot half-duplex stream, the
  same wall called out in ADR 004 for merge pushes. The proxy must buffer pack
  bodies (memory + latency cost) or chunk carefully, and respect request CPU/size
  limits. Large initial pushes are the worst case.
- Mapping eval rejection onto git's sideband channel (so `git push` fails
  legibly rather than hanging or 500-ing) is fiddly and must be got right.
- A second write path to keep in sync with the REST path as the pipeline evolves.
- Smart-HTTP only at first; SSH transport is explicitly out of scope (Workers
  have no raw TCP listener).

## Alternatives Considered

### Vend a short-lived Artifacts token to the client

Add an endpoint that returns a scoped Artifacts token so the user can push
directly to `*.artifacts.cloudflare.net`.

**Rejected:** Leaks the storage backend into the public contract, bypasses the
eval/merge gate entirely, and the token's minutes-long expiry makes for a hostile
UX (re-auth mid-push). Also couples every client to Cloudflare Artifacts URLs we
may want to move off of.

### Git-over-SSH

**Rejected for now:** Workers expose no raw TCP listener, so SSH would need a
separate always-on service — a large operational departure from the
Workers-only architecture. Revisit if smart-HTTP demand proves it out.

### Keep REST-only and lean on the CLI

**Rejected:** `stratum commit` is fine for agents but the lack of `git push` is a
recurring human-adoption objection; "it's not really a git host" is precisely the
gap this closes.

## Implementation

Sketch — a new `src/routes/git-http.ts` router:

```typescript
// GET /@:ns/:slug.git/info/refs?service=git-(upload|receive)-pack
// POST /@:ns/:slug.git/git-(upload|receive)-pack
//
// 1. authenticate(apiKey) — reuse REST auth middleware
// 2. authorize(project, service === "git-receive-pack" ? "write" : "read")
// 3. token = await freshRepoToken(env.ARTIFACTS, remote, scope, logger)
// 4. proxy the smart-HTTP request/response to the Artifacts remote with
//    Basic auth { username: "x", password: extractTokenSecret(token) }
// 5. for receive-pack: intercept the target ref — route default-branch pushes
//    through the change/eval/MergeQueue pipeline; pass workspace-ref pushes
//    straight through. Stream eval/merge status back over the sideband band.
```

Open questions to resolve during implementation:

- Buffer vs. chunk pack bodies within Worker request limits; cap max push size.
- Exact ref convention for "push = open a change" (auto workspace naming, reuse
  vs. create per push).
- Whether `upload-pack` (clone/fetch) ships first as a strictly smaller, lower-
  risk slice, with `receive-pack` (push) following once streaming is proven.
- CLI affordance: `stratum remote add` / printing the push URL on `stratum init`.

## Related Decisions

- [ADR 004: High-Frequency Agent Commits](./004-high-frequency-agent-commits.md)
  — shares the Workers streaming/buffering constraint and the merge-queue gate
  this proxy must funnel pushes through.
- [ADR 001: Namespace Support](./001-namespace-support.md) — the `@ns/slug`
  paths the `.git` endpoints extend.

## References

- Backing-store auth and token model: `src/storage/git-ops.ts`
  (`freshRepoToken`, `makeAuth`, `extractTokenSecret`).
- Current REST write path: `src/routes/workspaces.ts`, `cli/src/git.ts`.
- Git smart-HTTP protocol:
  https://git-scm.com/docs/http-protocol
