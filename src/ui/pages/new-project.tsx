import type { FC } from "hono/jsx";
import { Layout } from "../layout";

interface NewProjectProps {
  user?: { id: string; email: string; username: string } | null;
  error?: string;
  /** Per-request CSP nonce — required so the form script passes `script-src`. */
  nonce: string;
}

/**
 * One form, two modes. The script only does what markup can't: it points the
 * form at the right endpoint per mode (blank -> POST /api/projects, import ->
 * the namespaced import endpoint), keeps `required` on the URL field in sync
 * with the mode (a hidden required field would block submission), and suggests
 * a project name from a pasted GitHub URL until the user edits the name
 * themselves. Mode switching itself is pure CSS (`:has()` on the checked radio).
 */
const NEW_PROJECT_SCRIPT = `
(function () {
  var form = document.getElementById('new-project-form');
  if (!form) return;
  var urlInput = form.querySelector('[name=url]');
  var nameInput = form.querySelector('[name=name]');

  function mode() {
    var checked = form.querySelector('input[name=mode]:checked');
    return checked ? checked.value : 'blank';
  }

  function syncMode() {
    urlInput.required = mode() === 'import';
  }
  form.querySelectorAll('input[name=mode]').forEach(function (radio) {
    radio.addEventListener('change', syncMode);
  });
  syncMode();

  // Suggest a name from the pasted URL until the user types their own.
  var nameEdited = false;
  nameInput.addEventListener('input', function () { nameEdited = true; });
  urlInput.addEventListener('input', function () {
    if (nameEdited) return;
    var match = urlInput.value.match(/github\\.com\\/[^/]+\\/([^/?#]+)/);
    if (!match) return;
    nameInput.value = match[1]
      .replace(/\\.git$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  });

  form.addEventListener('submit', function (event) {
    if (mode() === 'import') {
      var userData = document.getElementById('user-data');
      var username = userData ? userData.dataset.username : '';
      if (!username) {
        alert('Please sign in first');
        event.preventDefault();
        return;
      }
      form.action =
        '/api/projects/@' + encodeURIComponent(username) +
        '/' + encodeURIComponent(nameInput.value) + '/import';
    } else {
      form.action = '/api/projects';
    }
  });
})();
`;

export const NewProjectPage: FC<NewProjectProps> = ({ user, error, nonce }) => {
  const username = user?.username || "";

  return (
    <Layout title="New Project" user={user} active="new">
      {/* Username for the import endpoint path — read by the form script. */}
      <div data-username={username} style="display:none" id="user-data" />

      <div class="page-header">
        <h1>New project</h1>
        <a class="btn" href="/">
          Cancel
        </a>
      </div>

      {error && (
        <div class="error-message" style={{ marginBottom: "1.25rem" }}>
          {error}
        </div>
      )}

      <div class="card" style={{ maxWidth: "560px" }}>
        <form id="new-project-form" method="post" action="/api/projects" class="new-project-form">
          <div class="mode-toggle" role="radiogroup" aria-label="How to start">
            <label>
              <input type="radio" name="mode" value="blank" checked />
              Start blank
            </label>
            <label>
              <input type="radio" name="mode" value="import" />
              Import from GitHub
            </label>
          </div>

          <div class="form-field import-only">
            <label for="np-url">GitHub URL</label>
            <input
              id="np-url"
              type="url"
              name="url"
              placeholder="https://github.com/owner/repo"
              pattern="https://github.com/.*"
              title="Must be a valid GitHub URL"
            />
            <p class="help-text">Public repositories import directly; the name fills in for you.</p>
          </div>

          <div class="form-field">
            <label for="np-name">Project name</label>
            <input
              id="np-name"
              type="text"
              name="name"
              placeholder="my-project"
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers, and hyphens only"
              required
            />
            <p class="help-text">Lowercase letters, numbers, and hyphens only.</p>
          </div>

          <div class="form-field">
            <label for="np-visibility">Visibility</label>
            <select id="np-visibility" name="visibility">
              <option value="public">Public (anyone can see it)</option>
              <option value="private" selected>
                Private (only you can see it)
              </option>
            </select>
          </div>

          <div class="form-field blank-only">
            <label class="checkbox-label">
              <input type="checkbox" name="seed" value="true" checked />
              Seed with sample files (README.md and src/index.ts)
            </label>
          </div>

          <button type="submit" class="btn btn-primary">
            <span class="submit-label-blank">Create project</span>
            <span class="submit-label-import">Import project</span>
          </button>
        </form>
      </div>

      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: NEW_PROJECT_SCRIPT }} />
    </Layout>
  );
};
