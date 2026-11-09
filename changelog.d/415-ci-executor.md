### Added
- **First-party CI: Stratum runs your project's own checks (#415).** Commit a
  `.stratum/ci.yaml` listing named steps — `npm run lint`, `npm test`, whatever
  the project gates on — and Stratum's CI executor runs them for every
  evaluated revision, each step reported as its own check run. A job runs in a
  fresh container that is destroyed afterwards, with no internet beyond an
  allowlist of package registries and **no credential of any kind**. It rebuilds
  the change from its base commit and diff and refuses to run a single step
  unless the result is exactly the tree that was evaluated. See the new
  *First-party CI* guide.
- **Every step in `.stratum/ci.yaml` is a required check**, without being listed
  under `merge.requiredChecks`; mark a step `optional: true` to make it advisory.
  The file is read from the default branch, never from the change, and joins the
  protected configuration files: a change cannot edit the steps it is gated by,
  and a change that touches the file needs an independent approval. If the file
  on the default branch changes after a change's checks ran, the merge is
  blocked until the change is re-evaluated.
- Each step has a **log**, linked from the check and available at
  `GET /api/changes/:id/checks/:checkId/log` to anyone who can read the project.
- The check dispatch sent to a project's own runner gains **`headTreeSha`**, the
  git tree id of the evaluated revision, so a runner that rebuilds a change from
  `baseSha` and `diff` can verify it built the right thing before running
  anything. Existing runners can ignore it.
- Self-hosters: first-party CI needs the new **executor Worker** in
  `ci-executor/`, deployed separately from Stratum, plus a shared
  `CI_EXECUTOR_SECRET` and a `CI_EXECUTOR` service binding (or
  `CI_EXECUTOR_URL`). The *First-party CI* guide lists every step. An instance
  without the executor behaves exactly as before unless a project adds a
  `.stratum/ci.yaml`, in which case its checks are `errored` with a summary
  saying what is missing. The release adds migration
  `077_checks_ci_config_digest.sql` (one nullable column and one index).

### Changed
- **`merge.requireFreshBase` now refuses a merge it cannot verify.** A change
  with no recorded base is refused with `STALE_BASE`, and when the project's
  current head cannot be read the merge is refused with `503 BASE_UNVERIFIABLE`
  instead of proceeding unchecked. The batch merge skips such a change. Retry,
  or re-evaluate the change.
- `merge.requiredChecks` may name a step declared in `.stratum/ci.yaml`.

### Fixed
- **The change diff now applies cleanly with `git apply`.** A new or deleted
  file no longer carries a spurious extra line, a file with no final newline is
  marked as such, an empty file is represented, and executable bits, symlinks
  and mode-only changes are included. Anything that rebuilt a change from
  `baseSha` and `diff` — a webhook or check runner — previously got a different
  tree for these cases. Line counts shown for a new or deleted file drop by the
  one phantom line.
- The change page's diff lists a deleted file under its own name instead of
  `/dev/null`, gives a file with no line changes (an empty new file, a change of
  mode alone) its own section, and no longer shows a file's `new file mode` line
  at the bottom of the file above it.
