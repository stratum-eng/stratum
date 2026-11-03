import { afterEach, describe, expect, it, vi } from "vitest";
import type { StratumConfig } from "../src/config.js";
import { type SignupDeps, type SignupRequest, runSignup } from "../src/signup.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const HOST = "https://s.example";
const EXPIRES_AT = "2030-01-01T00:15:00.000Z";
const START = Date.parse("2030-01-01T00:00:00.000Z");

const request: SignupRequest = {
  host: HOST,
  email: "you@example.com",
  username: "you",
  agentName: "Claude Code",
};

/** The 202 `POST /api/agent-signup` returns, as the route builds it. */
const accepted = {
  signupId: "asu_1",
  status: "pending",
  pollToken: "stratum_asp_secret",
  userCode: "WXYZ-4KHT",
  pollUrl: "/api/agent-signup/poll",
  interval: 5,
  expiresAt: EXPIRES_AT,
  message: "Approval email sent",
};

const pending = { status: "pending", interval: 5, expiresAt: EXPIRES_AT };

const complete = {
  status: "complete",
  user: { id: "usr_1", username: "you" },
  agent: { id: "agt_1", name: "Claude Code", ownerId: "usr_1", model: "claude-opus-5-5" },
  token: "stratum_agent_plaintext",
};

interface Harness {
  deps: SignupDeps;
  lines: string[];
  saved: StratumConfig[];
  sleeps: number[];
}

function harness(): Harness {
  const lines: string[] = [];
  const saved: StratumConfig[] = [];
  const sleeps: number[] = [];
  let clock = START;
  return {
    lines,
    saved,
    sleeps,
    deps: {
      notify: (line) => lines.push(line),
      save: async (config) => {
        saved.push(config);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
  };
}

function mockFetch(...responses: Array<Response | Error>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const response of responses) {
    if (response instanceof Error) spy.mockRejectedValueOnce(response);
    else spy.mockResolvedValueOnce(response);
  }
  return spy;
}

function bodyOf(spy: ReturnType<typeof mockFetch>, call: number): unknown {
  const init = spy.mock.calls[call]?.[1];
  return JSON.parse(String(init?.body));
}

describe("stratum signup: happy path", () => {
  it("requests the signup, shows the code, polls, and saves the agent token", async () => {
    const spy = mockFetch(
      jsonResponse(accepted, 202),
      jsonResponse(pending),
      jsonResponse(complete),
    );
    const h = harness();

    const result = await runSignup({ ...request, inviteCode: "BETA-1" }, h.deps);

    expect(result).toEqual({
      ok: true,
      value: {
        host: HOST,
        user: { id: "usr_1", username: "you" },
        agent: { id: "agt_1", name: "Claude Code", model: "claude-opus-5-5" },
      },
    });
    expect(spy.mock.calls[0]?.[0]).toBe(`${HOST}/api/agent-signup`);
    expect(bodyOf(spy, 0)).toEqual({
      email: "you@example.com",
      username: "you",
      agentName: "Claude Code",
      inviteCode: "BETA-1",
    });
    expect(spy.mock.calls[1]?.[0]).toBe(`${HOST}/api/agent-signup/poll`);
    expect(bodyOf(spy, 1)).toEqual({ pollToken: "stratum_asp_secret" });
    expect(h.lines.some((line) => line.includes("WXYZ-4KHT"))).toBe(true);
    expect(h.lines.some((line) => line.includes("you@example.com"))).toBe(true);
    // Stored exactly as `login --key` stores a token.
    expect(h.saved).toEqual([
      { host: HOST, credential: { kind: "apiKey", apiKey: "stratum_agent_plaintext" } },
    ]);
  });

  it("never prints the token", async () => {
    mockFetch(jsonResponse(accepted, 202), jsonResponse(complete));
    const h = harness();
    await runSignup(request, h.deps);
    expect(h.lines.join("\n")).not.toContain("stratum_agent_plaintext");
    expect(h.lines.join("\n")).not.toContain("stratum_asp_secret");
  });

  it("waits the server-suggested interval between polls, and follows changes to it", async () => {
    mockFetch(
      jsonResponse({ ...accepted, interval: 7 }, 202),
      jsonResponse({ ...pending, interval: 3 }),
      jsonResponse(complete),
    );
    const h = harness();
    await runSignup(request, h.deps);
    expect(h.sleeps).toEqual([7000, 3000]);
  });

  it("clamps a nonsensical interval", async () => {
    mockFetch(jsonResponse({ ...accepted, interval: 0 }, 202), jsonResponse(complete));
    const h = harness();
    await runSignup(request, h.deps);
    expect(h.sleeps).toEqual([1000]);
  });

  it("sends --model only when given, and normalizes the host", async () => {
    const spy = mockFetch(jsonResponse(accepted, 202), jsonResponse(complete));
    const h = harness();
    await runSignup({ ...request, host: `${HOST}/`, model: "claude-opus-5-5" }, h.deps);
    expect(spy.mock.calls[0]?.[0]).toBe(`${HOST}/api/agent-signup`);
    expect(bodyOf(spy, 0)).toMatchObject({ model: "claude-opus-5-5" });
    expect(bodyOf(spy, 0)).not.toHaveProperty("inviteCode");
  });
});

describe("stratum signup: request refused", () => {
  const cases: Array<[string, number, RegExp]> = [
    ["EMAIL_EXISTS", 409, /already has a Stratum account.*stratum login/],
    ["USERNAME_TAKEN", 409, /username 'you' is taken.*--username/],
    ["INVALID_INVITE", 403, /invite code isn't valid.*--invite/],
    ["INVITE_REQUIRED", 403, /invite code is required.*--invite/],
    ["AGENT_SIGNUP_DISABLED", 404, /not enabled/],
    ["RATE_LIMITED", 429, /try again later/i],
  ];

  for (const [code, status, message] of cases) {
    it(`explains ${code} and does not poll or save`, async () => {
      const spy = mockFetch(jsonResponse({ error: "server text", code }, status));
      const h = harness();
      const result = await runSignup(request, h.deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(message);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.saved).toEqual([]);
    });
  }

  it("passes an unknown error code through with the server's message", async () => {
    mockFetch(
      jsonResponse({ error: "Username not allowed: reserved", code: "INVALID_USERNAME" }, 400),
    );
    const result = await runSignup(request, harness().deps);
    expect(result).toEqual({
      ok: false,
      error: "Username not allowed: reserved (INVALID_USERNAME)",
    });
  });

  it("refuses a plaintext remote host before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await runSignup({ ...request, host: "http://s.example" }, harness().deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/plaintext/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports an unreachable host", async () => {
    mockFetch(new TypeError("fetch failed"));
    const result = await runSignup(request, harness().deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not reach.*fetch failed/);
  });

  it("reports a non-JSON response rather than crashing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("<html>", { status: 502 }));
    const result = await runSignup(request, harness().deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/non-JSON/);
  });
});

