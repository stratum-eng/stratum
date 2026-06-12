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

  createChange(projectName: string, workspace: string) {
    return this.request<{
      change: { id: string; status: string };
      eval: { score: number; passed: boolean; reason: string };
    }>("POST", `/api/projects/${encodeURIComponent(projectName)}/changes`, { workspace });
  }
}
