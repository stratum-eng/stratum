import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSignupRouter } from "../src/routes/agent-signup";
import { emailAuthRouter } from "../src/routes/email-auth";
import type { Env } from "../src/types";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeMagicLinkLimiters } from "./helpers/magic-link-limiter";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const ORIGIN = "https://stratum.test";

interface SentEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let app: Hono<{ Bindings: Env }>;
let env: Env;
let raw: ReturnType<typeof makeSqliteD1>["raw"];
let sent: SentEmail[];

function makeEnv(overrides: Partial<Env> = {}): Env {
  const sqlite = makeSqliteD1();
  raw = sqlite.raw;
  sent = [];
  return {
    DB: sqlite.db,
    STATE: makeFakeKV(),
    MAGIC_LINK_LIMITER: makeMagicLinkLimiters().namespace,
    EMAIL: {
      send: vi.fn(async (message: SentEmail) => {
        sent.push(message);
        return { messageId: "m" };
      }),
    },
    EMAIL_FROM_ADDRESS: "noreply@stratum.test",
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => {
  app = new Hono<{ Bindings: Env }>();
  app.route("/api/agent-signup", agentSignupRouter);
  app.route("/auth/email", emailAuthRouter);
  env = makeEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BODY = { email: "dev@example.com", username: "devperson", agentName: "Claude Code" };

async function requestSignup(body: Record<string, unknown> = BODY, e: Env = env) {
  const res = await app.fetch(
    new Request(`${ORIGIN}/api/agent-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify(body),
    }),
    e,
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.userCode === "string") lastUserCode = json.userCode;
  return { status: res.status, json };
}

async function poll(pollToken: unknown, e: Env = env) {
  const res = await app.fetch(
    new Request(`${ORIGIN}/api/agent-signup/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollToken }),
    }),
    e,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Pulls the approval token out of the last email, as the human's click would. */
function approvalTokenFromEmail(): string {
  const last = sent.at(-1);
  const match = last?.text.match(/verify\?token=([0-9a-f]+)/);
  if (!match?.[1]) throw new Error("no approval link in email");
  return match[1];
}

let lastUserCode = "";

async function approve(
  token: string,
  e: Env = env,
  userCode: string | null = lastUserCode,
): Promise<Response> {
  const form = new FormData();
  form.append("token", token);
  if (userCode !== null) form.append("userCode", userCode);
  return app.fetch(
    new Request(`${ORIGIN}/auth/email/verify`, {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: form,
    }),
    e,
  );
}

describe("POST /api/agent-signup", () => {
  it("records a pending request, emails an approval link naming the agent, and returns a poll secret", async () => {
    const { status, json } = await requestSignup();

    expect(status).toBe(202);
    expect(json.status).toBe("pending");
    expect(String(json.pollToken)).toMatch(/^stratum_asp_[0-9a-f]{64}$/);
    expect(String(json.userCode)).toMatch(/^[CDFGHJKMNPQRTVWXY349]{4}-[CDFGHJKMNPQRTVWXY349]{4}$/);
    expect(String(json.message)).toContain(String(json.userCode));
    expect(json.pollUrl).toBe("/api/agent-signup/poll");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("dev@example.com");
    // The requester-chosen name stays out of the subject, and the code never
    // appears in the email: possession of the code is what proves the human is
    // working with the agent that asked.
    expect(sent[0]?.subject).toBe("Approve your new Stratum account");
    expect(sent[0]?.text).toContain('"Claude Code"');
    expect(sent[0]?.text).toContain("@devperson");
    expect(sent[0]?.text).not.toContain(String(json.userCode));
    expect(sent[0]?.html).not.toContain(String(json.userCode));
    expect(sent[0]?.text).toContain(`${ORIGIN}/auth/email/verify?token=`);

    // Only the hash of the poll secret is stored.
    const row = raw.prepare("SELECT * FROM agent_signups").get() as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.poll_token_hash).not.toBe(json.pollToken);
    expect(JSON.stringify(row)).not.toContain(String(json.pollToken));
    expect(JSON.stringify(row)).not.toContain(String(json.userCode).replace("-", ""));
  });

  it("creates no account until the human approves", async () => {
    await requestSignup();
    const users = raw.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(users.n).toBe(0);
  });

  it.each([
    [{ ...BODY, email: "not-an-email" }, "INVALID_EMAIL"],
    [{ ...BODY, username: "1bad" }, "INVALID_USERNAME"],
    [{ ...BODY, agentName: "" }, "INVALID_AGENT_NAME"],
    [{ ...BODY, agentName: "<b>Stratum Security</b>" }, "INVALID_AGENT_NAME"],
    [{ ...BODY, agentName: "visit https://evil.example" }, "INVALID_AGENT_NAME"],
    [{ ...BODY, agentName: "acme.com" }, "INVALID_AGENT_NAME"],
    [{ ...BODY, model: "has spaces in it" }, "INVALID_MODEL"],
  ])("rejects %j with %s and sends nothing", async (body, code) => {
    const { status, json } = await requestSignup(body);
    expect(status).toBe(400);
    expect(json.code).toBe(code);
    expect(sent).toHaveLength(0);
  });

  it("refuses an address that already has an account rather than attaching an agent to it", async () => {
    raw
      .prepare(
        "INSERT INTO users (id, email, username, token_hash, created_at) VALUES ('usr_x', 'dev@example.com', 'someone', 'h', '2026-01-01')",
      )
      .run();
    const { status, json } = await requestSignup();
    expect(status).toBe(409);
    expect(json.code).toBe("EMAIL_EXISTS");
    expect(sent).toHaveLength(0);
  });

  it("refuses a taken username", async () => {
    raw
      .prepare(
        "INSERT INTO users (id, email, username, token_hash, created_at) VALUES ('usr_x', 'other@example.com', 'devperson', 'h', '2026-01-01')",
      )
      .run();
    const { status, json } = await requestSignup();
    expect(status).toBe(409);
    expect(json.code).toBe("USERNAME_TAKEN");
  });

  it("is capped by the magic-link per-email send limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await requestSignup()).status);
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("requires a valid invite code when the closed-beta gate is on", async () => {
    const gated = makeEnv({ BETA_GATE: "1", REFERRAL_SERVICE_URL: "https://referral.test" });
    const fetchMock = vi.fn(async () => Response.json({ valid: false, referrerUserId: null }));
    vi.stubGlobal("fetch", fetchMock);

    const missing = await requestSignup(BODY, gated);
    expect(missing.status).toBe(403);
    expect(missing.json.code).toBe("INVITE_REQUIRED");

    const bad = await requestSignup({ ...BODY, inviteCode: "nope" }, gated);
    expect(bad.status).toBe(403);
    expect(bad.json.code).toBe("INVALID_INVITE");
    expect(sent).toHaveLength(0);
  });

  it("is off when AGENT_SIGNUP_DISABLED=1", async () => {
    const off = makeEnv({ AGENT_SIGNUP_DISABLED: "1" });
    const { status, json } = await requestSignup(BODY, off);
    expect(status).toBe(404);
    expect(json.code).toBe("AGENT_SIGNUP_DISABLED");
    expect((await poll("stratum_asp_x", off)).status).toBe(404);
  });
});

describe("approve and collect", () => {
  it("polls pending until approved, then hands over an agent token exactly once", async () => {
    const { json } = await requestSignup({ ...BODY, model: "claude-opus-5-5" });
    const pollToken = json.pollToken;

    expect((await poll(pollToken)).json.status).toBe("pending");

    const res = await approve(approvalTokenFromEmail());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/welcome?agent=connected");
    expect(res.headers.get("Set-Cookie")).toContain("session");

    const user = raw
      .prepare("SELECT id, username FROM users WHERE email = ?")
      .get("dev@example.com") as { id: string; username: string };
    expect(user.username).toBe("devperson");

    const done = await poll(pollToken);
    expect(done.status).toBe(200);
    expect(done.json.status).toBe("complete");
    expect(String(done.json.token)).toMatch(/^stratum_agent_/);
    const agent = done.json.agent as Record<string, unknown>;
    expect(agent.ownerId).toBe(user.id);
    expect(agent.name).toBe("Claude Code");
    expect(agent.model).toBe("claude-opus-5-5");

    const again = await poll(pollToken);
    expect(again.status).toBe(410);
    expect(again.json.code).toBe("ALREADY_COLLECTED");

    const agents = raw
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE owner_id = ?")
      .get(user.id) as { n: number };
    expect(agents.n).toBe(1);

    const actions = (
      raw.prepare("SELECT action FROM audit_log ORDER BY rowid").all() as { action: string }[]
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["agent_signup.requested", "agent_signup.approved", "agent.created"]),
    );
  });

  it("mints only one agent when two polls race", async () => {
    const { json } = await requestSignup();
    await approve(approvalTokenFromEmail());

    const [a, b] = await Promise.all([poll(json.pollToken), poll(json.pollToken)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 410]);
    const agents = raw.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number };
    expect(agents.n).toBe(1);
  });

  it("does not approve when the address gained an account after the request", async () => {
    const { json } = await requestSignup();
    raw
      .prepare(
        "INSERT INTO users (id, email, username, token_hash, created_at) VALUES ('usr_x', 'dev@example.com', 'someone', 'h', '2026-01-01')",
      )
      .run();

    const res = await approve(approvalTokenFromEmail());
    expect(res.headers.get("Location")).toBe("/auth/login?error=email_exists");
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain("session");
    expect((await poll(json.pollToken)).json.status).toBe("pending");
  });

  it("reports an expired request and refuses to approve it", async () => {
    const { json } = await requestSignup();
    raw.prepare("UPDATE agent_signups SET expires_at = 1").run();

    const polled = await poll(json.pollToken);
    expect(polled.status).toBe(410);
    expect(polled.json.status).toBe("expired");

    const res = await approve(approvalTokenFromEmail());
    expect(res.headers.get("Location")).toBe("/auth/signup?error=link_expired");
    const users = raw.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(users.n).toBe(0);
  });

  it("answers 404 for an unknown poll secret and 400 for a malformed one", async () => {
    expect((await poll(`stratum_asp_${"0".repeat(64)}`)).status).toBe(404);
    expect((await poll("not-a-token")).status).toBe(400);
    expect((await poll(42)).status).toBe(400);
  });

  it("the approval link is single-use", async () => {
    await requestSignup();
    const token = approvalTokenFromEmail();
    await approve(token);
    const second = await approve(token);
    expect(second.headers.get("Location")).toContain("error=link_expired");
  });
});

