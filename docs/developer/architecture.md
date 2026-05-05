# Stratum Architecture

**Last Updated:** 2026-05-05  
**Strategic Position:** Progressive buy-in platform supporting both GitHub layer mode and full alternative mode

## Overview

Stratum is an agent operations platform built on Cloudflare Workers. It supports two modes of operation:

1. **Layer Mode (minimal buy-in):** Stratum sits between agents and GitHub. Developers use Stratum for agent workflows, team reviews in GitHub PRs.
2. **Alternative Mode (full buy-in):** Stratum is the source of truth for repos, workspaces, and changes.

The same codebase supports both modes. Users choose their level of adoption.

## System Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **API & UI** | Cloudflare Worker + Hono | Request handling, JSX rendering |
| **Database** | D1 (SQLite) | Structured data (users, projects, changes, provenance) |
| **Cache/Queue State** | KV | Session tokens, sync status, ephemeral state |
| **Git Hosting** | Artifacts | Repository storage, forking, merging |
| **Queues** | Cloudflare Queues | Background job processing |
| **Email** | Cloudflare Email | Magic link authentication |
| **Object Storage** | R2 (optional) | Large artifacts, behavioral traces |

## Request Flow

```
Client Request
    ↓
Cloudflare Worker
    ↓
Auth Middleware (session cookie → userId)
    ↓
Route Handler (Hono router)
    ↓
[Storage Layer | Queue Layer | External API]
    ↓
Response (JSON or HTML)
```

## Data Architecture

### D1 Schema (Core Tables)

#### Users & Authentication
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### Projects (Repositories)
```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  namespace TEXT NOT NULL,  -- @username or org-slug
  slug TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_type TEXT NOT NULL, -- 'user' | 'org' | 'agent'
  remote TEXT NOT NULL,     -- Artifacts remote URL
  token TEXT NOT NULL,      -- Artifacts token
  source_url TEXT,          -- GitHub URL if imported
  provider TEXT,            -- 'github' | 'gitlab' | 'bitbucket'
  visibility TEXT DEFAULT 'private',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### Workspaces
```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  remote TEXT NOT NULL,     -- Artifacts remote URL
  token TEXT NOT NULL,      -- Artifacts token
  agent_id TEXT,            -- If created by an agent
  objective TEXT,           -- Agent's objective for this workspace
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### Changes (Merge Proposals)
```sql
CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT REFERENCES workspaces(id),
  title TEXT NOT NULL,
  description TEXT,
  author_type TEXT NOT NULL,  -- 'human' | 'agent'
  author_id TEXT NOT NULL,
  status TEXT DEFAULT 'open', -- 'open' | 'evaluating' | 'approved' | 'merged' | 'rejected'
  composite_score REAL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  merged_at TIMESTAMP
);
```

