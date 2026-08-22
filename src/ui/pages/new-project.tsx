import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface NewProjectProps {
  user?: { id: string; email: string; username: string } | null;
  error?: string;
  /** Per-request CSP nonce — required so the import-form script passes `script-src`. */
  nonce: string;
}

/**
 * Rewrites the GitHub import form's action to the namespaced import endpoint on
 * submit (or blocks it with a login prompt). CSP-safe replacement for the old
 * inline `onsubmit=` handler — identical behavior: returning false became
 * `event.preventDefault()`, the mutated `action` still submits normally.
 */
const IMPORT_FORM_SCRIPT = `
(function () {
  var form = document.getElementById('import-form');
  if (!form) return;
  form.addEventListener('submit', function (event) {
    var name = form.querySelector('[name=name]').value;
    var userData = document.getElementById('user-data');
    var username = userData ? userData.dataset.username : '';
    if (!username) {
      alert('Please log in first');
      event.preventDefault();
      return;
    }
    form.action = '/api/projects/@' + encodeURIComponent(username) + '/' + encodeURIComponent(name) + '/import';
  });
})();
`;

export const NewProjectPage: FC<NewProjectProps> = ({ user, error, nonce }) => {
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
              <option value="public">Public (anyone can see it)</option>
              <option value="private" selected>
                Private (only you can see it)
              </option>
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

          <button type="submit" class="btn btn-primary">
            Create Project
          </button>
        </form>
      </div>

      <div class="card" style={{ marginTop: "1.5rem" }}>
        <h3 style={{ marginTop: 0 }}>Or import from GitHub</h3>
        <form
          id="import-form"
          method="post"
          action="/api/projects/import"
          style={{ marginTop: "1rem" }}
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
              <option value="public">Public (anyone can see it)</option>
              <option value="private" selected>
                Private (only you can see it)
              </option>
            </select>
          </div>

          <button type="submit" class="btn btn-primary">
            Import from GitHub
          </button>
        </form>
      </div>

      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: IMPORT_FORM_SCRIPT }} />
    </Layout>
  );
};
