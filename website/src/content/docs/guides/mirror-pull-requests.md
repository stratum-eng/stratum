---
title: "Pull requests on the mirror"
description: "Bring a pull request opened on a project's GitHub mirror into Stratum as a change: what waits for a maintainer, the trust model, the contributor agreement, the limits, and what GitHub shows after the merge."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/mirror-pull-requests.md"
---

A project with a [push mirror](/guides/push-mirror/) keeps a read-only copy of itself
on GitHub. People who find it there will open pull requests there, and most of
them will have no Stratum account.

Stratum can bring such a pull request in as a change. A maintainer imports it
with one action. From then on it is reviewed, evaluated, checked and merged in
Stratum like any other change, and the mirror shows the result.

This is off until an admin turns it on for the mirror.

## The short version

1. Someone opens a pull request against the mirror's default branch.
2. Stratum records it as a change in status **`external`**. Nothing runs.
3. A maintainer opens the change, looks at the pull request, and chooses
   **Import pull request**.
4. Stratum brings the pull request's commits into a workspace and evaluates the
   change. It is now an ordinary change.
5. The change is reviewed and merged in Stratum.
6. The mirror pushes the merge to GitHub. The pull request ends up merged or
   closed, with a comment that links to the change.

## The trust model

A pull request is written by someone the project does not know. Its title, the
names and emails on its commits, and every byte of its branch are chosen by
that person. Stratum treats all of it as untrusted input.

**Nothing happens until a maintainer acts.** When a pull request arrives,
Stratum writes two database rows. It does not fetch the commits. It does not
evaluate the change, so no LLM evaluator is called and nothing is spent. It
does not start a CI job. An `external` change cannot be evaluated, reviewed,
approved, or merged. A forced merge is refused too, even where the policy
allows force.

Each new version of the pull request needs a maintainer again. If the
contributor pushes more commits after an import, the change goes back to
`external`. Its earlier verdict, its checks and its approvals stop counting.

**Why CI does not run by itself.** A CI job runs the pull request's own
scripts, and the first-party executor is one small queue for the whole
instance. If pull requests started jobs by themselves, anyone with a GitHub
account could occupy that queue. So CI waits for the import, as evaluation
does.

**A pull request cannot change its own gate.** `.stratum/policy.yaml` and
`.stratum/ci.yaml` are read from the project's default branch, never from the
change. That is true of every change, and it is true here. A pull request that
edits either file is still evaluated under the versions on the default branch.
It is marked as touching protected config. It then needs one approval from
someone other than the maintainer who imported it, whatever the policy says,
and it cannot be force-merged.

**The importing maintainer is the change's author.** Their own approval does
not count towards `merge.requiredApprovals`. The person who decided to bring
the code in is not its independent reviewer. A project with one maintainer can
therefore import a pull request but cannot merge it where approvals are
required, the same limit that applies to that project's other changes.

**CI runs with nothing worth stealing.** An imported change's CI job is the
same kind as any other: the registry allowlist, no secrets, and no credential
beyond a short-lived read of the project's repository. The job is marked as
external, and the executor refuses to run an external job under any profile
other than `ci`. A deployment or a post-merge command can only follow a merge,
and a merge needs a maintainer.

**The fork is never contacted.** GitHub publishes every pull request's commits
on the mirror repository itself, as `refs/pull/<number>/head`. Stratum reads
them from there, with a token that can reach only the mirror repository.

**Text is data.** The pull request's title is stored as one line of text and
shown escaped. Its description is not stored. Neither of them, nor any commit
message, is sent to an evaluator.

Evaluators receive the change's diff, as they do for every change. The diff of
an imported pull request is the contributor's content. An LLM evaluator reads
that content in its prompt, after a fixed system prompt, with no stronger
separation than that. Text in a file can therefore try to steer the LLM's
verdict. Treat an LLM verdict on an imported pull request as advice. Use
`merge.requiredApprovals` so that a person decides.

**Only the configured mirror counts.** A webhook is acted on only if its
signature is valid, the repository GitHub names is the project's enabled
mirror, pull requests are turned on for that mirror, and the pull request
targets the default branch. Anything else is ignored.

## Before you start

You need a working [push mirror](/guides/push-mirror/). In addition:

