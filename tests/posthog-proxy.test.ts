import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { isPostHogProxyPath, posthogProxyRouter } from "../src/routes/posthog-proxy";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: { get: vi.fn(), create: vi.fn() } as unknown as Env["ARTIFACTS"],
    STATE: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    DB: {} as D1Database,
    POSTHOG_HOST: "https://app.posthog.com",
    POSTHOG_PUBLIC_KEY: "phc_test123",
    ...overrides,
  } as unknown as Env;
}

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** Replace global fetch, recording what the proxy forwarded. */
function stubUpstream(response: () => Response | Promise<Response>): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.url, init });
    return response();
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPostHogProxyPath", () => {
  it("matches the prefix and everything under it, and nothing else", () => {
    expect(isPostHogProxyPath("/_ph")).toBe(true);
    expect(isPostHogProxyPath("/_ph/e")).toBe(true);
    expect(isPostHogProxyPath("/_phony")).toBe(false);
    expect(isPostHogProxyPath("/api/_ph")).toBe(false);
  });
});

describe("ingestion forwarding", () => {
  it("forwards an allowlisted capture path to the region's ingestion host", async () => {
    const calls = stubUpstream(() => new Response("ok", { status: 200 }));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e?ver=1", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.url).toBe("https://us.i.posthog.com/e?ver=1");
  });

  it("routes an EU instance to the EU ingestion host", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv({ POSTHOG_HOST: "https://eu.posthog.com" }),
    );
    expect(calls[0]?.url).toBe("https://eu.i.posthog.com/e");
  });

  it("never forwards the session cookie or an Authorization header", async () => {
    // The proxy is same-origin, so the browser attaches the Stratum session
    // cookie to every analytics request. Forwarding it would hand a live
    // credential to a third party on every pageview.
    const calls = stubUpstream(() => new Response("ok"));
    await app.fetch(
      new Request("http://localhost/_ph/e", {
        method: "POST",
        body: "{}",
        headers: {
          cookie: "stratum_session=secret-session-value",
          authorization: "Bearer secret-token",
        },
      }),
      makeEnv(),
    );
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  it("forwards the client IP so events do not all geolocate to one datacentre", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    await app.fetch(
      new Request("http://localhost/_ph/e", {
        method: "POST",
        body: "{}",
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      }),
      makeEnv(),
    );
    expect(new Headers(calls[0]?.init?.headers).get("X-Forwarded-For")).toBe("203.0.113.7");
  });

  it("strips upstream Set-Cookie so PostHog cannot set state on this origin", async () => {
    stubUpstream(() => new Response("ok", { headers: { "set-cookie": "ph_session=1; Path=/" } }));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses any path outside the ingestion allowlist", async () => {
    // An unrestricted prefix is an unauthenticated relay running under this
    // origin and billed to whoever deployed it.
    const calls = stubUpstream(() => new Response("ok"));
    for (const path of ["/_ph/admin", "/_ph/s", "/_ph/anything"]) {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, { method: "POST" }),
        makeEnv(),
      );
      expect(res.status, path).toBe(204);
    }
    // Traversal is normalised away by URL parsing before routing, so it never
    // reaches the proxy at all — the property that matters is that no such
    // request is forwarded, whatever status the app ends up returning.
    await app.fetch(new Request("http://localhost/_ph/../secret", { method: "POST" }), makeEnv());
    expect(calls).toHaveLength(0);
  });

  it("refuses methods that are not beacons or config calls", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await app.fetch(new Request("http://localhost/_ph/e", { method }), makeEnv());
      expect(res.status, method).toBe(204);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a request it has already forwarded once", async () => {
    // Catches a POSTHOG_HOST that CNAMEs back to this same Worker route, which
    // same-origin comparison alone cannot see.
    const calls = stubUpstream(() => new Response("ok"));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", {
        method: "POST",
        body: "{}",
        headers: { "X-Stratum-Proxy": "1" },
      }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("refuses to forward when POSTHOG_HOST points back at this instance", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv({ POSTHOG_HOST: "http://localhost" }),
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("refuses an oversized beacon", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "x".repeat(1_000_001) }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("refuses an oversized chunked body without buffering it whole", async () => {
    // A chunked request declares no Content-Length, so the early header check
    // cannot see it — the running total during the stream read is what bounds
    // this case, and it is the shape an abusive caller would actually send.
    const calls = stubUpstream(() => new Response("ok"));
    const chunk = new Uint8Array(256 * 1024);
    const TOTAL_CHUNKS = 40; // 10 MB if fully drained
    let emitted = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (emitted >= TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await app.fetch(
      // @ts-expect-error duplex is required for a streaming body and is not in the DOM types
      new Request("http://localhost/_ph/e", { method: "POST", body: stream, duplex: "half" }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);

    // The assertions that distinguish this from the previous implementation.
    // Buffering the body first and checking afterwards would drain all 40
    // chunks and never cancel, so a 204 alone proves nothing: both versions
    // refuse the request, only one refuses it without holding 10 MB.
    expect(cancelled).toBe(true);
    expect(emitted).toBeLessThan(TOTAL_CHUNKS);
  });

  it("forwards a normal-sized chunked body", async () => {
    const calls = stubUpstream(() => new Response("ok"));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"event":"$pageview"}'));
        controller.close();
      },
    });
    const res = await app.fetch(
      // @ts-expect-error duplex is required for a streaming body and is not in the DOM types
      new Request("http://localhost/_ph/e", { method: "POST", body: stream, duplex: "half" }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("never forwards the Referer, which carries the full page URL", async () => {
    // Referrer-Policy: strict-origin-when-cross-origin sends the FULL url on a
    // same-origin subresource request, and this proxy is same-origin — so
    // without stripping, every beacon would carry the concrete repo path in a
    // header, bypassing the snippet's redaction entirely.
    const calls = stubUpstream(() => new Response("ok"));
    await app.fetch(
      new Request("http://localhost/_ph/e", {
        method: "POST",
        body: "{}",
        headers: {
          referer: "https://app.usestratum.dev/@alice/private-repo/blob/main/src/secret.ts?ref=abc",
        },
      }),
      makeEnv(),
    );
    const forwarded = new Headers(calls[0]?.init?.headers);
    expect(forwarded.get("referer")).toBeNull();
    expect(JSON.stringify([...forwarded])).not.toContain("private-repo");
  });

  it("never forwards a caller-supplied X-Forwarded-For", async () => {
    // Behind Cloudflare the edge rewrites it, but a self-hoster behind another
    // proxy would otherwise let a caller choose their own country in PostHog.
    const calls = stubUpstream(() => new Response("ok"));
    await app.fetch(
      new Request("http://localhost/_ph/e", {
        method: "POST",
        body: "{}",
        headers: { "X-Forwarded-For": "198.51.100.1" },
      }),
      makeEnv(),
    );
    expect(new Headers(calls[0]?.init?.headers).get("X-Forwarded-For")).toBeNull();
  });

  it("answers 204 rather than 500 when PostHog is unreachable", async () => {
    // Reaching the error boundary would emit an `error_occurred` event per
    // failed beacon: a telemetry storm caused by telemetry being down.
    stubUpstream(() => {
      throw new Error("network down");
    });
    const res = await app.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
  });
});

describe("gates", () => {
  it("relays nothing on an instance that never serves the SDK", async () => {
    // The default for every self-hoster. Without this the path allowlist made
    // it "not an open relay" while the feature switch did not — any instance
    // running this code relayed beacons on its own origin and subrequest budget.
    const calls = stubUpstream(() => new Response("ok"));
    for (const env of [
      makeEnv({ POSTHOG_PUBLIC_KEY: undefined }),
      makeEnv({ POSTHOG_PUBLIC_KEY: "phx_personal" }),
      makeEnv({ STRATUM_TELEMETRY_DISABLED: "true" }),
    ]) {
      const res = await app.fetch(
        new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
        env,
      );
      expect(res.status).toBe(204);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a beacon from a user who has opted out", async () => {
    // Suppressing the script only stops NEW page loads. A tab opened before the
    // user opted out keeps posting, and this is the last point that can refuse
    // it — so this is where the opt-out actually becomes enforcement rather
    // than a request not to be sent one.
    const probe = new Hono<{ Bindings: Env }>();
    probe.use("*", (c, next) => {
      c.set("telemetryOptOut", true);
      return next();
    });
    probe.route("/_ph", posthogProxyRouter);

    const calls = stubUpstream(() => new Response("ok"));
    const res = await probe.fetch(
      new Request("http://localhost/_ph/e", { method: "POST", body: "{}" }),
      makeEnv(),
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("does not serve the SDK bundle when the feature is off", async () => {
    const calls = stubUpstream(() => new Response("/* sdk */"));
    const res = await app.fetch(
      new Request("http://localhost/_ph/static/1.427.2/array.js"),
      makeEnv({ POSTHOG_PUBLIC_KEY: undefined }),
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("SDK bundle", () => {
  it("serves the pinned bundle immutably", async () => {
    const calls = stubUpstream(() => new Response("/* sdk */", { status: 200 }));
    const res = await app.fetch(
      new Request("http://localhost/_ph/static/1.427.2/array.js"),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(calls[0]?.url).toBe("https://cdn.jsdelivr.net/npm/posthog-js@1.427.2/dist/array.js");
  });

  it("refuses a version that is not plain semver", async () => {
    // The version is interpolated into a CDN URL, so it must never be
    // attacker-controlled path material.
    const calls = stubUpstream(() => new Response("/* sdk */"));
    for (const version of ["../../evil", "latest", "1.2", "1.2.3;x"]) {
      const res = await app.fetch(
        new Request(`http://localhost/_ph/static/${encodeURIComponent(version)}/array.js`),
        makeEnv(),
      );
      expect(res.status, version).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("answers 204 when the bundle cannot be fetched", async () => {
    stubUpstream(() => new Response("nope", { status: 500 }));
    const res = await app.fetch(
      new Request("http://localhost/_ph/static/1.427.2/array.js"),
      makeEnv(),
    );
    expect(res.status).toBe(204);
  });
});
