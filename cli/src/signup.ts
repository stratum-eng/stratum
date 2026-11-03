/**
 * `stratum signup`: agent-initiated signup against `POST /api/agent-signup`.
 *
 * The agent asks for an account on a human's behalf, shows the human a short
 * user code, and polls until the human approves from the emailed link (typing
 * that code) or the request expires. On approval the server hands back an agent
 * token owned by the new account, which is stored exactly as `login --key`
 * stores an API token.
 *
 * Kept apart from `index.ts` (which parses argv on import) so the whole flow
 * can be driven in tests with a mocked `fetch`, a fake clock and no sleeping.
 */
import type { StratumConfig } from "./config.js";
import { assertSecureHost, normalizeHost } from "./oauth.js";

export interface SignupRequest {
  host: string;
  email: string;
  username: string;
  agentName: string;
  inviteCode?: string;
  model?: string;
}

export interface SignupDeps {
  /** Progress lines for the human watching the terminal. */
  notify(line: string): void;
  /** Persists the credential; `writeConfig` in production. */
  save(config: StratumConfig): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface SignupIdentity {
  host: string;
  user: { id: string; username: string };
  agent: { id: string; name: string; model?: string };
}

export type SignupResult = { ok: true; value: SignupIdentity } | { ok: false; error: string };

/** The server suggests 5s; these bounds only guard against a nonsensical value. */
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * The server reports expiry itself (410 EXPIRED). This local deadline only stops
 * a CLI that cannot reach the server from polling forever after the request is
 * dead anyway.
 */
const EXPIRY_GRACE_MS = 60_000;
/**
 * Used when the server's 202 has no parseable `expiresAt`, so the deadline above
 * still bounds polling. Comfortably longer than the server's 30-minute request
 * lifetime, so it never cuts a live request short.
 */
const FALLBACK_DEADLINE_MS = 60 * 60_000;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function fail(error: string): SignupResult {
  return { ok: false, error };
}

interface HttpReply {
  status: number;
  body: JsonObject;
}

/**
 * One JSON POST. A network failure or a non-JSON body becomes a string rather
 * than a throw, so the poll loop can decide whether it is worth retrying.
 */
async function postJson(url: string, payload: JsonObject): Promise<HttpReply | string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `${url} returned a non-JSON response (HTTP ${response.status})`;
  }
  if (!isObject(parsed)) return `${url} returned an unexpected response (HTTP ${response.status})`;
  return { status: response.status, body: parsed };
}

/** Turns a failed `POST /api/agent-signup` into the message a user can act on. */
function requestError(req: SignupRequest, reply: HttpReply): string {
  const code = str(reply.body, "code");
  const serverMessage = str(reply.body, "error") ?? `HTTP ${reply.status}`;
  switch (code) {
    case "EMAIL_EXISTS":
      return `${req.email} already has a Stratum account. Sign in instead: stratum login`;
    case "USERNAME_TAKEN":
      return `the username '${req.username}' is taken. Choose another with --username.`;
    case "INVALID_INVITE":
      return "that invite code isn't valid or was already used. Check it and pass it with --invite.";
    case "INVITE_REQUIRED":
      return "this instance is in closed beta: an invite code is required. Pass it with --invite <code>.";
    case "AGENT_SIGNUP_DISABLED":
      return `agent signup is not enabled on ${req.host}. Sign up in the browser, then run stratum login.`;
    case "RATE_LIMITED":
      return "too many signup emails were sent recently. Try again later.";
    case undefined:
      return serverMessage;
    default:
      return `${serverMessage} (${code})`;
  }
}

function clampInterval(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, raw));
}

function parseIdentity(
  host: string,
  body: JsonObject,
): (SignupIdentity & { token: string }) | null {
  const token = str(body, "token");
  const user = body.user;
  const agent = body.agent;
  if (token === undefined || token === "" || !isObject(user) || !isObject(agent)) return null;
  const userId = str(user, "id");
  const username = str(user, "username");
  const agentId = str(agent, "id");
  const agentName = str(agent, "name");
  if (!userId || !username || !agentId || !agentName) return null;
  const model = str(agent, "model");
  return {
    host,
    token,
    user: { id: userId, username },
    agent: { id: agentId, name: agentName, ...(model ? { model } : {}) },
  };
}

