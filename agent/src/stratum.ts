/** Minimal Stratum API client — only the endpoints the agent loop needs. */

export interface ProjectRef {
  namespace: string;
  slug: string;
}

export function parseProjectRef(ref: string): ProjectRef {
  const [nsRaw, slug] = ref.split("/", 2);
  if (!nsRaw || !slug) {
    throw new Error(`Invalid project reference '${ref}' — expected namespace/slug`);
  }
  return { namespace: nsRaw.startsWith("@") ? nsRaw : `@${nsRaw}`, slug };
}

export class StratumApi {
  constructor(
    private host: string,
    private token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.host.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = (await response.json()) as { error?: string };
        message = parsed.error ?? message;
      } catch {
        message = response.statusText || message;
      }
      throw new Error(`Stratum ${method} ${path}: ${message}`);
    }
    return response.json() as Promise<T>;
  }

  withToken(token: string): StratumApi {
    return new StratumApi(this.host, token);
  }

  createAgentIdentity(name: string, model: string) {
    return this.request<{ agent: { id: string }; token: string }>("POST", "/api/agents", {
      name,
      model,
    });
  }

  getProject(ref: ProjectRef) {
    return this.request<{ id: string; name: string }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}`,
    );
  }

  listFiles(ref: ProjectRef) {
    return this.request<{ files: string[] }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/files`,
    );
  }

  getFileContent(ref: ProjectRef, path: string) {
    return this.request<{ kind: string; value?: string }>(
      "GET",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/content?path=${encodeURIComponent(path)}`,
    );
  }

  createWorkspace(ref: ProjectRef, name: string) {
    return this.request<{ workspace: string }>(
      "POST",
      `/api/projects/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.slug)}/workspaces`,
      { name },
    );
  }

  commit(workspace: string, projectId: string, files: Record<string, string>, message: string) {
    return this.request<{ commit: string }>(
      "POST",
      `/api/workspaces/${encodeURIComponent(workspace)}/commit`,
      { files, message, projectId },
    );
  }

  /**
   * Open a change. With an evaluation queue on the server the change comes
   * back `evaluating` and without `eval`; {@link waitForEvaluation} gets the
   * verdict. Older servers still return it inline.
   */
  createChange(projectName: string, workspace: string) {
    return this.request<{
      change: { id: string; status: string };
      eval?: { score: number; passed: boolean; reason: string };
    }>("POST", `/api/projects/${encodeURIComponent(projectName)}/changes`, { workspace });
  }

  getChange(id: string) {
    return this.request<{ change: ChangeSummary }>("GET", `/api/changes/${encodeURIComponent(id)}`);
  }

  /**
   * Poll until the change leaves `evaluating`. A change still evaluating at
   * the deadline is an error, never a verdict: reporting it as a failure would
   * tell the operator the gate rejected code it has not finished judging.
   */
  async waitForEvaluation(
    id: string,
    opts: {
      timeoutMs?: number;
      intervalMs?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    } = {},
  ): Promise<ChangeSummary> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const intervalMs = opts.intervalMs ?? 3_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.now ?? Date.now;
    const deadline = now() + timeoutMs;
    for (;;) {
      const { change } = await this.getChange(id);
      if (change.status !== "evaluating") return change;
      if (now() >= deadline) {
        throw new Error(`Change ${id} is still evaluating after ${Math.round(timeoutMs / 1000)}s`);
      }
      await sleep(intervalMs);
    }
  }
}

/** The fields of a change the agent reports. */
export interface ChangeSummary {
  id: string;
  status: string;
  evalScore?: number;
  evalPassed?: boolean;
  evalReason?: string;
}
