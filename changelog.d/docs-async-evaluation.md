### Fixed
- **The docs and agent skills no longer say evaluation runs synchronously at change
  creation.** On an instance with an evaluation queue, a new change comes back
  `evaluating` and its verdict lands afterwards, and an agent following the old
  `stratum-merge-gate` skill would act before it arrived. A gated `git push` still
  evaluates on the request.

### Changed
- The self-hosting docs now say Stratum needs the Workers Paid plan.
