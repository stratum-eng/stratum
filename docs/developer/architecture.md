# Architecture Overview

## System Components

- **Worker**: Hono API + Web UI
- **D1**: SQLite database
- **KV**: Key-value storage
- **Artifacts**: Git hosting
- **Queues**: Background jobs

## Request Flow

1. Request arrives at Worker
2. Auth middleware validates
3. Route handler processes
4. Storage layer persists
5. Response returned
