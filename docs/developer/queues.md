# Queue System

## Import Queue

Processes GitHub imports asynchronously.

## Event Queue

Handles notifications and webhooks.

## Configuration

```toml
[[queues.consumers]]
queue = "stratum-imports"
max_batch_size = 1
max_retries = 3
```
