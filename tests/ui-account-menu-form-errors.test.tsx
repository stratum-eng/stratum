/**
 * Issue #310's last two items: the signed-in name in the top bar is a menu
 * (profile, settings, logout) rather than three loose links, and the main
 * forms report a refusal as a styled inline error under the field instead of
 * the browser's validation bubble.
 *
 * `vitest.config.ts` restricts coverage to `src/**\/*.ts`, so the `.tsx` pages
 * contribute nothing to the ratchet — these assertions are what polices them.
 */
import { Hono } from "hono";
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it, vi } from "vitest";

// The re-rendered form pages read the signed-in user for the header.
vi.mock("../src/storage/users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/users")>()),
  getUser: vi.fn(async () => ({
    success: true,
    data: {
      id: "usr_1",
      email: "a@b.com",
      username: "alice",
      tokenHash: "h",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  })),
}));

vi.mock("../src/storage/webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/webhooks")>()),
  listWebhooks: vi.fn(async () => ({ success: true, data: [] })),
  listDeliveries: vi.fn(async () => ({ success: true, data: [] })),
}));

import { projectsRouter } from "../src/routes/projects";
import { uiRouter } from "../src/routes/ui";
import type { Env, ProjectEntry } from "../src/types";
import { FieldError, fieldAttrs, fieldErrorId } from "../src/ui/components/field-error";
import { Layout } from "../src/ui/layout";
import {
  NEW_PROJECT_ERROR_INVALID_NAME,
  NEW_PROJECT_ERROR_INVALID_URL,
  NEW_PROJECT_ERROR_NAME_TAKEN,
  NEW_PROJECT_ERROR_PRIVATE_LIMIT,
  type NewProjectFormValues,
  NewProjectPage,
  newProjectError,
} from "../src/ui/pages/new-project";
import { ProjectSettingsPage } from "../src/ui/pages/project-settings";
import { type WebhookFormValues, WebhooksPage, webhookFormError } from "../src/ui/pages/webhooks";

const user = { id: "usr_1", email: "a@b.com", username: "alice" };

/** The markup between `<details class="nav-user-menu">` and its close. */
function accountMenu(html: string): string {
  const start = html.indexOf('<details class="nav-user-menu">');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</details>", start) + "</details>".length);
}

/** The opening tag of the element with `id`. */
function tagWithId(html: string, id: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
  expect(match, `no element with id="${id}"`).not.toBeNull();
  return match?.[0] ?? "";
}

describe("top bar account menu", () => {
  const render = (active?: "new" | "settings") =>
    renderToString(
      <Layout title="T" user={user} {...(active !== undefined ? { active } : {})}>
        <p>body</p>
      </Layout>,
    );

  it("collapses profile, settings and logout under the signed-in name", () => {
    const menu = accountMenu(render());
    expect(menu).toMatch(/<summary[^>]*class="nav-user"/);
    expect(menu).toContain('title="@alice">alice<');
    expect(menu).toContain("account menu");
    expect(menu).toContain('href="/settings#account"');
    expect(menu).toContain('href="/settings"');
    // Logout stays a POST: a GET link would let any page log the user out.
    expect(menu).toMatch(
      /<form method="post" action="\/auth\/logout"[^>]*>\s*<button type="submit"/,
    );
  });

  it("leaves new project in the bar, outside the menu", () => {
    const html = render();
    const menu = accountMenu(html);
    expect(html).toContain('href="/new"');
    expect(menu).not.toContain('href="/new"');
  });

  it("keeps the current-page marker on the right link", () => {
    const onSettings = render("settings");
    expect(accountMenu(onSettings)).toMatch(/href="\/settings"[^>]*aria-current="page"/);
    expect(accountMenu(onSettings)).toContain('class="nav-user nav-user-current"');
    expect(onSettings).not.toMatch(/href="\/new"[^>]*aria-current/);

    const onNew = render("new");
    expect(onNew).toMatch(/href="\/new"[^>]*aria-current="page"/);
    expect(accountMenu(onNew)).not.toContain("aria-current");
    expect(accountMenu(onNew)).not.toContain("nav-user-current");
  });

  it("renders no menu when signed out", () => {
    const html = renderToString(
      <Layout title="T" user={null}>
        <p>body</p>
      </Layout>,
    );
    expect(html).not.toContain("nav-user-menu");
    expect(html).toContain('href="/auth/login"');
  });
});

describe("FieldError and fieldAttrs", () => {
  it("marks a refused control invalid and points it at its error and help", () => {
    expect(fieldAttrs("np-name", "Bad name", "np-name-help")).toEqual({
      id: "np-name",
      "aria-invalid": "true",
      "aria-describedby": "np-name-error np-name-help",
    });
  });

  it("keeps only the help text when the control is fine", () => {
    expect(fieldAttrs("np-name", undefined, "np-name-help")).toEqual({
      id: "np-name",
      "aria-describedby": "np-name-help",
    });
    expect(fieldAttrs("np-name", undefined)).toEqual({ id: "np-name" });
  });

  it("renders the message, nothing without one, and a hidden slot when reserved", () => {
    expect(renderToString(<FieldError for="x" message="Wrong" />)).toBe(
      `<p class="field-error" id="${fieldErrorId("x")}">Wrong</p>`,
    );
    expect(renderToString(<FieldError for="x" />)).toBe("");
    expect(renderToString(<FieldError for="x" reserve />)).toMatch(
      /<p class="field-error" id="x-error" hidden(="")?><\/p>/,
    );
  });
});