/**
 * Requests the signup, then polls until it is approved, expires, or fails. On
 * success the agent token has already been saved.
 */
export async function runSignup(req: SignupRequest, deps: SignupDeps): Promise<SignupResult> {
  let host: string;
  try {
    // The poll returns a long-lived agent token; it must not cross a plaintext wire.
    assertSecureHost(req.host);
    host = normalizeHost(req.host);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const started = await postJson(`${host}/api/agent-signup`, {
    email: req.email,
    username: req.username,
    agentName: req.agentName,
    ...(req.inviteCode ? { inviteCode: req.inviteCode } : {}),
    ...(req.model ? { model: req.model } : {}),
  });
  if (typeof started === "string") return fail(started);
  if (started.status !== 202) return fail(requestError(req, started));

  const pollToken = str(started.body, "pollToken");
  const userCode = str(started.body, "userCode");
  if (!pollToken || !userCode) {
    return fail(`${host} accepted the signup but returned no poll token or user code`);
  }
  const expiresAtRaw = str(started.body, "expiresAt");
  const reportedExpiry = expiresAtRaw ? Date.parse(expiresAtRaw) : Number.NaN;
  const deadline = Number.isNaN(reportedExpiry)
    ? deps.now() + FALLBACK_DEADLINE_MS
    : reportedExpiry + EXPIRY_GRACE_MS;
  let intervalSeconds = clampInterval(started.body.interval, 5);

  deps.notify("");
  deps.notify(`  Type this code on the approval page:  ${userCode}`);
  deps.notify("");
  deps.notify(`Check ${req.email} for an email from Stratum and follow the approval link.`);
  deps.notify(
    Number.isNaN(reportedExpiry)
      ? "Waiting for approval..."
      : `Waiting for approval (the request expires at ${new Date(reportedExpiry).toISOString()})...`,
  );

  for (;;) {
    await deps.sleep(intervalSeconds * 1000);

    if (deps.now() > deadline) {
      return fail("the signup request expired before it was approved. Run stratum signup again.");
    }

    const reply = await postJson(`${host}/api/agent-signup/poll`, { pollToken });
    if (typeof reply === "string") {
      // A dropped connection mid-wait is not a reason to abandon a request the
      // human may be approving right now; the deadline above bounds the retries.
      deps.notify(`Warning: ${reply}; retrying.`);
      continue;
    }

    const status = str(reply.body, "status");
    const code = str(reply.body, "code");

    if (reply.status === 200 && status === "pending") {
      intervalSeconds = clampInterval(reply.body.interval, intervalSeconds);
      continue;
    }
    if (reply.status === 200 && status === "complete") {
      const identity = parseIdentity(host, reply.body);
      if (identity === null) {
        return fail(`${host} approved the signup but returned an unreadable token response`);
      }
      const { token, ...rest } = identity;
      try {
        await deps.save({ host, credential: { kind: "apiKey", apiKey: token } });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return fail(
          `the account was created but the token could not be saved: ${reason}. Sign in to the web app, create a token under Settings → API tokens, and run stratum login --key.`,
        );
      }
      return { ok: true, value: rest };
    }
    if (reply.status === 429) {
      // Slow down rather than give up, as the device flow's slow_down does.
      intervalSeconds = Math.min(MAX_INTERVAL_SECONDS, intervalSeconds * 2);
      continue;
    }
    if (reply.status >= 500) {
      // POLL_FAILED is explicitly retryable: the server releases its claim.
      deps.notify(`Warning: ${str(reply.body, "error") ?? `HTTP ${reply.status}`}; retrying.`);
      continue;
    }

    switch (code) {
      case "EXPIRED":
        return fail("the signup request expired before it was approved. Run stratum signup again.");
      case "LOCKED":
        return fail(
          "too many wrong codes were entered on the approval page, so the request was cancelled. Run stratum signup again.",
        );
      case "ALREADY_COLLECTED":
        return fail(
          "this signup's token was already collected by another process. Sign in to the web app, create a token under Settings → API tokens, and run stratum login --key.",
        );
      default:
        return fail(
          `${str(reply.body, "error") ?? `unexpected response (HTTP ${reply.status})`}${code ? ` (${code})` : ""}`,
        );
    }
  }
}