1. **Give the GitHub App the Pull requests permission.**

   | Permission | Access | Why |
   |---|---|---|
   | **Pull requests** | Read and write | Reading a pull request and its commits. Posting the link back, and closing the pull request after a merge. |

   Someone must accept the new permission on the installation before it takes
   effect. The Contents permission the mirror already has is still needed.
2. **Subscribe the App to the `pull_request` webhook event.** Stratum acts on
   the `opened`, `reopened`, `synchronize`, `edited` and `closed` actions.
3. **The instance has a webhook secret** (`GITHUB_WEBHOOK_SECRET`), and the App
   sends its webhooks to `https://<your instance>/api/webhooks/github`. An
   instance that already receives GitHub webhooks has both.

## Turn it on

In the project, open **Settings**, find **GitHub mirror**, tick **Accept pull
requests**, and save. Only a project admin can do this.

Or use the API:

```bash
curl -X PUT https://app.usestratum.dev/api/projects/@acme/widgets/mirror \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "acme/widgets", "acceptPullRequests": true, "requireContributorAgreement": true}'
```

A request that leaves `acceptPullRequests` or `requireContributorAgreement` out
does not change that setting.

Pull requests that were opened before you turned this on are not brought in
until GitHub sends another event for them. A new push to the pull request, or
an edit to its title, is enough.

## The contributor agreement

If your project has a contributor agreement, tick **Require a contributor
agreement**. A maintainer must then confirm, at import, that the pull
request's author has agreed to it. Without the confirmation the import is
refused (`422 CONTRIBUTOR_AGREEMENT_REQUIRED`).

The confirmation is written to the audit log as
`contributor_agreement.confirmed`, with the maintainer, the change, the pull
request and its author. It is asked for again each time new commits are
imported.

Stratum does not check the agreement itself. It does not read the pull
request's description for a ticked box. How a contributor agrees is your
project's process. This setting records that a named maintainer checked.

For a project like Stratum's own, whose `CLA.md` asks each contributor to
confirm the agreement in their pull request, turn both settings on:

```json
{ "repo": "stratum-eng/stratum", "acceptPullRequests": true, "requireContributorAgreement": true }
```

## Import a pull request

Open the change. Changes waiting for import have the status `external`, and you
can list them with `GET /api/projects/{project}/changes?status=external`.

The change page shows the pull request, its author, its title and its head
commit, with a link to GitHub. Read the pull request on GitHub before you
import it. Importing means its code will be evaluated and its tests will run.

Choose **Import pull request**. The button is a plain form and works without
JavaScript. Or use the API:

```bash
curl -X POST https://app.usestratum.dev/api/changes/chg_123/import \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agreementConfirmed": true, "headSha": "9f2c1e7a…"}'
```

Send `headSha`, the head commit you looked at. If the contributor has pushed
since, the import is refused (`409 PR_HEAD_MOVED`) and nothing is brought in.

Only a person with write access to the project can import. An agent cannot,
even an agent that belongs to a maintainer. There is no MCP tool for it.

What an import does:

- It reads the pull request from GitHub again. The pull request must still be
  open against the default branch.
