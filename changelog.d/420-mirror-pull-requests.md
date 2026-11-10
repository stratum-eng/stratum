### Added
- **Pull requests on a GitHub mirror can be brought into Stratum as changes.**
  When an admin turns it on for a project's push mirror, a pull request opened
  against the mirror's default branch is recorded as a change in the new status
  `external`. Nothing runs on it: no evaluation, no CI job, and it cannot be
  merged, even by force. A maintainer imports it with one action (a button on
  the change page that works without JavaScript, or
  `POST /api/changes/{id}/import`), which brings the contributor's own commits
  into a workspace and starts the usual evaluation. New commits on the pull
  request send the change back to `external` and dismiss its approvals. After
  the change merges and the mirror has pushed, Stratum comments on the pull
  request with a link to the change, and closes it if GitHub has not marked it
  merged by itself (a squash). See the new guide, "Pull requests on the
  mirror".
- **A contributor-agreement setting for mirrors.** With
  `requireContributorAgreement`, a maintainer must confirm at import that the
  pull request's author has agreed to the project's contributor agreement. The
  confirmation is written to the audit log.
- `GET /api/changes/{id}` returns `externalPullRequest` for such a change, and
  `GET /api/projects/{name}/changes` accepts `?status=external`.
- A squash merge of a change that came from a pull request names the pull
  request's commit authors in `Co-authored-by` trailers.

### Changed
- **Using this needs two changes to the GitHub App**: the **Pull requests**
  repository permission (read and write), accepted on the installation, and
  the `pull_request` webhook event. A mirror that does not accept pull requests
  needs neither and behaves as before.
- The mirror API's responses carry two new fields, `acceptPullRequests` and
  `requireContributorAgreement`, both `false` unless set.
- A batch merge skips a change that came from a pull request, so that its
  commits are kept, and a batch with nothing eligible now returns the skipped
  changes and the reason for each.
- A first-party CI dispatch carries `job.origin` (`project` or `external`). An
  executor from before this release ignores it; a current executor refuses an
  external job under any profile but `ci`.

### Security
- A `pull_request` webhook for a pull request whose head is in another
  repository (a fork) is no longer matched to a layer-mode change by branch
  name. Before this, a fork's pull request whose branch was named like a
  promoted change's branch could re-point that change's pull request link, or
  close the change by being closed.
