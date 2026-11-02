# Releasing

Stratum releases are **changelog-driven**: `CHANGELOG.md` is the source of truth for
what the current version is and what shipped in it. The tooling reads that file —
nothing derives a version from commit messages, and nobody edits a version number by
hand.

Every version released through this process gets a `vX.Y.Z` git tag and a GitHub
release whose notes are that version's changelog section, so
`.../releases/tag/vX.Y.Z` and the `compare` links in `CHANGELOG.md` resolve.

Versions that shipped before this process need their tags backfilled — see
[Publishing a tag pushed by hand](#publishing-a-tag-pushed-by-hand). Until
`v0.1.0` is backfilled its links still 404, and the Release workflow refuses to
publish a version whose predecessor tag is missing rather than ship a release
whose history link is dead.

## The habit

Add a new file under [`changelog.d/`](../../changelog.d/README.md) in the same PR as
the change — not a direct edit to `CHANGELOG.md`'s `## [Unreleased]` section, which is
how two PRs end up editing the same lines. A fragment is the same Keep a Changelog
snippet you'd otherwise paste into `Unreleased`: one or more `### Group` headings
(`Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) with
their bullets. Then cut a release whenever a meaningful feature lands — small and
often beats a quarterly mega-release.

## Cutting a release

**1. Prepare (local, one command).**

```bash
npm run release:prepare            # auto-picks the bump from the Unreleased + fragment groups
npm run release:prepare -- --dry-run          # print the version, write nothing
npm run release:prepare -- --bump minor       # or major / minor / patch
```

This folds every `changelog.d/*.md` fragment into `## [Unreleased]`, moves the result
into a new dated `## [X.Y.Z]` section, opens a fresh empty `Unreleased`, rewrites the
compare links, bumps `version` in the root `package.json`, and deletes the fragments
it consumed.

The bump comes from the group headings across `Unreleased` and every fragment:

| Groups present | Bump |
|---|---|
| `Breaking` or `Removed` | major |
| `Added` | minor |
| anything else (`Changed`, `Fixed`, `Security`, `Deprecated`) | patch |

While the major version is `0`, an inferred major is clamped to a minor — per SemVer,
`0.y.z` may break at any time. Reaching `1.0.0` is a deliberate act:
`npm run release:prepare -- --bump major`.

**2. Open the release PR.** Commit as `chore(release): vX.Y.Z`, get it reviewed and
merged like any other change. The release PR is the last chance to reword entries —
the changelog text *is* the release notes.

**3. Publish.** Run the **Release** workflow (Actions → Release → Run workflow). It
reads the version from `CHANGELOG.md`, checks `package.json` agrees, re-runs
lint → typecheck → test:coverage against the tree it is about to tag, verifies the
predecessor version is already tagged, then creates the annotated `vX.Y.Z` tag and
the GitHub release from the changelog section.

The tag is created through the GitHub API rather than `git push`, so the checkout
never persists a repository-write credential that a dependency's install script
could reach.

Tick **dry run** to see the resolved version and the exact release body in the job
summary without tagging or publishing anything.

**4. Deploy.** Releasing does not deploy. Run **Deploy Production** as usual; the tag
records what that deploy contains.

## Publishing a tag pushed by hand

Pushing a `vX.Y.Z` tag also triggers the workflow, which publishes the release from
the changelog section for that version. This is how tags are backfilled onto commits
that predate the release tooling:

```bash
git tag -a v0.1.0 <commit> -m "v0.1.0"
git push origin v0.1.0
```

Both paths read `CHANGELOG.md` and the tooling from the default branch, never from
the tagged tree — an old commit has neither. Re-running for a tag that already has a
release refreshes its notes rather than failing, so a changelog correction can be
republished.

## Checking the changelog

```bash
npm run release:check                # structure + fragment validity + package.json agreement
npm run release:notes                # print the newest release's notes
npm run release:notes -- 0.1.0       # …or a specific version's
npm run release:latest               # print the newest released version
npm run release:previous             # print the version below it (empty if none)
```

`release:check` catches exactly the failures this process exists to prevent: a version
with no link definition, an undated or out-of-order release, a `package.json` that
has drifted from the changelog, and a malformed `changelog.d/` fragment (no content, a
`### Group` heading that isn't one of the seven Keep a Changelog groups, or a group
with no bullets). `tests/changelog.test.ts` runs the same validation against the real
`CHANGELOG.md` and every real fragment, so `npm test` fails before a malformed one can
reach the release workflow.

## Scope

The root `package.json` version covers the Worker — the deployed platform. The
publishable packages under `cli/`, `agent/`, and `mcp/` version and publish
independently; `release:prepare` does not touch them.

## Files

| File | Role |
|---|---|
| `CHANGELOG.md` | Source of truth: versions, dates, notes, links |
| `changelog.d/` | Where PRs add their entry — one new file each, folded in and deleted at release time |
| `scripts/changelog.ts` | Pure parsing, fragment merging, bump inference, and rewriting |
| `scripts/release.ts` | The `check` / `latest` / `previous` / `notes` / `prepare` CLI |
| `tests/changelog.test.ts` | Unit tests, plus validation of the real changelog and real fragments |
| `.github/workflows/release.yml` | Tags and publishes the GitHub release |
