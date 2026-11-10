# Runbook: Break-glass for a self-hosted Stratum

Stratum's own repository is hosted on Stratum, and GitHub holds a read-only
[push mirror](../user-guide/push-mirror.md) of it. That arrangement has one
circular failure: if a defect in Stratum stops Stratum from merging, the fix for
that defect cannot be merged on Stratum either.

This runbook is the way out. The fix lands on the GitHub mirror, is deployed by
hand, and Stratum then catches up with a **resync**. The same procedure works
for any instance that hosts the code it runs.

> **Status: not yet rehearsed.** The [rehearsal log](#rehearsal-log) is empty.
> Until it has a row, treat every step as unproven on a real instance, and expect
> to find something this document gets wrong. The steps marked *verify in
> rehearsal* are the ones most likely to need correcting.

## When to use it

Use it when **all** of these are true:

- Stratum cannot merge changes to the project that holds its own code, or cannot
  serve requests at all.
- The fix is a code change. A bad deploy with a good previous version needs
  `wrangler rollback`, not this (see
  [deployment](../developer/deployment.md)). A configuration or secret problem
  needs a configuration change.
- Waiting is worse than landing a commit that Stratum's evaluators never saw.

Do not use it to skip a slow review, to land a change that evaluators rejected,
or because the merge queue is busy. Every commit that comes in this way bypasses
the evaluation gate. The audit log is meant to say so permanently, and normally
does, but an audit write that fails is logged and does not stop the resync. So
the audit log is the first record, not the only one: step 8 has you check it
and write anything missing into the incident issue.

## What you need before an incident

Prepare these while everything works. During an incident it is too late.

| Item | Where it lives | Notes |
| --- | --- | --- |
| A Cloudflare API token that can deploy the Worker | Offline: a hardware-backed password manager or a sealed envelope. **Not** in a repository, CI, or a chat tool | Scoped to the one account, with only the permissions `wrangler deploy` and `wrangler d1 migrations apply` need. Give it an expiry and rotate it at each rehearsal. *Verify in rehearsal* that the scope is sufficient and no wider. |
| The Cloudflare account ID | With the token | Not a secret, but you need it. |
| A maintainer with admin rights on the GitHub mirror repository | GitHub | Needed to lift and restore the branch lock. Use an account with a second factor. |
| A Stratum admin for the project | Stratum | The project's owner, or an owner or admin of its organization. They run the resync. |
| A personal Stratum API token with the `read_write` scope, or a browser session | The admin's password manager | An OAuth grant (MCP, the CLI's sign-in) cannot run a resync. |
| A clone of the mirror repository on the maintainer's machine | Local disk | With `npm ci` already run. An incident is a bad time to find that a dependency registry is also down. |

The deploy token is the most dangerous item in this table: it can replace the
running Worker. Keep it offline, give it to as few people as possible, and
record each use in the [incident log](#8-record-the-incident).

## Procedure

Work through the steps in order. Do not skip step 1 or step 6.

### 1. Stop merging on Stratum

Tell everyone, and every agent operator, to stop merging on the affected
project. Stratum has no freeze switch for this. It is a rule people follow.

It matters because a resync only fast-forwards. If any merge lands on Stratum
after the fix lands on GitHub, the two histories diverge, and the resync in
step 5 is refused until someone reconciles them by hand.

Set the names this runbook uses. Every command below reads them, so set them
in the shell you will keep for the whole incident:

First the instance. Run ONE of these two blocks, not both. There is no
default: a rehearsal that inherited the production URL would resync
production.

For a rehearsal:

```bash
STRATUM_URL=https://staging.app.usestratum.dev
```

For a production incident:

```bash
STRATUM_URL=https://app.usestratum.dev
```

Then the rest:

```bash
: "${STRATUM_URL:?set STRATUM_URL first}" && echo "Instance: $STRATUM_URL"
PROJECT=@stratum/stratum                 # the affected project, as @namespace/slug
BRANCH=main                              # that project's DEFAULT branch, if it is not main
ORG=stratum                              # the organization that owns it
# STRATUM_TOKEN: a project admin's personal read_write token. Read it without
# typing it on a command line:
read -rs STRATUM_TOKEN
```

Record the project's current default-branch commit. You compare against it
later:

```bash
curl -s "$STRATUM_URL/api/projects/$PROJECT/mirror" \
  -H "Authorization: Bearer $STRATUM_TOKEN"
```

`lastPushedSha` is the commit the mirror last received. With `"state": "ok"`
and `"pending": false`, it is also the project's commit. If Stratum cannot
answer, read the mirror's default branch on GitHub.

### 2. Lift the branch lock on the mirror

The mirror's default branch is normally locked so that only the Stratum GitHub
App can push to it. Lift that for one maintainer, for the shortest time
possible.

1. On GitHub, open the mirror repository's **Settings → Rules → Rulesets** (or
   **Branches**, for classic branch protection).
