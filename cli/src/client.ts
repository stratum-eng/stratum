/**
 * Typed client for the Stratum REST API. Method-per-endpoint, mirroring the
 * Worker's routes — when a route changes shape, the corresponding method and
 * its test change with it.
 */

interface ApiErrorBody {
  error?: string;
  message?: string;
  reasons?: string[];
}

export interface ProjectRef {
  namespace: string;
  slug: string;
}

/**
 * Parse "ns/slug" or "@ns/slug" into a project reference. Exactly two
 * non-empty segments — extra segments are rejected rather than silently
 * dropped, so a command can never operate on a different project than named.
 */
export function parseProjectRef(ref: string): ProjectRef {
  const segments = ref.split("/");
  const [nsRaw, slug] = segments;
  if (segments.length !== 2 || !nsRaw || nsRaw === "@" || !slug) {
    throw new Error(`Invalid project reference '${ref}' — expected namespace/slug`);
  }
  return { namespace: nsRaw.startsWith("@") ? nsRaw : `@${nsRaw}`, slug };
}

export interface ProjectSummary {
  id: string;
  name: string;
  namespace: string;
  slug: string;
  path?: string;
  remote?: string;
  visibility?: string;
  createdAt?: string;
}

export interface Change {
  id: string;
  project: string;
  workspace: string;
  status: string;
  evalScore?: number;
  evalPassed?: boolean;
  evalReason?: string;
  baseSha?: string;
  createdAt: string;
  mergedAt?: string;
}

export interface EvalRun {
  id: string;
  evaluatorType: string;
  score: number;
  passed: boolean;
  reason: string;
}

