// Type-only: erased at compile time, so parameterizing DEPLOY_QUEUE with the
// runner's message union cannot create a runtime import cycle.
import type { DeployQueueMessage } from "./deploy/runner";
import type { MirrorQueueMessage } from "./github/mirror";
import type { MagicLinkRateLimiter } from "./queue/magic-link-limiter";
import type { UsageMeter } from "./queue/usage-meter";
import type { LoggerContext } from "./utils/logger";
export type { LoggerContext };

// Validation constants for namespace and slug fields
export const MAX_NAMESPACE_LENGTH = 39; // GitHub username limit
export const MAX_SLUG_LENGTH = 100; // Reasonable project name limit
export const MAX_PROJECT_NAME_LENGTH = 100;

export interface ArtifactsCreateResult {
  name: string;
  remote: string;
  token: string;
}

/** An immediate child of a Git tree, as returned by {@link ArtifactsRepo.readTree}. */
export interface ArtifactsTreeEntry {
  /** Name relative to the tree being read. */
  name: string;
  /** Canonical Git mode, such as `100644` for a file or `40000` for a tree. */
  mode: string;
  /** Lowercase, 40-character SHA-1 object ID. */
  hash: string;
  /** `gitlink` is a submodule reference; `exec` an executable file. */
  type: "tree" | "blob" | "symlink" | "gitlink" | "exec";
}

/** Decoded commit, as returned by {@link ArtifactsRepo.log} and `readCommit`. */
export interface ArtifactsCommitMetadata {
  hash: string;
  treeHash: string;
  /** Commit message with one trailing newline removed. */
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  /** Unix seconds. */
  authoredAt: number;
  /** Unix seconds. */
  committedAt: number;
}

/**
 * Repository capability returned by `ARTIFACTS.get()`. An RPC stub: callers must
 * dispose it when done (see `withArtifactsRepo`), or the runtime warns that it
 * was garbage-collected undisposed.
 *
 * The read methods (`log`, `readTree`, `readBlob`, `readCommit`, `readFile`)
 * arrived with the Artifacts open beta (2026-10-01) and are hand-declared here
 * from `@cloudflare/workers-types` 5.x, which this repo does not yet depend on.
 */
export interface ArtifactsRepo {
  name: string;
  remote: string;
  /** Current repository metadata (a fresh lookup on each call). */
  info(): Promise<{ name: string; remote: string; defaultBranch: string }>;
  /** Commits along the first-parent chain, newest first; `[]` if `ref` does not resolve. */
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]>;
  /** Immediate children of a tree, or `null` if the object is missing. */
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  /** Raw bytes of a blob, or `null` if missing or not a blob. */
  readBlob(hash: string): Promise<Blob | null>;
  /** A decoded commit, or `null` if missing. */
  readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;
  /** A file resolved by branch/tag/commit and path, or `null` if it does not resolve to a file. */
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  createToken(
    scope?: "read" | "write",
    ttl?: number,
  ): Promise<{ plaintext: string; expiresAt: number }>;
  fork(
    name: string,
    opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<ArtifactsCreateResult>;
}

export interface ArtifactsNamespace {
  create(name: string, opts?: Record<string, unknown>): Promise<ArtifactsCreateResult>;
  get(name: string): Promise<ArtifactsRepo>;
  list(opts?: Record<string, unknown>): Promise<unknown>;
  delete(name: string): Promise<boolean>;
  import(params: {
    source: {
      url: string;
      branch?: string;
      depth?: number;
      auth?: {
        type: "bearer";
        token: string;
      };
    };
    target: {
      name: string;
      opts?: {
        description?: string;
        readOnly?: boolean;
      };
    };
  }): Promise<ArtifactsCreateResult>;
}