describe("new project form errors", () => {
  const render = (code?: string, values: NewProjectFormValues = {}) =>
    renderToString(
      <NewProjectPage user={user} nonce="n0nce" error={newProjectError(code)} values={values} />,
    );

  it("opts out of native bubbles, since the script and the server both validate", () => {
    expect(render()).toMatch(/<form id="new-project-form"[^>]*novalidate/);
  });

  it("renders a refused name under the name field, refilled", () => {
    const html = render(NEW_PROJECT_ERROR_NAME_TAKEN, { name: "taken" });
    const input = tagWithId(html, "np-name");
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="np-name-error np-name-help"');
    expect(input).toContain('value="taken"');
    expect(html).toMatch(/<p class="field-error" id="np-name-error">You already have a project/);
    // The URL field is not the problem, and no form-wide banner duplicates it.
    expect(tagWithId(html, "np-url")).not.toContain("aria-invalid");
    expect(html).not.toContain('class="error-message"');
  });

  it("reopens import mode for a refused URL", () => {
    const html = render(NEW_PROJECT_ERROR_INVALID_URL, {
      mode: "import",
      url: "https://example.com/x",
      name: "x",
    });
    expect(html).toMatch(/value="import" checked/);
    expect(tagWithId(html, "np-url")).toContain('aria-invalid="true"');
    expect(tagWithId(html, "np-url")).toContain('value="https://example.com/x"');
    expect(html).toContain('id="np-url-error">Enter a GitHub repository URL');
  });

  it("keeps a form-wide refusal in the banner, not under a field", () => {
    const html = render(NEW_PROJECT_ERROR_PRIVATE_LIMIT);
    expect(html).toMatch(/class="error-message" role="alert"[^>]*>This account.{1,6}s plan/);
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("resolves only known codes, never inherited keys", () => {
    expect(newProjectError(NEW_PROJECT_ERROR_INVALID_NAME)?.field).toBe("name");
    expect(newProjectError("toString")).toBeUndefined();
    expect(newProjectError("<script>")).toBeUndefined();
    expect(newProjectError(undefined)).toBeUndefined();
  });
});

describe("GET /new never prefills from the query string", () => {
  // A link that opened the import form holding someone else's repository is
  // one click from importing it.
  it("shows a coded error but none of the URL's values", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("userId", "usr_1");
      await next();
    });
    app.route("/", uiRouter);
    const res = await app.fetch(
      new Request(
        "https://t.test/new?error=invalid_url&mode=import&name=evil&url=https%3A%2F%2Fgithub.com%2Fattacker%2Frepo",
      ),
      { DB: {} as D1Database } as Env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="np-url-error">Enter a GitHub repository URL');
    expect(html).not.toContain("attacker");
    expect(html).not.toContain('value="evil"');
  });
});

describe("POST /projects from the new-project form", () => {
  const existing: ProjectEntry = {
    id: "prj_1",
    name: "taken",
    slug: "taken",
    namespace: "@alice",
    ownerId: "usr_1",
    ownerType: "user",
    remote: "https://example.invalid/taken.git",
    createdAt: "2026-01-01T00:00:00.000Z",
    visibility: "public",
  };

  function submit(fields: Record<string, string>, as: "form" | "json" = "form") {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("userId", "usr_1");
      c.set("username", "alice");
      await next();
    });
    app.route("/projects", projectsRouter);
    const env = {
      // Every key holds the existing project: a refusal for a taken name is all
      // these tests need to reach.
      STATE: { get: async () => JSON.stringify(existing) } as unknown as KVNamespace,
      DB: {} as D1Database,
    } as Env;
    return app.fetch(
      new Request("https://t.test/projects", {
        method: "POST",
        ...(as === "json"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) }
          : { body: new URLSearchParams(fields) }),
      }),
      env,
    );
  }

  it("re-renders the form itself for an invalid name, refilled from the POST", async () => {
    const res = await submit({ name: "no spaces!", visibility: "public" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(tagWithId(html, "np-name")).toContain('value="no spaces!"');
    expect(tagWithId(html, "np-name")).toContain('aria-invalid="true"');
    expect(html).toContain('id="np-name-error">That name cannot be used for a project.');
  });

  it("re-renders the form for a taken name", async () => {
    const res = await submit({ name: "taken", visibility: "public" });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(tagWithId(html, "np-name")).toContain('value="taken"');
    expect(html).toContain('id="np-name-error">You already have a project');
  });

  it("still answers an API caller with JSON", async () => {
    const res = await submit({ name: "no spaces!", visibility: "public" }, "json");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("POST /projects/:namespace/:slug/import from the new-project form", () => {
  /** An in-memory KV with the calls the import limiter and the route make. */
  function memoryKv(): { kv: KVNamespace; store: Map<string, string> } {
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null }),
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    } as unknown as KVNamespace;
    return { kv, store };
  }

  it("gives back the import lock on a refusal, so a corrected retry is not refused as busy", async () => {
    const { kv, store } = memoryKv();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("userId", "usr_1");
      c.set("username", "alice");
      await next();
    });
    app.route("/projects", projectsRouter);
    const submit = () =>
      app.fetch(
        new Request("https://t.test/projects/@alice/myrepo/import", {
          method: "POST",
          body: new URLSearchParams({ url: "not a url", visibility: "public" }),
        }),
        { STATE: kv, DB: {} as D1Database } as Env,
      );

    const first = await submit();
    expect(first.status).toBe(400);
    const html = await first.text();
    // The user's own submission comes back, in import mode, from the POST.
    expect(html).toMatch(/value="import" checked/);
    expect(tagWithId(html, "np-url")).toContain('value="not a url"');
    expect(tagWithId(html, "np-name")).toContain('value="myrepo"');
    expect(store.has("ratelimit:import:project:@alice:myrepo")).toBe(false);

    // Without the release this is a 429 "Project import in progress".
    const retry = await submit();
    expect(retry.status).toBe(400);
  });
});

