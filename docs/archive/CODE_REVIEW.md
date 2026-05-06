# Stratum — Code Review (Phases 1–4)

**Reviewer:** Claude (principal-engineer perspective)
**Scope:** Commits `9947315`, `e424e16`, `af2a8a2` on `main` (≈5,800 LOC across 63 files)
**Date:** 2026-04-29

---

## Tooling status

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm test` (`vitest run`) | 224/224 passing across 16 files |
| `npm run lint` (`biome check`) | **101 errors** (mostly quote style and import ordering) |

The green test suite is misleading. Several of the bugs called out below are
faithfully reproduced — and pinned in — by the tests. A passing suite here
means "code does what was written," not "code does what we want."

---

## 1. Blocking issues

These are the items I would not let through code review. They are correctness or
security defects that affect the product's trust model.

### 1.1 Authorization is absent on the data plane

`authMiddleware` resolves a `userId` or `agentId` and attaches it to the request
context, but the resource routes do not enforce it.

- `src/routes/projects.ts` — no `c.get('userId')` references at all. Anyone
  (including unauthenticated callers) can `POST /api/projects` to create a
  project, list files, read commit logs, or trigger imports.
- `src/routes/workspaces.ts` — same: no auth checks. Workspace creation and
  listing are open.
- `src/routes/changes.ts` — reads `agentId` only to *attribute* provenance
  (`changes.ts:38`, `changes.ts:190`); never to enforce that the caller owns
  the project or workspace. `POST /changes/:id/merge` will merge **any** change
  for **any** caller with a valid token.
- `src/storage/orgs.ts:60-75` — `addOrgMember` accepts any `userId` from the
  request body. There is no invitation flow, no existence check, and no
  consent.

The `orgs` and `teams` routes added an `isOrgAdmin` gate, but it never reaches
the resources orgs are meant to govern (projects, workspaces, changes).

**Fix:** introduce an ownership model — `projects.owner_user_id` /
`projects.org_id` columns, plus a `requireProjectAccess(projectName, userId)`
helper that every project-scoped route calls. Reject unauthenticated callers
explicitly on every state-changing endpoint.

### 1.2 The "diff" the evaluators consume is not a real diff

`getDiffBetweenRepos` (`src/storage/git-ops.ts:~210`) emits, for any changed
file, the entire old file as `-` lines and the entire new file as `+` lines,
under a fabricated `@@ -1,N +1,M @@` hunk header. Consequences:

- **DiffEvaluator** measures file size, not change size. A one-line tweak to a
  large file blows past `maxLines` every time.
- **SandboxEvaluator** (`src/evaluation/sandbox-evaluator.ts`) reconstructs
  files from `+` lines only and writes them into a fresh sandbox FS. There is
  no base tree — `npm test` cannot succeed unless the *entire* project,
  including `package.json` and `node_modules` provisioning, came in as new
  content. In practice this evaluator is unusable for any real workspace.
- **SecretScanEvaluator** sees every existing secret-shaped string in the file
  as "newly added," generating false positives proportional to file size.
- **LLMEvaluator** receives a misleading transcript that describes every change
  as a full-file rewrite.

**Fix:** produce a real unified diff. Either use `isomorphic-git`'s
`walk` + a proper line-diff library (`diff` npm package), or compute per-file
patches by hashing blocks. At minimum, the hunk header math must reflect actual
line ranges.

### 1.3 `mergeWorkspaceIntoProject` silently overwrites on any failure

`src/storage/git-ops.ts:~95` wraps `git.merge` in a `try`/`catch` and falls
through to `squashMerge` on **any** error, including legitimate merge
conflicts. The squash:

- Computes "changed" files by comparing blob OIDs and overwrites the project
  copy with the workspace copy (`git-ops.ts:~140`).
- **Does not handle deletions.** Files removed in the workspace remain in the
  project after merge.
- **Drops project commits made after the workspace forked**, because the squash
  is committed on top of `main` with workspace contents.

This is a silent data-loss path. A user who calls `merge` on a stale workspace
loses any concurrent commits.

**Fix:** distinguish "merge failed for a recoverable reason" (e.g. ref not
found) from "merge produced conflicts." Surface conflicts to the caller. Make
squash-merge an explicit `?strategy=squash` opt-in, and handle deletions when
implementing it.

### 1.4 Secret scanner pattern set is too noisy to trust

`src/evaluation/secret-scanner.ts` includes:

```ts
{ name: 'Generic high-entropy secret', pattern: /[A-Za-z0-9+/]{40,}={0,2}/ }
```

This matches every git OID, every SHA-256 hex string, every JWT, and most
lockfile entries — anything ≥40 base64-ish chars. The added tests
(`tests/secret-scanner.test.ts`) only exercise the AKIA case; the high-entropy
path is untested. Once a real PR contains a lockfile or a minified asset, this
fires constantly and users will turn off scanning.

**Fix:** remove the generic pattern, or replace it with a true entropy
calculation (Shannon entropy ≥ 4.5 bits/char) gated on a context check
(assignment to a key-shaped variable, etc.). Pair the rule with a
`.stratumignore`-style exclusion list (lockfiles, build artifacts).

### 1.5 OAuth `next` parameter is not bound to `state`

`src/routes/auth.ts` reads `next` directly from the callback query and uses it
for the post-login redirect. The state token validates that the OAuth
roundtrip is fresh, but it is not bound to the `next` value, so an attacker
can craft a login link with their own `state` and a victim's `next` and
control the redirect target. The relative-URL check
(`new URL(next, 'http://localhost')` + hostname allowlist) is a reasonable
backstop, but it relies on the URL parser behaving exactly the way we expect.

**Fix:** sign `next` into the `state` token (or store both together in KV),
and require `next` to begin with `/` and not `//`.

