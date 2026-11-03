/**
 * Agent-initiated signup (`/api/agent-signup`).
 *
 * Lets an agent get its human onto Stratum with one email click:
 *
 *   1. The agent POSTs the account it wants (email, username, its own name)
 *      and gets back a poll secret.
 *   2. Stratum emails the address an approval link that names the agent, and
 *      hands the AGENT a short user code to show its human.
 *   3. The human follows the link and types that code. That creates the
 *      account exactly as a magic-link signup does (same invite gate, same
 *      username rules) and signs them in.
 *   4. The agent's next poll returns an agent token owned by the new account.
 *
 * Every agent still has a human owner, and nothing exists until that human
 * proves they control the address AND that they are working with the agent
 * that asked. The second half is the user code (the OAuth device-flow
 * pattern): without it, anyone could request an account for someone else's
 * address and wait for an unsuspecting click, keeping an agent token inside
 * the victim's new account. An agent token cannot submit reviews, so
 * the account's human-only gates are unchanged. Abuse controls are the ones a
 * web signup already has: the per-email and per-IP magic-link send caps, the
 * closed-beta invite code, and single-use, short-lived links. Operators can
 * turn the endpoint off with `AGENT_SIGNUP_DISABLED=1`.
 *
 * The flow is unauthenticated by nature, like `/auth/email/send-signup`, and
 * carries no cookies, so CSRF does not apply.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { betaGateEnabled, validateInviteCode } from "../beta/gate";
import { getAgentSignupEmail } from "../email/templates";
import {
  type AgentSignup,
  MAX_USER_CODE_ATTEMPTS,
  approveAgentSignupRelease,
  claimAgentSignupForCollection,
  createAgentSignup,
  generateUserCode,
  getAgentSignupByPollToken,
  recordAgentSignupAgent,
} from "../storage/agent-signups";
import { createAgent } from "../storage/agents";
import { recordAudit } from "../storage/audit";
import { createMagicLink } from "../storage/magic-links";
import { usernameNamespaceTaken } from "../storage/project-namespace";
import { getUserByEmail, getUserByUsername } from "../storage/users";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { validateUsername } from "../utils/username-validation";
import { validateEmail } from "../utils/validation";
import { checkMagicLinkRateLimits, generateSecureToken, hashEmail } from "./email-auth";

const app = new Hono<{ Bindings: Env }>();

/** The request body is a handful of short strings. */
const MAX_BODY_BYTES = 4 * 1024;

/** Seconds an agent should wait between polls. Advisory; the global limiter enforces. */
export const AGENT_SIGNUP_POLL_INTERVAL_SECONDS = 5;

/** How long the emailed approval link lives, matching a plain signup link. */
const APPROVAL_LINK_TTL_SECONDS = 15 * 60;

/**
 * An agent name appears in an email subject and body, so it is held to a plain
 * charset: no markup, no URLs, nothing that reads as an instruction from
 * Stratum. Escaping covers HTML; this keeps the plain-text part honest too.
 */
// No dots: a dotted name ("acme.com") renders as a link in most mail clients,
// which is a phishing aid in an email whose subject is account creation.
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const AGENT_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

interface AgentSignupBody {
  email?: unknown;
  username?: unknown;
  agentName?: unknown;
  model?: unknown;
  inviteCode?: unknown;
}

function errorResponse(
  c: Context<{ Bindings: Env }>,
  status: 400 | 403 | 404 | 409 | 410 | 429 | 500 | 503,
  code: string,
  error: string,
): Response {
  return c.json({ error, code }, status);
}