describe("user code (device-flow binding)", () => {
  it("shows a code prompt on the approval page without consuming the link", async () => {
    await requestSignup();
    const token = approvalTokenFromEmail();
    const page = await app.fetch(new Request(`${ORIGIN}/auth/email/verify?token=${token}`), env);
    const html = await page.text();
    expect(html).toContain('name="userCode"');
    expect(html).toContain("If no agent of yours showed you a code");
    const consumed = raw.prepare("SELECT consumed FROM magic_links").get() as { consumed: number };
    expect(consumed.consumed).toBe(0);
  });

  it("an unknown token gets the ordinary page, not the code prompt", async () => {
    const page = await app.fetch(new Request(`${ORIGIN}/auth/email/verify?token=unknown`), env);
    expect(await page.text()).not.toContain('name="userCode"');
  });

  it("refuses approval without the code, and keeps the link usable", async () => {
    const { json } = await requestSignup();
    const token = approvalTokenFromEmail();

    const missing = await approve(token, env, null);
    expect(missing.headers.get("Location")).toContain("error=wrong_code");
    expect(missing.headers.get("Set-Cookie") ?? "").not.toContain("session");
    const users = raw.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(users.n).toBe(0);

    const ok = await approve(token, env, String(json.userCode));
    expect(ok.headers.get("Location")).toBe("/welcome?agent=connected");
  });

  it("a wrong code creates nothing; the right one, typed loosely, still works", async () => {
    const { json } = await requestSignup();
    const token = approvalTokenFromEmail();

    const wrong = await approve(token, env, "CCCC-CCCC");
    expect(wrong.headers.get("Location")).toContain("error=wrong_code");
    expect((await poll(json.pollToken)).json.status).toBe("pending");

    const loose = String(json.userCode).toLowerCase().replace("-", " ");
    const ok = await approve(token, env, loose);
    expect(ok.headers.get("Location")).toBe("/welcome?agent=connected");
    expect((await poll(json.pollToken)).json.status).toBe("complete");
  });

  it("five wrong codes kill the request and the link", async () => {
    const { json } = await requestSignup();
    const token = approvalTokenFromEmail();
    for (let i = 0; i < 5; i++) await approve(token, env, "CCCC-CCCC");

    const locked = await approve(token, env, String(json.userCode));
    expect(locked.headers.get("Location")).toBe("/auth/signup?error=link_expired");
    const users = raw.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(users.n).toBe(0);

    const again = await approve(token, env, String(json.userCode));
    expect(again.headers.get("Location")).toContain("error=link_expired");
  });
});

