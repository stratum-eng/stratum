import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { NO_ANALYTICS_HEADER, webAnalyticsMiddleware } from "../src/middleware/web-analytics";
import type { Env } from "../src/types";
import { STRATUM_SOURCE_URL } from "../src/version";

const KEY = "phc_test123";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: { get: vi.fn(), create: vi.fn() } as unknown as Env["ARTIFACTS"],
    STATE: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    DB: {} as D1Database,
    POSTHOG_PUBLIC_KEY: KEY,
    STRATUM_ENVIRONMENT: "test",
    ...overrides,
  } as unknown as Env;
}

/** A page that renders for an anonymous visitor, so no session plumbing is needed. */
async function fetchSignup(env: Env): Promise<Response> {
  return app.fetch(new Request("http://localhost/auth/signup"), env);
}

describe("web analytics injection", () => {
  it("injects the SDK and bootstrap when every gate is open", async () => {
    const html = await (await fetchSignup(makeEnv())).text();
    expect(html).toContain("/_ph/static/");
    expect(html).toContain("posthog.init");
  });

  it("injects nothing when no public key is configured", async () => {
    // The default for every self-hoster, and for this repo's own local dev.
    const html = await (await fetchSignup(makeEnv({ POSTHOG_PUBLIC_KEY: undefined }))).text();
    expect(html).not.toContain("/_ph/static/");
    expect(html).not.toContain("posthog.init");
  });

  it("injects nothing when the instance kill switch is set", async () => {
    const env = makeEnv({ STRATUM_TELEMETRY_DISABLED: "true" });
    const html = await (await fetchSignup(env)).text();
    expect(html).not.toContain("posthog.init");
  });

  it("injects nothing when the key is not a project token", async () => {
    // A personal key (phx_) would be a credential, not a public identifier.
    const html = await (await fetchSignup(makeEnv({ POSTHOG_PUBLIC_KEY: "phx_secret" }))).text();
    expect(html).not.toContain("posthog.init");
    expect(html).not.toContain("phx_secret");
  });

  it("carries the request's CSP nonce on both injected tags", async () => {
    // Without a matching nonce the tags are blocked by `script-src` and the only
    // result is a pair of violation reports.
    const res = await fetchSignup(makeEnv());
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get("Content-Security-Policy") ?? "")?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    const tags = html.match(/<script[^>]*>/g) ?? [];
    const injected = tags.filter((t) => t.includes("/_ph/static/") || t.includes("defer"));
    expect(injected.length).toBeGreaterThan(0);
    expect(injected.filter((t) => !t.includes(`nonce="${nonce}"`))).toEqual([]);
  });

  it("reports the route pattern, never the concrete path", async () => {
    const html = await (await fetchSignup(makeEnv())).text();
    const config = /var cfg = (\{.*?\});/s.exec(html)?.[1];
    expect(config).toBeTruthy();
    expect(JSON.parse(config as string).route).toBe("/auth/signup");
  });

  it("marks injected responses no-store so a stale nonce is never cached", async () => {
    const res = await fetchSignup(makeEnv());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("overrides a handler's own cacheable header, and corrects Content-Length", async () => {
    // Hono's `set res` copies the outgoing response's headers onto the
    // replacement, so setting these on the constructor's Headers was silently
    // undone. A cached page would serve a stale nonce and block the script;
    // a stale Content-Length describes a document shorter than the one sent.
    const probe = new Hono<{ Bindings: Env }>();
    probe.use("*", (c, next) => {
      c.set("cspNonce", "test-nonce");
      return next();
    });
    probe.use("*", webAnalyticsMiddleware);
    probe.get("/cached", (c) =>
      c.html("<html><body>hi</body></html>", 200, {
        "Cache-Control": "public, max-age=300",
        "Content-Length": "29",
      }),
    );
    const res = await probe.fetch(new Request("http://localhost/cached"), makeEnv());
    const body = await res.text();
    expect(body).toContain("posthog.init");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Length")).toBeNull();
  });

  it("leaves non-HTML responses alone", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv());
    expect(await res.text()).not.toContain("posthog.init");
  });

  it("leaves the stylesheet alone", async () => {
    const res = await app.fetch(new Request("http://localhost/ui.css"), makeEnv());
    expect(await res.text()).not.toContain("posthog.init");
  });

  it("never instruments a page that renders a secret", async () => {
    // /settings reveals a freshly minted API token exactly once, and the
    // webhook-created page under /api prints a signing secret beside a Copy
    // button. Autocapture on either is a disclosure, so both are denied.
    for (const path of ["/settings", "/api/projects/x/webhooks"]) {
      const res = await app.fetch(new Request(`http://localhost${path}`), makeEnv());
      expect(await res.text(), path).not.toContain("posthog.init");
    }
  });

  it("never instruments the routes that render a plaintext credential", async () => {
    // The regression this covers: DENIED_ROUTES matched by equality, so
    // `/settings` covered only `GET /settings` — which renders nothing secret —
    // while POST /settings/tokens, /settings/rotate-token and /settings/agents,
    // the three that DO return a plaintext token, were instrumented.
    // Through a probe, not the real app: without a session those handlers
    // answer 302, and the middleware bails on a redirect before `isDenied` ever
    // runs — so asserting against the real app passed for the wrong reason and
    // would have kept passing with the deny list deleted.
    const probe = new Hono<{ Bindings: Env }>();
    probe.use("*", (c, next) => {
      c.set("cspNonce", "test-nonce");
      return next();
    });
    probe.use("*", webAnalyticsMiddleware);
    const denied = ["/settings/tokens", "/settings/rotate-token", "/settings/agents"];
    for (const path of denied) {
      probe.post(path, (c) => c.html("<html><body>plaintext token</body></html>"));
    }
    // A control, so the probe is proven capable of injecting in the first place.
    probe.post("/ordinary", (c) => c.html("<html><body>hi</body></html>"));

    for (const path of denied) {
      const res = await probe.fetch(
        new Request(`http://localhost${path}`, { method: "POST" }),
        makeEnv(),
      );
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain("posthog.init");
    }
    const control = await probe.fetch(
      new Request("http://localhost/ordinary", { method: "POST" }),
      makeEnv(),
    );
    expect(await control.text()).toContain("posthog.init");
  });

  it("honours a handler's own opt-out header, and does not leak it to the client", async () => {
    const probe = new Hono<{ Bindings: Env }>();
    probe.use("*", (c, next) => {
      c.set("cspNonce", "test-nonce");
      return next();
    });
    probe.use("*", webAnalyticsMiddleware);
    probe.get("/secret", (c) =>
      c.html("<html><body>token</body></html>", 200, { [NO_ANALYTICS_HEADER]: "1" }),
    );
    probe.get("/ordinary", (c) => c.html("<html><body>hi</body></html>"));

    const denied = await probe.fetch(new Request("http://localhost/secret"), makeEnv());
    expect(await denied.text()).not.toContain("posthog.init");
    expect(denied.headers.get(NO_ANALYTICS_HEADER)).toBeNull();

    const allowed = await probe.fetch(new Request("http://localhost/ordinary"), makeEnv());
    expect(await allowed.text()).toContain("posthog.init");
  });

  it("injects even when the document has no closing body tag", async () => {
    // Silent absence of analytics is the failure this whole change exists to
    // fix, so a missing anchor must not reintroduce it.
    const probe = new Hono<{ Bindings: Env }>();
    probe.use("*", (c, next) => {
      c.set("cspNonce", "test-nonce");
      return next();
    });
    probe.use("*", webAnalyticsMiddleware);
    probe.get("/fragment", (c) => c.html("<p>no body element here</p>"));
    const res = await probe.fetch(new Request("http://localhost/fragment"), makeEnv());
    expect(await res.text()).toContain("posthog.init");
  });

  it("never instruments the OAuth consent screen", async () => {
    const res = await app.fetch(
      new Request("http://localhost/oauth/authorize?client_id=a&state=b"),
      makeEnv(),
    );
    expect(await res.text()).not.toContain("posthog.init");
  });

  it("does not instrument the proxy's own responses", async () => {
    const res = await app.fetch(new Request("http://localhost/_ph/e"), makeEnv());
    expect(await res.text()).not.toContain("posthog.init");
  });

  it("does not fire a browser pageview on a 404", async () => {
    // `analyticsMiddleware` drops server-side 404s and the FAQ documents it;
    // injecting here would put the two surfaces permanently out of agreement.
    const res = await app.fetch(new Request("http://localhost/no-such-page"), makeEnv());
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("posthog.init");
  });

  it("never lets the public key reach a page that was not instrumented", async () => {
    const env = makeEnv({ STRATUM_TELEMETRY_DISABLED: "true" });
    const html = await (await fetchSignup(env)).text();
    expect(html).not.toContain(KEY);
  });

  it("leaves the AGPL source offer intact on the page it rewrites", async () => {
    // Two features now write to the same document: `Layout` renders the §13
    // offer just inside `</body>`, and this middleware splices scripts in at
    // that same marker. Injecting is a rewrite of an already-rendered page, so
    // the offer must survive it — a legal notice dropped by an analytics
    // rewrite would be a licence violation caused by telemetry.
    const html = await (await fetchSignup(makeEnv())).text();
    expect(html).toContain("posthog.init");
    expect(html).toContain(STRATUM_SOURCE_URL);
    expect(html).toContain("AGPL-3.0");
  });
});
