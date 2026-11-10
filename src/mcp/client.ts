/**
 * The Stratum API surface the MCP tools call.
 *
 * Every tool call is handed to a dispatcher that runs the SAME Hono routers
 * in-process, with the REST API's own paths, payloads and error mapping. The
 * point of routing through the real handlers is that MCP callers get exactly
 * the REST API's behaviour, including its authorization checks, its evaluation
 * gates and its refusals, rather than a parallel implementation that has to be
 * kept in agreement with it.
 *
 * There is no request timeout here. A dispatched request never leaves the
 * isolate, so there is no socket to hang: the bound is
 * the Worker's own wall-clock limit, and an AbortController racing it would
 * only turn a clean platform error into a confusing one. `stratum_create_change`
 * is the long pole where no evaluation queue is bound — it then runs the whole
 * evaluation suite synchronously — and it is precisely the call we do NOT want
 * to cut short at an arbitrary deadline. With the queue bound it returns as
 * soon as the run is enqueued (#412).
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
 * A tool argument was malformed in a way the JSON Schema could not express.
 *
 * Its own type so `tools.ts` can label it as an ARGUMENT failure rather than an
 * API failure. The distinction is the whole point of the two message prefixes:
 * a model that reads "Stratum API error" for a malformed project reference
 * retries the same reference, where "Invalid arguments" tells it to fix the
 * value it sent.
 */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

/**
 * Parse "ns/slug" or "@ns/slug" into a project reference. Exactly two
 * non-empty segments — extra segments are rejected rather than silently
 * dropped, so a tool can never operate on a different project than named.
 */
export function parseProjectRef(ref: string): ProjectRef {
  const segments = ref.split("/");
  const [nsRaw, slug] = segments;
  if (segments.length !== 2 || !nsRaw || nsRaw === "@" || !slug) {
    throw new InvalidArgumentError(`Invalid project reference '${ref}' — expected namespace/slug`);
  }
  return { namespace: nsRaw.startsWith("@") ? nsRaw : `@${nsRaw}`, slug };
}

/**
 * Runs one API request against the in-process routers.
 *
 * Supplied by `src/mcp/dispatch.ts`, which owns the middleware chain the
 * sub-request passes through.
 */
export type ApiDispatch = (request: Request) => Promise<Response>;

/** `/api/projects/{namespace}/{slug}`, each segment encoded. */
function projectPath(ref: ProjectRef): string {
  return `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}`;
}

/** `/api/orgs/{slug}`, encoded. Accepts the slug with or without its `@`. */
function orgPath(org: string): string {
  return `/api/orgs/${encodeURIComponent(org.startsWith("@") ? org.slice(1) : org)}`;
}