#### Evaluation Results
```sql
CREATE TABLE evaluation_results (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  change_id TEXT REFERENCES changes(id),
  evaluator_id TEXT NOT NULL,
  evaluator_type TEXT NOT NULL, -- 'diff' | 'webhook' | 'llm' | 'sandbox'
  commit_sha TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  score REAL NOT NULL,
  summary TEXT,
  findings TEXT,            -- JSON array of Finding objects
  metrics TEXT,             -- JSON object of metric values
  duration_ms INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### Provenance (Agent Context)
```sql
CREATE TABLE provenance (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes(id),
  commit_sha TEXT NOT NULL,
  actor_type TEXT NOT NULL,     -- 'human' | 'agent'
  actor_id TEXT NOT NULL,
  model_id TEXT,                -- LLM model used
  model_config TEXT,            -- JSON (temperature, etc.)
  prompt_hash TEXT,             -- Hash of system prompt
  prompt_content TEXT,          -- Full prompt (or R2 reference)
  reasoning_trace TEXT,         -- Chain-of-thought (or R2 reference)
  tool_calls TEXT,              -- JSON array of tool invocations
  tokens_used INTEGER,
  execution_ms INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

#### GitHub Integration
```sql
CREATE TABLE github_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  github_user_id TEXT NOT NULL,
  access_token TEXT NOT NULL,   -- Encrypted
  refresh_token TEXT,           -- Encrypted
  token_expires_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE github_pr_mappings (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes(id),
  github_pr_number INTEGER NOT NULL,
  github_repo_owner TEXT NOT NULL,
  github_repo_name TEXT NOT NULL,
  last_sync_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### KV Structure

```
session:{sessionId} → { userId, expiresAt }
rate_limit:magic_link:{emailHash} → { count, resetAt }
sync_status:{namespace}:{slug} → { lastCheckedAt, hasUpdates, commitsBehind }
eval_cache:{workspaceId}:{evaluatorId} → { result, cachedAt }
```

## Evaluation Engine

The evaluation engine runs configured evaluators against workspace changes and produces a composite score.

### Evaluator Interface

```typescript
interface Evaluator {
  id: string;
  type: 'diff' | 'webhook' | 'llm' | 'sandbox';
  evaluate(ctx: EvalContext): Promise<EvaluationResult>;
}

interface EvalContext {
  workspaceId: string;
  projectId: string;
  commitSha: string;
  remote: string;        // Artifacts remote URL
  token: string;         // Artifacts token
  config: Record<string, any>;
  logger: Logger;
}

interface EvaluationResult {
  evaluatorId: string;
  evaluatorType: string;
  passed: boolean;
  score: number;         // 0.0 - 1.0
  summary: string;
  findings: Finding[];
  metrics?: Record<string, number>;
  durationMs: number;
}

interface Finding {
  severity: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}
```

### Built-in Evaluators

#### 1. DiffEvaluator
Pure analysis of git diff. No code execution.

```typescript
const diffEvaluator: Evaluator = {
  id: 'diff_check',
  type: 'diff',
  async evaluate(ctx) {
    // Clone workspace, compare to parent
    // Check: files changed, lines added/removed, restricted paths
    // Score based on thresholds in config
  }
};
```

**Configuration:**
```yaml
evaluators:
  - id: diff_check
    type: diff
    max_files_changed: 30
    max_lines_changed: 1000
    restricted_paths:
      - "src/auth/**"
      - "migrations/**"
```

#### 2. WebhookEvaluator
Calls external CI/CD system.

```typescript
const webhookEvaluator: Evaluator = {
  id: 'external_ci',
  type: 'webhook',
  async evaluate(ctx) {
    // POST to configured URL with workspace metadata
    // Poll or receive callback with results
  }
};
```

**Configuration:**
```yaml
evaluators:
  - id: external_ci
    type: webhook
    url: "https://ci.example.com/evaluate"
    timeout_seconds: 300
    headers:
      Authorization: "Bearer ${CI_TOKEN}"
```

#### 3. LLMEvaluator
Sends diff to LLM for review via AI Gateway.

```typescript
const llmEvaluator: Evaluator = {
  id: 'llm_review',
  type: 'llm',
  async evaluate(ctx) {
    // Build prompt with diff + criteria
    // Call AI Gateway
    // Parse response for score and findings
  }
};
```

**Configuration:**
```yaml
evaluators:
  - id: llm_review
    type: llm
    model: "claude-sonnet-4-20250514"
    criteria: |
      Does this change match the stated objective?
      Are error cases handled appropriately?
      Does it follow existing code patterns?
    min_score: 0.7
```

#### 4. SandboxEvaluator
Executes code in Cloudflare Sandbox.

```typescript
const sandboxEvaluator: Evaluator = {
  id: 'tests',
  type: 'sandbox',
  async evaluate(ctx) {
    // Clone workspace to Sandbox
    // Run configured command
    // Capture output and exit code
  }
};
```

**Configuration:**
```yaml
evaluators:
  - id: tests
    type: sandbox
    command: "npm test"
    required: true
```

### Composite Scoring

```typescript
async function runEvaluation(
  evaluators: Evaluator[],
  ctx: EvalContext
): Promise<CompositeResult> {
  // Run evaluators in parallel
  const results = await Promise.all(
    evaluators.map(e => e.evaluate(ctx))
  );
  
  // Aggregate scores
  const compositeScore = calculateComposite(results);
  const passed = checkPassConditions(results, policy);
  
  return {
    compositeScore,
    passed,
    results,
    timestamp: new Date().toISOString()
  };
}
```

## GitHub Bridge

The GitHub bridge enables the "layer mode" where Stratum sits between agents and GitHub.

### Inbound Sync (GitHub → Stratum)

**Webhook Events:**
- `push` → Sync code to Stratum project
- `pull_request` → Create/update Stratum Change
- `pull_request_review` → Update evaluation/approval state

**Handler:**
```typescript
app.post('/api/webhooks/github', async (c) => {
  // Verify webhook signature
  // Parse event type
  // Route to appropriate handler
  // Return 200 quickly (process async)
});
```

### Outbound Sync (Stratum → GitHub)

**Push Change to PR:**
```typescript
async function pushToGitHub(change: Change): Promise<void> {
  // Get or create GitHub PR
  // Push workspace branch to GitHub
  // Post evaluation results as PR comment
  // Set commit status (pass/fail)
}
```

**PR Comment Format:**
```markdown
## Stratum Evaluation Results

**Composite Score:** 0.92 ✅

| Evaluator | Score | Status |
|-----------|-------|--------|
| Diff Check | 1.0 | ✅ Pass |
| Unit Tests | 0.95 | ✅ Pass |
| LLM Review | 0.82 | ✅ Pass |

**Objective:** Fix the N+1 query in user loading

[View detailed results in Stratum](https://stratum.dev/...)
```

## Merge Queue

Durable Object that serializes merge operations per repository.

```typescript
export class MergeQueue extends DurableObject {
  async enqueue(changeId: string): Promise<MergeResult> {
    // Check if base is current
    // Check for conflicts with in-flight merges
    // Attempt merge (fast-forward or squash)
    // If conflict: auto-rebase if clean, else fail
    // Update Change status
    // Return result
  }
}
```

**Features:**
- Serialized merges (no race conditions)
- Staleness detection
- Auto-rebase for clean merges
- Batch merging for non-conflicting changes

## Queue Processing

Background jobs processed by Cloudflare Queues.

### Job Types

#### ImportJob
```typescript
interface ImportJob {
  type: 'import';
  projectId: string;
  sourceUrl: string;
  provider: 'github' | 'gitlab' | 'bitbucket';
}
```

#### SyncJob
```typescript
interface SyncJob {
  type: 'sync';
  projectId: string;
  checkOnly: boolean;
}
```

#### EvaluationJob
```typescript
interface EvaluationJob {
  type: 'evaluate';
  workspaceId: string;
  changeId?: string;
}
```

### Queue Architecture

```
Producer (API route) → Queue → Consumer Worker
                              ↓
                         Process job
                              ↓
                    Update status in D1
                    Emit SSE event (if subscribed)
```

## Authentication Flows

### Magic Link (Current)

```
POST /auth/email/request
  ↓
Generate token → Store in KV (15 min TTL)
  ↓
Send email via Cloudflare Email
  ↓
User clicks link /auth/email/verify?token=...
  ↓
Validate token → Create session → Set cookie
```

### GitHub OAuth (For GitHub Bridge)

```
GET /auth/github
  ↓
Redirect to GitHub OAuth
  ↓
Callback /auth/github/callback?code=...
  ↓
Exchange code for token
  ↓
Store encrypted token in D1
  ↓
Redirect to dashboard
```

## File Structure

```
src/
├── index.ts                 # Hono app entry
├── types.ts                 # Shared types
├── auth/
│   ├── middleware.ts        # Session validation
│   ├── magic-link.ts        # Magic link routes
│   └── github-oauth.ts      # GitHub OAuth routes
├── routes/
│   ├── projects.ts          # Project CRUD
│   ├── workspaces.ts        # Workspace management
│   ├── changes.ts           # Change lifecycle
│   ├── evaluations.ts       # Evaluation triggers
│   ├── sync-management.ts   # Git sync operations
│   └── webhooks.ts          # GitHub webhooks
├── storage/
│   ├── db.ts                # D1 query helpers
│   ├── kv.ts                # KV operations
│   ├── git-ops.ts           # Git operations
│   └── sync.ts              # Sync status tracking
├── evaluation/
│   ├── engine.ts            # Evaluation orchestrator
│   ├── diff.ts              # DiffEvaluator
│   ├── webhook.ts           # WebhookEvaluator
│   ├── llm.ts               # LLMEvaluator
│   └── sandbox.ts           # SandboxEvaluator
├── queue/
│   ├── import.ts            # Import job processor
│   ├── sync.ts              # Sync job processor
│   └── evaluate.ts          # Evaluation job processor
├── github/
│   ├── client.ts            # GitHub API client
│   ├── webhooks.ts          # Webhook handlers
│   └── sync.ts              # Bidirectional sync logic
├── merge/
│   └── queue.ts             # Durable Object merge queue
└── utils/
    ├── errors.ts            # Error classes
    ├── logging.ts           # Logger setup
    └── validation.ts        # Input validation
```

## Scaling Considerations

### D1
- Read replicas for query-heavy workloads
- Connection pooling via Prisma or similar
- Batch writes for high-volume operations

### KV
- 1-write-per-second limit per key
- Use for low-frequency updates (sessions, rate limits)
- Not for high-frequency counters

### Queues
- Automatic retry with exponential backoff
- Dead letter queue for failed jobs
- Batch processing for efficiency

### Artifacts
- No rate limits, but monitor costs
- Use depth limits for large repos
- Lazy loading for file contents

## Security Model

### Authorization Levels

1. **Public** - Read-only access to public repos
2. **Authenticated** - User is logged in
3. **Project Member** - User has access to specific project
4. **Project Owner** - User owns the project
5. **Admin** - Full system access

### Token Storage
- GitHub tokens: Encrypted in D1
- Session tokens: Hashed in KV
- Artifacts tokens: Encrypted in D1

### Webhook Security
- Verify GitHub signature (HMAC-SHA256)
- IP allowlisting (GitHub IPs only)
- Idempotent handlers (safe to retry)

## Monitoring

### Key Metrics
- Request latency (p50, p95, p99)
- Evaluation duration by evaluator type
- Queue depth and processing time
- GitHub API rate limit usage
- Error rates by route

### Alerting Thresholds
- Queue depth > 100
- Error rate > 1%
- p95 latency > 5s
- Failed webhook deliveries > 5 in 1 hour

## Related Documents

- [TODO.md](/TODO.md) - Current priorities and roadmap
- [PIVOT_SUMMARY.md](/docs/PIVOT_SUMMARY.md) - Strategic pivot explanation
- [Database Schema](/docs/developer/database.md) - Detailed D1 schema
- [Queue Processing](/docs/developer/queues.md) - Queue architecture
- [Testing Guide](/docs/developer/testing.md) - Testing patterns

## Archived Documents

Historical documents preserved for reference:
- [Code Review (2026-04-29)](/docs/archive/CODE_REVIEW.md)
- [Architecture Audit (2026-05-02)](/docs/archive/AUDIT.md)
