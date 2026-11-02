# Queue System

## Import Queue

Processes GitHub imports asynchronously.

## Event Queue

Handles notifications and webhooks.

## Deploy Queue

`stratum-deploys` (binding `DEPLOY_QUEUE`) carries post-merge deployments — one
deployment per message, `max_batch_size = 1`, `max_concurrency = 2`,
`max_retries = 2`, `visibility_timeout_ms = 900000`. The visibility timeout is
tied to the bounds in `src/deploy/limits.ts`; raising those limits means raising
it, or a run that outlives its lease is redelivered while still uploading.

A message is retried only for an *indeterminate* failure (D1 or KV unavailable,
the project unreadable). A failed deployment is a result, not a delivery
failure: it is acked with a `failed` row. A malformed message is acked and
logged.

**`stratum-deploys-dlq` has no consumer.** Dead-lettered messages sit there for
manual inspection; nothing alerts and no deployment row is written for them.
Staging uses `stratum-deploys-staging` / `stratum-deploys-dlq-staging` so its
messages can never reach the production consumer.

Deploys also require the `DEPLOY_SECRET_KEY` Wrangler secret; without it every
deployment fails, because project secrets cannot be decrypted. See
[the deployments guide](../user-guide/deployments.md).

## Configuration

```toml
[[queues.consumers]]
queue = "stratum-imports"
max_batch_size = 1
max_retries = 3
```
