### Fixed
- **A change on a larger repository could stay in `evaluating` for twenty
  minutes and then fail.** Building the diff for evaluation read every file on
  both sides of the change, which ran the evaluation worker out of memory on a
  repository of a few hundred files. The worker was stopped before it could
  record a verdict, so the change waited for the stuck-run sweep. The diff now
  reads only the files that differ.