export interface Issue {
  id: string;
  project: string;
  number: number;
  title: string;
  body?: string;
  status: "open" | "closed";
  linkedChangeId?: string;
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  type: string;
  actorType: string;
  actorId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// Change creation runs the full evaluation suite synchronously server-side, so
// the deadline must comfortably exceed a slow LLM + sandbox run.
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A credential that can be presented and, if the server rejects it, renewed.
 * A bare string is an API key: presented as-is, never renewable.
 */
export interface ClientCredential {
  token(): Promise<string>;
  refresh(): Promise<string | null>;
}

function asCredential(auth: string | ClientCredential): ClientCredential {
  if (typeof auth !== "string") return auth;
  return { token: async () => auth, refresh: async () => null };
}

/** An API error that kept its status code, so callers can act on a 401. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class StratumClient {
  private readonly credential: ClientCredential;

  constructor(
    private host: string,
    auth: string | ClientCredential,
    private opts: { timeoutMs?: number } = {},
  ) {
    this.credential = asCredential(auth);
  }

  /**
   * One retry, and only on a 401 that a refresh could plausibly fix: an access
   * token can expire mid-session (they last an hour), and re-running the whole
   * command is not something a user should have to do for that.
   */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.credential.token();
    try {
      return await this.send<T>(method, path, token, body);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      // A refresh that fails for its own reason — the network is down, the host
      // is unreachable — must surface that reason. Reporting it as the original
      // 401 sends the user to re-authenticate over a problem login cannot fix.
      const renewed = await this.credential.refresh().catch((refreshErr: unknown) => {
        throw refreshErr instanceof Error ? refreshErr : err;
      });
      if (renewed === null) throw err;
      return this.send<T>(method, path, renewed, body);
    }
  }

  private async send<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const url = `${this.host.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Stratum API request timed out")),
      this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    // The timer stays armed through body parsing — the signal propagates into
    // response.json(), so a server that stalls mid-body can't hang the request
    // past the deadline.
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const err = (await response.json()) as ApiErrorBody;
          message = err.error ?? err.message ?? message;
          if (err.reasons && err.reasons.length > 0) {
            message += `\n  - ${err.reasons.join("\n  - ")}`;
          }
        } catch {
          message = response.statusText || message;
        }
        throw new ApiError(message, response.status);
      }

      // The error path above is already defensive; the success path was not.
      // A 200 with an empty body (a delete) or an HTML body (a proxy, a captive
      // portal) otherwise surfaces as a raw `Unexpected token '<'`.
      const text = await response.text();
      if (text === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiError(
          `${url} returned a non-JSON body (HTTP ${response.status})`,
          response.status,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Projects ────────────────────────────────────────────────────────────

  async createProject(name: string, opts?: { org?: string; visibility?: string }) {
    return this.request<ProjectSummary & { commit: string }>("POST", "/api/projects", {
      name,
      ...(opts?.org ? { org: opts.org } : {}),
      ...(opts?.visibility ? { visibility: opts.visibility } : {}),
    });
  }

  async listProjects() {
    return this.request<{ projects: ProjectSummary[] }>("GET", "/api/projects");
  }

  async getProject(ref: ProjectRef) {
    return this.request<ProjectSummary>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}`,
    );
  }

  async deleteProject(ref: ProjectRef, confirm: string) {
    return this.request<{ status: string; jobId: string }>(
      "DELETE",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}`,
      { confirm },
    );
  }

  async listFiles(ref: ProjectRef) {
    return this.request<{ files: string[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/files`,
    );
  }

  async getFileContent(ref: ProjectRef, path: string) {
    return this.request<{ kind: string; value?: string }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/content?path=${encodeURIComponent(path)}`,
    );
  }

  async getActivity(ref: ProjectRef) {
    return this.request<{ events: ActivityEvent[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/activity`,
    );
  }

  // ── Workspaces ──────────────────────────────────────────────────────────

  async createWorkspace(ref: ProjectRef, name?: string) {
    return this.request<{ workspace: string; remote: string; path: string }>(
      "POST",
      `/api/workspaces/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/workspaces`,
      { ...(name ? { name } : {}) },
    );
  }

  async listWorkspaces(ref: ProjectRef) {
    return this.request<{ workspaces: Array<{ name: string; createdAt: string; path: string }> }>(
      "GET",
      `/api/workspaces/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/workspaces`,
    );
  }

  async deleteWorkspace(name: string, projectId: string) {
    return this.request<{ deleted: boolean }>(
      "DELETE",
      `/api/workspaces/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    );
  }

  async commitToWorkspace(
    workspace: string,
    projectId: string,
    files: Record<string, string>,
    message: string,
  ) {
    return this.request<{ workspace: string; commit: string; filesChanged: string[] }>(
      "POST",
      `/api/workspaces/${encodeURIComponent(workspace)}/commit`,
      { files, message, projectId },
    );
  }

  // ── Changes ─────────────────────────────────────────────────────────────

  async createChange(projectName: string, workspace: string) {
    return this.request<{
      change: Change;
      eval: { score: number; passed: boolean; reason: string };
      evalRuns: EvalRun[];
    }>("POST", `/api/projects/${encodeURIComponent(projectName)}/changes`, { workspace });
  }

  async listChanges(projectName: string, status?: string) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request<{ changes: Change[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(projectName)}/changes${query}`,
    );
  }

  async getChange(id: string) {
    return this.request<{
      change: Change;
      evalRuns: EvalRun[];
      costs: Array<{ kind: string; total: number; estimated: boolean }>;
    }>("GET", `/api/changes/${encodeURIComponent(id)}`);
  }

  async mergeChange(id: string, opts?: { force?: boolean; strategy?: "merge" | "squash" }) {
    const params = new URLSearchParams();
    if (opts?.force) params.set("force", "true");
    if (opts?.strategy) params.set("strategy", opts.strategy);
    const serialized = params.toString();
    const query = serialized ? `?${serialized}` : "";
    return this.request<{
      merged: boolean;
      commit?: string;
      postMerge?: { status: string; reason?: string };
    }>("POST", `/api/changes/${encodeURIComponent(id)}/merge${query}`);
  }

  async rejectChange(id: string) {
    return this.request<{ rejected: boolean }>(
      "POST",
      `/api/changes/${encodeURIComponent(id)}/reject`,
    );
  }

  async reviewChange(id: string, verdict: "approve" | "request_changes", comment?: string) {
    return this.request<{ review: { verdict: string }; changeStatus: string }>(
      "POST",
      `/api/changes/${encodeURIComponent(id)}/reviews`,
      { verdict, ...(comment ? { comment } : {}) },
    );
  }

  // ── Issues ──────────────────────────────────────────────────────────────

  async createIssue(ref: ProjectRef, title: string, body?: string, linkedChangeId?: string) {
    return this.request<{ issue: Issue }>(
      "POST",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/issues`,
      { title, ...(body ? { body } : {}), ...(linkedChangeId ? { linkedChangeId } : {}) },
    );
  }

  async listIssues(ref: ProjectRef, status?: "open" | "closed") {
    const query = status ? `?status=${status}` : "";
    return this.request<{ issues: Issue[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/issues${query}`,
    );
  }

  async updateIssue(
    ref: ProjectRef,
    number: number,
    updates: { status?: "open" | "closed"; title?: string; body?: string },
  ) {
    return this.request<{ issue: Issue }>(
      "PATCH",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/issues/${number}`,
      updates,
    );
  }

  // ── Agents & account ────────────────────────────────────────────────────

  async createAgent(name: string, model?: string) {
    return this.request<{ agent: { id: string; name: string }; token: string }>(
      "POST",
      "/api/agents",
      { name, ...(model ? { model } : {}) },
    );
  }

  async me() {
    return this.request<{ id: string; email: string }>("GET", "/api/users/me");
  }

  async deleteAccount(confirm: string) {
    return this.request<{ status: string; jobId: string }>("DELETE", "/api/users/me", { confirm });
  }
}
