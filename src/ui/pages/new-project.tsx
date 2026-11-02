import type { FC } from "hono/jsx";
import { FieldError, fieldAttrs } from "../components/field-error";
import { Layout } from "../layout";

/** `?error=` code for a form submission refused by the private project gauge. */
export const NEW_PROJECT_ERROR_PRIVATE_LIMIT = "private_project_limit";
/** `?error=` code for a project name the server will not accept as a slug. */
export const NEW_PROJECT_ERROR_INVALID_NAME = "invalid_name";
/** `?error=` code for a name already used by a project in the namespace. */
export const NEW_PROJECT_ERROR_NAME_TAKEN = "name_taken";
/** `?error=` code for an import URL that is not a supported repository URL. */
export const NEW_PROJECT_ERROR_INVALID_URL = "invalid_url";

/** Which field an error is about; absent for one about the whole form. */
type NewProjectField = "name" | "url";

/** A resolved `?error=` code: the copy, and the field to render it under. */
export interface NewProjectError {
  message: string;
  field?: NewProjectField;
}

const NAME_RULE = "Use lowercase letters, numbers, and hyphens only.";
const INVALID_URL_MESSAGE = "Enter a GitHub repository URL, like https://github.com/owner/repo.";

const NEW_PROJECT_ERRORS: Record<string, NewProjectError> = {
  [NEW_PROJECT_ERROR_PRIVATE_LIMIT]: {
    message:
      "This account's plan does not allow another private project. Make this one public, remove or make public one you already have, or raise this account's plan limits.",
  },
  [NEW_PROJECT_ERROR_INVALID_NAME]: {
    field: "name",
    message: `That name cannot be used for a project. ${NAME_RULE}`,
  },
  [NEW_PROJECT_ERROR_NAME_TAKEN]: {
    field: "name",
    message: "You already have a project with that name. Choose another.",
  },
  [NEW_PROJECT_ERROR_INVALID_URL]: {
    field: "url",
    message: INVALID_URL_MESSAGE,
  },
};

/**
 * Maps a `?error=` code to its copy. Only known codes render, so the query
 * string can select a message but never supply one.
 */
export function newProjectError(code: string | undefined): NewProjectError | undefined {
  // `Object.hasOwn`, not a bare index: `NEW_PROJECT_ERRORS["toString"]` is a
  // function, which would otherwise render as an error.
  return code !== undefined && Object.hasOwn(NEW_PROJECT_ERRORS, code)
    ? NEW_PROJECT_ERRORS[code]
    : undefined;
}

/** Longest value echoed back into the form; longer input is dropped, not cut. */
const MAX_ECHOED_LENGTH = 2048;

/** What the user had typed, carried through the redirect back to the form. */
export interface NewProjectFormValues {
  mode?: "blank" | "import";
  name?: string;
  url?: string;
}

/**
 * Where a refused form submission goes: back to `/new` with the error code
 * and what the user had entered, so the form comes back filled in with the
 * reason under the field. Values are only ever rendered as input values
 * (escaped by JSX), never as copy.
 */
export function newProjectErrorUrl(code: string, values: NewProjectFormValues = {}): string {
  const params = new URLSearchParams({ error: code });
  if (values.mode === "import") params.set("mode", "import");
  for (const key of ["name", "url"] as const) {
    const value = values[key];
    if (value !== undefined && value !== "" && value.length <= MAX_ECHOED_LENGTH) {
      params.set(key, value);
    }
  }
  return `/new?${params.toString()}`;
}

/** Reads the echoed form values back off the `/new` query string. */
export function newProjectFormValues(
  query: (key: string) => string | undefined,
): NewProjectFormValues {
  const values: NewProjectFormValues = {};
  if (query("mode") === "import") values.mode = "import";
  for (const key of ["name", "url"] as const) {
    const value = query(key);
    if (value !== undefined && value.length <= MAX_ECHOED_LENGTH) values[key] = value;
  }
  return values;
}

interface NewProjectProps {
  user?: { id: string; email: string; username: string } | null;
  /** A refused submission's reason, resolved from its `?error=` code. */
  error?: NewProjectError | undefined;
  /** What the user had entered before the refusal, to refill the form. */
  values?: NewProjectFormValues;
  /** Per-request CSP nonce — required so the form script passes `script-src`. */
  nonce: string;
}