describe("stratum signup: polling ends without approval", () => {
  it("reports expiry", async () => {
    mockFetch(
      jsonResponse(accepted, 202),
      jsonResponse({ status: "expired", code: "EXPIRED", error: "expired" }, 410),
    );
    const h = harness();
    const result = await runSignup(request, h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired.*stratum signup again/);
    expect(h.saved).toEqual([]);
  });

  it("reports a request locked by wrong codes", async () => {
    mockFetch(
      jsonResponse(accepted, 202),
      jsonResponse({ status: "locked", code: "LOCKED", error: "locked" }, 410),
    );
    const result = await runSignup(request, harness().deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/wrong codes/);
  });

  it("reports a token another process already collected", async () => {
    mockFetch(
      jsonResponse(accepted, 202),
      jsonResponse({ error: "collected", code: "ALREADY_COLLECTED" }, 410),
    );
    const result = await runSignup(request, harness().deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already collected/);
  });

  it("gives up locally once the request is past expiry, even if the server is unreachable", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(accepted, 202));
    spy.mockRejectedValue(new TypeError("fetch failed"));
    const h = harness();
    const result = await runSignup(request, h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired/);
    // 15 minutes plus a minute's grace at 5s a poll, then stop.
    expect(spy.mock.calls.length).toBeLessThan(200);
  });

  it("still gives up when the server's 202 has no expiresAt", async () => {
    const { expiresAt: _omitted, ...noExpiry } = accepted;
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(noExpiry, 202));
    spy.mockRejectedValue(new TypeError("fetch failed"));
    const h = harness();
    const result = await runSignup(request, h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired/);
    // A one-hour fallback deadline at 5s a poll, then stop.
    expect(spy.mock.calls.length).toBeLessThan(800);
  });
});

describe("stratum signup: transient poll failures", () => {
  it("retries a network error and a 5xx, then completes", async () => {
    mockFetch(
      jsonResponse(accepted, 202),
      new TypeError("fetch failed"),
      jsonResponse({ error: "Could not create the agent; poll again", code: "POLL_FAILED" }, 500),
      jsonResponse(complete),
    );
    const h = harness();
    const result = await runSignup(request, h.deps);
    expect(result.ok).toBe(true);
    expect(h.lines.filter((line) => line.startsWith("Warning:"))).toHaveLength(2);
  });

  it("backs off on 429", async () => {
    mockFetch(
      jsonResponse(accepted, 202),
      jsonResponse({ error: "slow down" }, 429),
      jsonResponse(complete),
    );
    const h = harness();
    await runSignup(request, h.deps);
    expect(h.sleeps).toEqual([5000, 10000]);
  });

  it("refuses a completion that carries no token", async () => {
    mockFetch(jsonResponse(accepted, 202), jsonResponse({ ...complete, token: "" }));
    const h = harness();
    const result = await runSignup(request, h.deps);
    expect(result.ok).toBe(false);
    expect(h.saved).toEqual([]);
  });

  it("says the account exists when the token cannot be saved", async () => {
    mockFetch(jsonResponse(accepted, 202), jsonResponse(complete));
    const h = harness();
    h.deps.save = async () => {
      throw new Error("EACCES");
    };
    const result = await runSignup(request, h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/account was created.*EACCES/);
  });
});
