### Added
- **A webhook's signing secret can now be regenerated in place.** The webhooks page has a
  "Regenerate secret" button on each webhook (with a confirm), backed by
  `POST /api/projects/{namespace}/{slug}/webhooks/{id}/regenerate-secret`. The new secret
  is shown once, exactly as on creation, and the webhook keeps its id, configuration and
  delivery history — previously a lost secret meant deleting and recreating the webhook.
  The old secret stops working immediately, so update your receivers with the new one.
  Each regeneration is recorded in the audit log as `webhook.secret_rotated`.
