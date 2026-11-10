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
2. If it should be kept, bring it into the project through a change in Stratum,
   so that the project contains it. If it should not, remove it on GitHub
   yourself. Stratum will not do that for you.
3. Choose **Resume mirror**, or call the `resume` endpoint above.

Resuming never forces a push. If the repository still has history the project
does not, the next push reports divergence again.

To stop pushes to GitHub that cause divergence in the first place, protect the
mirror's default branch on GitHub and allow only the GitHub App to push to it.

## Events and webhooks

| Event | When |
|---|---|
| `mirror.diverged` | A push found the mirror diverged, and pushing stopped. |
| `mirror.failed` | A push failed and will not be retried. |

Both carry `repo` (`owner/repository`) and `reason`. Subscribe a project
webhook to them to be told when a mirror stops.

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
