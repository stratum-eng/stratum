import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface AgentSummary {
  id: string;
  name: string;
  model?: string;
  createdAt: string;
}

interface SettingsPageProps {
  user: { id: string; email: string; username: string };
  agents: AgentSummary[];
  /** Freshly created credential, shown exactly once after a rotate/create POST. */
  freshToken?: { kind: "api-key" | "agent"; value: string; agentName?: string };
}

export const SettingsPage: FC<SettingsPageProps> = ({ user, agents, freshToken }) => {
  return (
    <Layout title="Settings" user={user}>
      <div class="page-header">
        <h1>Settings</h1>
      </div>

      {freshToken && (
        <div class="card settings-token-reveal">
          <h3 style={{ marginTop: 0 }}>
            {freshToken.kind === "api-key"
              ? "Your new API key"
              : `Token for agent ${freshToken.agentName ?? ""}`}
          </h3>
          <p class="settings-help">
            Copy it now — it is shown only once.{" "}
            {freshToken.kind === "api-key" ? "Your previous key no longer works." : ""}
          </p>
          <code class="settings-token">{freshToken.value}</code>
        </div>
      )}

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Account</h3>
        <dl class="detail-list">
          <dt>Username</dt>
          <dd>@{user.username}</dd>
          <dt>Email</dt>
          <dd>{user.email}</dd>
        </dl>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>API key</h3>
        <p class="settings-help">
          Used as <code>Authorization: Bearer stratum_user_…</code> for the API and CLI. Rotating
          invalidates the current key immediately.
        </p>
        <form method="post" action="/settings/rotate-token">
          <button type="submit" class="btn btn-danger">
            Rotate API key
          </button>
        </form>
      </div>

      <div class="card">
        <h3 style={{ marginTop: 0 }}>Agents</h3>
        <p class="settings-help">
          Agent tokens let automated agents fork workspaces, commit, and open changes under your
          account. Reviews remain human-only.
        </p>
        {agents.length === 0 ? (
          <p class="settings-help">No agents yet.</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Model</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td>{agent.name}</td>
                  <td>{agent.model ?? "—"}</td>
                  <td>{new Date(agent.createdAt).toLocaleDateString()}</td>
                  <td>
                    <form method="post" action={`/settings/agents/${agent.id}/delete`}>
                      <button type="submit" class="btn btn-small btn-danger">
                        Revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form method="post" action="/settings/agents" class="settings-agent-form">
          <label>
            Agent name
            <input type="text" name="name" required maxlength={100} />
          </label>
          <label>
            Model (optional)
            <input type="text" name="model" placeholder="claude-sonnet-4-6" maxlength={100} />
          </label>
          <button type="submit" class="btn btn-primary">
            Create agent token
          </button>
        </form>
      </div>
    </Layout>
  );
};
