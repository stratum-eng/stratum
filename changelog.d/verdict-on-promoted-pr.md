### Fixed

- **A promoted pull request now shows Stratum's verdict.** Promoting a change posts its latest evaluation to the pull request as a comment and a `stratum/evaluation` commit status. Before, the verdict was posted only by evaluations that ran after the pull request existed, so a pull request opened from an already-evaluated change showed nothing, and `stratum/evaluation` could not be made a required check.
