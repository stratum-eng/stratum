### Added
- **Mark a promoted change's pull request ready for review from Stratum.** A
  promoted change opens a draft pull request, and taking it out of draft meant
  going to GitHub. While the pull request is a draft, the change page's button
  is now "Mark ready for review" (`POST /api/changes/{id}/github-pr/ready`); it
  becomes "Open GitHub PR" once the pull request is ready. A change
  records whether its pull request is a draft (`githubPrDraft`), and follows
  along when that is changed on GitHub.
