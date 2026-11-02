# Staged-tree retention (R2 lifecycle)

The fast merge path (`REPO_DO_ENABLED`, ADR 004) stores an immutable copy of each
workspace commit's staged tree in the `REPO_OBJECTS` bucket, so a merge can read
the tree that was **evaluated** even after the workspace has been pushed again
(#124). These copies live under their own prefix:

```
staged-sha/<projectId>/<workspace>/<sha>
```

## What reclaims them

- **Merges** delete the copy for the change they merge (`src/queue/repo-do.ts`
  and the batch merge in `src/routes/changes.ts`).
- **A bucket lifecycle rule** expires everything else: copies for rejected
  changes, intermediate commits that never became a change, and abandoned
  workspaces (#262).

Expiry is almost always free. A missing copy only costs speed: the merge then
uses the latest-tip tree when it provably matches the evaluated tree, and
otherwise the git path, which merges the same pinned sha.

There is one case where expiry makes a merge fail. It needs all of the following:

- the project's merge policy allows force merges (`allowForce`, off by default);
- a change stays open longer than the expiry;
- the workspace is force-pushed so that the evaluated commit is no longer
  reachable;
- the change is then force-merged.

The force merge skips the workspace-freshness check, the latest tip no longer
matches the evaluated tree, and the git path can't fetch a commit that is gone.
The merge then fails with an error. It never merges the wrong tree. Re-evaluate
the change against the current workspace and merge again. If a project relies on
long-lived changes like this, raise the expiry.

The latest-tip trees (`repos/<projectId>/ws/<workspace>`) and backups
(`repos/<projectId>.pack`) are outside the prefix. The rule can't touch them.

## The rule

The expiry should be well beyond the longest realistic gap between a change's
evaluation and its merge. The copy's age is counted from the commit that wrote
it. 30 days is the default:

```sh
npx wrangler r2 bucket lifecycle add stratum-repo-objects-staging \
  expire-staged-sha staged-sha/ --expire-days 30
npx wrangler r2 bucket lifecycle list stratum-repo-objects-staging
```

Add the same rule to any bucket bound as `REPO_OBJECTS`, including production
when it gets one. The rule is bucket configuration, not code, so a new bucket
doesn't have it until someone runs this.

## Copies written before the prefix change

Copies written before this change sit at `repos/<projectId>/ws/<workspace>/sha/<sha>`.
The rule can't match them, because R2 rules only match a leading prefix and `repos/`
also holds objects that must never expire. Nothing reads them anymore. Only the
staging bucket ever had any. Delete them once with any S3-compatible client
pointed at the bucket's S3 endpoint, for example:

```sh
aws s3 rm "s3://stratum-repo-objects-staging/repos/" --recursive \
  --exclude "*" --include "*/ws/*/sha/*" \
  --endpoint-url "https://<account-id>.r2.cloudflarestorage.com"
```

Run it with `--dryrun` first and check that every listed key contains `/sha/`.

Wait until changes evaluated before the deploy have merged or closed. Until then,
their only copy is at the old key. The new code doesn't read it, so those changes
merge through the fallbacks above, and the case above applies to them as well.