/** `null`, arrays and primitives all parse as JSON but carry no fields to read. */
function isJsonObject<T extends object>(value: T | null | unknown): value is T {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentSignupDisabled(env: Env): boolean {
  return env.AGENT_SIGNUP_DISABLED === "1";
}

/**
 * The requester's country as Cloudflare saw it, for the approval email: a
 * human who is in Lisbon and reads "requested from KP" has a reason to stop.
 */
function requestCountry(c: Context<{ Bindings: Env }>): string | undefined {
  const cf = (c.req.raw as Request & { cf?: { country?: unknown } }).cf;
  const country = cf?.country;
  return typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : undefined;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// POST /api/agent-signup — request an account on a human's behalf
app.post("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  if (agentSignupDisabled(c.env)) {
    return errorResponse(c, 404, "AGENT_SIGNUP_DISABLED", "Agent signup is not enabled here");
  }

  const body = await readJsonWithLimit<AgentSignupBody | null>(c, MAX_BODY_BYTES, logger);
  if (body instanceof Response) return body;
  if (!isJsonObject(body)) {
    return errorResponse(c, 400, "INVALID_BODY", "The request body must be a JSON object");
  }

  const emailInput = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const usernameInput = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const agentName = typeof body.agentName === "string" ? body.agentName.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : undefined;
  const inviteCode =
    typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";

  const emailValidation = validateEmail(emailInput, logger);
  if (!emailValidation.success) {
    return errorResponse(c, 400, "INVALID_EMAIL", "A valid email address is required");
  }
  const usernameValidation = validateUsername(usernameInput, logger);
  if (!usernameValidation.success) {
    const reason = usernameValidation.error[0]?.message ?? "invalid username";
    return errorResponse(c, 400, "INVALID_USERNAME", `Username not allowed: ${reason}`);
  }
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    return errorResponse(
      c,
      400,
      "INVALID_AGENT_NAME",
      "agentName is required: 1-64 letters, digits, spaces, '_' or '-', starting with a letter or digit",
    );
  }
  if (model !== undefined && model !== "" && !AGENT_MODEL_PATTERN.test(model)) {
    return errorResponse(c, 400, "INVALID_MODEL", "model must be 1-100 characters with no spaces");
  }
  const email = emailValidation.data;
  const username = usernameValidation.data;
  const emailHash = hashEmail(email);

  if (!c.env.EMAIL || !c.env.EMAIL_FROM_ADDRESS) {
    logger.error("Agent signup requested but email sending is not configured");
    return errorResponse(c, 503, "EMAIL_UNAVAILABLE", "This instance cannot send email");
  }

  // Count the attempt before answering anything about who exists, so this
  // endpoint is never a cheaper account-enumeration oracle than the web form.
  const rateLimit = await checkMagicLinkRateLimits(c, email, logger);
  if (rateLimit.blocked) {
    return errorResponse(c, 429, "RATE_LIMITED", "Too many signup emails; try again later");
  }

  if (betaGateEnabled(c.env)) {
    if (!inviteCode) {
      return errorResponse(
        c,
        403,
        "INVITE_REQUIRED",
        "Stratum is in closed beta: an inviteCode is required",
      );
    }
    const inviteCheck = await validateInviteCode(c.env, inviteCode, logger);
    if (!inviteCheck.valid) {
      return errorResponse(c, 403, "INVALID_INVITE", "That invite code isn't valid or was used");
    }
  }

  const existingByEmail = await getUserByEmail(c.env.DB, email, logger);
  if (existingByEmail.success) {
    return errorResponse(
      c,
      409,
      "EMAIL_EXISTS",
      "That address already has an account. Connect the agent from Settings or over OAuth instead",
    );
  }
  const existingByUsername = await getUserByUsername(c.env.DB, username, logger);
  if (existingByUsername.success) {
    return errorResponse(c, 409, "USERNAME_TAKEN", "That username is taken");
  }
  const namespaceTaken = await usernameNamespaceTaken(c.env, username, logger);
  if (!namespaceTaken.success) {
    return errorResponse(c, 500, "SIGNUP_FAILED", "Could not check username availability");
  }
  if (namespaceTaken.data) {
    return errorResponse(c, 409, "USERNAME_TAKEN", "That username is taken");
  }

  const pollToken = `stratum_asp_${generateSecureToken()}`;
  const userCode = generateUserCode();
  const stored = await createAgentSignup(
    c.env.DB,
    {
      email,
      username,
      agentName,
      ...(model !== undefined && model !== "" ? { agentModel: model } : {}),
    },
    { pollToken, userCode },
    logger,
  );
  if (!stored.success) {
    return errorResponse(c, 500, "SIGNUP_FAILED", "Could not record the signup request");
  }
  const signup = stored.data;

  const linkToken = generateSecureToken();
  const link = await createMagicLink(
    c.env.DB,
    linkToken,
    {
      email,
      username,
      intent: "agent-signup",
      agentSignupId: signup.id,
      inviteCode,
      rememberMe: true,
      createdAt: Date.now(),
    },
    APPROVAL_LINK_TTL_SECONDS,
    logger,
  );
  if (!link.success) {
    return errorResponse(c, 500, "SIGNUP_FAILED", "Could not create the approval link");
  }

  const url = new URL(c.req.url);
  const approveLink = `${url.protocol}//${url.host}/auth/email/verify?token=${linkToken}`;
  const requestedFrom = requestCountry(c);
  const emailContent = getAgentSignupEmail({
    approveLink,
    email,
    username,
    agentName,
    ...(requestedFrom !== undefined ? { requestedFrom } : {}),
  });
  try {
    await c.env.EMAIL.send({
      to: email,
      from: { email: c.env.EMAIL_FROM_ADDRESS, name: "Stratum" },
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });
  } catch (error) {
    logger.error("Failed to send agent signup email", error instanceof Error ? error : undefined, {
      emailHash,
    });
    return errorResponse(c, 500, "SEND_FAILED", "Could not send the approval email");
  }

  await recordAudit(c.env.DB, logger, {
    action: "agent_signup.requested",
    actorType: "system",
    actorId: "agent-signup",
    subject: signup.id,
    detail: { agentName, emailHash },
  });
  logger.info("Agent signup requested", { signupId: signup.id, emailHash, username });

  return c.json(
    {
      signupId: signup.id,
      status: "pending",
      pollToken,
      userCode,
      pollUrl: "/api/agent-signup/poll",
      interval: AGENT_SIGNUP_POLL_INTERVAL_SECONDS,
      expiresAt: new Date(signup.expiresAt * 1000).toISOString(),
      message: `Approval email sent to ${email}. Show your human the code ${userCode}: they will type it on the approval page. Then poll with pollToken.`,
    },
    202,
  );
});

