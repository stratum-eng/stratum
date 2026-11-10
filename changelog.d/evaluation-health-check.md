### Added
- **A daily check that evaluation still works.** Once a day an instance with a
  Workers AI binding runs its default `llm` model on two built-in diffs, one
  that should pass and one that should not, and counts the evaluations of the
  last 24 hours that ended with no verdict. This would have caught the retired
  default model on the day it was retired.
- **`OPS_ALERT_PROJECT`.** Set it to a project on the instance
  (`"@namespace/slug"`) and a failed health check opens an issue there, and
  closes it when the check passes again. Unset, the default, the result is only
  logged, so a self-hosted instance behaves as before unless it turns this on.
