import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { rateLimitMiddleware } from "../src/middleware/rate-limit";
import type { Env } from "../src/types";

/** A native binding that allows the first `allow` calls per key, then refuses. */
function fakeLimiter(allow = Number.POSITIVE_INFINITY): RateLimit & {
  limit: ReturnType<typeof vi.fn>;
} {
  const counts = new Map<string, number>();
  return {
    limit: vi.fn(async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= allow };
    }),
  } as unknown as RateLimit & { limit: ReturnType<typeof vi.fn> };
}

function makeKV() {
  const store = new Map<string, string>();
  const get = vi.fn(async (k: string) => store.get(k) ?? null);
  const put = vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  });
  return { kv: { get, put } as unknown as KVNamespace, get, put };
}

function makeApp(opts?: { requestsPerMinute?: number }, userId?: string) {
  const app = new Hono<{ Bindings: Env; Variables: { userId?: string } }>();
  app.use("*", async (c, next) => {
    if (userId) c.set("userId", userId);
    await next();
  });
  app.use("*", rateLimitMiddleware(opts));
  app.get("*", (c) => c.text("ok"));
  return app;
}

function req(path: string): Request {
  return new Request(`https://app.example${path}`, {
    headers: { "CF-Connecting-IP": "203.0.113.7" },
  });
}

describe("rate limiting with native bindings", () => {
  it("counts a signed-out request in the binding, never in KV", async () => {
    const { kv, get, put } = makeKV();
    const anon = fakeLimiter();
    const env = { STATE: kv, RATE_LIMIT_ANON: anon } as unknown as Env;

    const res = await makeApp().fetch(req("/"), env);

    expect(res.status).toBe(200);
    expect(anon.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("uses the signed-in binding, keyed by user, for an authenticated request", async () => {
    const { kv } = makeKV();
    const anon = fakeLimiter();
    const auth = fakeLimiter();
    const env = { STATE: kv, RATE_LIMIT_ANON: anon, RATE_LIMIT_AUTH: auth } as unknown as Env;

    await makeApp(undefined, "usr_1").fetch(req("/"), env);

    expect(auth.limit).toHaveBeenCalledWith({ key: "usr_1" });
    expect(anon.limit).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After once the binding refuses", async () => {
    const { kv } = makeKV();
    const env = { STATE: kv, RATE_LIMIT_ANON: fakeLimiter(1) } as unknown as Env;
    const app = makeApp();

    expect((await app.fetch(req("/"), env)).status).toBe(200);
    const refused = await app.fetch(req("/"), env);

    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(refused.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("routes a route-level 20/min limit to its own binding", async () => {
    const { kv } = makeKV();
    const strict = fakeLimiter();
    const env = { STATE: kv, RATE_LIMIT_STRICT: strict } as unknown as Env;

    await makeApp({ requestsPerMinute: 20 }, "usr_1").fetch(req("/projects"), env);

    expect(strict.limit).toHaveBeenCalledWith({ key: "usr_1" });
  });

  it("falls back to the KV counter when no binding is configured for the limit", async () => {
    const { kv, get, put } = makeKV();
    // A self-host without the bindings, or a limit no binding is sized for.
    const env = { STATE: kv, RATE_LIMIT_ANON: fakeLimiter() } as unknown as Env;

    const res = await makeApp({ requestsPerMinute: 7 }).fetch(req("/"), env);

    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalled();
    expect(put).toHaveBeenCalled();
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("6");
  });

  it("allows the request when the binding itself fails", async () => {
    const { kv } = makeKV();
    const broken = { limit: vi.fn(async () => Promise.reject(new Error("down"))) };
    const env = { STATE: kv, RATE_LIMIT_ANON: broken } as unknown as Env;

    expect((await makeApp().fetch(req("/"), env)).status).toBe(200);
  });

  it("does not rate limit the stylesheet or favicon at all", async () => {
    const { kv, get } = makeKV();
    const anon = fakeLimiter(0);
    const env = { STATE: kv, RATE_LIMIT_ANON: anon } as unknown as Env;
    const app = makeApp();

    expect((await app.fetch(req("/ui.css"), env)).status).toBe(200);
    expect((await app.fetch(req("/favicon.ico"), env)).status).toBe(200);
    expect(anon.limit).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
