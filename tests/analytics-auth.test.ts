import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAuthCompleted } from "../src/analytics/auth";
import type { Env } from "../src/types";
import { createLogger } from "../src/utils/logger";

vi.mock("../src/storage/users", () => ({ getUser: vi.fn() }));

import { getUser } from "../src/storage/users";

interface Captured {
  event: string;
  distinct_id: string;
  properties: Record<string, string | number | boolean>;
}

function stubCapture(): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      captured.push(JSON.parse(init?.body as string) as Captured);
      return new Response("ok");
    }),
  );
  return captured;
}

const env = { POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://ph.example.com" } as Env;
const logger = createLogger({ component: "test" });

/**
 * Runs `captureAuthCompleted` inside a real request, which is the only way to
 * exercise the `waitUntil`-or-await branch it shares with the rest of this
 * codebase's best-effort auth-path writes.
 */
async function runInRequest(
  outcome: Parameters<typeof captureAuthCompleted>[2],
  executionCtx?: ExecutionContext,
): Promise<void> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", async (c) => {
    await captureAuthCompleted(c, logger, outcome);
    return c.json({ ok: true });
  });
  await app.fetch(new Request("https://api.example.com/"), env, executionCtx);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("captureAuthCompleted", () => {
  it("records a sign-up with its provider", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { id: "user_1" },
    } as never);

    await runInRequest({ kind: "signup", provider: "github", userId: "user_1" });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe("auth_completed");
    expect(captured[0]?.distinct_id).toBe("user_1");
    expect(captured[0]?.properties.kind).toBe("signup");
    expect(captured[0]?.properties.provider).toBe("github");
  });

  it("records a sign-in distinctly from a sign-up", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: { id: "user_1" } } as never);

    await runInRequest({ kind: "signin", provider: "email", userId: "user_1" });

    expect(captured[0]?.properties.kind).toBe("signin");
    expect(captured[0]?.properties.provider).toBe("email");
  });

  it("honours an existing account's opt-out", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { id: "user_1", telemetryOptOut: true },
    } as never);

    await runInRequest({ kind: "signin", provider: "google", userId: "user_1" });

    expect(captured).toHaveLength(0);
  });

  it("never carries an email address or a username", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { id: "user_1", email: "person@acme.example", username: "acme-person" },
    } as never);

    await runInRequest({ kind: "signup", provider: "email", userId: "user_1" });

    const body = JSON.stringify(captured[0]);
    expect(body).not.toContain("acme");
    expect(body).not.toContain("@");
  });

  it("schedules the send past the response when an execution context exists", async () => {
    stubCapture();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: { id: "user_1" } } as never);
    const waitUntil = vi.fn();

    await runInRequest({ kind: "signup", provider: "github", userId: "user_1" }, {
      waitUntil,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  // Signing in must not be able to fail because telemetry did.
  it("resolves when the preference lookup throws", async () => {
    stubCapture();
    vi.mocked(getUser).mockRejectedValue(new Error("D1 exploded"));

    await expect(
      runInRequest({ kind: "signin", provider: "github", userId: "user_1" }),
    ).resolves.toBeUndefined();
  });

  // Without a person property a profile is an opaque id, and no cohort can ask
  // "accounts that signed up with GitHub". `$set_once`, so a later sign-in
  // through another provider cannot rewrite how someone actually arrived.
  it("records the signup provider as a first-touch person property", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: { id: "user_1" } } as never);

    await runInRequest({ kind: "signup", provider: "github", userId: "user_1" });

    expect(captured[0]?.properties.$set_once).toEqual({ signup_provider: "github" });
  });

  it("does not rewrite the signup provider on a later sign-in", async () => {
    const captured = stubCapture();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: { id: "user_1" } } as never);

    await runInRequest({ kind: "signin", provider: "google", userId: "user_1" });

    expect(captured[0]?.properties.$set_once).toBeUndefined();
  });
});