interface AnalyticsEngineDataset {
  writeDataPoint(data: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

// Re-export Queue types from Cloudflare
export type { Queue, Message, MessageBatch } from "@cloudflare/workers-types";

export interface AiBinding {
  run(
    model: string,
    options: {
      messages?: Array<{ role: string; content: string }>;
      prompt?: string;
    },
  ): Promise<
    | {
        /** The text, for most models. Some return the JSON they wrote already
         * parsed, so this is not always a string. */
        response?: unknown;
        /**
         * Token counts Workers AI actually reported. Declared because it is
         * genuinely there and this repo was throwing it away: Cloudflare's
         * generated types give a text-generation output as `response`,
         * `tool_calls` and `usage`, with the counts named `prompt_tokens` /
         * `completion_tokens` (`AiTextGenerationOutput` and `UsageTags` in
         * `@cloudflare/workers-types`). Optional field by field, unlike those
         * types, because a binding that omits them must be a cost sample marked
         * `estimated`, not a type error — `usageOrNothing` decides which.
         */
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        /**
         * The OpenAI chat-completion shape, which current Workers AI models
         * return as well as, or instead of, `response`. Typed `unknown` where
         * the provider checks before use.
         */
        choices?: Array<{
          message?: { content?: unknown };
          finish_reason?: unknown;
        }>;
      }
    | ReadableStream
  >;
}

export interface SandboxBinding {
  create(): Promise<SandboxInstance>;
}

export interface SandboxInstance {
  writeFile(path: string, content: string): Promise<void>;
  run(
    command: string,
    opts?: { timeout?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  destroy(): Promise<void>;
}

export interface EmailMessage {
  to: string;
  from: { email: string; name?: string };
  subject: string;
  text: string;
  html: string;
}

export interface EmailBinding {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export interface Env {
  ARTIFACTS: ArtifactsNamespace;
  STATE: KVNamespace;
  DB: D1Database;
  POSTHOG_API_KEY?: string;
  /**
   * The PostHog **project** token, published in every page of HTML.
   *
   * Deliberately separate from `POSTHOG_API_KEY` and deliberately a `[vars]`
   * entry rather than a secret. Reusing the existing secret would silently
   * redefine what a self-hoster's configuration means — today it exports
   * server-side route patterns, it would additionally load third-party
   * JavaScript in their users' browsers and send those users' IP addresses —
   * for operators who set it long ago and took no action since. Browser
   * analytics is therefore opt-in on its own key, and a value that ships in
   * public HTML is not a secret.
   */
  POSTHOG_PUBLIC_KEY?: string;
  POSTHOG_HOST?: string;
  STRATUM_TELEMETRY_DISABLED?: string;
  /**
   * `"true"` makes telemetry opt-in for NEW accounts (#257): signup forms show
   * an unticked consent box, and an account is created opted out unless it was
   * ticked. Unset — the self-hosted default — changes nothing. Existing
   * accounts are never touched either way. See `src/analytics/consent.ts`.
   */
  TELEMETRY_CONSENT_AT_SIGNUP?: string;
  /**
   * The Stratum project, as `@namespace/slug`, in which the instance opens an
   * issue when one of its own health checks fails. Unset — the default — an
   * alert is only logged. See `src/services/ops-alerts.ts`.
   */
  OPS_ALERT_PROJECT?: string;
  /**
   * Which deployment this is ("production", "staging", a self-hoster's own
   * label). Attached to every analytics event. Without it a staging deploy's
   * traffic is indistinguishable from production's in the same PostHog
   * project, and every funnel built on the data is quietly wrong.
   */
  STRATUM_ENVIRONMENT?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  OAUTH_REDIRECT_URI?: string;
  /**
   * GitHub App credentials. When both are set, outbound GitHub calls for a
   * repo the app is installed on use an installation token; GITHUB_TOKEN is
   * the fallback (see src/github/app-auth.ts). The key must be PKCS#8
   * (`-----BEGIN PRIVATE KEY-----`) — WebCrypto cannot import PKCS#1.
   */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /**
   * Operator bindings from a GitHub owner to the Stratum owner allowed to act
   * on its repos without an installation link: comma-separated
   * `githubOwner=org:<orgId>` / `githubOwner=user:<userId>` entries. Ids, not
   * namespaces, which can be freed and reclaimed. The only way a project can
   * use the `GITHUB_TOKEN` PAT. Any other entry is ignored. See
   * src/github/repo-authorization.ts.
   */
  GITHUB_ALLOWED_OWNERS?: string;
  /** Former name of {@link GITHUB_ALLOWED_OWNERS}; still read, entries combine. */
  GITHUB_APP_ALLOWED_OWNERS?: string;
  // Git provider API tokens for sync
  GITHUB_TOKEN?: string;
  GITLAB_TOKEN?: string;
  BITBUCKET_TOKEN?: string;
  BITBUCKET_USERNAME?: string;
  BITBUCKET_APP_PASSWORD?: string;
  EMAIL?: EmailBinding;
  EMAIL_FROM_ADDRESS?: string;
  ADMIN_EMAIL?: string;
  ADMIN_API_KEY?: string;
  // Enables the /dev-login backdoor. Must be "true" AND the request host must be
  // localhost. Set only in local dev config; unset in staging/production so the
  // route is inert there.
  DEV_LOGIN_ENABLED?: string;
  // Closed-beta gate (optional; OSS self-hosters leave these unset → no gating).
  // When BETA_GATE is enabled AND REFERRAL_SERVICE_URL is set, new-account creation
  // requires a valid referral/invite code validated against the cloud referral service.
  BETA_GATE?: string;
  /** "1" turns off agent-initiated signup (`/api/agent-signup`); on by default. */
  AGENT_SIGNUP_DISABLED?: string;
  REFERRAL_SERVICE_URL?: string;
  REFERRAL_SERVICE_SECRET?: string;
  /** Plan/entitlements service (Stratum Cloud only; OSS self-hosters leave these
   * unset -> every owner resolves to `UnlimitedEntitlements` and nothing is
   * fetched). BOTH are required for the hook to be live — see
   * `entitlementsEnabled` in src/billing/entitlements.ts. */
  BILLING_SERVICE_URL?: string;
  BILLING_SERVICE_SECRET?: string;
  /** "1" makes entitlement decisions REFUSE rather than only record. Off by
   * default: the limits are measured for a period before they gate anything.
   * Setting it without BILLING_SERVICE_URL is enforcement that looks on and does
   * nothing — `entitlementsConfigError` flags exactly that. */
  ENTITLEMENTS_ENFORCE?: string;
  /** JSON array of the operator's LLM providers, e.g.
   * `[{"name":"anthropic","kind":"anthropic","baseUrl":"https://api.anthropic.com/v1"}]`.
   * The ONLY place a provider endpoint may be named: a project's policy file
   * selects one of these by name and can never supply a `baseUrl`. Unset (the
   * default) means Workers AI only. Credentials are NOT here — they live per
   * project in `project_secrets`. Parsed by `parseLlmProviders`, which rejects
   * a non-https, credential-bearing, loopback, link-local or private-range
   * `baseUrl` at parse time and stores it normalized. Include the API version
   * path: the provider appends `/messages` or `/chat/completions` to whatever
   * this names, so a `baseUrl` missing the `/v1` 404s on every call. */
  LLM_PROVIDERS?: string;
  /** Encrypts org SSO client secrets at rest (PBKDF2 + AES-GCM, SSO-specific
   * salt). Unset → the whole SSO surface (admin API, login) returns 501. Kept
   * separate from the GitHub token secret for blast-radius isolation. */
  SSO_ENCRYPTION_SECRET?: string;
  ANALYTICS?: AnalyticsEngineDataset;
  SANDBOX?: SandboxBinding;
  AI?: AiBinding;
  MERGE_QUEUE?: DurableObjectNamespace;
  REPO_DO?: DurableObjectNamespace;
  /** Serialized magic-link send counters (issue #283). Optional only so tests
   * can omit it; every deploy from this repo's wrangler.toml binds it.
   *
   * Parameterised by the class so `.get()` returns a typed stub: the route then
   * calls `reserve`/`refund` directly, and a signature change here becomes a
   * compile error instead of surviving behind a hand-written cast. The import
   * is type-only, so the cycle with magic-link-limiter.ts (which imports `Env`
   * from here) is erased. */
  MAGIC_LINK_LIMITER?: DurableObjectNamespace<MagicLinkRateLimiter>;
  /**
   * Native request rate limiters (wrangler.toml `[[ratelimits]]`), one per
   * standard per-minute limit. Optional: without one, that limit is counted in
   * KV instead (see src/middleware/rate-limit.ts).
   */
  RATE_LIMIT_ANON?: RateLimit;
  RATE_LIMIT_AUTH?: RateLimit;
  RATE_LIMIT_ANALYTICS?: RateLimit;
  RATE_LIMIT_STRICT?: RateLimit;
  /** Serialized usage counters, one instance per ENFORCEMENT subject (PRD §4a:
   * the acting user, or an org positively known to be paid — NOT the recorded
   * billing subject, which is resettable by creating an org). Optional only so
   * tests and minimal deployments can omit it; every deploy from this repo's
   * wrangler.toml binds it, and nothing here enforces anything until the
   * enforcement call sites exist.
   *
   * Parameterised by the class for the same reason as the limiter above: the
   * `.get()` stub is typed, so a change to `reserve`/`settle`/`setFloor` is a
   * compile error at the call site rather than something a cast absorbs. The
   * import is type-only, so the cycle with usage-meter.ts (which imports `Env`
   * from here) is erased. */
  USAGE_METER?: DurableObjectNamespace<UsageMeter>;
  /** Content-addressed git object plane (ADR 004 Phase 2). */
  REPO_OBJECTS?: R2Bucket;
  /** Durable backup store (D1 dumps, KV identity, repo packs). Optional: when
   * unbound the backup subsystem no-ops. See docs/runbooks/backup-restore.md. */
  BACKUPS?: R2Bucket;
  /** When set, backup blobs are envelope-encrypted at rest with this secret. */
  BACKUP_ENCRYPTION_SECRET?: string;
  /** Number of complete backup runs to retain (default 14). */
  BACKUP_RETENTION?: string;
  /** Max repos snapshotted per backup run; the rest defer to a later run (default 25). */
  MAX_REPOS_PER_RUN?: string;
  /** Comma-separated `@namespace/slug` projects snapshotted in EVERY backup run,
   * on top of (and not counted against) `MAX_REPOS_PER_RUN`. */
  BACKUP_PINNED_PROJECTS?: string;
  /** Skip a repo whose reachable object bytes exceed this (default 128MB). */
  MAX_BACKUP_BYTES?: string;
  /** Gates the RepoDO fast-forward path (ADR 004). Off -> classic cold merge. */
  REPO_DO_ENABLED?: string;
  /**
   * Restricts every Durable Object to a Cloudflare jurisdiction: `eu`, `us` or
   * `fedramp`. Unset (the default) means no restriction.
   *
   * Read in exactly one place, `durableObjectNamespace`
   * (src/utils/durable-objects.ts), which every call site goes through. A
   * restricted namespace addresses DIFFERENT objects than the unrestricted one,
   * so this is a setting for a fresh deployment: turning it on later strands
   * existing Durable Object state (docs/user-guide/trust.md). An unsupported
   * value makes every request answer 503 rather than run unrestricted.
   */
  DO_JURISDICTION?: string;
  /** "true" routes a `git push` to a project's default branch through the
   * change/eval gate (ADR 005 slice 2b) instead of refusing it. Staging-first
   * rollout flag; off in production until validated end-to-end. */
  GIT_PUSH_GATED_ENABLED?: string;
  /** Deploy environment: "development" | "staging" | "production". Gates dev-only
   * routes and toggles HSTS. Defaults to production-safe behavior when unset. */
  ENVIRONMENT?: string;
  /** Comma-separated extra CORS origin allowlist (beyond same-origin). Optional. */
  ALLOWED_ORIGINS?: string;
  /**
   * The canonical public URL of this instance (e.g. `https://app.usestratum.dev`).
   * Optional. When set, passkeys (#256) are bound to its origin and hostname
   * (the WebAuthn RP ID) instead of the request's own — pin it in an
   * environment that is reachable under more than one hostname, so a passkey
   * registered on one is not silently unusable on another.
   */
  APP_URL?: string;
  /**
   * Optional secret keying the stored hashes of passkey recovery codes (#256):
   * with it, a copy of the `recovery_codes` table (or a D1 backup) is not
   * enough to test guesses. Set with `wrangler secret put`. Changing or
   * removing it invalidates codes issued under it — users regenerate them from
   * Settings → Security. Without it, hashes are user-bound SHA-256.
   */
  RECOVERY_CODE_PEPPER?: string;
  /**
   * Base URL of this instance's first-party CI executor (#415), the separate
   * Worker in `ci-executor/` — e.g. `https://ci.example.com`. Optional: without
   * an executor, a project that has a `.stratum/ci.yaml` gets its checks
   * `errored` with a summary naming this setting, and its merges stay blocked.
   * Must be https (http is accepted for localhost only).
   */
  CI_EXECUTOR_URL?: string;
  /**
   * Shared secret between this Worker and the CI executor: signs every job
   * dispatched to it, verifies every result it reports, and signs log
   * fetches. At least 32 characters; set the SAME value on both Workers with
   * `wrangler secret put CI_EXECUTOR_SECRET`. It is the instance's, not a
   * project's — no project secret can stand in for it.
   */
  CI_EXECUTOR_SECRET?: string;
  /**
   * Optional service binding to the executor Worker. When bound, jobs and log
   * fetches go over it instead of the public network — required when the
   * executor is routed on this Worker's own zone, where a global `fetch()`
   * would not reach it.
   */
  CI_EXECUTOR?: Fetcher;
  /** Master key for the per-project deploy secret store: provider credentials
   * are AES-GCM encrypted under a key derived from it. Optional because a
   * self-hoster who never deploys never needs one — but a project that HAS
   * configured a deploy fails loudly (a `failed` deployment naming the missing
   * key) rather than silently not deploying. Rotating it makes every existing
   * ciphertext undecryptable, so secrets must be re-entered after a rotation. */
  DEPLOY_SECRET_KEY?: string;
  /** Post-merge deployments. Deliberately NOT the events queue: a deploy is a
   * minutes-long job, and the shared `stratum-events` consumer awaits each
   * message in turn, so a slow deploy there would stall webhook delivery. */
  DEPLOY_QUEUE?: Queue<DeployQueueMessage>;
  EVENTS_QUEUE?: Queue;
  IMPORT_QUEUE?: Queue<ImportJobMessage | SyncJobMessage | IssueImportJobMessage>;
  /** Evaluation runs (#412, ADR 009). Its own queue for the reason
   * `DEPLOY_QUEUE` is: a sandbox or LLM evaluation runs for minutes, and must
   * not stall webhook delivery on the shared events consumer. Optional: with
   * it unbound, evaluation runs inline on the request, as it did before. */
  EVALUATION_QUEUE?: Queue<EvaluationQueueMessage>;
  /** Push-mirror nudges (#417). Its own queue because a push clones the
   * repository into memory and can run for minutes — neither of which the
   * shared events consumer is sized for. Optional: with it unbound, the
   * five-minute sweep pushes pending mirrors inline instead. */
  MIRROR_QUEUE?: Queue<MirrorQueueMessage>;
}

/** One evaluation run. Keyed to the change AND the run, never the change
 * alone: the consumer drops a message whose run is no longer the one the
 * change is waiting on. */
export interface EvaluationQueueMessage {
  type: "change.evaluate";
  changeId: string;
  runId: string;
}

// Import queue message types
export interface ImportJobMessage {
  type: "github.import" | "git.import";
  importId: string;
  projectId: string;
  namespace: string;
  slug: string;
  githubUrl: string;
  sourceUrl?: string;
  provider?: GitProvider;
  branch: string;
  /** Clone depth (1..MAX_CLONE_DEPTH); 0 means full history (depth omitted from the clone). */
  depth: number;
  timestamp: string;
  /**
   * User id of the account that triggered the import. Failure notifications are
   * emailed to this user's address (in addition to the ADMIN_EMAIL copy).
   */
  initiatedBy?: string;
}

/**
 * One page of a GitHub issue import (#421). Rides the import queue: each
 * message imports one page of issues and enqueues the next, so a repository of
 * any size never has to fit in one invocation.
 */
export interface IssueImportJobMessage {
  type: "github.issues.import";
  runId: string;
  projectId: string;
  namespace: string;
  slug: string;
  /** 1-based page of GitHub's issue listing this message imports. */
  page: number;
  timestamp: string;
}

// Git provider types
export type GitProvider = "github" | "gitlab" | "bitbucket";

export interface SyncJobMessage {
  type: "github.sync" | "git.sync";
  importId: string;
  projectId: string;
  namespace: string;
  slug: string;
  githubUrl: string; // Keep for backward compatibility
  sourceUrl?: string; // Generic URL for any provider
  provider?: GitProvider;
  branch: string;
  depth: number;
  timestamp: string;
  /** How this sync was triggered. Omitting defaults to 'manual'. */
  trigger?: "manual" | "webhook" | "auto";
}

export interface ProjectEntry {
  id: string; // UUID - stable agent reference
  name: string; // Display name
  slug: string; // URL-safe name
  namespace: string; // @username or org-slug
  ownerId: string; // User/Agent/Org ID
  ownerType: "user" | "org" | "agent";
  remote: string;
  createdAt: string;
  // Legacy GitHub-specific fields (kept for backward compatibility)
  githubUrl?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubDefaultBranch?: string;
  githubConnectedAt?: string;
  githubConnectionStatus?: "connected" | "disconnected";
  // New generic git provider fields
  sourceUrl?: string;
  sourceProvider?: GitProvider;
  sourceOwner?: string;
  sourceRepo?: string;
  sourceDefaultBranch?: string;
  // Sync tracking
  lastSyncedAt?: string;
  lastSyncedCommit?: string;
  lastSyncStatus?: "success" | "failed" | "in_progress" | "idle";
  lastSyncError?: string;
  autoSyncEnabled?: boolean;
  syncFrequency?: number; // Minutes between auto-syncs
  visibility?: "private" | "public";
  /**
   * The billing subject (user or pooled org id) whose private-project gauge
   * this project was counted against at creation. Differs from `ownerId` when a
   * user creates into an org that does not pool. Absent on entries created
   * before it existed, or while entitlements were off.
   */
  gaugeSubjectId?: string;
  // False while the initial import is in flight; true once it completes.
  // Absent on legacy projects — treated as true for backward compatibility.
  importCompleted?: boolean;
}

// Helper to generate full project path
export function projectPath(project: ProjectEntry): string {
  return `/${project.namespace}/${project.slug}`;
}

/**
 * A user's namespace as it appears in every project key and URL: the username
 * with an "@" prefix. Tolerates an already-prefixed value so callers can pass
 * either a username or a namespace.
 */
export function getUserNamespace(username: string): string {
  return username.startsWith("@") ? username : `@${username}`;
}

// Helper to generate Artifacts repo name
// Uses double underscore separator to avoid collisions between namespace/slug boundaries
// e.g., "user-a/b" and "user/a-b" both become "user-a-b" with hyphen, but
// "user-a__b" and "user__a-b" with double underscore
export function getArtifactsRepoName(namespace: string, slug: string): string {
  return `${namespace.replace("@", "")}__${slug}`;
}

// Helper to generate Artifacts repo name from ProjectEntry
export function artifactsRepoName(project: ProjectEntry): string {
  return getArtifactsRepoName(project.namespace, project.slug);
}

/**
 * The default branch of the project's Artifacts repo.
 *
 * `Artifacts.import` mirrors the SOURCE branch name into the target repo — it
 * does not rename it to `main` (the push gate in routes/git-http.ts relies on
 * this: a repo imported with a `master`/`trunk` default has no refs/heads/main).
 * Workspace forks copy the parent's default branch under the same name, so this
 * is also the branch every fork-based git op must target. Stratum-native repos
 * (created via initAndPush) always have `main`, which the final fallback covers.
 *
 * Single source of truth for the `sourceDefaultBranch || githubDefaultBranch ||
 * "main"` chain previously inlined at the push gate, sync, and PR paths.
 */
export function projectDefaultBranch(project: {
  sourceDefaultBranch?: string;
  githubDefaultBranch?: string;
}): string {
  return project.sourceDefaultBranch || project.githubDefaultBranch || "main";
}

/**
 * A project's `@namespace/slug` label, falling back to its bare name.
 *
 * The fallback is the point. A legacy entry can carry no namespace — KV records
 * are cast without shape validation, and this file's own `projectDefaultBranch`
 * exists for the same class of drift — so interpolating the pair unguarded
 * yields the string `"undefined/my-repo"`. That is merely ugly in a log line
 * and actively wrong in `cost_records.project`, where it becomes a persisted
 * identifier that matches no project during the deletion cascade's name-form
 * lookup.
 */
export function projectDisplayName(project: {
  namespace?: string;
  slug?: string;
  name: string;
}): string {
  return project.namespace && project.slug ? `${project.namespace}/${project.slug}` : project.name;
}

export interface WorkspaceEntry {
  name: string;
  remote: string;
  parent: string;
  createdAt: string;
  /** The Artifacts fork ref name. Equals `name` for workspaces created after this field was added.
   *  Absent on workspaces created before this field; callers should fall back to `name`. */
  branchName?: string;
  /**
   * The effective owning USER of this workspace: the creating user's id, or —
   * when an agent created it — that agent's owner's id. This is the identity the
   * write-authz check compares against, so an agent and its owner share one
   * ownership principal. Absent on legacy workspaces created before ownership was
   * recorded; those fail closed to project admins only. */
  createdByUserId?: string;
  /** Provenance only: the agent that created the workspace, when applicable. Not
   *  used for authorization (the agent's owner in `createdByUserId` is). */
  createdByAgentId?: string;
}

// Import progress tracking
export type ImportStatus =
  | "queued"
  | "cloning"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "cancelling"
  | "syncing"
  | "checking";

export interface ImportProgress {
  id: string;
  projectId: string;
  namespace: string;
  slug: string;
  status: ImportStatus;
  sourceUrl: string;
  branch: string;
  /**
   * Clone depth this job ran under, when one was recorded. Absent on jobs
   * created before migration 040 and on callers with no depth to record;
   * absent means "fall back to DEFAULT_CLONE_DEPTH", which `0` (full history)
   * explicitly does not.
   */
  depth?: number;
  startedAt: string;
  completedAt?: string;
  updatedAt: string; // For stall detection
  /**
   * Version field for optimistic locking.
   * Incremented on each update to prevent race conditions (TOCTOU).
   * Used for conflict detection during concurrent updates.
   */
  version: number;
  progress: {
    totalFiles?: number;
    processedFiles: number;
    currentFile?: string;
    bytesTransferred?: number;
    totalBytes?: number;
  };
  errors: Array<{
    file: string;
    error: string;
    timestamp: string;
  }>;
  logs: Array<{
    message: string;
    level: "info" | "warn" | "error";
    timestamp: string;
  }>;
}

export interface Author {
  name: string;
  email: string;
}

export interface CommitLogEntry {
  sha: string;
  message: string;
  author: string;
  timestamp: number;
}

export interface ApiError {
  error: string;
  code?: string;
}

/**
 * What an API token is allowed to do (#254).
 *
 * `read` permits GET/HEAD over the API and `git clone`/`fetch`; every other HTTP
 * method and every git write is refused. `read_write` is the full account power
 * a token has always had, and is what the legacy `users.token_hash` resolves to.
 *
 * Deliberately coarse: WHICH projects a token reaches is the separate
 * {@link CredentialBinding} dimension (#323), and this is a TEXT column so that
 * vocabulary can grow without a migration.
 */
export type ApiTokenScope = "read" | "read_write";

/**
 * Which projects a credential may reach (#323) — the second scope dimension,
 * orthogonal to {@link ApiTokenScope}'s read/write.
 *
 * - `unbound`: every project the principal can reach. Sessions, agents, OAuth
 *   grants, the legacy key, and every scoped token minted without a binding.
 * - `project`: exactly one project, by its stable id (survives renames).
 * - `org`: every project currently OWNED by that org — not personal projects of
 *   its members, and not other orgs' projects shared with the same user.
 *
 * A binding only ever NARROWS: the principal's own access is still required, so
 * a token bound to a project its owner later loses access to stops working.
 * One project or one org per token, deliberately not a set: a set is a list a
 * reviewer has to audit per token, while "make another token" costs nothing.
 */
export type CredentialBinding =
  | { readonly kind: "unbound" }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "org"; readonly orgId: string };

/** The bound (narrowing) members of {@link CredentialBinding}. */
export type BoundCredentialBinding = Exclude<CredentialBinding, { kind: "unbound" }>;

export interface User {
  id: string;
  email: string;
  username: string; // Username for namespace (@username)
  /** Free-form label shown in place of the username; never an identifier. */
  displayName?: string;
  githubId?: string;
  githubUsername?: string;
  tokenHash: string;
  createdAt: string;
  /**
   * When set (ISO timestamp), the account is soft-`deleting`: its credentials
   * stop working immediately (auth rejects) and its cascade is in flight.
   * Absent/null on live accounts. See PRD "Grace window".
   */
  deletingAt?: string;
  /**
   * When set (ISO timestamp), the account is disabled — reversibly, unlike the
   * destructive `deletingAt`. All credentials are inert while set (auth,
   * git smart-HTTP, and every login flow reject); `enableUser` clears it and
   * the same credentials work again. Set by SCIM deprovisioning.
   */
  disabledAt?: string;
  /**
   * When true, the user has opted out of product analytics: no PostHog event is
   * exported for their requests or for domain events they author (#257).
   * Absent means opted in, which is the default for every account.
   */
  telemetryOptOut?: boolean;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
}

export interface Agent {
  id: string;
  name: string;
  ownerId: string;
  model?: string;
  description?: string;
  promptHash?: string;
  tokenHash: string;
  createdAt: string;
  /**
   * How this agent authenticates (#409, ADR 010). Absent means `token`, the
   * only kind before migration 067. An `oauth_grant` agent was created on the
   * MCP consent screen and has no token of its own: its only way in is an
   * OAuth grant bound to it.
   */
  credential?: AgentCredentialKind;
}

export type AgentCredentialKind = "token" | "oauth_grant";

export interface Change {
  id: string;
  project: string;
  /** Globally-unique project UUID. Optional: NULL on rows written before the
   *  project-identity unification (name -> id lives in KV, not backfillable in SQL). */
  projectId?: string;
  workspace: string;
  status:
    | "open"
    /** An evaluation run is queued or running; no verdict yet (#412). Never
     * mergeable, even by force — the change has no evaluated revision to pin. */
    | "evaluating"
    /**
     * A pull request from the project's GitHub mirror, recorded and waiting for
     * a maintainer to import it (#420). Its workspace may not exist yet, and
     * nothing has run against it. Never mergeable, even by force, and never
     * evaluated or reviewed: importing it is the only way out besides closing
     * it. An imported change returns here when its pull request gets new
     * commits.
     */
    | "external"
    | "needs_changes"
    | "accepted"
    | "approved"
    | "promoted"
    | "merged"
    | "rejected"
    | "reverted";
  agentId?: string;
  evalScore?: number;
  evalPassed?: boolean;
  evalReason?: string;
  /** Project HEAD at change creation — the base the evaluation ran against. */
  baseSha?: string;
  /** Workspace tip the evaluation ran against; a merge rejects if it moved
   * (SEC-2 defense-in-depth assertion). Same revision as `workspaceHeadSha`. */
  evaluatedSha?: string;
  /** Tree oid of the evaluated workspace tip; a merge backend content-addresses
   * the code it lands against this to close the tip-check→merge TOCTOU. */
  evaluatedTreeOid?: string;
  /** The authoring agent's model, snapshotted at change creation (not read live). */
  agentModel?: string;
  /** The authoring agent's prompt hash, snapshotted at change creation. */
  agentPromptHash?: string;
  /** True when the change's diff modifies a merge-protection config file
   * (.stratum/policy.yaml / stratum.config.json). Such a change requires a human
   * approval and cannot be force-merged, so protection can't be silently relaxed. */
  touchesProtectedConfig?: boolean;
  /** The human author of the change (the acting user, or an agent's owning
   * user). Their own review does not count toward `merge.requiredApprovals`.
   * NULL on legacy rows and on changes with no Stratum author (e.g. inbound
   * GitHub PRs). */
  createdByUserId?: string;
  /**
   * The workspace commit sha the evaluation ran against. The merge gate merges
   * *this* sha (not the workspace's live tip, #115), so a re-push between eval and
   * merge cannot land unevaluated content on the default branch. Held alongside
   * `evaluatedSha` (same value): #115 selects this commit, SEC-2 asserts it.
   */
  workspaceHeadSha?: string;
  /**
   * The evaluation run this change is waiting on, or the last one that was
   * dispatched. A queue consumer only records its verdict while this still
   * names its run, so a superseded run cannot overwrite a newer one (#412).
   * Absent on changes evaluated inline (no evaluation queue bound) and on rows
   * written before migration 063.
   */
  evalRunId?: string;
  /** When `evalRunId` was dispatched. The stuck-run sweep keys on it. */
  evalRequestedAt?: string;
  createdAt: string;
  mergedAt?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  githubPrNumber?: number;
  githubPrUrl?: string;
  githubPrState?: string;
  githubHeadSha?: string;
  githubCommentId?: number;
  promotedAt?: string;
  promotedBy?: string;
}

// Sync check result for detecting new commits
export interface SyncCheckResult {
  hasUpdates: boolean;
  currentCommit?: string;
  latestCommit?: string;
  commitsBehind?: number;
  lastSyncAt?: string;
  error?: string;
}

// Bulk import job tracking
export interface BulkImportJob {
  id: string;
  namespace: string;
  ownerId: string;
  status: "queued" | "processing" | "completed" | "failed" | "partial";
  totalRepos: number;
  processedRepos: number;
  successfulRepos: number;
  failedRepos: number;
  createdAt: string;
  completedAt?: string;
  errors: Array<{
    repo: string;
    error: string;
  }>;
}

// Import template definition
export interface ImportTemplate {
  id: string;
  name: string;
  description: string;
  language: string;
  framework?: string;
  files: Record<string, string>;
  postSetupHooks?: string[];
}
