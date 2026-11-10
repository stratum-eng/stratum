### Changed
- **The change page now says what the change is.** Its heading is the subject
  of the change's first commit instead of the change id, with who opened it and
  which agent wrote it beneath. "Files changed" gives the totals, lists the
  commits, and says when the workspace is behind the project and which commit
  the diff starts from. A promoted change keeps its diff and says that review
  and merging happen on the GitHub pull request.
- **The change page shows the latest evaluation on its own.** A change
  evaluated more than once listed every run in one table, so a failure that a
  later run replaced sat beside the passing result. Earlier evaluations are now
  folded away under the latest one, which is labelled with when it ran and the
  revision it judged.

### Fixed
- The change page had a second merge button at its foot, "Merge into Stratum
  repo". It was shown to everyone, including signed-out visitors who could not
  use it, and on a change with a GitHub pull request, where merging happens on
  GitHub. It is gone: "Merge change" under Actions is the one merge button.
