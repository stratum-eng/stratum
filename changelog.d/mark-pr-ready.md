### Added
- **Mark a promoted change's pull request ready for review from Stratum.** A
  promoted change opens a draft pull request, and taking it out of draft meant
  going to GitHub. The change page now has a "Mark ready for review" button
  beside "Open GitHub PR" (`POST /api/changes/{id}/github-pr/ready`). A change
  records whether its pull request is a draft (`githubPrDraft`), and follows
  along when that is changed on GitHub.
