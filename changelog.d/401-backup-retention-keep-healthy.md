### Fixed
- **Backup retention no longer prunes the last healthy run.** Retention used to keep
  the newest `BACKUP_RETENTION` complete runs whether or not they were restorable, so
  a stretch of failed runs (a misconfigured secret, an R2 permissions change) could
  leave only unrestorable backups. It now reads `healthy` from each run's manifest:
  unhealthy runs no longer take `BACKUP_RETENTION` slots (they still age out after
  that many complete runs), and the newest healthy run is always kept. Worst-case
  backup storage can therefore reach about twice the retention window. Manifests without a `healthy`
  field count toward the window as before. If a manifest cannot be read from R2,
  that run prunes nothing.