### 1.6 Rate limiter is fail-open and racy

`src/middleware/rate-limit.ts` does a KV `get` followed by a KV `put`, which
is a TOCTOU window — concurrent requests will under-count. KV is also
eventually consistent, so the read can be stale. On any KV error the limiter
allows the request through with no metric or alert.

For a 60 rpm anonymous limit this is acceptable. As a security control it is
not.

**Fix:** move the counter to a Durable Object (one DO per identifier, or a
sharded set), and either fail-closed or emit a metric on KV errors so we can
tell when the limiter is silently disabled.

---

## 2. Architectural concerns

### 2.1 Workers are the wrong shape for this workload

A single Worker hosts: HTTP routing, OAuth, isomorphic-git over MemoryFS,
sandbox orchestration, AI calls, queues, cron sweeps, telemetry, and a JSX UI.
Cloudflare Workers have a 128MB memory ceiling and CPU-time limits that this
workload will violate at the first non-trivial repo.

- `getDiffBetweenRepos` clones **two** repos into RAM in parallel
  (`git-ops.ts:~225`).
- `mergeWorkspaceIntoProject` clones one full project tree, fetches another
  remote into the same MemoryFS, then walks both trees.
- `syncAllProjects` clones every project sequentially in a single cron tick.

**Recommendation:** push git-ops to a backend with a real filesystem (a
Container, a Durable Object with R2-backed FS, or off-platform). Keep the
Worker as the routing/auth tier.

### 2.2 `MergeQueue` is a misnomer

The Durable Object provides per-project serialization for merges, which is
correct. But there is no queue, no retry, no backpressure, and no dead-letter
behavior. The merge is invoked synchronously from the request path
(`changes.ts:~150`) and blocks on the DO call.

**Recommendation:** either rename to `MergeCoordinator` to match the actual
contract, or implement actual queuing with the existing `EVENTS_QUEUE` and a
status-polling endpoint.

### 2.3 `EVENTS_QUEUE` consumer is a no-op

`src/index.ts:53-58` consumes the events queue and only `console.log`s. Either
remove the binding until there is a real consumer, or implement the consumer
that the events were designed for (PostHog fanout, webhook delivery, etc.).
Right now this is paying queue costs to print to stderr.

### 2.4 `syncAllProjects` and `runTtlSweep` will not scale

- `runTtlSweep` (`src/queue/ttl-sweep.ts`) reads only the first page of
  `STATE.list({ prefix: 'workspace:' })`. There is no `cursor` loop. With
  more than ~1,000 workspaces, items past page 1 are never swept.
- `syncAllProjects` clones every project sequentially in one cron tick. No
  per-project timeout, no concurrency limit, no failure isolation visible to
  the operator.

**Fix:** paginate the KV list; bound concurrency on sync (e.g. `Promise.all`
in batches of 5 with a per-project timeout); record sync results to D1 so
operators can see failures.

### 2.5 Two stores, no referential integrity

Project identity lives in KV (slug → entry); `changes.project` in D1 is free
text. `eval_runs` is defined in `migrations/001_core.sql` but **no code writes
to it** — dead schema. The route trees overlap: `changesRouter` mounts at
`/api` and owns `/projects/:name/changes`, while `projectsRouter` mounts at
`/api/projects` (`src/index.ts:34-41`). Adding a `/projects/:name/changes`
route to the projects router will silently shadow the changes router.