describe("webhook form errors", () => {
  const project = { name: "api", namespace: "@alice", slug: "api" };
  const render = (code?: string, formValues?: WebhookFormValues) =>
    renderToString(
      <WebhooksPage
        project={project}
        formValues={formValues}
        webhooks={[
          {
            webhook: {
              id: "wh_1",
              project: "api",
              projectId: "proj_alice",
              url: "https://alice.example.com/hook",
              events: "*",
              active: true,
              createdBy: "usr_1",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            deliveries: [],
          },
        ]}
        subscribableEvents={["change.merged"]}
        formError={webhookFormError(code)}
        user={user}
        nonce="test-nonce"
      />,
    );

  it("keeps the regenerate-secret action and its confirm script beside an inline error", () => {
    const html = render("url");
    expect(html).toContain("Regenerate secret");
    expect(html).toContain('<script nonce="test-nonce">');
    expect(html).toContain('id="webhook-url-error"');
  });

  it("renders a refused URL under the URL field", () => {
    const html = render("url");
    expect(html).toMatch(/<form[^>]*class="webhook-form" novalidate/);
    const input = tagWithId(html, "webhook-url");
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="webhook-url-error"');
    expect(html).toContain('id="webhook-url-error">Enter a public http:// or https:// URL');
  });

  it("renders nothing extra without an error, and ignores unknown codes", () => {
    for (const html of [render(), render("toString")]) {
      expect(html).not.toContain("field-error");
      expect(html).not.toContain("aria-invalid");
    }
  });

  // The attack this guards against: a link that opens the management page
  // already holding the sender's endpoint with every event checked, one Save
  // from delivering all of the project's events to them.
  it("never prefills the add form from the page's query string", async () => {
    const project: ProjectEntry = {
      id: "prj_1",
      name: "api",
      slug: "api",
      namespace: "@alice",
      ownerId: "usr_1",
      ownerType: "user",
      remote: "https://example.invalid/api.git",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("userId", "usr_1");
      await next();
    });
    app.route("/", uiRouter);
    const res = await app.fetch(
      new Request(
        "https://t.test/@alice/api/webhooks?error=url&url=https%3A%2F%2Fattacker.example%2Fcollect&events=*&events=change.merged",
      ),
      {
        DB: {} as D1Database,
        STATE: { get: async () => JSON.stringify(project) } as unknown as KVNamespace,
      } as Env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="webhook-url"');
    expect(html).not.toContain("attacker.example");
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toMatch(/value="change\.merged" checked/);
  });

  it("refills the URL and exactly the checked events after a refusal", () => {
    const html = render("url", { url: "http://10.0.0.1/hook", events: ["change.merged"] });
    expect(tagWithId(html, "webhook-url")).toContain('value="http://10.0.0.1/hook"');
    expect(html).toMatch(/value="change\.merged" checked/);
    // "All events" was not checked, so it does not come back checked.
    expect(html).not.toMatch(/value="\*" checked/);
    // A fresh form still defaults to "All events".
    expect(render()).toMatch(/value="\*" checked/);
  });
});

describe("deploy secret form errors", () => {
  it("renders a field's refusal under that field instead of above the form", () => {
    const html = renderToString(
      <ProjectSettingsPage
        project={{ name: "api", namespace: "@alice", slug: "api", createdAt: "2026-01-01" }}
        isOwner={true}
        secrets={[]}
        canManageSecrets={true}
        secretError="A secret value is required."
        secretErrorField="value"
        user={user}
      />,
    );
    expect(tagWithId(html, "secret-value")).toContain('aria-invalid="true"');
    expect(html).toContain('id="secret-value-error">A secret value is required.');
    expect(html).not.toContain("settings-help-error");
    expect(html).toMatch(/class="secret-form" novalidate/);
  });
});
