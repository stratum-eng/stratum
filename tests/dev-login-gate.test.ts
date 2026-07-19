/**
 * SEC-5: /dev-login is a session-minting backdoor that ships in the production
 * Worker. It must be gated on an explicit env flag (DEV_LOGIN_ENABLED === "true")
 * in addition to the localhost host check, so it is inert in staging/production
 * even if a request presents a localhost authority.
 */
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  getUserByEmail: vi.fn(async () => ({
    success: true,
    data: { id: "usr_dev", email: "dev@example.com" },
  })),
  getUserByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  createUser: vi.fn(),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

vi.mock("../src/storage/sessions", () => ({
  createSession: vi.fn(async () => ({ success: true, data: { id: "sess_dev" } })),
}));

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
    ...overrides,
  } as Env;
}

function devLoginRequest(): Request {
  return new Request("http://localhost/dev-login?email=dev@example.com", { method: "GET" });
}

describe("SEC-5: /dev-login gating", () => {
  it("is forbidden when DEV_LOGIN_ENABLED is unset (production posture)", async () => {
    const res = await app.fetch(devLoginRequest(), makeEnv());
    expect(res.status).toBe(403);
  });

  it("is forbidden when DEV_LOGIN_ENABLED is not exactly 'true'", async () => {
    const res = await app.fetch(devLoginRequest(), makeEnv({ DEV_LOGIN_ENABLED: "1" }));
    expect(res.status).toBe(403);
  });

  it("mints a session (302 redirect) on localhost when explicitly enabled", async () => {
    const res = await app.fetch(devLoginRequest(), makeEnv({ DEV_LOGIN_ENABLED: "true" }));
    expect(res.status).toBe(302);
  });

  it("stays forbidden on a non-localhost host even when enabled", async () => {
    const res = await app.fetch(
      new Request("https://app.usestratum.dev/dev-login?email=dev@example.com", { method: "GET" }),
      makeEnv({ DEV_LOGIN_ENABLED: "true" }),
    );
    expect(res.status).toBe(403);
  });
});