2. Let the maintainer push, and nothing more. Do not delete or disable any
   rule. Do not allow force pushes: a force push can rewrite the branch so
   that the resync in step 6 is refused.

   - **Classic branch protection:** add the maintainer to **Restrict who can
     push to matching branches**. Leave **Allow force pushes** off.
   - **Rulesets:** a bypass covers every rule in its ruleset, and the bypass
     list takes roles, teams and apps, not single people. So check first that
     **Block force pushes** is in a different ruleset from the one that
     restricts updates. If one ruleset holds both, create a second ruleset
     that targets the default branch, holds only **Block force pushes**, and
     has an empty bypass list. Then add a team whose only member is the
     maintainer to the bypass list of the ruleset that restricts updates, with
     bypass mode **Always**.
   - **A repository owned by a person, not an organization,** has no teams and
     no push restriction list. With rulesets, add the **Repository admin**
     role to the bypass list instead of a team: on a personal repository that
     is the owner alone. With classic protection the owner can already push
     unless **Do not allow bypassing the above settings** is on; turn that
     setting off for the incident and leave everything else as it is.

   Other rules can refuse the push as well, and each needs its own exception.
   Before the maintainer pushes, read every rule that applies to the branch:

   - **Classic protection, required pull requests:** add the maintainer to
     **Allow specified actors to bypass required pull requests**.
   - **Classic protection, required status checks:** these have no
     per-person exception. Write down the list of required checks, turn
     **Require status checks to pass before merging** off, and turn it back
     on with the same list in step 4.
   - **Rulesets:** a bypass covers only its own ruleset. Add the same team or
     role to the bypass list of every other active ruleset that targets the
     branch and requires a pull request or status checks.

   The one rule that gets no exception is the block on force pushes. Write
   down each setting you change and its value before the change. Step 4 puts
   every one of them back.
3. Note the time. The lock is restored in step 4.

### 3. Land the fix on the mirror

On the maintainer's machine, in the clone of the mirror:

```bash
git fetch origin
git switch "$BRANCH"
git status --porcelain              # must print nothing: a clean checkout
git merge --ff-only "origin/$BRANCH"
# The local branch must be EXACTLY the mirror's, not merely a descendant of it.
# `--ff-only` also succeeds when the local branch is already ahead, and those extra
# commits would then be pushed and resynced in without evaluation.
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" || echo "STOP: the local branch differs"
```

If that last line prints `STOP`, do not continue from this clone. Take a fresh
clone of the mirror.

Make the fix. Then stage it, and run the gates and the commit as ONE command,
so that a failed gate stops the commit:

```bash
git add -A                          # includes new files; `commit -a` would not
git status                          # read it: only the fix's files are staged
npm run typecheck && npm test && npm run lint \
  && git commit -m "Fix: <what broke>"
```

If the commit was made, check what is in it before it leaves the machine. It
must contain every file the fix needs, and nothing else:

```bash
git show --stat HEAD
git push origin "$BRANCH"           # a plain push, never --force
```

If a gate failed, there is no commit and nothing to push. Fix it and run the
command again.

Rules for this step:

- **Keep the fix small.** No evaluator sees it. The local gates are the only
  checks it gets.
- **Only add commits on top of the default branch.** Never rebase, amend or
  force-push it. A rewritten branch cannot be resynced.
- **Record the fix commit's full SHA.** You pin the resync to it in step 5.

