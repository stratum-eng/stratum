# changelog.d/

Add one new file here in the same PR as any user-visible change, instead of editing
`## [Unreleased]` in `CHANGELOG.md` directly. Two PRs adding two different files can
never conflict with each other — that's the entire point of this directory.

## Format

Exactly the same [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) snippet
syntax you'd otherwise paste into `Unreleased`: one or more `### Group` headings
(`Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`), each
followed by its bullets. A fragment can carry more than one group.

```markdown
### Added
- **A one-line summary of the feature.** A sentence or two of detail, written for
  someone deciding whether to upgrade — this text ships verbatim as release notes.

### Fixed
- What was broken, and what changed.
```

## Filename

Freeform kebab-case, e.g. `345-fragment-changelog.md`. A PR or issue number prefix is
recommended (not required) — it's the only thing giving merge order any meaning, and
it makes the file easy to trace back to its PR later. Two PRs picking the same
filename is still a one-line create/create git conflict (pick a different name),
nothing like the multi-line content merges this directory exists to avoid.

## What happens to these files

`npm run release:prepare` folds every fragment here into `Unreleased`, cuts the
release, and deletes the files it consumed. Nothing here is meant to survive a
release — if you're reading this after a release just shipped and files are still
here, something folded incorrectly.

See [`docs/developer/releasing.md`](../docs/developer/releasing.md) for the full
release process.
