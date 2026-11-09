# Check runs

Check runs let an external CI system report **per-job results back to a change,
asynchronously**. Stratum tells your runner about each evaluated revision and
returns immediately; the runner reports `running`, then `passed` or `failed`,
whenever it is ready — minutes later if need be. A project can require named
checks before a change may merge.

Use check runs when your CI takes longer than a request can wait, or when you
want one result per job. The [`webhook` evaluator](ci-integration.md#the-webhook-evaluator-contract)
is the simpler choice when a single verdict fits in one HTTP response.

| | `webhook` evaluator | Check runs |
|---|---|---|
| Result arrives | In the response, within `timeoutMs` (at most 120 s) | Later, through a signed callback (default deadline 30 minutes, at most 6 hours) |
| Granularity | One score for the whole call | One status per named check |
| Affects the evaluation verdict | Yes, it is scored | No — it gates the merge through `merge.requiredChecks` |
| Gate setting | `merge.requiredEvaluators: ["webhook"]` | `merge.requiredChecks: [name, ...]` |

## Configure it

Check runs are declared in `.stratum/policy.yaml`, on the project's default
branch:

```yaml
evaluators:
  - type: checks
    url: "https://ci.example.com/stratum/checks"
    secretRef: WEBHOOK_CI_SIGNING_KEY   # required: names a project secret
    checks: [lint, test, build]         # every check this runner reports
    timeoutMs: 10000                    # optional: how long the dispatch request may take
    deadlineMs: 1800000                 # optional: how long a check may stay unfinished

merge:
  requiredChecks: [lint, test]          # these must have passed to merge
```

| Field | Required | Meaning |
|---|---|---|
| `url` | yes | Where the dispatch request is POSTed. Must be a public `http(s)` address; redirects are not followed. |
| `secretRef` | yes | Name of the [project secret](ci-integration.md#the-signing-secret) that signs the dispatch **and** verifies the runner's reports. Same rules as the webhook evaluator: it must start with `WEBHOOK_`. A literal `secret` is refused. |
| `checks` | yes | The check names this endpoint reports: 1–64 characters of letters, digits, `.`, `_`, `-` or `/`, starting with a letter or a digit (`-lint` and `.test` are refused). A bad name, here or in `merge.requiredChecks`, makes the whole policy file malformed, which blocks every merge until it is fixed: an entry that cannot be used is a gate its author meant to have, so it is never quietly dropped. At most 32 names per policy file. |
| `timeoutMs` | no | Timeout for the dispatch request. Default 10 000, clamped to 1 000–120 000. |
| `deadlineMs` | no | How long a check may stay `queued` or `running`. Default 1 800 000 (30 minutes), clamped to 60 000–21 600 000 (6 hours). |

Add the signing key in *Project → Settings → Deploy secrets* (or with
`PUT /api/projects/{namespace}/{slug}/secrets/{name}`), under the name you put
in `secretRef`. Rotating it takes effect on the next dispatch and the next
report, with no policy change.

Rules the policy file must follow, or the **whole file is rejected and merges
are blocked** until it is fixed:

- A check name belongs to exactly one `checks` entry. Two entries may not
  declare the same name.
- Every name in `merge.requiredChecks` must be declared by a `checks` entry.
  A required check nothing dispatches could never pass.
- `merge.requiredChecks` must be a list of valid names. A string or a mistyped
  entry is an error, not "require nothing".

You may declare several `checks` entries, each with its own `url`, key and
names — for example a fast linter service and a slow test farm.

A `checks` entry is not scored. It adds no row to a change's evaluator
evidence and does not change whether the change is `accepted` or
`needs_changes`. Do not list `checks` in `merge.requiredEvaluators`; use
`merge.requiredChecks`.

## Where the names come from

**The set of checks is declared in the policy, not created by the runner.**
When a revision is evaluated, Stratum creates one check run per declared name
and hands their ids to the runner. A report addresses an existing check run by
id and can change only its status, summary and details link.

This is what makes a required check trustworthy. A runner cannot:

- create a check, or report under a name it was not dispatched for;
- move a result from one revision of a change to another;
- report for another project, even with a valid key of its own — the key is
  resolved from the project the check run belongs to.

The policy is read from the project's **default branch**, never from the
change. A change that edits `.stratum/policy.yaml` to drop a required check is
still held to the checks the base requires (and, because it edits protected
config, needs a human approval as well).

## Lifecycle

```
queued ──▶ running ──▶ passed
   │           │   ├──▶ failed
   │           │   └──▶ errored
   └───────────┴──▶ errored   (deadline passed, dispatch failed, or superseded)
```

| Status | Meaning |
|---|---|
| `queued` | Created and dispatched; the runner has not reported yet. |
| `running` | The runner reported that work has started. It may report `running` again to update the summary. |
| `passed` | Terminal. The only status that satisfies a required check. |
| `failed` | Terminal. The job ran and did not pass. |
| `errored` | Terminal. The job could not produce a result: the runner said so, the dispatch could not be delivered, the deadline passed, or a newer run replaced this one. |

`passed`, `failed` and `errored` are final. A report that would move a check
out of a terminal state is rejected.

Checks are dispatched each time a revision is evaluated: when a change is
opened, and each time it is re-evaluated. Each dispatch creates **new** check
runs with new ids, and ends any still-pending runs from before.

## The dispatch request (Stratum → your runner)

`POST <url>` with `Content-Type: application/json`:

```json
{
  "event": "checks.requested",
  "changeId": "chg_8f2b…",
  "project": "@acme/api",
  "baseSha": "9c1e…",
  "headSha": "4a7d…",
  "diff": "diff --git a/src/app.ts b/src/app.ts\n…",
  "checkRunIds": { "lint": "chk_51c0…", "test": "chk_a93e…" },
  "callbackUrl": "https://app.usestratum.dev/api/checks",
  "deadline": "2026-11-09T12:30:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `event` | Always `checks.requested`. Also sent as the `X-Stratum-Event` header. |
| `changeId` | The change the checks belong to. |
| `project` | The project, as `@namespace/slug`. |
| `baseSha` | The commit `diff` was computed against. |
| `headSha` | The evaluated revision. Echo it back in every report. |
| `diff` | Unified diff of `baseSha..headSha`. |
| `checkRunIds` | Check name → check run id, for exactly the checks this request asks for. A re-run of one check carries only that one. |
| `callbackUrl` | Report to `<callbackUrl>/<checkRunId>`. |
| `deadline` | ISO 8601 instant after which an unfinished check is `errored`. |

Headers:

- `X-Stratum-Signature: sha256=<hex>` — HMAC-SHA256 of the **raw request body**
  under your signing key. Verify it before trusting the payload, with a
  constant-time comparison.
- `X-Stratum-Event: checks.requested`

**Respond with any `2xx` as soon as you have accepted the work.** The response
body is ignored; the checks stay `queued` until you report. Do not run the jobs
before responding. A non-`2xx` status, a redirect, a timeout or a connection
failure marks the dispatched checks `errored` with the reason, and
re-evaluating the change (or re-running the check) dispatches again.

To apply the change, check out `baseSha` and apply `diff`, exactly as for the
webhook evaluator — see [Wiring your CI to the contract](ci-integration.md#wiring-your-ci-to-the-contract)
and [Running a Webhook Evaluator Executor Safely](webhook-executor.md). The
diff is untrusted code; everything in that guide applies to a check runner.

## The callback (your runner → Stratum)

`POST <callbackUrl>/<checkRunId>` with a JSON body:

```json
{
  "checkRunId": "chk_51c0…",
  "headSha": "4a7d…",
  "status": "passed",
  "sequence": 3,
  "summary": "214 tests passed in 3m 12s",
  "detailsUrl": "https://ci.example.com/runs/8841"
}
```

| Field | Required | Meaning |
|---|---|---|
| `checkRunId` | yes | Must equal the id in the URL. It is inside the signed body so a captured report cannot be replayed against a different check. |
| `headSha` | yes | Must equal the dispatched `headSha`. |
| `status` | yes | `running`, `passed`, `failed` or `errored`. |
| `sequence` | yes | A positive integer that **increases with every report for this check run** — a counter, or milliseconds since the epoch. Stratum applies a report only if its `sequence` is higher than the last one applied. |
| `summary` | no | Plain text shown on the change page. Truncated to 4 000 characters. Omit it to keep the previous one. |
| `detailsUrl` | no | An `http(s)` link to the job, at most 2 048 characters, with no embedded credentials. Omit it to keep the previous one. |

Unknown fields are ignored. There is no field that sets a check's name, change
or revision.

Sign the request the same way Stratum signs the dispatch:

- `X-Stratum-Signature: sha256=<hex HMAC-SHA256 of the raw body under the signing key>`

Send **no** `Authorization` header and no cookie. The signature is the only
authentication; a Stratum API token grants nothing on this endpoint.

### Responses

| Status | `code` | Meaning | What the runner should do |
|---|---|---|---|
| `200` | — | `{ "applied": true, "check": {…} }` — the report was recorded. | Continue. |
| `200` | — | `{ "applied": false, "check": {…} }` — a duplicate or out-of-order report (`sequence` not higher than the last applied). Nothing changed. | Treat as success. This is what makes a retry safe. |
| `400` | `INVALID_REPORT` | The body is signed but not a valid report. | Fix the request; retrying it unchanged will not help. |
| `401` | `INVALID_SIGNATURE` | Missing or wrong signature, **or no such check run**. The two are deliberately indistinguishable. | Check the key and the id. |
| `409` | `STALE_REVISION` | `headSha` is not the check's revision, or the change has moved on to a newer revision. | Stop work on this run. |
| `409` | `CHECK_SUPERSEDED` | A newer run of this check (a re-run or a re-evaluation) replaced this one. | Stop work on this run. |
| `409` | `CHECK_TERMINAL` | The check already finished. | Stop; the result is final. |
| `409` | `CHECK_DEADLINE_EXCEEDED` | The deadline passed before a terminal report arrived. The check is `errored`. | Stop; ask for a re-run. |
| `413` | `PAYLOAD_TOO_LARGE` | The body is over 64 KB. | Send a shorter summary and link to the full log. |
| `429` | — | Rate limited. | Retry after the `Retry-After` header. |

Every `409` carries the current `check` so the runner can see why.

### Retries and ordering

- **Retry on a network failure, `429` or `5xx`, with the same body.** If the
  first attempt was applied, the retry gets `200` with `applied: false`.
- Reports may arrive out of order. `sequence` decides: a late, lower-numbered
  report is acknowledged and ignored.
- Report state transitions, not log lines. The callback shares the
  per-address rate limit for unauthenticated requests (60 per minute by
  default), which is ample for `running` plus a result per check.

## The deadline

Each check run has a deadline, `deadlineMs` after it was dispatched. A check
that has not reached a terminal state by then becomes `errored` with the
summary "The runner did not report a result before the deadline."

A background sweep applies this every five minutes, but nothing waits for the
sweep: the merge gate treats an overdue check as blocking the moment its
deadline passes, and a report that arrives after the deadline is refused.

**A runner that never reports cannot make a change mergeable.** Silence is
never read as a pass.

## The merge gate

`merge.requiredChecks` is enforced with the other merge protections, on both
`POST /api/changes/:id/merge` and the batch merge. For each required name
Stratum reads the **newest run of that check for the change's evaluated
revision**, and blocks unless it is `passed`:

| The required check is… | Merge |
|---|---|
| `passed` | allowed (subject to the other rules) |
| missing — never dispatched for this revision | blocked |
| `queued` or `running` | blocked |
| `failed` | blocked |
| `errored` | blocked |

The blocked response is `403 PROTECTION_BLOCKED` with one reason per check,
for example `Required check 'test' is still running`.

Things that follow from "evaluated revision":

- **New commits invalidate old results.** After you push to the workspace and
  re-evaluate, the change is on a new revision with a fresh set of `queued`
  checks. A pass recorded for the previous revision does not count.
- **Re-evaluating the same revision also starts over.** The new runs replace
  the old ones.
- Checks that are declared but not required are shown on the change and never
  block.

`merge.allowForce` behaves as it does for every other protection: a force
merge skips `requiredChecks` only where the policy has explicitly enabled
force, and never for a change that edits the policy file.

A manual conflict resolution cannot satisfy a required check — there is no
evaluated revision for a runner to report against — so it is refused when
`requiredChecks` is set. Commit the resolution to the workspace and
re-evaluate the change instead.

## Re-running a check

Re-run a check when a job was flaky or the runner never reported. A re-run
creates a new run (attempt 2, 3, …) of the same check **on the same revision**
and dispatches only that check. The previous run stops counting, and if it was
still pending it is ended.

- On the change page: the **Re-run** button beside the check.
- API: `POST /api/changes/:id/checks/:checkId/rerun`
- MCP: `stratum_rerun_check`

A re-run needs write access to the project and a **user** credential: like
re-evaluating a change, it is refused to agent tokens. It is also refused when:

| `code` | Why |
|---|---|
| `EVALUATION_PENDING` | The change is still being evaluated; its checks are dispatched when that finishes. |
| `STALE_REVISION` | The workspace has new commits, or the change has moved to another revision. Re-evaluate the change — that dispatches checks for the new revision. |
| `CHECK_SUPERSEDED` | A newer run of this check already exists. Re-run that one. |
| `CHECK_NOT_DECLARED` | The policy on the default branch no longer declares this check. |
| `CHECK_DISPATCH_FAILED` (`502`) | The new run was created but the runner could not be reached; it is `errored`. |

A re-run does not pick up new commits and cannot be used to carry a result to
code that was never evaluated.

## Seeing check runs

- **Change page** — a *Checks* section lists the newest run of each check for
  the evaluated revision, with status, summary and details link.
- **API** — `GET /api/changes/:id/checks` returns the same set;
  `?all=true` returns every revision and attempt. See the
  [API reference](../api/endpoints/changes.md#check-runs).
- **MCP** — `stratum_list_checks`.

An agent waiting to merge should poll `stratum_list_checks` (or the API) until
every required check is terminal.

## A minimal runner

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const KEY = process.env.STRATUM_SIGNING_KEY;
const sign = (body) => `sha256=${createHmac("sha256", KEY).update(body).digest("hex")}`;

const app = express();
app.post("/stratum/checks", express.raw({ type: "application/json" }), (req, res) => {
  const expected = Buffer.from(sign(req.body));
  const presented = Buffer.from(req.get("X-Stratum-Signature") ?? "");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return res.sendStatus(401);
  }
  const job = JSON.parse(req.body);
  res.sendStatus(202); // acknowledge first, work afterwards
  for (const [name, checkRunId] of Object.entries(job.checkRunIds)) {
    void runCheck(job, name, checkRunId);
  }
});

async function report(job, checkRunId, fields) {
  const body = JSON.stringify({
    checkRunId,
    headSha: job.headSha,
    sequence: Date.now(),
    ...fields,
  });
  const res = await fetch(`${job.callbackUrl}/${checkRunId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Stratum-Signature": sign(body) },
    body,
  });
  // 409 means this run no longer counts (new revision, re-run, finished): stop.
  return res.status;
}

