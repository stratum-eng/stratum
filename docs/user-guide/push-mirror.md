# Mirroring a project to GitHub

A project that lives on Stratum can keep a read-only copy of itself on GitHub.
After every merge, Stratum pushes the project's default branch and its tags to a
GitHub repository you choose. People can find, clone and read the project there.
Changes still merge in Stratum.

The mirror only ever **fast-forwards**. It never force-pushes, and it never
deletes a branch or a tag on GitHub.

## What a mirror is, and what it is not

A project relates to GitHub in one of two ways, and never both at once:

- **Layer mode.** The project was imported from GitHub and follows it. Stratum
  syncs new commits *from* GitHub, and promotes changes to GitHub pull requests.
- **Forge mode.** Stratum is the source of truth. Changes merge here, and the
  GitHub repository is a mirror that Stratum pushes *to*.

Enabling a mirror puts the project in forge mode. While the mirror is enabled:

- syncing from the source is refused, by hand and on a schedule
  (`409 PUSH_MIRROR_ENABLED`), and a push to the GitHub repository does not
  trigger a sync;
- promoting a change to a GitHub pull request is refused
  (`409 PUSH_MIRROR_ENABLED`).
- If Stratum cannot read whether a project has a mirror, it refuses both with
  `503 PUSH_MIRROR_UNKNOWN` and tries again later. It never treats a failed
  read as "no mirror", and it ignores pull request events from GitHub in the
  same case.

People can still open pull requests on the mirror. To bring those into
Stratum as changes, see [Pull requests on the mirror](mirror-pull-requests.md).

Disable or remove the mirror to go back to layer mode. An imported project can
mirror to the same repository it was imported from. That is the usual way to
move a project from GitHub to Stratum and leave a copy behind.

## Before you start

The mirror pushes with your instance's **GitHub App**, not with a personal
token. You need all of these:

1. **The GitHub App is configured on the instance.** On an instance you do not
   operate, ask its operator.
2. **The App is installed on the mirror repository**, with these repository
   permissions:

   | Permission | Access | Why |
   |---|---|---|
   | **Contents** | Read and write | Pushing commits and tags. Required. |
   | **Workflows** | Read and write | GitHub refuses a push that adds or changes a file under `.github/workflows/` without it. Needed only if your project has such files. |
   | **Metadata** | Read | Always granted with any App. |

   If you add a permission to an App that is already installed, someone must
   accept the new permissions on the installation before it takes effect.
3. **The installation is linked to the project's owner** on the
   [GitHub App setup page](../api/endpoints/github-app.md) (`/github/app/setup`).
4. **You are an admin of the project**: its owner, or an owner or admin of the
   organization that owns it. Write access is not enough, and agents cannot
   configure a mirror.

For each push, Stratum asks GitHub for a short-lived token that can reach only
the mirror repository. No long-lived GitHub credential is stored for a mirror.