describe("review follow-ups", () => {
  it.each([["null"], ["[]"], ['"x"'], ["42"]])(
    "answers 400 INVALID_BODY for a %s body on both endpoints",
    async (raw) => {
      for (const path of ["/api/agent-signup", "/api/agent-signup/poll"]) {
        const res = await app.fetch(
          new Request(`${ORIGIN}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: raw,
          }),
          env,
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("INVALID_BODY");
      }
    },
  );

  it("polls report LOCKED once the code attempts are used up", async () => {
    const { json } = await requestSignup();
    const token = approvalTokenFromEmail();
    for (let i = 0; i < 5; i++) await approve(token, env, "CCCC-CCCC");

    const polled = await poll(json.pollToken);
    expect(polled.status).toBe(410);
    expect(polled.json.status).toBe("locked");
    expect(polled.json.code).toBe("LOCKED");
  });

  it("does not claim the agent is connected when the hand-off misses", async () => {
    const { json } = await requestSignup();
    // The request expires in the moment between the pre-check and approval:
    // creating the user row is what flips it.
    raw.exec(
      "CREATE TRIGGER expire_on_user AFTER INSERT ON users BEGIN UPDATE agent_signups SET expires_at = 1; END;",
    );
    const res = await approve(approvalTokenFromEmail());
    expect(res.headers.get("Location")).toBe("/settings?agent=not_connected");
    expect(res.headers.get("Set-Cookie")).toContain("session");
    expect((await poll(json.pollToken)).status).toBe(410);
  });

  it("the daily purge deletes requests a day past expiry, and nothing newer", async () => {
    const { purgeExpiredAgentSignups } = await import("../src/storage/agent-signups");
    await requestSignup();
    await requestSignup({ ...BODY, email: "other@example.com", username: "otherperson" });
    const now = Math.floor(Date.now() / 1000);
    raw
      .prepare("UPDATE agent_signups SET expires_at = ? WHERE email = 'dev@example.com'")
      .run(now - 25 * 60 * 60);
    raw
      .prepare("UPDATE agent_signups SET expires_at = ? WHERE email = 'other@example.com'")
      .run(now - 60);

    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as Parameters<typeof purgeExpiredAgentSignups>[1];
    const purged = await purgeExpiredAgentSignups(env.DB, logger);
    expect(purged).toEqual({ success: true, data: 1 });
    const left = raw.prepare("SELECT email FROM agent_signups").all() as { email: string }[];
    expect(left.map((r) => r.email)).toEqual(["other@example.com"]);
  });
});
