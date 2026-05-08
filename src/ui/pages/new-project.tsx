import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface NewProjectProps {
  user?: { id: string; email: string; username: string } | null;
  error?: string;
}

export const NewProjectPage: FC<NewProjectProps> = ({ user, error }) => {
  // Always set username data, fallback to empty string if not available
  const username = user?.username || "";

  return (
    <Layout title="New Project" user={user}>
      {/* Set username for import form JavaScript - always render even if empty */}
      <div data-username={username} style="display:none" id="user-data" />

      <div class="page-header">
        <h1>Create New Project</h1>
        <a class="btn" href="/">
          Cancel
        </a>
      </div>

      {error && (
        <div class="card" style="background: #3d1a1a; border-color: #6e2a2a; margin-bottom: 1rem;">
          <p style="color: #f87171; margin: 0;">{error}</p>
        </div>
      )}

      <div class="card">
        <form method="post" action="/api/projects">
          <div style="margin-bottom: 1rem;">
            <label style={{ display: "block", marginBottom: "0.5rem", color: "#888" }}>
              Project Name
            </label>
            <input
              type="text"
              name="name"
              placeholder="my-project"
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers, and hyphens only"
              required
              style={{
                width: "100%",
                padding: "0.5rem",
                background: "#0a0a0a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#f0f0f0",
                fontFamily: "inherit",
              }}
            />
            <small style={{ color: "#666", display: "block", marginTop: "0.25rem" }}>
              Use lowercase letters, numbers, and hyphens only
            </small>
          </div>

          <div style="margin-bottom: 1rem;">
            <label style={{ display: "block", marginBottom: "0.5rem", color: "#888" }}>
              Visibility
            </label>
            <select
              name="visibility"
              style={{
                width: "100%",
                padding: "0.5rem",
                background: "#0a0a0a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#f0f0f0",
                fontFamily: "inherit",
              }}
            >
              <option value="public" selected>
                Public (anyone can see it)
              </option>
              <option value="private">Private (only you can see it)</option>
            </select>
          </div>

          <div style="margin-bottom: 1rem;">
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                color: "#888",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                name="seed"
                value="true"
                checked
                style={{ cursor: "pointer" }}
              />
              Seed with sample files (README.md and src/index.ts)
            </label>
          </div>

          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button type="submit" class="btn btn-primary">
              Create Project
            </button>
            <a href="/" class="btn">
              Cancel
            </a>
          </div>
        </form>
      </div>

      <div class="card" style={{ marginTop: "1.5rem" }}>
        <h3 style={{ marginTop: 0 }}>Or import from GitHub</h3>
        <form
          method="post"
          action="/api/projects/import"
          style={{ marginTop: "1rem" }}
          onsubmit="const name = this.querySelector('[name=name]').value; const userData = document.getElementById('user-data'); const username = userData ? userData.dataset.username : ''; if (!username) { alert('Please log in first'); return false; } this.action = '/api/projects/@' + encodeURIComponent(username) + '/' + encodeURIComponent(name) + '/import'; return true;"
        >
          <div style="margin-bottom: 1rem;">
            <label style={{ display: "block", marginBottom: "0.5rem", color: "#888" }}>
              Project Name
            </label>
            <input
              type="text"
              name="name"
              placeholder="my-project"
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers, and hyphens only"
              required
              style={{
                width: "100%",
                padding: "0.5rem",
                background: "#0a0a0a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#f0f0f0",
                fontFamily: "inherit",
              }}
            />
          </div>

          <div style="margin-bottom: 1rem;">
            <label style={{ display: "block", marginBottom: "0.5rem", color: "#888" }}>
              GitHub URL
            </label>
            <input
              type="url"
              name="url"
              placeholder="https://github.com/owner/repo"
              pattern="https://github.com/.*"
              title="Must be a valid GitHub URL"
              required
              style={{
                width: "100%",
                padding: "0.5rem",
                background: "#0a0a0a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#f0f0f0",
                fontFamily: "inherit",
              }}
            />
          </div>

          <div style="margin-bottom: 1rem;">
            <label style={{ display: "block", marginBottom: "0.5rem", color: "#888" }}>
              Visibility
            </label>
            <select
              name="visibility"
              style={{
                width: "100%",
                padding: "0.5rem",
                background: "#0a0a0a",
                border: "1px solid #333",
                borderRadius: "4px",
                color: "#f0f0f0",
                fontFamily: "inherit",
              }}
            >
              <option value="public" selected>
                Public (anyone can see it)
              </option>
              <option value="private">Private (only you can see it)</option>
            </select>
          </div>

          <button type="submit" class="btn btn-primary">
            Import from GitHub
          </button>
        </form>
      </div>
    </Layout>
  );
};