export class StratumClient {
  /**
   * @param origin  Absolute origin the sub-request URLs are built on. Taken
   *   from the inbound MCP request so a self-hosted instance addresses itself,
   *   never a hard-coded host.
   * @param authorization  The verbatim `Authorization` header of the inbound
   *   MCP request, replayed on every sub-request. The credential is therefore
   *   re-resolved by the real auth middleware for each call, so a token revoked
   *   mid-session stops working on the very next tool call rather than at the
   *   end of the connection.
   */
  constructor(
    private origin: string,
    private authorization: string,
    private dispatch: ApiDispatch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.authorization };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.dispatch(
      new Request(`${this.origin}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );

    if (!response.ok) {
      // The API's error shapes, surfaced as the tool's error text. `reasons` is
      // what a blocked merge returns — the gate verdicts — and losing it would
      // reduce "these three evaluators failed" to "409".
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
      throw new Error(message);
    }

    return (await response.json()) as T;
  }

  // ── Projects ────────────────────────────────────────────────────────────

  async listProjects() {
    return this.request<{ projects: unknown[] }>("GET", "/api/projects");
  }

  async getProject(ref: ProjectRef) {
    return this.request<unknown>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}`,
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
    return this.request<{ events: unknown[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/activity`,
    );
  }

  async listBranches(ref: ProjectRef) {
    return this.request<unknown>("GET", `${projectPath(ref)}/branches`);
  }

  /**
   * Create a project in the caller's namespace, or in `org`'s when given.
   * `POST /api/projects` decides who may create where; nothing is checked here.
   */
  async createProject(opts: {
    name: string;
    org?: string;
    visibility?: "private" | "public";
    seed?: boolean;
  }) {
    return this.request<unknown>("POST", "/api/projects", {
      name: opts.name,
      ...(opts.org !== undefined ? { org: opts.org } : {}),
      ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    });
  }

  async importProject(
    ref: ProjectRef,
    opts: { url: string; branch?: string; depth?: number; visibility?: "private" | "public" },
  ) {
    return this.request<unknown>("POST", `${projectPath(ref)}/import`, {
      url: opts.url,
      ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
      ...(opts.visibility !== undefined ? { visibility: opts.visibility } : {}),
    });
  }

  async getImportStatus(ref: ProjectRef) {
    return this.request<unknown>("GET", `${projectPath(ref)}/import/status`);
  }

  async getSyncStatus(ref: ProjectRef) {
    return this.request<unknown>("GET", `${projectPath(ref)}/sync/status`);
  }

  /**
   * Sent with an empty JSON body on purpose: the sync route answers a request
   * WITHOUT a JSON content type as a browser form, with a redirect, which the
   * dispatcher would surface as an opaque non-2xx.
   */
  async syncProject(ref: ProjectRef) {
    return this.request<unknown>("POST", `${projectPath(ref)}/sync`, {});
  }

  // ── Organizations ───────────────────────────────────────────────────────

  async createOrg(name: string, slug: string) {
    return this.request<unknown>("POST", "/api/orgs", { name, slug });
  }

  async listOrgs() {
    return this.request<{ orgs: unknown[] }>("GET", "/api/orgs");
  }

  async getOrg(org: string) {
    return this.request<unknown>("GET", orgPath(org));
  }

  async addOrgMember(org: string, userId: string, role?: "member" | "admin") {
    return this.request<unknown>("POST", `${orgPath(org)}/members`, {
      userId,
      ...(role !== undefined ? { role } : {}),
    });
  }

  async removeOrgMember(org: string, userId: string) {
    return this.request<unknown>("DELETE", `${orgPath(org)}/members/${encodeURIComponent(userId)}`);
  }

  async createTeam(
    org: string,
    team: { name: string; slug: string; permissions?: "read" | "write" | "admin" },
  ) {
    return this.request<unknown>("POST", `${orgPath(org)}/teams`, {
      name: team.name,
      slug: team.slug,
      ...(team.permissions !== undefined ? { permissions: team.permissions } : {}),
    });
  }

  async listTeams(org: string) {
    return this.request<{ teams: unknown[] }>("GET", `${orgPath(org)}/teams`);
  }

  async addTeamMember(org: string, teamId: string, userId: string) {
    return this.request<unknown>(
      "POST",
      `${orgPath(org)}/teams/${encodeURIComponent(teamId)}/members`,
      { userId },
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
    return this.request<{ workspaces: unknown[] }>(
      "GET",
      `/api/workspaces/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/workspaces`,
    );
  }

  /**
   * Mint a short-lived git credential for one workspace (#408). The response
   * carries the secret; nothing on this path logs a successful result.
   */
  async workspaceRemote(ref: ProjectRef, workspace: string, expiresInMinutes?: number) {
    return this.request<{
      remote: string;
      username: string;
      token: string;
      expiresAt: string;
      credentialId: string;
    }>(
      "POST",
      `/api/workspaces/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/workspaces/${encodeURIComponent(workspace)}/remote-credential`,
      expiresInMinutes !== undefined ? { expiresInMinutes } : {},
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

  async createChange(
    projectName: string,
    workspace: string,
    text: { title?: string; description?: string } = {},
  ) {
    return this.request<unknown>(
      "POST",
      `/api/projects/${encodeURIComponent(projectName)}/changes`,
      {
        workspace,
        ...(text.title !== undefined ? { title: text.title } : {}),
        ...(text.description !== undefined ? { description: text.description } : {}),
      },
    );
  }

  async updateChange(id: string, text: { title?: string; description?: string }) {
    return this.request<unknown>("PATCH", `/api/changes/${encodeURIComponent(id)}`, {
      ...(text.title !== undefined ? { title: text.title } : {}),
      ...(text.description !== undefined ? { description: text.description } : {}),
    });
  }

  async listChanges(projectName: string, status?: string) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request<{ changes: unknown[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(projectName)}/changes${query}`,
    );
  }

  async getChange(id: string) {
    return this.request<unknown>("GET", `/api/changes/${encodeURIComponent(id)}`);
  }

  async mergeChange(id: string, opts?: { force?: boolean; strategy?: "merge" | "squash" }) {
    const params = new URLSearchParams();
    if (opts?.force) params.set("force", "true");
    if (opts?.strategy) params.set("strategy", opts.strategy);
    const serialized = params.toString();
    const query = serialized ? `?${serialized}` : "";
    return this.request<unknown>("POST", `/api/changes/${encodeURIComponent(id)}/merge${query}`);
  }

  async rejectChange(id: string) {
    return this.request<{ rejected: boolean }>(
      "POST",
      `/api/changes/${encodeURIComponent(id)}/reject`,
    );
  }

  async reviewChange(id: string, verdict: "approve" | "request_changes", comment?: string) {
    return this.request<unknown>("POST", `/api/changes/${encodeURIComponent(id)}/reviews`, {
      verdict,
      ...(comment ? { comment } : {}),
    });
  }

  /** Sent with an empty JSON body so the route answers in JSON, never with
   * the redirect it gives a browser form. */
  async evaluateChange(id: string) {
    return this.request<unknown>("POST", `/api/changes/${encodeURIComponent(id)}/evaluate`, {});
  }

  async listChecks(id: string, opts?: { all?: boolean }) {
    const query = opts?.all ? "?all=true" : "";
    return this.request<unknown>("GET", `/api/changes/${encodeURIComponent(id)}/checks${query}`);
  }

  async rerunCheck(id: string, checkId: string) {
    return this.request<unknown>(
      "POST",
      `/api/changes/${encodeURIComponent(id)}/checks/${encodeURIComponent(checkId)}/rerun`,
      {},
    );
  }

  async promoteChange(id: string, opts: { title?: string; body?: string; draft?: boolean }) {
    return this.request<unknown>("POST", `/api/changes/${encodeURIComponent(id)}/github-pr`, {
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
    });
  }

  async commentOnChange(
    id: string,
    comment: {
      body: string;
      file?: string;
      line?: number;
      side?: "old" | "new";
      commitSha?: string;
      parentCommentId?: string;
    },
  ) {
    return this.request<unknown>(
      "POST",
      `/api/changes/${encodeURIComponent(id)}/comments`,
      comment,
    );
  }

  async listChangeComments(id: string) {
    return this.request<{ comments: unknown[] }>(
      "GET",
      `/api/changes/${encodeURIComponent(id)}/comments`,
    );
  }

  // ── Issues ──────────────────────────────────────────────────────────────

  async createIssue(ref: ProjectRef, title: string, body?: string, linkedChangeId?: string) {
    return this.request<unknown>(
      "POST",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/issues`,
      { title, ...(body ? { body } : {}), ...(linkedChangeId ? { linkedChangeId } : {}) },
    );
  }

  async listIssues(ref: ProjectRef, status?: "open" | "closed") {
    const query = status ? `?status=${status}` : "";
    return this.request<{ issues: unknown[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/issues${query}`,
    );
  }

  async updateIssue(
    ref: ProjectRef,
    number: number,
    updates: { status?: "open" | "closed"; title?: string; body?: string },
  ) {
    return this.request<unknown>(
      "PATCH",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/issues/${number}`,
      updates,
    );
  }

  // ── Account ─────────────────────────────────────────────────────────────

  /** Who the credential acts as. A user credential gets its account; an OAuth
   * grant bound to an agent (#409) gets the agent and the owner it acts for. */
  async me() {
    return this.request<
      | { actingAs: "user"; id: string; email: string; username?: string; createdAt: string }
      | {
          actingAs: "agent";
          agent: { id: string; name: string };
          owner: { id: string; username: string };
        }
    >("GET", "/api/users/me");
  }

  /**
   * The caller's metered usage against their plan limits.
   *
   * Read-only by design and by surface: there is no billing WRITE anywhere on
   * this client, because an agent that can raise its own limit does not have
   * one (PRD §4c).
   */
  async getUsage() {
    return this.request<unknown>("GET", "/api/users/me/usage");
  }
}
