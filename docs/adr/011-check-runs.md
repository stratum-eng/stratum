# ADR 011: Check Runs

## Status

Accepted. Implements issue #414 ("Check runs: asynchronous, per-job CI results
reported back to a change"). Builds on ADR 009.

## Context

The `webhook` evaluator is one HTTP call that must answer with a score inside
its timeout. Real CI takes minutes and reports per job. #414 adds a model in
which Stratum tells a runner about a revision, returns, and accepts the
runner's results later through a signed callback, with `merge.requiredChecks`
gating the merge on them.

That makes an external party's later message decide whether code merges. The
decisions below are about what that party can and cannot cause.

## Decision

### 1. Check names are declared in the base policy; runners never create checks

A `checks` evaluator entry lists the names its endpoint reports
(`checks: [lint, test]`). When a revision is evaluated, Stratum inserts one
`checks` row per declared name and sends the runner their ids. The callback
(`POST /api/checks/:id`) addresses a row by id and can change only its status,
summary and details link.

The alternative — the runner creates checks as it reports, as GitHub's check
runs API allows — was rejected. With it, "a required check named `test`
passed" would mean only "someone holding the key said so, about some
revision". With rows created by Stratum, a required name is satisfied only by
a run Stratum dispatched, for the revision it dispatched it for.

Two loader rules keep that meaningful. A name may be declared by only one
`checks` entry, so each name has exactly one endpoint and one key. And every
name in `merge.requiredChecks` must be declared, so a required check is always
one that gets dispatched. Both fail the policy file closed.

The policy is the one `evaluateWorkspace` already loaded from the project's
default branch. A change cannot add, drop or re-point its own checks.

### 2. Identity is (change, revision, name, attempt); the gate reads the newest attempt for the evaluated revision

`revision` is the evaluated head sha. `checkMergeProtection` reads
`latestChecksForRevision(change.id, change.evaluated_sha)`, so:

- a new revision has no rows until its own dispatch, and the previous
  revision's results are not consulted — nothing has to invalidate them;
- a re-run or a re-evaluation of the same revision inserts `attempt + 1`, and
  the older attempt stops counting whatever its status.

Each dispatch also ends the change's still-pending runs as `errored`
("superseded"), so an abandoned run does not sit `running` until its deadline.

The gate fails closed on anything but `passed`: missing, `queued`, `running`,
`failed`, `errored`. A runner that never reports therefore cannot make a
change mergeable. The deadline sweep is bookkeeping that gives the run a
terminal state; the gate does not depend on it having run, and treats a
pending run past its deadline as overdue on its own.

### 3. A `checks` entry is not an evaluator

It lives under `evaluators:` because that is where a project lists what runs
against a change, but `buildEvaluators` builds nothing for it. An evaluator
must return a verdict, and "dispatched" is not one: reported as a pass it
would satisfy `requireAll: false` single-handedly. So it writes no `eval_runs`
row, does not affect `accepted` / `needs_changes`, and gates only through
`merge.requiredChecks`. Dispatch happens after the verdict for the revision is
recorded, from the three places that record one (inline creation, inline
re-evaluation, the queue consumer).

A failed dispatch is not an evaluation failure either. Its runs become
`errored`, which blocks if they are required and is visible if they are not.

### 4. The callback authenticates by HMAC, with the key resolved from the row's project

The check row stores the `secretRef` **name** and the project id. The callback
resolves the key through the same `resolveSigningKey` the webhook evaluator
uses, for that project, at callback time. Consequences:

- no key material is stored outside `project_secrets`, and rotation takes
  effect on the next report;
- a key valid for one project verifies nothing for another;
- `secretRef` is mandatory for `checks` and a literal `secret` is refused —
  a key readable from the repository could sign a `passed`.

Every failure before the signature verifies returns the same `401`, including
"no such check run", so the endpoint is not an oracle for ids (which are 128
random bits regardless). It reads no session and no token; the anonymous
per-IP rate limit bounds how often an unsigned caller can cause the lookup.

### 5. Replay safety: bound body, sequence numbers, final terminal states

The signature covers only the body, so the body must carry what it is about:
`checkRunId` (must equal the URL's) and `headSha` (must equal the row's
revision). A captured report cannot be pointed at another check or revision.

`sequence` is a runner-supplied, strictly increasing integer. The update is one
conditional statement — still pending, still the newest attempt, inside the
deadline, `last_sequence < sequence` — so a redelivered or reordered report is
acknowledged (`200`, `applied: false`) and changes nothing, and concurrent
reports cannot both win. Terminal states are never left.

A callback is also refused once the change's `evaluated_sha` is no longer the
row's revision.

### 6. `callbackUrl` comes from `APP_URL`

The queue consumer has no request to derive an origin from, and an address
handed to a third party should be the configured one. With `APP_URL` unset, a
dispatch made on a request falls back to that request's origin; one made on
the queue fails closed with a summary naming the setting.

## Consequences

- **Manual conflict resolution** cannot satisfy a required check (there is no
  revision to dispatch for) and is refused when `requiredChecks` is set.
- **Force** skips `requiredChecks` exactly as it skips the other protections,
  and only where `merge.allowForce` is on.
- **Re-running** a check is user-only, like re-evaluation, and stays on the
  same revision; a moved workspace is refused with `STALE_REVISION`.
- **No cancellation signal** reaches the runner; it learns a run is dead from
  the `409` on its next report.
- **New table** `checks` (migration 074): in the backup set and the project
  deletion cascade.

## Alternatives considered

- **Runner-created checks.** See decision 1.
- **A per-check callback token instead of HMAC.** Simpler for a runner, but a
  bearer secret in the dispatch body is one log line away from being leaked,
  and the project already has a signing key the dispatch itself is signed with.
- **Timestamp-window replay protection.** Needs clock agreement and still
  admits replays inside the window; a per-run sequence does not.
- **Making the dispatch a scored evaluator.** See decision 3.
