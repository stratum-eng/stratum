### Fixed
- **A change on a larger repository could stay in `evaluating` for twenty
  minutes and then fail.** Evaluation cloned the project and the workspace in
  memory with every file checked out, which ran the evaluation worker out of
  memory on a repository of a few hundred files. The worker was stopped before
  it could record a verdict, so the change waited for the stuck-run sweep.
  Evaluation now fetches only each side's latest commit, without checking the
  files out, and reads only the files that differ. On an 830-file repository
  that halves both the peak memory and the time.
