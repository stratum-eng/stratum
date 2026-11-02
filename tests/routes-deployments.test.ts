/**
 * The deployment and deploy-secret HTTP surface.
 *
 * The assertions that matter are the authorization ones. Three of them encode
 * decisions that are easy to undo by accident:
 *
 * - No response body carries a secret value. Asserted against every route on
 *   this surface for a reader, and against the secret routes for a writer — a
 *   deployment's `reason`/`logTail` is provider text that once held a
 *   credential, and only a writer is meant to see it at all.
 * - Agent identities are refused on the secret routes and on approve. Both
 *   would otherwise pass: an agent owned by the project owner is a project
 *   admin, and `canWriteProject` grants an agent its owner's write access.
 * - `log_tail` is a writer-only field, while list metadata follows read access
 *   — and read access is unconditional on a public project.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import {
  canManageSecrets,
  deploymentsRouter,
  projectDeploymentsRouter,
  secretErrorMessage,
} from "../src/routes/deployments";
import type { Env, ProjectEntry } from "../src/types";
import { AppError } from "../src/utils/errors";

vi.mock("../src/storage/deployments", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/deployments")>();
  return {
    ...actual,
    approveDeployment: vi.fn(),
    findDeploymentById: vi.fn(),
    insertDeployment: vi.fn(),
    listDeployments: vi.fn(),
  };
});
vi.mock("../src/storage/project-secrets", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/project-secrets")>();
  return {
    ...actual,
    putSecret: vi.fn(),
    listSecretNames: vi.fn(),
    deleteSecret: vi.fn(),
  };
});
vi.mock("../src/storage/state", () => ({ getProjectByPath: vi.fn(), getProjectById: vi.fn() }));
vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));
// The outbox that makes a failed enqueue recoverable. Mocked rather than run
// against a real database because what these routes owe the caller is *that*
// the request was made durable, not how the row is shaped.
vi.mock("../src/storage/events", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/events")>();
  return { ...actual, insertEvent: vi.fn() };
});
vi.mock("../src/storage/users", () => ({ getUserByToken: vi.fn(), getUser: vi.fn() }));
vi.mock("../src/storage/agents", () => ({ getAgentByToken: vi.fn() }));

import { getAgentByToken } from "../src/storage/agents";
import { recordAudit } from "../src/storage/audit";
import {
  type Deployment,
  approveDeployment,
  findDeploymentById,
  insertDeployment,
  listDeployments,
} from "../src/storage/deployments";
import { insertEvent } from "../src/storage/events";
import {
  DEPLOY_SECRET_KEY_MISSING,
  deleteSecret,
  listSecretNames,
  putSecret,
} from "../src/storage/project-secrets";
import { getProjectById, getProjectByPath } from "../src/storage/state";
import { getUser, getUserByToken } from "../src/storage/users";

const OWNER_TOKEN = "stratum_user_owner0000000000000000000";
const OUTSIDER_TOKEN = "stratum_user_outsider00000000000000";
const AGENT_TOKEN = "stratum_agent_bot00000000000000000000";

const asOwner = { Authorization: `Bearer ${OWNER_TOKEN}` };
const asOutsider = { Authorization: `Bearer ${OUTSIDER_TOKEN}` };
const asAgent = { Authorization: `Bearer ${AGENT_TOKEN}` };

/**
 * The one string that must never appear in a response. Planted as a secret
 * value and as provider log text so both leak paths are covered.
 */
const SECRET_VALUE = "vercel_live_TOKEN_MUST_NOT_LEAK";

// Public on purpose: `canReadProject` short-circuits to true for a public
// project, so this is the shape in which a log-tail leak would actually happen.
const PROJECT: ProjectEntry = {
  id: "prj_owner",
  name: "site",
  slug: "site",
  namespace: "@owner",
  ownerId: "usr_owner",
  ownerType: "user",
  visibility: "public",
  remote: "https://acct.artifacts.cloudflare.net/git/@owner/site.git",
  createdAt: "2026-01-01T00:00:00.000Z",
};

