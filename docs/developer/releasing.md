# Releasing

Stratum releases are **changelog-driven**: `CHANGELOG.md` is the source of truth for
what the current version is and what shipped in it. The tooling reads that file —
nothing derives a version from commit messages, and nobody edits a version number by
hand.

Every version released through this process gets a `vX.Y.Z` git tag and a GitHub
release whose notes are that version's changelog section, so
`.../releases/tag/vX.Y.Z` and the `compare` links in `CHANGELOG.md` resolve.

Production is not gated on a release. Every merge to `main` deploys to production
through `ci.yml`, so a version labels code that is already live.

**Releases cut themselves.** [Release Autopilot](#autopilot) runs daily, and agents and
people only need to add changelog fragments. A release is done when
`gh release view vX.Y.Z` succeeds, and not before: a green workflow run is not proof,
because a dry run is green too.

## The habit

Add a new file under [`changelog.d/`](../../changelog.d/README.md) in the same PR as
the change — not a direct edit to `CHANGELOG.md`'s `## [Unreleased]` section, which is
how two PRs end up editing the same lines. A fragment is the same Keep a Changelog
snippet you'd otherwise paste into `Unreleased`: one or more `### Group` headings
(`Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) with
their bullets.

## Autopilot

`.github/workflows/release-autopilot.yml` runs daily and on demand
(`gh workflow run release-autopilot.yml`). Each run:

1. **Repairs first.** If the newest version in `CHANGELOG.md` has no tag or release, it
   retries that publish and stops there.
2. **Clears leftovers.** It closes its own release PR from a run that died. A held or
   hand-opened release PR stops the run, so it never competes with a person.
3. **Plans.** With no unreleased entries it stops (`npm run release:plan` shows the same
   decision).
4. **Gates.** It runs `prepare`, then lint, typecheck and test:coverage on that exact tree.
5. **Ships.** If `main` moved during the gates, it stops and tries again on the next run.
   Otherwise it opens the PR, checks that only release files changed, and starts **PR
   Checks** on the release branch (its own PRs start none on their own). When
   they pass it squash-merges, then starts **Release** (tag and publish) and **CI**
   (staging, then production).

**What waits for a person:** a release whose notes include `Breaking` or `Removed` entries.
Autopilot opens that PR with the `release-hold` label and doesn't merge it. Merging it
publishes as usual, and no release is cut until it's resolved.

**To stop it:** `gh variable set RELEASE_AUTOPILOT --body off`. Manual runs still work.

**To preview it:** `gh workflow run release-autopilot.yml -f dry_run=true` plans and runs the
gates, and opens, merges and publishes nothing.

**It needs** "Allow GitHub Actions to create and approve pull requests" enabled in the
repository's Actions settings.

### When a release is blocked

Any failure in Autopilot or Release opens one issue labelled `release-blocked`, and later
failures comment on it. It closes itself when a release next publishes. To clear one, open
the linked run and fix what failed, usually a red gate on `main`:

- A failed publish retries on the next daily run, or now with
  `gh workflow run release.yml -f version=X.Y.Z`.
- A failed cut starts again from the current `main` on the next run. Nothing needs cleaning up.
- Don't work around a gate by merging a release PR by hand.

## Cutting a release by hand

You rarely need this: use it to release ahead of the schedule or to choose the bump.

**1. Check there is something to cut, and what it will be.**

```bash
npm run release:pr -- --dry-run
```

This prints the version bump from the current `origin/main` and writes nothing.

**2. Open the release PR.**

```bash
npm run release:pr                 # auto-picks the bump
npm run release:pr -- --bump minor # or major / minor / patch
npm run release:pr -- --co-author "Claude Opus 5.5 <noreply@anthropic.com>"  # agents: see AGENTS.md
```

This needs a clean working tree and a logged-in `gh`, and it leaves you on the new
`release/vX.Y.Z` branch. It refuses to run if a release PR is already open, or if the
newest version in `CHANGELOG.md` never got a tag.

It branches from `origin/main`, runs `prepare` (below), commits as
`chore(release): vX.Y.Z`, pushes, and opens the PR. The checks run as on any other PR.
The PR is the last chance to reword entries, because the changelog text *is* the release
notes. Push edits to `CHANGELOG.md` on that branch; don't re-run the command.

**3. Merge it.** That's the last manual step. The **Release** workflow sees a new version
in `package.json`, re-runs lint, typecheck and test:coverage on that commit, tags it, and
publishes the GitHub release from the changelog section.

The tag goes on the commit that introduced the version, not the tip of `main`, so a PR
merged after the release PR is never in that tag. A PR merged *while* the release PR is
open is in it, because the merge includes it, but its fragment waits for the next release's
notes. If that matters, close the release PR, delete its branch, and cut again.

**4. Confirm.**

```bash
gh release view vX.Y.Z
```

If that fails, read the Release run (`gh run list --workflow=release.yml`), fix the
cause, and retry with `gh workflow run release.yml -f version=X.Y.Z`. Retrying is safe: it
reuses an existing tag and refreshes an existing release.

### What `prepare` does

`npm run release:prepare` is the local step inside `release:pr`, and you can run it alone
to look at the result. It folds every `changelog.d/*.md` fragment into `## [Unreleased]`,
moves the result into a new dated `## [X.Y.Z]` section, opens a fresh empty `Unreleased`,
rewrites the compare links, bumps `version` in the root `package.json`, the matching root
versions in `package-lock.json` (top-level `version` and `packages[""].version`) and
`STRATUM_VERSION` in `src/version.ts`, and deletes the fragments it consumed. The lockfile
edit touches only those two fields; it does not re-resolve dependencies or need the
network.

The bump comes from the group headings across `Unreleased` and every fragment:

| Groups present | Bump |
|---|---|
| `Breaking` or `Removed` | major |
| `Added` | minor |
| anything else (`Changed`, `Fixed`, `Security`, `Deprecated`) | patch |

While the major version is `0`, an inferred major is clamped to a minor — per SemVer,
`0.y.z` may break at any time. Reaching `1.0.0` is a deliberate act:
`npm run release:pr -- --bump major`.

## Running the workflow by hand

Autopilot starts this for you. Run **Release** by hand (Actions, or
`gh workflow run release.yml`) only to:

| Goal | Inputs |
|---|---|
| Retry a publish that failed | `version=X.Y.Z` |
| Republish after correcting a changelog section | `version=X.Y.Z` |
| Publish an older version that never got a release | `version=X.Y.Z` |
| See the resolved commit and exact notes | `dry_run=true` |

Backfilling needs care: an untagged version is tagged on the commit that introduced it
in `package.json`, which is only right if that commit is what shipped. If it isn't,
push the tag to the right commit first and then run the workflow.

A dry run publishes nothing, even though its run is green. Its run name and summary say so.

Pushing a tag does **not** publish anything. GitHub reads a tag push's workflow from the
tagged commit, so that trigger silently did nothing for commits older than the workflow.

The publish step never sees a dependency install: `npm ci` runs only in the `verify` job,
which holds no write permission, so a dependency's install script can't reach a
repository-write credential.

## Checking the changelog

```bash
npm run release:check                # structure + fragments + package.json/lockfile/src/version.ts agreement
npm run release:notes                # print the newest release's notes
npm run release:notes -- 0.1.0       # …or a specific version's
npm run release:latest               # print the newest released version
npm run release:previous             # print the version below it (empty if none)
npm run release:commit               # print the commit the newest release's tag belongs on
```

`release:check` catches exactly the failures this process exists to prevent: a version
with no link definition, an undated or out-of-order release, a `package.json` that
has drifted from the changelog, a `package-lock.json` or `src/version.ts` that has drifted
from `package.json`, and a malformed `changelog.d/` fragment (no content, a
`### Group` heading that isn't one of the seven Keep a Changelog groups, or a group
with no bullets). `tests/changelog.test.ts` runs the same validation against the real
`CHANGELOG.md` and every real fragment, so `npm test` fails before a malformed one can
reach the release workflow. It also checks the real `package-lock.json` against
`package.json`.

## Scope

The root `package.json` version covers the Worker, the deployed platform. The packages
under `cli/` and `agent/` version independently, and `release:prepare` does not touch them.
Nothing publishes them to npm yet.

## Files

| File | Role |
|---|---|
| `CHANGELOG.md` | Source of truth: versions, dates, notes, links |
| `changelog.d/` | Where PRs add their entry — one new file each, folded in and deleted at release time |
| `scripts/changelog.ts` | Pure parsing, fragment merging, bump inference, and rewriting |
| `scripts/release.ts` | The `check` / `latest` / `previous` / `notes` / `commit` / `plan` / `prepare` / `pr` CLI |
| `tests/changelog.test.ts` | Unit tests, plus validation of the real changelog and real fragments |
| `.github/workflows/release-autopilot.yml` | Cuts, gates, merges and starts the publish, daily |
| `.github/workflows/release.yml` | Tags and publishes the GitHub release |
| `scripts/release-alert.sh` | Opens, updates and closes the `release-blocked` issue |