/**
 * One form, two modes. The script only does what markup can't: it points the
 * form at the right endpoint per mode (blank -> POST /api/projects, import ->
 * the namespaced import endpoint), keeps `required` on the URL field in sync
 * with the mode (a hidden required field would block submission), suggests a
 * project name from a pasted GitHub URL until the user edits the name
 * themselves, and checks the fields before submit. Mode switching itself is
 * pure CSS (`:has()` on the checked radio).
 *
 * The form is `novalidate`, so the browser shows no bubbles: the script runs
 * the same constraint checks and writes the reason into the field's
 * `.field-error` instead, from the `data-missing` / `data-invalid` copy on the
 * control. Without script the form still submits, and the server's refusal
 * comes back as the same inline error.
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

  function showError(input, message) {
    var error = document.getElementById(input.id + '-error');
    if (!error) return;
    var help = input.getAttribute('data-help');
    if (message) {
      error.textContent = message;
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', error.id + (help ? ' ' + help : ''));
    } else {
      error.textContent = '';
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      if (help) input.setAttribute('aria-describedby', help);
      else input.removeAttribute('aria-describedby');
    }
  }

  function check(input) {
    if (input.checkValidity()) { showError(input, ''); return true; }
    showError(input, input.validity.valueMissing
      ? input.getAttribute('data-missing')
      : input.getAttribute('data-invalid'));
    return false;
  }

  [urlInput, nameInput].forEach(function (input) {
    // Clear a shown error as soon as the value is fixed, not on the next submit.
    input.addEventListener('input', function () {
      if (input.getAttribute('aria-invalid') === 'true') check(input);
    });
  });

  // Suggest a name from the pasted URL until the user types their own.
  var nameEdited = nameInput.value !== '';
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
    if (nameInput.getAttribute('aria-invalid') === 'true') check(nameInput);
  });

  form.addEventListener('submit', function (event) {
    // The URL field is hidden in blank mode, so it is neither checked nor
    // left showing an error the user cannot see.
    var importing = mode() === 'import';
    if (!importing) showError(urlInput, '');
    var fields = importing ? [urlInput, nameInput] : [nameInput];
    var firstInvalid = null;
    fields.forEach(function (input) {
      if (!check(input) && !firstInvalid) firstInvalid = input;
    });
    if (firstInvalid) {
      event.preventDefault();
      firstInvalid.focus();
      return;
    }
    if (importing) {
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

export const NewProjectPage: FC<NewProjectProps> = ({ user, error, values = {}, nonce }) => {
  const username = user?.username || "";
  const importMode = values.mode === "import" || error?.field === "url";
  const urlError = error?.field === "url" ? error.message : undefined;
  const nameError = error?.field === "name" ? error.message : undefined;

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

      {/* A form-wide refusal (the plan limit) has no field to sit under. */}
      {error && error.field === undefined && (
        <div class="error-message" role="alert" style={{ marginBottom: "1.25rem" }}>
          {error.message}
        </div>
      )}

      <div class="card" style={{ maxWidth: "560px" }}>
        <form
          id="new-project-form"
          method="post"
          action="/api/projects"
          class="new-project-form"
          novalidate
        >
          <div class="mode-toggle" role="radiogroup" aria-label="How to start">
            <label>
              <input type="radio" name="mode" value="blank" checked={!importMode} />
              Start blank
            </label>
            <label>
              <input type="radio" name="mode" value="import" checked={importMode} />
              Import from GitHub
            </label>
          </div>

          <div class="form-field import-only">
            <label for="np-url">GitHub URL</label>
            <input
              {...fieldAttrs("np-url", urlError, "np-url-help")}
              type="url"
              name="url"
              value={values.url}
              placeholder="https://github.com/owner/repo"
              pattern="https://github.com/.*"
              data-help="np-url-help"
              data-missing="Enter the URL of the repository to import."
              data-invalid={INVALID_URL_MESSAGE}
            />
            <FieldError for="np-url" message={urlError} reserve />
            <p class="help-text" id="np-url-help">
              Public repositories import directly; the name fills in for you.
            </p>
          </div>

          <div class="form-field">
            <label for="np-name">Project name</label>
            <input
              {...fieldAttrs("np-name", nameError, "np-name-help")}
              type="text"
              name="name"
              value={values.name}
              placeholder="my-project"
              pattern="[a-z0-9-]+"
              required
              data-help="np-name-help"
              data-missing="Enter a name for the project."
              data-invalid={`That name cannot be used. ${NAME_RULE}`}
            />
            <FieldError for="np-name" message={nameError} reserve />
            <p class="help-text" id="np-name-help">
              Lowercase letters, numbers, and hyphens only.
            </p>
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