/**
 * Mints the agent for an approved signup. Exactly one poll wins the claim. If
 * minting then fails, the claim is released so a later poll can retry, rather
 * than stranding an approved request with no token.
 */
async function collect(
  c: Context<{ Bindings: Env }>,
  signup: AgentSignup & { userId: string },
  logger: Logger,
): Promise<Response> {
  const claimed = await claimAgentSignupForCollection(c.env.DB, signup.id, logger);
  if (!claimed.success) {
    return errorResponse(c, 500, "POLL_FAILED", "Could not collect the agent token");
  }
  if (!claimed.data) {
    return errorResponse(c, 410, "ALREADY_COLLECTED", "This signup's token was already collected");
  }

  const agentResult = await createAgent(
    c.env.DB,
    signup.userId,
    signup.agentName,
    logger,
    signup.agentModel,
    "Created by agent signup",
  );
  if (!agentResult.success) {
    await approveAgentSignupRelease(c.env.DB, signup.id, logger);
    return errorResponse(c, 500, "POLL_FAILED", "Could not create the agent; poll again");
  }
  const { agent, plaintext } = agentResult.data;

  await recordAgentSignupAgent(c.env.DB, signup.id, agent.id, logger);
  await recordAudit(c.env.DB, logger, {
    action: "agent.created",
    actorType: "user",
    actorId: signup.userId,
    subject: agent.id,
    detail: { name: agent.name, via: "agent_signup", signupId: signup.id },
  });
  logger.info("Agent signup collected", { signupId: signup.id, agentId: agent.id });

  return c.json({
    status: "complete",
    user: { id: signup.userId, username: signup.username },
    agent: { id: agent.id, name: agent.name, ownerId: agent.ownerId, model: agent.model },
    token: plaintext,
  });
}

// POST /api/agent-signup/poll — check on a request; collect the token once approved
app.post("/poll", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  if (agentSignupDisabled(c.env)) {
    return errorResponse(c, 404, "AGENT_SIGNUP_DISABLED", "Agent signup is not enabled here");
  }

  const body = await readJsonWithLimit<{ pollToken?: unknown } | null>(c, MAX_BODY_BYTES, logger);
  if (body instanceof Response) return body;
  if (!isJsonObject(body)) {
    return errorResponse(c, 400, "INVALID_BODY", "The request body must be a JSON object");
  }
  const pollToken = typeof body.pollToken === "string" ? body.pollToken.trim() : "";
  if (!pollToken.startsWith("stratum_asp_")) {
    return errorResponse(c, 400, "INVALID_POLL_TOKEN", "pollToken is required");
  }

  const found = await getAgentSignupByPollToken(c.env.DB, pollToken, logger);
  if (!found.success) {
    return errorResponse(c, 500, "POLL_FAILED", "Could not read the signup request");
  }
  const signup = found.data;
  if (!signup) {
    return errorResponse(c, 404, "UNKNOWN_SIGNUP", "No signup request matches that pollToken");
  }

  if (signup.status === "collected") {
    return errorResponse(c, 410, "ALREADY_COLLECTED", "This signup's token was already collected");
  }
  if (signup.expiresAt <= nowSeconds()) {
    return c.json(
      { status: "expired", code: "EXPIRED", error: "The signup request expired; start again" },
      410,
    );
  }
  if (signup.status === "pending" && signup.codeAttempts >= MAX_USER_CODE_ATTEMPTS) {
    return c.json(
      {
        status: "locked",
        code: "LOCKED",
        error: "Too many wrong codes were entered on the approval page; start again",
      },
      410,
    );
  }
  if (signup.status === "approved" && signup.userId !== undefined) {
    return collect(c, { ...signup, userId: signup.userId }, logger);
  }

  return c.json({
    status: "pending",
    interval: AGENT_SIGNUP_POLL_INTERVAL_SECONDS,
    expiresAt: new Date(signup.expiresAt * 1000).toISOString(),
  });
});

export { app as agentSignupRouter };
