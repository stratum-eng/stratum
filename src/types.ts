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

export interface ArtifactsRepo {
  name: string;
  remote: string;
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
  ): Promise<{ response?: string } | ReadableStream>;
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
  POSTHOG_HOST?: string;
  STRATUM_TELEMETRY_DISABLED?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  OAUTH_REDIRECT_URI?: string;
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
  // Closed-beta gate (optional; OSS self-hosters leave these unset → no gating).
  // When BETA_GATE is enabled AND REFERRAL_SERVICE_URL is set, new-account creation
  // requires a valid referral/invite code validated against the cloud referral service.
  BETA_GATE?: string;
  REFERRAL_SERVICE_URL?: string;
  REFERRAL_SERVICE_SECRET?: string;
  ANALYTICS?: AnalyticsEngineDataset;
  SANDBOX?: SandboxBinding;
  AI?: AiBinding;
  MERGE_QUEUE?: DurableObjectNamespace;
  REPO_DO?: DurableObjectNamespace;
  /** Content-addressed git object plane (ADR 004 Phase 2). */
  REPO_OBJECTS?: R2Bucket;
  /** Gates the RepoDO fast-forward path (ADR 004). Off -> classic cold merge. */
  REPO_DO_ENABLED?: string;
  EVENTS_QUEUE?: Queue;
  IMPORT_QUEUE?: Queue<ImportJobMessage | SyncJobMessage>;
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
  depth: number;
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
  // False while the initial import is in flight; true once it completes.
  // Absent on legacy projects — treated as true for backward compatibility.
  importCompleted?: boolean;
}

// Helper to generate full project path
export function projectPath(project: ProjectEntry): string {
  return `/${project.namespace}/${project.slug}`;
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

export interface WorkspaceEntry {
  name: string;
  remote: string;
  parent: string;
  createdAt: string;
  /** The Artifacts fork ref name. Equals `name` for workspaces created after this field was added.
   *  Absent on workspaces created before this field; callers should fall back to `name`. */
  branchName?: string;
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

export interface User {
  id: string;
  email: string;
  username: string; // Username for namespace (@username)
  githubId?: string;
  githubUsername?: string;
  tokenHash: string;
  createdAt: string;
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
}

export interface Change {
  id: string;
  project: string;
  workspace: string;
  status:
    | "open"
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