// A different tenant's project, private, so an id from it is unreadable here.
const OTHER_PROJECT: ProjectEntry = {
  ...PROJECT,
  id: "prj_other",
  namespace: "@other",
  ownerId: "usr_other",
  visibility: "private",
};

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep_1",
    projectId: PROJECT.id,
    project: PROJECT.name,
    changeId: "chg_1",
    commitSha: "a".repeat(40),
    name: "production",
    target: "vercel",
    attempt: 1,
    status: "failed",
    reason: "Provider rejected the upload",
    logTail: `provider said: ${SECRET_VALUE}`,
    requestedByType: "user",
    requestedById: "usr_owner",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

const send = vi.fn(async () => {});
const env = {
  DB: {} as D1Database,
  STATE: {} as KVNamespace,
  DEPLOY_QUEUE: { send } as unknown as Queue,
} as Env;

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/projects", projectDeploymentsRouter);
  app.route("/api/deployments", deploymentsRouter);
  return app;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return await makeApp().fetch(new Request(`http://localhost${path}`, init), env);
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(insertEvent).mockResolvedValue({
    success: true,
    data: {
      id: "evt_1",
      type: "deploy.enqueue",
      project: PROJECT.name,
      actorType: "system",
      payload: {},
      status: "pending",
      attempts: 0,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  });

  vi.mocked(getUserByToken).mockImplementation(async (_db, token) => {
    const id = token === OWNER_TOKEN ? "usr_owner" : "usr_outsider";
    return {
      success: true,
      data: {
        id,
        email: `${id}@x.io`,
        username: id,
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
  });
  vi.mocked(getAgentByToken).mockResolvedValue({
    success: true,
    data: {
      id: "agt_bot",
      name: "bot",
      // Owned by the project owner: without an explicit refusal this agent is
      // a project admin and a project writer.
      ownerId: "usr_owner",
      tokenHash: "h",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  vi.mocked(getUser).mockResolvedValue({
    success: true,
    data: {
      id: "usr_owner",
      email: "owner@x.io",
      username: "owner",
      tokenHash: "h",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  });

  vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: PROJECT });
  vi.mocked(getProjectById).mockResolvedValue({ success: true, data: PROJECT });
});

describe("deploy secret routes", () => {
  it("lists names and metadata, never a value", async () => {
    vi.mocked(listSecretNames).mockResolvedValue({
      success: true,
      data: [
        {
          name: "VERCEL_TOKEN",
          createdBy: "usr_owner",
          updatedBy: "usr_owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const res = await call("/api/projects/@owner/site/secrets", { headers: asOwner });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { secrets: Array<Record<string, unknown>> };
    expect(body.secrets[0]).toMatchObject({ name: "VERCEL_TOKEN" });
    expect(body.secrets[0]).not.toHaveProperty("value");
    expect(listSecretNames).toHaveBeenCalledWith(env.DB, expect.any(Object), "prj_owner");
  });

  it("stores a value, echoes only metadata, and audits the write", async () => {
    vi.mocked(putSecret).mockResolvedValue({
      success: true,
      data: {
        name: "VERCEL_TOKEN",
        createdBy: "usr_owner",
        updatedBy: "usr_owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    const res = await call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", {
      method: "PUT",
      headers: { ...asOwner, "content-type": "application/json" },
      body: JSON.stringify({ value: SECRET_VALUE }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(SECRET_VALUE);
    expect(putSecret).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      env,
      expect.objectContaining({
        projectId: "prj_owner",
        name: "VERCEL_TOKEN",
        value: SECRET_VALUE,
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "secret.written", actorId: "usr_owner" }),
    );
    // The audited detail is the name; the value has no business in the trail.
    const audited = vi.mocked(recordAudit).mock.calls[0]?.[2];
    expect(JSON.stringify(audited)).not.toContain(SECRET_VALUE);
  });

  it("rejects a non-string value", async () => {
    const res = await call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", {
      method: "PUT",
      headers: { ...asOwner, "content-type": "application/json" },
      body: JSON.stringify({ value: 42 }),
    });

    expect(res.status).toBe(400);
    expect(putSecret).not.toHaveBeenCalled();
  });

  it("404s a delete of a name the project does not have", async () => {
    vi.mocked(deleteSecret).mockResolvedValue({ success: true, data: false });

    const res = await call("/api/projects/@owner/site/secrets/NOPE", {
      method: "DELETE",
      headers: asOwner,
    });

    expect(res.status).toBe(404);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("deletes a secret and audits it", async () => {
    vi.mocked(deleteSecret).mockResolvedValue({ success: true, data: true });

    const res = await call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", {
      method: "DELETE",
      headers: asOwner,
    });

    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "secret.deleted" }),
    );
  });

  // The form aliases are on this list deliberately: they exist so the browser
  // can reach these routes, and an alias that skipped the agent refusal would
  // hand an agent the one credential it is never trusted with (PRD G3).
  it("refuses an agent token on every secret route, form aliases included", async () => {
    const responses = await Promise.all([
      call("/api/projects/@owner/site/secrets", { headers: asAgent }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", {
        method: "PUT",
        headers: { ...asAgent, "content-type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", {
        method: "DELETE",
        headers: asAgent,
      }),
      call("/api/projects/@owner/site/secrets", {
        method: "POST",
        headers: asAgent,
        body: new URLSearchParams({ name: "VERCEL_TOKEN", value: SECRET_VALUE }),
      }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN/delete", {
        method: "POST",
        headers: asAgent,
        body: new URLSearchParams(),
      }),
    ]);

    // Refused outright — never a redirect back to the page, which would read as
    // "done" to the browser that posted it.
    for (const res of responses) expect(res.status).toBe(403);
    expect(listSecretNames).not.toHaveBeenCalled();
    expect(putSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("refuses a non-admin user on every secret route, form aliases included", async () => {
    const responses = await Promise.all([
      call("/api/projects/@owner/site/secrets", { headers: asOutsider }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", {
        method: "PUT",
        headers: { ...asOutsider, "content-type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", {
        method: "DELETE",
        headers: asOutsider,
      }),
      call("/api/projects/@owner/site/secrets", {
        method: "POST",
        headers: asOutsider,
        body: new URLSearchParams({ name: "VERCEL_TOKEN", value: SECRET_VALUE }),
      }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN/delete", {
        method: "POST",
        headers: asOutsider,
        body: new URLSearchParams(),
      }),
    ]);

    for (const res of responses) expect(res.status).toBe(403);
    expect(putSecret).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});

/**
 * The browser half of the secret routes. An HTML form can only issue GET or
 * POST and cannot read a JSON body, so these aliases exist — behind the same
 * guard — and answer with a redirect. The failure codes are a closed set so a
 * caller-supplied string is never round-tripped into the page.
 */
describe("deploy secret form aliases", () => {
  const SETTINGS = "/@owner/site/settings";

  function form(path: string, fields: Record<string, string> = {}): Promise<Response> {
    return call(path, {
      method: "POST",
      headers: asOwner,
      body: new URLSearchParams(fields),
    });
  }

  it("stores a value posted as a form and returns to the settings page", async () => {
    vi.mocked(putSecret).mockResolvedValue({
      success: true,
      data: {
        name: "VERCEL_TOKEN",
        createdBy: "usr_owner",
        updatedBy: "usr_owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    const res = await form("/api/projects/@owner/site/secrets", {
      name: "VERCEL_TOKEN",
      value: SECRET_VALUE,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${SETTINGS}#secrets`);
    expect(await res.text()).not.toContain(SECRET_VALUE);
    expect(putSecret).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      env,
      expect.objectContaining({
        projectId: "prj_owner",
        name: "VERCEL_TOKEN",
        value: SECRET_VALUE,
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "secret.written" }),
    );
  });

  it("reports a bad name and an empty value as fixed codes, not as text", async () => {
    const badName = await form("/api/projects/@owner/site/secrets", {
      name: "<script>lower case</script>",
      value: SECRET_VALUE,
    });
    expect(badName.status).toBe(302);
    expect(badName.headers.get("location")).toBe(`${SETTINGS}?secretError=name#secrets`);

    const noValue = await form("/api/projects/@owner/site/secrets", {
      name: "VERCEL_TOKEN",
      value: "",
    });
    expect(noValue.status).toBe(302);
    expect(noValue.headers.get("location")).toBe(`${SETTINGS}?secretError=value#secrets`);

    expect(putSecret).not.toHaveBeenCalled();
  });

  it("distinguishes an unconfigured instance from a storage failure", async () => {
    vi.mocked(putSecret).mockResolvedValue({
      success: false,
      error: new AppError("no key", DEPLOY_SECRET_KEY_MISSING, 500),
    });
    const noKey = await form("/api/projects/@owner/site/secrets", {
      name: "VERCEL_TOKEN",
      value: SECRET_VALUE,
    });
    expect(noKey.headers.get("location")).toBe(`${SETTINGS}?secretError=key#secrets`);

    vi.mocked(putSecret).mockResolvedValue({
      success: false,
      error: new AppError("boom", "DATABASE_ERROR", 500),
    });
    const failed = await form("/api/projects/@owner/site/secrets", {
      name: "VERCEL_TOKEN",
      value: SECRET_VALUE,
    });
    expect(failed.headers.get("location")).toBe(`${SETTINGS}?secretError=failed#secrets`);
  });

  it("deletes through the POST alias and audits it", async () => {
    vi.mocked(deleteSecret).mockResolvedValue({ success: true, data: true });

    const res = await form("/api/projects/@owner/site/secrets/VERCEL_TOKEN/delete");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${SETTINGS}#secrets`);
    expect(deleteSecret).toHaveBeenCalledWith(env.DB, expect.any(Object), {
      projectId: "prj_owner",
      name: "VERCEL_TOKEN",
    });
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "secret.deleted" }),
    );
  });

  it("audits nothing when the delete removed nothing", async () => {
    vi.mocked(deleteSecret).mockResolvedValue({ success: true, data: false });

    const res = await form("/api/projects/@owner/site/secrets/NOPE/delete");

    expect(res.status).toBe(302);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("canManageSecrets", () => {
  // The one definition the routes and the settings page both consult. An agent
  // owned by the project owner is a project admin, so "admin" alone is not the
  // rule — this is what stops the section from rendering, and the routes from
  // acting, for a `stratum_agent_` identity.
  it("grants an admin user and refuses an agent owned by that same user", async () => {
    expect(
      await canManageSecrets(env.DB, PROJECT, { userId: "usr_owner", agentId: undefined }),
    ).toBe(true);
    expect(
      await canManageSecrets(env.DB, PROJECT, { userId: "usr_owner", agentId: "agt_bot" }),
    ).toBe(false);
    expect(await canManageSecrets(env.DB, PROJECT, { userId: undefined, agentId: "agt_bot" })).toBe(
      false,
    );
    expect(
      await canManageSecrets(env.DB, PROJECT, { userId: "usr_outsider", agentId: undefined }),
    ).toBe(false);
  });
});

describe("secretErrorMessage", () => {
  it("resolves only the codes the routes emit", () => {
    for (const code of ["name", "value", "key", "failed"]) {
      expect(secretErrorMessage(code)).toBeTypeOf("string");
    }
  });

  it("resolves nothing for anything else, inherited keys included", () => {
    expect(secretErrorMessage(undefined)).toBeUndefined();
    expect(secretErrorMessage("<img src=x onerror=boom>")).toBeUndefined();
    // `in` would answer true here and hand the page a function.
    expect(secretErrorMessage("toString")).toBeUndefined();
    expect(secretErrorMessage("constructor")).toBeUndefined();
  });
});

describe("deployment list and detail", () => {
  beforeEach(() => {
    vi.mocked(listDeployments).mockResolvedValue({ success: true, data: [deployment()] });
    vi.mocked(findDeploymentById).mockResolvedValue({ success: true, data: deployment() });
  });

  it("gives a writer the log tail", async () => {
    const res = await call("/api/projects/@owner/site/deployments", { headers: asOwner });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployments: Array<Record<string, unknown>> };
    expect(body.deployments[0]).toHaveProperty("logTail");
  });

  it("lists metadata for a public-project reader but withholds the log tail", async () => {
    const list = await call("/api/projects/@owner/site/deployments", { headers: asOutsider });
    const detail = await call("/api/deployments/dep_1", { headers: asOutsider });

    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { deployments: Array<Record<string, unknown>> };
    expect(listBody.deployments[0]).toMatchObject({ id: "dep_1", status: "failed" });
    expect(listBody.deployments[0]).not.toHaveProperty("logTail");

    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { deployment: Record<string, unknown> };
    expect(detailBody.deployment).not.toHaveProperty("logTail");
  });

  it("rejects an unknown status filter", async () => {
    const res = await call("/api/projects/@owner/site/deployments?status=nope", {
      headers: asOwner,
    });

    expect(res.status).toBe(400);
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it("404s an id from another project rather than confirming it exists", async () => {
    vi.mocked(findDeploymentById).mockResolvedValue({
      success: true,
      data: deployment({ id: "dep_other", projectId: OTHER_PROJECT.id }),
    });
    vi.mocked(getProjectById).mockResolvedValue({ success: true, data: OTHER_PROJECT });

    const res = await call("/api/deployments/dep_other", { headers: asOwner });

    expect(res.status).toBe(404);
  });
});

describe("approve", () => {
  const pending = deployment({ status: "pending_approval", logTail: undefined });

  beforeEach(() => {
    vi.mocked(findDeploymentById).mockResolvedValue({ success: true, data: pending });
    vi.mocked(approveDeployment).mockResolvedValue({
      success: true,
      data: {
        approved: true,
        deployment: { ...pending, status: "queued", approvedBy: "usr_owner" },
      },
    });
  });

  it("queues the deployment once and audits the approval", async () => {
    const res = await call("/api/deployments/dep_1/approve", {
      method: "POST",
      headers: { ...asOwner, "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      kind: "deployment",
      projectId: "prj_owner",
      deploymentId: "dep_1",
    });
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "deployment.approved", actorId: "usr_owner" }),
    );
  });

  it("answers a form submission with a redirect back to the deployment", async () => {
    const res = await call("/api/deployments/dep_1/approve", {
      method: "POST",
      headers: asOwner,
      body: new URLSearchParams(),
    });

    // Every page in this UI has to work with JavaScript disabled, so the button
    // that posts here must land back on a page, never on a JSON body.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/@owner/site/deployments/dep_1");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses an agent token", async () => {
    const res = await call("/api/deployments/dep_1/approve", { method: "POST", headers: asAgent });

    expect(res.status).toBe(401);
    expect(approveDeployment).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a reader who cannot write the project", async () => {
    const res = await call("/api/deployments/dep_1/approve", {
      method: "POST",
      headers: asOutsider,
    });

    expect(res.status).toBe(403);
    expect(approveDeployment).not.toHaveBeenCalled();
  });

  it("cannot enqueue twice when the row is already approved", async () => {
    // What the conditional UPDATE reports to the loser of a double-approve.
    vi.mocked(approveDeployment).mockResolvedValue({
      success: true,
      data: { approved: false, reason: "not_pending" },
    });

    const res = await call("/api/deployments/dep_1/approve", { method: "POST", headers: asOwner });

    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("rejects approval of a superseded row", async () => {
    vi.mocked(findDeploymentById).mockResolvedValue({
      success: true,
      data: deployment({ status: "superseded", logTail: undefined }),
    });
    vi.mocked(approveDeployment).mockResolvedValue({
      success: true,
      data: { approved: false, reason: "not_pending" },
    });

    const res = await call("/api/deployments/dep_1/approve", { method: "POST", headers: asOwner });

    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects approval of a terminal row", async () => {
    vi.mocked(findDeploymentById).mockResolvedValue({
      success: true,
      data: deployment({ status: "succeeded", logTail: undefined }),
    });
    vi.mocked(approveDeployment).mockResolvedValue({
      success: true,
      data: { approved: false, reason: "not_pending" },
    });

    const res = await call("/api/deployments/dep_1/approve", { method: "POST", headers: asOwner });

    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  // The row has already left `pending_approval` by the time the send is
  // attempted, and only a queue message can move it any further: approve
  // refuses a `queued` row and `claimDeployment` runs from the consumer. The
  // old "retry it" was advice that could not succeed, so the request has to be
  // made durable instead.
  it("records the request for recovery when the queue refuses it", async () => {
    send.mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await call("/api/deployments/dep_1/approve", {
      method: "POST",
      headers: { ...asOwner, "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(insertEvent).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({
        type: "deploy.enqueue",
        projectId: "prj_owner",
        payload: { kind: "deployment", projectId: "prj_owner", deploymentId: "dep_1" },
      }),
    );
  });

  it("reports the failure only when the request could not be recorded either", async () => {
    send.mockRejectedValueOnce(new Error("queue unavailable"));
    vi.mocked(insertEvent).mockResolvedValue({
      success: false,
      error: new AppError("D1 unavailable", "DATABASE_ERROR", 500),
    });

    const res = await call("/api/deployments/dep_1/approve", {
      method: "POST",
      headers: { ...asOwner, "content-type": "application/json" },
    });

    expect(res.status).toBe(500);
  });

  it("404s an id from another project", async () => {
    vi.mocked(findDeploymentById).mockResolvedValue({
      success: true,
      data: deployment({
        id: "dep_other",
        projectId: OTHER_PROJECT.id,
        status: "pending_approval",
      }),
    });
    vi.mocked(getProjectById).mockResolvedValue({ success: true, data: OTHER_PROJECT });

    const res = await call("/api/deployments/dep_other/approve", {
      method: "POST",
      headers: asOwner,
    });

    expect(res.status).toBe(404);
    expect(approveDeployment).not.toHaveBeenCalled();
  });
});

describe("retry", () => {
  beforeEach(() => {
    vi.mocked(findDeploymentById).mockResolvedValue({
      success: true,
      data: deployment({ attempt: 2, status: "failed" }),
    });
    vi.mocked(insertDeployment).mockResolvedValue({
      success: true,
      data: {
        inserted: true,
        deployment: deployment({ id: "dep_2", attempt: 3, status: "queued" }),
      },
    });
  });

  it("inserts the next attempt for the same commit and queues it", async () => {
    const res = await call("/api/deployments/dep_1/retry", {
      method: "POST",
      headers: { ...asOwner, "content-type": "application/json" },
    });

    expect(res.status).toBe(201);
    expect(insertDeployment).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({
        projectId: "prj_owner",
        commitSha: "a".repeat(40),
        name: "production",
        attempt: 3,
        status: "queued",
      }),
    );
    expect(send).toHaveBeenCalledWith({
      kind: "deployment",
      projectId: "prj_owner",
      deploymentId: "dep_2",
    });
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "deployment.retried" }),
    );
  });

  // The retry row exists and is `queued`, so "try again" would only be refused
  // by the unique index on (project, name, commit, attempt). The outbox row is
  // what can still start it.
  it("records the request for recovery when the queue refuses it", async () => {
    send.mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await call("/api/deployments/dep_1/retry", {
      method: "POST",
      headers: { ...asOwner, "content-type": "application/json" },
    });

    expect(res.status).toBe(201);
    expect(insertEvent).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({
        type: "deploy.enqueue",
        projectId: "prj_owner",
        payload: { kind: "deployment", projectId: "prj_owner", deploymentId: "dep_2" },
      }),
    );
  });

  it("accepts an agent, which retry does not gate on a user identity", async () => {
    const res = await call("/api/deployments/dep_1/retry", {
      method: "POST",
      headers: { ...asAgent, "content-type": "application/json" },
    });

    expect(res.status).toBe(201);
    expect(insertDeployment).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ requestedByType: "agent", requestedById: "agt_bot" }),
    );
  });

  it("answers a form submission with a redirect to the new attempt", async () => {
    const res = await call("/api/deployments/dep_1/retry", {
      method: "POST",
      headers: asOwner,
      body: new URLSearchParams(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/@owner/site/deployments/dep_2");
    expect(insertDeployment).toHaveBeenCalled();
  });

  it("refuses a form caller exactly as it refuses a JSON one", async () => {
    // The terminal-status check is the gate that keeps a retry from routing
    // around approval; posting as a form must not slip past it.
    vi.mocked(findDeploymentById).mockResolvedValue({
      success: true,
      data: deployment({ status: "pending_approval" }),
    });

    const res = await call("/api/deployments/dep_1/retry", {
      method: "POST",
      headers: asOwner,
      body: new URLSearchParams(),
    });

    expect(res.status).toBe(409);
    expect(insertDeployment).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to retry a deployment that has not finished", async () => {
    vi.mocked(findDeploymentById).mockResolvedValue({
      success: true,
      data: deployment({ status: "running" }),
    });

    const res = await call("/api/deployments/dep_1/retry", { method: "POST", headers: asOwner });

    expect(res.status).toBe(409);
    expect(insertDeployment).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to retry a row still awaiting approval", async () => {
    vi.mocked(findDeploymentById).mockResolvedValue({
      success: true,
      data: deployment({ status: "pending_approval" }),
    });

    const res = await call("/api/deployments/dep_1/retry", { method: "POST", headers: asOwner });

    expect(res.status).toBe(409);
    expect(insertDeployment).not.toHaveBeenCalled();
  });

  it("409s when that attempt already exists", async () => {
    vi.mocked(insertDeployment).mockResolvedValue({
      success: true,
      data: { inserted: false, existing: deployment({ id: "dep_2", attempt: 3 }) },
    });

    const res = await call("/api/deployments/dep_1/retry", { method: "POST", headers: asOwner });

    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a reader who cannot write the project", async () => {
    const res = await call("/api/deployments/dep_1/retry", { method: "POST", headers: asOutsider });

    expect(res.status).toBe(403);
    expect(insertDeployment).not.toHaveBeenCalled();
  });
});

describe("secret values never reach a response body", () => {
  it("holds across every route on this surface", async () => {
    vi.mocked(listSecretNames).mockResolvedValue({
      success: true,
      data: [
        {
          name: "VERCEL_TOKEN",
          createdBy: "usr_owner",
          updatedBy: "usr_owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(putSecret).mockResolvedValue({
      success: true,
      data: {
        name: "VERCEL_TOKEN",
        createdBy: "usr_owner",
        updatedBy: "usr_owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    vi.mocked(deleteSecret).mockResolvedValue({ success: true, data: true });
    vi.mocked(listDeployments).mockResolvedValue({ success: true, data: [deployment()] });
    vi.mocked(findDeploymentById).mockResolvedValue({ success: true, data: deployment() });
    vi.mocked(insertDeployment).mockResolvedValue({
      success: true,
      data: { inserted: true, deployment: deployment({ id: "dep_2", attempt: 2 }) },
    });
    vi.mocked(approveDeployment).mockResolvedValue({
      success: true,
      data: { approved: false, reason: "not_pending" },
    });

    const routes = (headers: Record<string, string>): Array<Promise<Response>> => [
      call("/api/projects/@owner/site/secrets", { headers }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN", { method: "DELETE", headers }),
      call("/api/projects/@owner/site/secrets", {
        method: "POST",
        headers,
        body: new URLSearchParams({ name: "VERCEL_TOKEN", value: SECRET_VALUE }),
      }),
      call("/api/projects/@owner/site/secrets/VERCEL_TOKEN/delete", {
        method: "POST",
        headers,
        body: new URLSearchParams(),
      }),
      call("/api/projects/@owner/site/deployments", { headers }),
      call("/api/deployments/dep_1", { headers }),
      call("/api/deployments/dep_1/approve", { method: "POST", headers }),
      call("/api/deployments/dep_1/retry", { method: "POST", headers }),
    ];

    // The fixture's `logTail` deliberately still contains the value: redaction
    // (`src/deploy/redact.ts`) is literal-substring matching and is stated to
    // miss encoded forms, so the reader gate has to hold on its own even when
    // redaction missed. A writer legitimately receives that field, so only the
    // secret routes are checked for them.
    const readerBodies = await Promise.all(
      routes(asOutsider).map(async (pending) => (await pending).text()),
    );
    for (const body of readerBodies) expect(body).not.toContain(SECRET_VALUE);

    const writerBodies = await Promise.all(
      routes(asOwner)
        .slice(0, 5)
        .map(async (pending) => (await pending).text()),
    );
    for (const body of writerBodies) expect(body).not.toContain(SECRET_VALUE);
  });
});