### 4. Restore the branch lock

Undo every change made in step 2: remove the maintainer, the team or the
role from each list it was added to, and turn back on any setting that was
turned off. Compare each setting with the value you wrote down. Then confirm
that a push from that account is refused again, if it was refused before the
incident: the owner of a personal repository may have been able to push all
along, and for them the written record is the check. Do this now, before the deploy. The lock must not
stay open while attention is elsewhere.

### 5. Deploy the fix from the maintainer's machine

Deploy the commit you pushed, from the same clone, with the offline token.
These are the commands the `Deploy Production` workflow runs. Set the
environment first; everything below reads it.

First choose the environment. Run ONE of these two blocks, not both. They are
separate on purpose: pasted together, the second would win.

For a rehearsal, with a token scoped to staging only:

```bash
DEPLOY_ENV=staging; D1_NAME=stratum-staging
```

For a production incident:

```bash
DEPLOY_ENV=production; D1_NAME=stratum
```

Set the account, which is an identifier and not a secret:

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id>
```

Then deploy. Paste this as ONE block. It runs in a subshell with `set -e`, so
a missing value or any failed command stops everything after it. Checks typed
as separate lines would not: in an interactive shell a failed check reports
and the next pasted line runs anyway. The token is read inside the subshell,
without appearing on a command line or in the shell's history, and is gone
when the block ends.

```bash
(
  set -eu
  : "${DEPLOY_ENV:?choose an environment first}" "${D1_NAME:?choose an environment first}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set the account id first}" "${STRATUM_URL:?set STRATUM_URL first}"
  echo "Deploying to: $DEPLOY_ENV  ($STRATUM_URL)"
  test -z "$(git status --porcelain)" || { echo "STOP: the working tree is not clean"; exit 1; }
  printf 'Cloudflare API token: ' && read -rs CLOUDFLARE_API_TOKEN && echo
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

  # Only if the fix adds a migration, remove the leading "# " from the next line:
  # npx wrangler d1 migrations apply "$D1_NAME" --remote --env="$DEPLOY_ENV"

  npx wrangler deploy --env="$DEPLOY_ENV"
  curl -sfS "$STRATUM_URL/api/health"
)
```

For a rehearsal, the environment, the token and `STRATUM_URL` must all be
staging's. A staging-scoped token cannot deploy production, which is the
point: do not rehearse with a token that could.

Notes:

- If the instance sets `POSTHOG_PUBLIC_KEY` at deploy time, pass it as the
  workflow does (`--var POSTHOG_PUBLIC_KEY:"$POSTHOG_PUBLIC_KEY"`), or browser
  analytics is off until the next normal deploy.
- `wrangler deploy` fails if a bound queue does not exist. The workflow creates
  missing queues first (`node scripts/wrangler-queues.mjs "$DEPLOY_ENV"`). On an
  instance that has deployed before, they exist.
- If the deploy makes things worse, roll back:
  `npx wrangler rollback --env="$DEPLOY_ENV" --message "<reason>"`. The token
  is gone once the deploy block ends, so run this inside a block of the same
  shape, in place of the deploy and health-check lines.
- If GitHub Actions on the mirror still deploys from the default branch and is healthy, the
  push in step 3 may already have deployed the fix. Check the running version
  before you deploy by hand.

Confirm that Stratum works again: sign in, open the project, and merge a
trivial change on a **different** project if one exists. Do not merge on the
affected project yet.

### 6. Resync Stratum from the mirror

Stratum is healthy, and its copy of the project is behind GitHub by the fix.
Bring it level. An admin of the project runs this, with a browser session or a
personal API token:

```bash
curl -X POST "$STRATUM_URL/api/projects/$PROJECT/resync" \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expectedSha": "<full SHA of the fix commit from step 3>"}'
```

Or, in the project's settings, use the **Break-glass: resync from GitHub** card:
type the mirror's `owner/repository` to confirm, and paste the fix commit's SHA
as the expected commit.

Read the answer:

| Answer | Meaning | Do this |
| --- | --- | --- |
| `200`, `"status": "fast-forwarded"` | The project now holds the fix. `commits` lists what came in. | Check that `commits` is exactly what you pushed. Go to step 7. |
| `200`, `"status": "up-to-date"` | The project already had the fix. | Go to step 7. |
| `409 RESYNC_DIVERGED` | Something was merged on Stratum after the fix landed on GitHub. The error names both commits. Nothing was changed. | See [If the resync is refused](#if-the-resync-is-refused). |
| `409 RESYNC_SHA_MISMATCH` | `$BRANCH` on GitHub is not at the commit you pinned. That is the project's default branch, which need not be the one GitHub calls default. Nothing was changed. | Find out who pushed, and what. Do not resync until you know. |
| `409 RESYNC_PROJECT_MOVED` | A merge landed during the resync. Nothing was changed by the resync. | Stop merges (step 1) and run it again. It will probably report divergence now. |
| `403 SECOND_FACTOR_REQUIRED` or `IP_NOT_ALLOWED` | The organization's policy applies to this action too. | Sign in with a passkey, or run it from an allowed network. |
| `403 ADMIN_REQUIRES_DIRECT_CREDENTIAL` | You used an OAuth grant. | Use a browser session or a personal API token. |
| `502 RESYNC_FAILED` or `504 RESYNC_PUSH_TIMEOUT` | The outcome is unknown. | Read the project's default branch. If it is at the fix commit, the resync worked: run it again and expect `up-to-date`. |

The other codes are in the
[API reference](../api/endpoints/projects.md#resync-from-github-break-glass).

### 7. Confirm the mirror is back to `ok`

A resync that moved the branch queues a mirror push. That push finds the
project and GitHub already equal, sends nothing, and records `ok`. If the mirror
was `diverged` or `failed` during the incident, the resync resumed it first.

A resync that answered `up-to-date` queues nothing for a healthy mirror. That
is the case after a push that timed out and then landed: the retry finds
nothing to do, and the mirror can sit at `"pending": false` with
`lastPushedSha` still at the old commit. If you see that, choose **Push now**
on the mirror card in project settings.

```bash
curl -s "$STRATUM_URL/api/projects/$PROJECT/mirror" \
  -H "Authorization: Bearer $STRATUM_TOKEN"
