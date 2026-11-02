### Fixed
- **`deployment.succeeded` and `deployment.failed` are emitted only once the terminal
  status is actually recorded.** The deploy runner emitted the terminal event even
  when writing the deployment's terminal status to the database failed, or when the
  row had already been finished by another owner. Webhook consumers could then act on
  an outcome the deployment record did not show (the row stayed `running`). No event
  is emitted now unless the write landed; the failure is logged instead.
