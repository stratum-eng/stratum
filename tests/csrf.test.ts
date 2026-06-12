import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { csrfMiddleware } from "../src/middleware/csrf";
import type { Env } from "../src/types";

function makeApp(authVia?: "token" | "session") {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (authVia) c.set("authVia", authVia);
    await next();
  });
  app.use("*", csrfMiddleware);
  app.post("/mutate", (c) => c.json({ ok: true }));
  app.get("/read", (c) => c.json({ ok: true }));
  return app;
}

const env = {} as Env;

function post(headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.com/mutate", { method: "POST", headers });
}

describe("csrfMiddleware", () => {
  it("allows GET requests regardless of headers", async () => {
    const app = makeApp("session");
    const res = await app.fetch(new Request("https://app.example.com/read"), env);
    expect(res.status).toBe(200);
  });

  it("allows bearer-token mutations without Origin", async () => {
    const app = makeApp("token");
    const res = await app.fetch(post(), env);
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated mutations (no session to forge)", async () => {
    const app = makeApp(undefined);
    const res = await app.fetch(post(), env);
    expect(res.status).toBe(200);
  });

  it("allows session mutations with a same-origin Origin header", async () => {
    const app = makeApp("session");
    const res = await app.fetch(post({ Origin: "https://app.example.com" }), env);
    expect(res.status).toBe(200);
  });

  it("rejects session mutations from a different origin", async () => {
    const app = makeApp("session");
    const res = await app.fetch(post({ Origin: "https://evil.example.net" }), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("CSRF");
  });

  it("falls back to Referer when Origin is absent", async () => {
    const app = makeApp("session");
    const ok = await app.fetch(post({ Referer: "https://app.example.com/some/page" }), env);
    expect(ok.status).toBe(200);

    const bad = await app.fetch(post({ Referer: "https://evil.example.net/attack" }), env);
    expect(bad.status).toBe(403);
  });

  it("rejects session mutations with neither Origin nor Referer", async () => {
    const app = makeApp("session");
    const res = await app.fetch(post(), env);
    expect(res.status).toBe(403);
  });

  it("rejects malformed Origin headers", async () => {
    const app = makeApp("session");
    const res = await app.fetch(post({ Origin: "not a url" }), env);
    expect(res.status).toBe(403);
  });
});