- It fetches the commits and checks them against the [limits](#limits).
- It joins them to the project's default branch in a new workspace. If the
  pull request is up to date, the workspace ends at the contributor's own
  commit. If it is behind, Stratum adds a merge commit. If it conflicts, the
  import is refused, and the contributor has to update their branch.
- It starts the change's evaluation. Checks are dispatched as usual.

The contributor's commits are kept exactly as they were written. Their name and
email stay on them.

### After new commits

When the contributor pushes again, the change returns to `external`. Choose
**Import new commits** to bring them in. They are added to the same workspace,
so commits a maintainer made there are kept.

A merge checks this again by itself. If the pull request has commits newer
than the ones that were imported, the merge is refused with `PR_HEAD_MOVED`,
whatever state the change is in and even with `force`, and the change returns
to `external` so the new commits can be imported.

A push can still arrive while a merge is already under way. Those commits are
not in what merged. Stratum's comment on the pull request then says which
commit the merge went up to, and asks the contributor to open a new pull
request for the rest.

A maintainer can commit to the workspace like any other. Those commits carry
the maintainer's name, and the contributor's commits keep theirs.

## Merging and what GitHub shows

Merge the change in Stratum as usual. The mirror then pushes the default
branch, and Stratum posts a comment on the pull request that links to the
change.

What GitHub shows next depends on how the change merged.

- **A plain merge keeps the contributor's commits.** They arrive on the
  mirror's default branch. GitHub marks a pull request as merged when its
  commits become reachable from the base branch, so the pull request shows
  **Merged**. Stratum does not need to close it.
- **A squash writes one new commit.** The contributor's own commits never
  reach the default branch, so GitHub cannot tell that the work landed. About
  two minutes after the comment, Stratum closes the pull request through the
  API. It shows **Closed**, not Merged, and the comment says why. The squash
  commit carries a `Co-authored-by` line for the authors of the pull request's
  commits, so GitHub still credits them. At most 10 authors are recorded, in
  the order their commits are read, and an author is left out when the commit's
  name or email cannot be written safely into a trailer (an empty name, or an
  email that is not of the form `name@host`). A plain merge has no such limit,
  because it keeps the commits themselves.

To keep contributors' commits, a change that came from a pull request always
merges on its own. A batch merge skips it and says so.

If Stratum cannot comment on or close the pull request, the merge and the
mirror are not affected. The change page shows the error. The usual cause is
that the App lacks the Pull requests permission.

## Closing

- **The contributor closes the pull request.** The change is closed
  (`rejected`), whether or not it was imported. A change that has already
  merged is not affected.
- **The pull request is reopened.** Stratum starts a new `external` change for
  it. Nothing carries over from the old one.
- **A maintainer rejects the change in Stratum.** The pull request stays open
  on GitHub. Close it there yourself. Later pushes to it do not bring the
  change back; closing and reopening it does.
- **The pull request is retargeted to another branch.** The change is closed.

## Limits

A pull request over a limit is refused, and the change page says which limit.
It stays `external`, with no import offered, until the contributor pushes a
version that fits.

| Limit | Value |
|---|---|
| Commits the pull request adds | 100 |
| Files it adds, changes or deletes | 300 |
| File content it adds or changes | 5 MB |
| Data fetched from GitHub for one import | 20 MB |
| `external` changes one project can hold | 50 |

The first two are checked against GitHub's own counts when the pull request
arrives. All of them are checked again, against the commits themselves, at
import.

Also refused, with the reason shown on the change:

| Code | Meaning |
|---|---|
| `SUBMODULES_UNSUPPORTED` | The pull request adds a git submodule. Stratum does not support submodules. |
| `LFS_UNSUPPORTED` | The pull request adds a Git LFS pointer file. Stratum has no LFS server. |
| `PR_CONFLICTS` | It conflicts with the default branch. |
| `PR_UNRELATED_HISTORY` | It starts from a commit too far behind the default branch, or shares no history with it. |
| `PR_EMPTY` | Every commit in it is on the default branch already. |

When a project already holds 50 `external` changes, a new pull request is not
brought in. Import or reject some of the waiting ones. The pull request is then
brought in at its next event.

There is one `external` change per pull request. Later events update it.

## What is not supported

- Importing from the CLI or over MCP.
- Running CI on a pull request before a maintainer imports it.
- Bringing in pull requests that target a branch other than the default.
- Closing the pull request on GitHub when a maintainer rejects the change.
- Showing Stratum's evaluation results or checks on the GitHub pull request.
- Copying the pull request's review comments into Stratum, or Stratum's into
  GitHub.

## Audit log

| Action | When |
|---|---|
| `external_change.imported` | A maintainer imported a pull request. Names the maintainer, the repository, the pull request, its author and the head commit. |
| `contributor_agreement.confirmed` | A maintainer confirmed the contributor agreement at import. |
| `external_change.closed` | A change was closed because its pull request was closed or retargeted. |
| `external_change.pull_request_closed` | Stratum closed a pull request after its change merged. |
| `review.approvals_dismissed` | New commits arrived on an imported pull request, and its approvals were dismissed. |

Every endpoint is in the [OpenAPI specification](/reference/openapi/); see also
[the endpoint reference](/reference/endpoints/#import-a-pull-request).