async function runCheck(job, name, checkRunId) {
  if ((await report(job, checkRunId, { status: "running" })) === 409) return;
  const result = await runJobInIsolation(job, name); // see the executor safety guide
  await report(job, checkRunId, {
    status: result.ok ? "passed" : "failed",
    summary: result.summary,
    detailsUrl: result.url,
  });
}
```

`runJobInIsolation` is where your CI lives. It runs code from a diff an agent
wrote: read [Running a Webhook Evaluator Executor Safely](webhook-executor.md)
before you write it.

## Self-hosting notes

- **`APP_URL` must be set** on an instance that evaluates on the evaluation
  queue (the default deployment). It is the public origin put in
  `callbackUrl`; a queue consumer has no request to take one from. Without it
  the checks are `errored` with a summary saying so. An instance that evaluates
  inline falls back to the origin of the triggering request.
- **`DEPLOY_SECRET_KEY` must be set**, as for any project secret. Without it
  the signing key cannot be decrypted, dispatches fail closed, and reports are
  rejected.
- The deadline sweep runs on the existing five-minute cron. No new binding or
  queue is needed.

## Limits and what is not here yet

- Check runs report a status, a summary and a link. There are no log uploads,
  annotations or artifacts.
- Stratum does not cancel work on the runner. A run that has been replaced
  learns of it from the `409` on its next report.
- There is no event or outbound webhook when a check finishes; poll the API or
  the MCP tool.
- A dispatch that fails is not retried automatically. Re-run the check or
  re-evaluate the change.
- The CLI has no check-run commands yet.

## See also

- [CI Integration (Bring Your Own CI)](ci-integration.md) — the synchronous webhook evaluator, and what runs code where
- [Running a Webhook Evaluator Executor Safely](webhook-executor.md)
- [Changes API: check runs](../api/endpoints/changes.md#check-runs)
- [The MCP server](mcp.md)
