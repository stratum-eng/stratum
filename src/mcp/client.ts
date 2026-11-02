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
 * is the long pole — it runs the whole evaluation suite synchronously — and it
 * is precisely the call we do NOT want to cut short at an arbitrary deadline.
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
    return this.request<unknown>(
      "POST",
      `/api/projects/${encodeURIComponent(projectName)}/changes`,
      {
        workspace,
      },
    );
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

  async me() {
    return this.request<{ id: string; email: string }>("GET", "/api/users/me");
  }
}