The mirror repository should be **empty, or already an ancestor of the
project** (for example, the repository the project was imported from). If it
holds commits the project does not have, the first push reports
[divergence](#divergence) and changes nothing.

## Set up a mirror

In the project, open **Settings**, find **GitHub mirror**, enter the
repository as `owner/repository`, and choose **Set up mirror**.

Or use the API:

```bash
curl -X PUT https://app.usestratum.dev/api/projects/@acme/widgets/mirror \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "acme/widgets"}'
```

Stratum checks that the App can push to the repository before it saves
anything. If it cannot, the response says which of the requirements above is
not met. Saving queues the first push, which carries the whole history.

A GitHub repository can be the mirror of one project only.

## What is pushed, and when

- **The default branch**, after every merge. A merge that a failed post-merge
  check reverts is mirrored too: the revert is a new commit on top.
- **Every tag the project has** that the mirror does not have yet.

Other branches are not mirrored.

A push normally reaches GitHub within a minute of the merge. A merge never
waits for its mirror, and a mirror that cannot push never fails a merge.

When several merges land close together, they may be covered by one push. The
mirror always pushes the branch as it is at that moment, so it ends at the
latest merge whatever order the work ran in.

## Status

The **GitHub mirror** card in project settings shows the state, the last commit
pushed, the last attempt, and the last error. The same information is in
`GET /api/projects/{namespace}/{slug}/mirror`, and in the `mirror` field of
`GET /api/projects/{namespace}/{slug}/sync/status`.

| State | Meaning |
|---|---|
| `idle` | Configured; nothing has been pushed yet. |
| `pushing` | A push is running. |
| `ok` | The mirror matched the project when the last push finished. |
| `retrying` | The last attempt failed. Another is scheduled. |
| `failed` | Stratum has stopped retrying. See [Failures](#failures). |
| `diverged` | The mirror has history the project does not. See [Divergence](#divergence). |

## Failures

A push that fails is retried up to five times in all, waiting 30 seconds, then
1, 2 and 4 minutes between attempts. After that the mirror is left `failed`,
with the reason in **Last error**, and a `mirror.failed` event is emitted.

Some failures are not retried, because no retry would change them: the App is
not installed on the repository, the installation is not linked to the
project's owner, the App lacks a permission, or another project holds the
repository.

A `failed` mirror tries again by itself at the next merge. To retry sooner, fix
the cause and choose **Resume mirror** in settings, or call:

```bash
curl -X POST https://app.usestratum.dev/api/projects/@acme/widgets/mirror/resume \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json"
```

## Divergence

The mirror is **diverged** when the GitHub repository holds something Stratum
would have to overwrite:

- its default branch is not an ancestor of the project's default branch. For
  example, someone pushed or merged a commit directly on GitHub;
- or one of its tags points at a different object than the project's tag of the
  same name.

Stratum then pushes **nothing**, not even the refs that would have gone
cleanly. It marks the mirror `diverged`, emits a `mirror.diverged` event, and
writes a `mirror.diverged` audit entry. Merges continue to work. The mirror does
not move again until an admin resumes it.

To recover:

1. Look at the GitHub repository and decide what the extra history is.
2. If it should be kept, bring it into the project so that the project contains
   it. Normally that means a change in Stratum. If the extra history is a fix
   that had to land on GitHub because Stratum could not merge, and the project
   has not moved since, use the [break-glass resync](#break-glass-resync-from-github)
   instead: it resumes the mirror for you. If the history should not be kept,
   remove it on GitHub yourself. Stratum will not do that for you.
3. Choose **Resume mirror**, or call the `resume` endpoint above.

Resuming never forces a push. If the repository still has history the project
does not, the next push reports divergence again.

To stop pushes to GitHub that cause divergence in the first place, protect the
mirror's default branch on GitHub and allow only the GitHub App to push to it.

## Break-glass: resync from GitHub

The mirror is read-only: nothing on GitHub flows back into the project. There
is one exception, for one situation. Stratum could not merge, so a fix was
committed directly to the GitHub repository. Stratum is healthy again, and the
project must catch up with that fix.

A **resync** fast-forwards the project's default branch to the same branch on
GitHub. Operators: the full incident procedure is the
[break-glass runbook](../runbooks/break-glass-self-hosting.md).

> **A resync bypasses the evaluation gate.** The commits it brings in do not go
> through a change. No evaluator runs on them, nobody approves them in
> Stratum, the post-merge check does not run, and no deployment is started.
> They are on the default branch because an admin said so. Every record of a
> resync says this: the audit entry, the event and the API response all carry
> `evaluated: false` and the list of commits.

### What it does

- **It only fast-forwards.** If the project's default branch is an ancestor of
  the branch on GitHub, the project moves to GitHub's commit. If the two have
  diverged, the resync is refused with `409 RESYNC_DIVERGED`. The error names
  both commits, and nothing changes. A resync never forces, never rewrites
  history, and never creates a merge commit.
- **It does nothing when there is nothing to do.** If the project already
  contains GitHub's commit, the answer is `200` with `"status": "up-to-date"`.
  That is not an error.
- **It reads from one fixed place.** The source is the project's push mirror
  repository, even while the mirror is disabled. A project with no mirror uses
  the GitHub repository it was imported from or is linked to. A project with
  neither gets `409 RESYNC_NO_UPSTREAM`. The request cannot name a repository.
- **It reads with a narrow credential.** Stratum uses a GitHub App installation
  token limited to that one repository, with read-only access to its contents.
- **It only moves the default branch.** Tags and other branches are not
  resynced. A resync does not populate an empty project.

### Who can run it

The project's owner, or an owner or admin of the organization that owns it. The
organization's second-factor policy and IP allowlist apply. The caller must use
a signed-in browser session or a personal API token with the `read_write`
scope. An OAuth grant (an MCP client, or the CLI's sign-in) is refused with
`403 ADMIN_REQUIRES_DIRECT_CREDENTIAL`, and agents cannot run it. There is no
MCP tool for it.

### Run it

In project settings, the **Break-glass: resync from GitHub** card is below the
mirror card. Type the repository's `owner/repository` to confirm, then choose
**Resync from GitHub**. The page works without JavaScript.

Or call the API:

```bash
curl -X POST https://app.usestratum.dev/api/projects/@acme/widgets/resync \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expectedSha": "9f2c1e7a0b3d4c5e6f708192a3b4c5d6e7f80910"}'
```

`expectedSha` is optional, and we recommend it. It is the full SHA of the commit
you reviewed on GitHub. If GitHub's branch is at any other commit, the resync is
refused with `409 RESYNC_SHA_MISMATCH` and nothing changes. Without it, the
resync takes whatever the branch holds at that moment.

```json
{
  "status": "fast-forwarded",
  "branch": "main",
  "source": { "kind": "mirror", "repo": "acme/widgets" },
  "oldSha": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "newSha": "9f2c1e7a0b3d4c5e6f708192a3b4c5d6e7f80910",
  "commits": [
    { "sha": "9f2c1e7a…", "summary": "Fix the merge queue deadlock", "author": "Ada" }
  ],
  "commitCount": 1,
  "commitsTruncated": false,
  "evaluated": false,
  "mirror": { "repo": "acme/widgets", "state": "ok", "pending": true }
}
```

`commits` lists at most 50 commits, newest first. `commitCount` is the true
number.

### What it records

- An audit entry `branch.resync_requested`, written before anything runs. It
  exists even if the request fails later.
- An audit entry `branch.resync_uncertain` when the resync stopped without
  knowing whether its push landed: it timed out, or its run died. It holds the
  commits where they were known, and the reason. The request itself writes
  it, so a request that was cut off after its push leaves no such entry. If
  you never received an answer, check the branch whether or not this entry
  exists.
- An audit entry `branch.resynced` when the branch moves. It holds the old and
  new commit, the source repository, the commits that came in, and
  `evaluated: false`. Every entry names the admin.
- A `branch.resynced` event, with the same data. The event's actor is the admin.

A refused resync writes only the first entry, except the two refusals above
that leave the outcome unknown. An up-to-date resync writes the first entry,
and a `mirror.resumed` entry too when it resumed a `failed` or `diverged`
mirror (see [The mirror afterwards](#the-mirror-afterwards)).

Audit entries are written best-effort. If one cannot be written, the failure
is logged and the resync still runs, so that a broken audit table cannot block
a recovery. After a break-glass resync, check that the entries exist, and
record anything missing where the incident is written up.

### The mirror afterwards

After a resync, the project contains everything on GitHub's branch. The mirror
is brought back in step:

- A healthy, enabled mirror gets a push queued **when the resync moved the
  branch**. That push finds the two already equal, sends nothing, and records
  `ok` at the new commit. An `up-to-date` resync moved nothing and queues
  nothing for a healthy mirror, and a disabled mirror is never pushed to, so
  a resync is not a way to refresh either.
- A mirror that is `diverged` or `failed` is resumed, as **Resume mirror**
  does, and a `mirror.resumed` audit entry is written with `via: "resync"`. A
  mirror often diverges during an incident because a push ran while GitHub was
  ahead with the fix. The queued push then finds the two equal and records
  `ok`. If something else is still wrong, such as a moved tag, the mirror stops
  again as before. Nothing is forced.
- A refused resync does not touch the mirror.

### Open changes

A resync does not rewrite open changes or their workspaces. A change that was
based on the old commit is now behind, exactly as it would be after any other
merge. It is merged against the new default branch when you merge it, and a
conflict is reported then.

### Merges at the same time

On an instance with `REPO_DO_ENABLED`, the resync moves the branch inside the
same per-project Durable Object that serializes merges, so the two cannot
interleave. On an instance without it, merges and resyncs both rely on the
project's repository refusing a push that is not a fast-forward of what it
holds. In both cases, if a merge lands while a resync is running, the resync
is refused with `409 RESYNC_PROJECT_MOVED` and the merge is kept.

## Events and webhooks

| Event | When |
|---|---|
| `mirror.diverged` | A push found the mirror diverged, and pushing stopped. |
| `mirror.failed` | A push failed and will not be retried. |
| `branch.resynced` | An admin fast-forwarded the default branch with a break-glass resync. |

The mirror events carry `repo` (`owner/repository`) and `reason`. Subscribe a
project webhook to them to be told when a mirror stops. `branch.resynced`
carries `branch`, `oldSha`, `newSha`, `repo`, `source`, `commits`,
`commitCount`, `commitsTruncated` and `evaluated: false`.

Every endpoint is in the [OpenAPI specification](../api/openapi.yml); see also
[the endpoint reference](../api/endpoints/projects.md#push-mirror).

## Disable or remove a mirror

- **Disable** keeps the configuration and status and stops pushing. Untick
  **Enabled** in settings, or send `{"repo": "acme/widgets", "enabled": false}`.
  Enabling it again queues a push of everything it missed.
- **Remove** deletes the configuration and status
  (`DELETE /api/projects/{namespace}/{slug}/mirror`).

Neither changes the GitHub repository. It keeps whatever was last pushed.

## Limits

- **Size.** A push clones the default branch into the Worker's memory: recent
  history for a routine push, the full history for the first push and for a
  retry. A repository too large to clone that way cannot be mirrored.
- **Tags.** At most 50 new tags are created per push. A project with more
  catches up over several pushes, by itself.
- **New tags.** A project's remote does not accept tag pushes yet, so the tags
  a project has today are the ones it was imported with. Those are mirrored. A
  tag you create on GitHub is left alone and does not count as divergence.
- **Tags are never updated or deleted.** A tag deleted in the project stays on
  the mirror. A tag moved in the project is reported as divergence.
- **Git LFS objects are not mirrored**, only the pointer files in the tree.
- **Resync size.** A resync loads the default branch into memory, like a push.
  It first loads the newest 50 commits of each side. If that cannot prove a
  fast-forward, it loads the full history of both. The push that moves the
  branch has 25 seconds. Past that the resync answers
  `504 RESYNC_PUSH_TIMEOUT`, which means it stopped **waiting**, not that the
  push was cancelled: the branch may still move. Check the default branch
  before you run it again. If it did move, the retry answers `up-to-date`.

## Operating an instance with mirrors

The mirror runs on its own queue, `stratum-mirrors`, bound as `MIRROR_QUEUE` in
`wrangler.toml`. Create it before you deploy a version that binds it:

```bash
wrangler queues create stratum-mirrors
```

A deploy fails if a bound queue does not exist. If you remove the binding
instead, mirrors still work: a sweep that runs every five minutes pushes them,
so the mirror lags a merge by up to five minutes instead of one.

The same sweep recovers pushes the queue lost, so the queue needs no
dead-letter queue.