```

Within a minute or two, expect `"state": "ok"`, `"pending": false`, and
`lastPushedSha` equal to the fix commit. A sweep re-sends a lost message every
five minutes, but on an instance with the mirror queue bound it sends it to
that same queue, so it does not get around a queue that is not delivering.
(Only an instance with no mirror queue pushes from the sweep itself, and it
handles at most three mirrors per run, so a backlog of other projects' mirrors
can delay this one.) If the mirror is still `pending` after ten minutes, find
out which it is. With a queue bound, the likeliest cause is the queue: check
the `stratum-mirrors` queue and its consumer in the Cloudflare dashboard. With
no queue, look at how many mirrors are pending. Either way, **Push now** on the
mirror card in project settings asks again once the cause is cleared.

If the state is `diverged` again, read `lastError`. A tag that was moved on
GitHub is the usual cause. Fix it on GitHub, then choose **Resume mirror**.

Then tell everyone that merging is open again.

### 8. Record the incident

Do this the same day:

1. Check the audit log, with one query per action:

   ```bash
   for action in branch.resync_requested branch.resynced branch.resync_uncertain; do
     curl -s "$STRATUM_URL/api/orgs/$ORG/audit?action=$action" \
       -H "Authorization: Bearer $STRATUM_TOKEN"
   done
   ```

   That query is scoped to an organization. A project a person owns has no
   organization, so its entries are not there. Read them from the instance
   audit log instead, which needs the instance admin key:

   ```bash
   read -rs ADMIN_API_KEY
   for action in branch.resync_requested branch.resynced branch.resync_uncertain; do
     curl -s "$STRATUM_URL/api/admin/audit?action=$action" \
       -H "X-Admin-API-Key: $ADMIN_API_KEY"
   done
   ```

   That log covers every project on the instance, and each answer holds at
   most 100 entries, newest first. Find the entries for this project at the
   time of the incident. If they are not on the first page and the answer has
   a `nextCursor`, ask again with `&cursor=<nextCursor>` until they appear or
   no `nextCursor` comes back. Do not conclude that an entry is missing from
   the first page alone.

   What to expect depends on how step 6 ended:

   - **The branch moved** (`status: "fast-forwarded"`): one `branch.resync_requested`
     and one `branch.resynced`, by the admin who ran it, with the old and new
     commit.
   - **`up-to-date`**: only `branch.resync_requested`. Nothing moved, so there
     is no `branch.resynced` entry and none is missing.
   - **The push timed out and then landed** (`RESYNC_PUSH_TIMEOUT`, and a retry
     answered `up-to-date`): two `branch.resync_requested` entries, one
     `branch.resync_uncertain`, and **no** `branch.resynced`. The branch moved
     without the entry that normally records it. The `branch.resync_uncertain`
     entry names the commit the branch was at and the one GitHub had, where
     they were known. Write both into the incident issue, and confirm the new
     one against the branch's current tip.
   - **The run died** (`RESYNC_FAILED`): one `branch.resync_requested` and one
     `branch.resync_uncertain`, which may carry no commits, because the run
     did not report back. Read the default branch to learn what happened.

   If an entry you expect is missing, an audit write failed. Say so in the
   incident issue and record the details there by hand.

2. Open an issue that records: what broke, when merging stopped and restarted,
   the fix commit, who lifted the branch lock and for how long, who used the
   deploy token, and the audit entries found in step 1.
3. Review the fix commits as you would have reviewed a change. They were never
   evaluated. If the review finds a problem, fix it through a normal change.
4. Rotate the deploy token if it left offline storage for longer than the
   deploy, or if you are not sure where it was typed.
5. Confirm on GitHub that the maintainer is not on the bypass list.

## If the resync is refused

`RESYNC_DIVERGED` means the project and the mirror each have commits the other
does not. A resync never fixes that, by design. Stratum cannot rewind a branch,
so the project's history stays, and the fix has to join it:

1. Bring the fix into Stratum as a change. Create a workspace, apply the fix
   commits there (for example with `git cherry-pick`), and merge the change
   through the normal gate. The fix is then evaluated like any other change.
2. The mirror is still diverged, because GitHub holds the original fix commits
   and the project holds copies with different SHAs. Agree with the other
   maintainers, then remove the original commits from the mirror's default
   branch by hand on GitHub. This is the one force push in this runbook, it is
   made by a person on GitHub, and Stratum never makes it.

   The branch lock you restored in step 4 refuses it, and step 2 told you not
   to allow force pushes. So this needs its own, separate exception, for one
   maintainer:

   - **Classic branch protection:** add the maintainer to **Restrict who can
     push to matching branches**, and set **Allow force pushes** to **Specify
     who can force push**, naming only that maintainer.
   - **Rulesets:** leave **Block force pushes** enabled, so that everyone else
     who can push is still refused. Add a team whose only member is the
     maintainer to the bypass list of the ruleset that restricts updates and
     of the ruleset that blocks force pushes.

   Make the push, then undo the exception at once: remove the maintainer or
   the team from every list it was added to, and turn **Allow force pushes**
   off again. Confirm that a push from that account is refused. Record who did
   it, and for how long, in the incident issue.
3. Choose **Resume mirror**. Stratum pushes the project's history, and the
   mirror returns to `ok`.

This is slow, and it rewrites the mirror. Step 1 of the procedure exists to
avoid it.

## What a resync does not do

- It does not run evaluators, the post-merge check, or a deployment.
- It does not move tags or any branch except the default branch.
- It does not rewrite open changes. A change based on the old commit is merged
  against the new default branch when you merge it.
- It does not force, on either side, in any case.

## Rehearsal log

Rehearse this runbook on **staging** before you rely on it, and again after any
change to the resync, the mirror, or the deploy process. A rehearsal runs every
step against a staging project with a staging mirror repository, including the
manual deploy with a staging-scoped token. Never rehearse with a production
token.

Add a row for each rehearsal: the date, who ran it, the staging project, the
fix commit that was resynced, the result, and anything the runbook got wrong.

| Date | Operator | Project | Fix commit | Result | Notes / issue |
| --- | --- | --- | --- | --- | --- |