**Fix:** consolidate identity in D1 with `projects.id` as the primary key and
`projects.slug UNIQUE`; treat KV as a per-request cache. Wire `eval_runs` or
delete the table. Mount both routers under non-overlapping prefixes, e.g.
`/api/projects/:name/changes` owned by a single router.

### 2.6 LLM evaluator leaks policy secrets into the prompt

`src/evaluation/llm-evaluator.ts:~22`:

```ts
content: `Policy context: ${JSON.stringify(policy)}\n\nDiff to review:\n${diff.slice(0, 8000)}`
```

If the policy includes a `webhook` evaluator with a `secret`, that secret is
serialized into the LLM prompt. Workers AI may log prompts; third-party
models definitely do.

**Fix:** filter the policy down to a sanitized projection before including it
in the prompt. Never send `secret` fields.

---

## 3. Quality / maintainability

- **Token model is sound.** 128-bit random keys, SHA-256 hashed at rest,
  constant-time comparison, prefix-distinguished scopes. No SQL injection
  surface (D1 prepared statements throughout).
- **`agents.token_hash` is not `UNIQUE`.** Collision is astronomically
  unlikely, but the index should exist anyway because every authenticated
  request hits `getAgentByToken`.
- **`changes.ts` mounts at `/api`** while owning `/projects/:name/changes` —
  fragile. Move under a single, explicit prefix.
- **`POST /api/projects` initializes a new repo with sample `README.md` and
  `src/index.ts`** when no `files` provided (`src/routes/projects.ts:9-12`).
  Fine for dev, surprising in prod. Make it opt-in via `?seed=true`.
- **101 lint errors** are almost entirely Biome's `useDoubleQuote` and
  `organizeImports` rules. Run `npm run lint:fix`. If we don't agree with the
  rules, change `biome.json` rather than leave them failing.
- **`migrations/002_sessions.sql` uses `ALTER TABLE agents ADD COLUMN`**
  unconditionally. SQLite has no `IF NOT EXISTS` for columns. D1's
  `_d1_migrations` table prevents re-run in production, but any test harness
  that resets state mid-run will hit this. Consider rewriting as
  `CREATE TABLE agents_new ... ; INSERT INTO agents_new SELECT ... ; DROP
  TABLE agents; ALTER TABLE agents_new RENAME TO agents;` if the column
  shape needs to be schema-stable across re-runs.

---

## 4. Process

- **A single 5,800-line commit titled "Phases 1–4" is unreviewable.** The
  follow-up `fix: D1 database ID, SQLite ALTER TABLE syntax, Queues setup`
  confirms the platform did not work end-to-end on first push. Future work
  should land per-phase, ideally per-feature.
- **Tests pass but pin in the bugs.** `tests/sandbox-evaluator.test.ts` and
  `tests/evaluation.test.ts` exercise the broken diff format as if it were
  correct. We need at least one integration test that runs the full pipeline
  — create project → workspace → real change → diff → evaluate → merge —
  against a local Artifacts namespace, so divergence between intent and
  implementation surfaces.
- **No CI configured.** A `gh-actions` workflow that runs `npm run lint &&
  npm run typecheck && npm test` on every PR is the cheapest available
  guardrail.
- **The `claude/review-repo-status-pJsWO` branch was deleted upstream while
  the new platform code shipped to `main`.** Branches that work is in flight
  on should not be deleted; if the convention is "delete after merge,"
  document it.

---

## 5. Recommended order of fixes

1. **Authorization on data-plane routes** (1.1) — the security floor.
2. **Real unified diff in `getDiffBetweenRepos`** (1.2) — unblocks every
   evaluator.
3. **Surface merge conflicts; gate squash behind opt-in; handle deletions**
   (1.3) — closes the data-loss path.
4. **Drop the high-entropy regex** (1.4).
5. **Bind `next` to `state` in OAuth** (1.5).
6. **Move git-ops off the Worker** (2.1) — necessary before real users.
7. **CI + integration test** (process) — to keep all of the above from
   regressing.

Items 8+: rate limiter to DO, paginate TTL sweep, sanitize LLM prompt,
consolidate routers, wire or remove `eval_runs` and `EVENTS_QUEUE` consumer.

---

## 6. What's done well

- Cleanly composed Hono middleware
- `httpOnly` + `Secure` + `SameSite=Lax` session cookie
- D1 migrations split per concern; prepared statements throughout
- Per-project DO serialization for merges is the right primitive
- PostHog client is gated behind an explicit disable flag and fails open with
  a swallow — appropriate for telemetry
- Test breadth is encouraging; the tests are real, not snapshot stubs
