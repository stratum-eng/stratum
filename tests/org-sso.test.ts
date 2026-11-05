import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { orgSsoRouter } from "../src/routes/org-sso";
import type { SsoConnection } from "../src/storage/sso";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

vi.mock("../src/storage/users", () => ({
  getUser: vi.fn(),
  getUserByToken: vi.fn(),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
}));

vi.mock("../src/storage/sessions", () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock("../src/storage/orgs", () => ({
  getOrgBySlug: vi.fn(),
  isOrgAdmin: vi.fn(),
  isOrgMember: vi.fn(),
}));

// Keep normalizeEmailDomains (pure validation incl. the public-domain
// deny-list) real; mock the persistence functions.
vi.mock("../src/storage/sso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/sso")>();
  return {
    ...actual,
    upsertSsoConnection: vi.fn(),
    getSsoConnectionByOrgId: vi.fn(),
    deleteSsoConnection: vi.fn(),
    findVerifiedDomainConflicts: vi.fn(),
    setSsoDomainsVerified: vi.fn(),
    setSsoConnectionEnabled: vi.fn(),
    rotateScimToken: vi.fn(),
  };
});

vi.mock("../src/services/oidc-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/oidc-discovery")>();
  return { ...actual, discoverOidcConfiguration: vi.fn() };
});

vi.mock("../src/services/domain-verification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/domain-verification")>();
  return { ...actual, checkDomainTxtRecord: vi.fn() };
});

vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue({ success: true, data: undefined }),
}));

import { checkDomainTxtRecord } from "../src/services/domain-verification";
import { discoverOidcConfiguration } from "../src/services/oidc-discovery";
import { recordAudit } from "../src/storage/audit";
import { getOrgBySlug, isOrgAdmin, isOrgMember } from "../src/storage/orgs";
import {
  deleteSsoConnection,
  findVerifiedDomainConflicts,
  getSsoConnectionByOrgId,
  rotateScimToken,
  setSsoConnectionEnabled,
  setSsoDomainsVerified,
  upsertSsoConnection,
} from "../src/storage/sso";
import { getUserByToken } from "../src/storage/users";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/orgs", orgSsoRouter);
  return app;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
    SSO_ENCRYPTION_SECRET: "test-sso-encryption-secret",
    ...overrides,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

const mockUser = {
  id: "usr_admin",
  email: "admin@example.com",
  username: "admin",
  tokenHash: "hash",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockOrg = {
  id: "org_abc",
  name: "Acme",
  slug: "acme",
  ownerId: "usr_owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  requireSecondFactor: false,
  ipAllowlist: [],
};

const SECRET_CIPHERTEXT = "CIPHERTEXT_NEVER_ECHOED";
const SCIM_HASH = "SCIM_HASH_NEVER_ECHOED";

function mockConnection(overrides: Partial<SsoConnection> = {}): SsoConnection {
  return {
    id: "ssoc_1",
    orgId: "org_abc",
    protocol: "oidc",
    issuer: "https://idp.example.com",
    clientId: "client-123",
    clientSecretCiphertext: SECRET_CIPHERTEXT,
    authorizationEndpoint: "https://idp.example.com/authorize",
    tokenEndpoint: "https://idp.example.com/token",
    jwksUri: "https://idp.example.com/jwks",
    emailDomains: ["corp.example.com"],
    domainsVerifiedAt: null,
    domainVerificationToken: "aabbccdd00112233aabbccdd00112233",
    scimTokenHash: SCIM_HASH,
    enabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const authHeader = { Authorization: "Bearer stratum_user_token" };

const validPutBody = {
  issuer: "https://idp.example.com",
  clientId: "client-123",
  clientSecret: "super-secret-value",
  emailDomains: ["corp.example.com"],
};

function grantAdmin() {
  vi.mocked(isOrgAdmin).mockResolvedValue({ success: true, data: true });
  vi.mocked(isOrgMember).mockResolvedValue({ success: true, data: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserByToken).mockResolvedValue({ success: true, data: mockUser });
  vi.mocked(getOrgBySlug).mockResolvedValue({ success: true, data: mockOrg });
  vi.mocked(recordAudit).mockResolvedValue({ success: true, data: undefined });
  vi.mocked(discoverOidcConfiguration).mockResolvedValue({
    success: true,
    data: {
      issuer: "https://idp.example.com",
      authorizationEndpoint: "https://idp.example.com/authorize",
      tokenEndpoint: "https://idp.example.com/token",
      jwksUri: "https://idp.example.com/jwks",
    },
  });
});

describe("authz gate (shared across endpoints)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await makeApp().fetch(request("GET", "/api/orgs/acme/sso"), makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns 404 to a non-member (no existence leak)", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue({ success: true, data: false });
    vi.mocked(isOrgMember).mockResolvedValue({ success: true, data: false });
    const res = await makeApp().fetch(
      request("GET", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(getSsoConnectionByOrgId).not.toHaveBeenCalled();
  });

  it("returns 403 to a member who is not an admin", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue({ success: true, data: false });
    vi.mocked(isOrgMember).mockResolvedValue({ success: true, data: true });
    const res = await makeApp().fetch(
      request("GET", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(getSsoConnectionByOrgId).not.toHaveBeenCalled();
  });

  it("allows an org admin", async () => {
    grantAdmin();
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection(),
    });
    const res = await makeApp().fetch(
      request("GET", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
  });

  it("allows the org owner even without a member row", async () => {
    vi.mocked(getOrgBySlug).mockResolvedValue({
      success: true,
      data: { ...mockOrg, ownerId: mockUser.id },
    });
    vi.mocked(isOrgAdmin).mockResolvedValue({ success: true, data: false });
    vi.mocked(isOrgMember).mockResolvedValue({ success: true, data: false });
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection(),
    });
    const res = await makeApp().fetch(
      request("GET", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown org", async () => {
    vi.mocked(getOrgBySlug).mockResolvedValue({
      success: false,
      error: new NotFoundError("Org", "nope"),
    });
    const res = await makeApp().fetch(
      request("GET", "/api/orgs/nope/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });

  it("returns 501 on every endpoint when SSO_ENCRYPTION_SECRET is unset", async () => {
    grantAdmin();
    const env = makeEnv({ SSO_ENCRYPTION_SECRET: undefined });
    const app = makeApp();
    const calls: [string, string, unknown?][] = [
      ["PUT", "/api/orgs/acme/sso", validPutBody],
      ["GET", "/api/orgs/acme/sso"],
      ["DELETE", "/api/orgs/acme/sso"],
      ["POST", "/api/orgs/acme/sso/verify-domains"],
      ["POST", "/api/orgs/acme/sso/enable"],
      ["POST", "/api/orgs/acme/sso/disable"],
      ["POST", "/api/orgs/acme/sso/scim-token"],
    ];
    for (const [method, path, body] of calls) {
      const res = await app.fetch(request(method, path, body, authHeader), env);
      expect(res.status, `${method} ${path} must 501 unconfigured`).toBe(501);
    }
    expect(upsertSsoConnection).not.toHaveBeenCalled();
    expect(getSsoConnectionByOrgId).not.toHaveBeenCalled();
  });
});

describe("PUT /api/orgs/:slug/sso", () => {
  beforeEach(() => {
    grantAdmin();
    vi.mocked(upsertSsoConnection).mockResolvedValue({
      success: true,
      data: { connection: mockConnection({ scimTokenHash: null }), created: true },
    });
  });

  it("creates a connection, returns verification info, and never echoes the secret", async () => {
    const res = await makeApp().fetch(
      request("PUT", "/api/orgs/acme/sso", validPutBody, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain(SECRET_CIPHERTEXT);
    const body = JSON.parse(text) as {
      connection: Record<string, unknown>;
      domainVerification: { token: string; records: { name: string; value: string }[] };
    };
    expect(body.connection.clientSecret).toBeUndefined();
    expect(body.connection.clientSecretCiphertext).toBeUndefined();
    expect(body.domainVerification.token).toBe("aabbccdd00112233aabbccdd00112233");
    expect(body.domainVerification.records[0]?.name).toBe("_stratum-sso.corp.example.com");
    expect(body.domainVerification.records[0]?.value).toBe(
      "stratum-sso-verify=aabbccdd00112233aabbccdd00112233",
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "sso.connection.created", actorId: mockUser.id }),
    );
    // The secret reaches storage only as ciphertext, never as the plaintext.
    const input = vi.mocked(upsertSsoConnection).mock.calls[0]?.[2];
    expect(input?.clientSecretCiphertext).toBeDefined();
    expect(input?.clientSecretCiphertext).not.toBe("super-secret-value");
  });

  it("audits sso.connection.updated on replace", async () => {
    vi.mocked(upsertSsoConnection).mockResolvedValue({
      success: true,
      data: { connection: mockConnection(), created: false },
    });
    const res = await makeApp().fetch(
      request("PUT", "/api/orgs/acme/sso", validPutBody, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "sso.connection.updated" }),
    );
  });

  it("rejects a deny-listed public email domain at create time", async () => {
    const res = await makeApp().fetch(
      request(
        "PUT",
        "/api/orgs/acme/sso",
        { ...validPutBody, emailDomains: ["gmail.com"] },
        authHeader,
      ),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(discoverOidcConfiguration).not.toHaveBeenCalled();
    expect(upsertSsoConnection).not.toHaveBeenCalled();
  });

  it("propagates discovery rejections (SSRF/reserved issuer) as 400", async () => {
    // The real discovery module rejects these pre-fetch; here the mock stands
    // in for that contract.
    const { ValidationError } = await import("../src/utils/errors");
    vi.mocked(discoverOidcConfiguration).mockResolvedValue({
      success: false,
      error: new ValidationError("issuer must use https"),
    });
    const res = await makeApp().fetch(
      request(
        "PUT",
        "/api/orgs/acme/sso",
        { ...validPutBody, issuer: "http://idp.example.com" },
        authHeader,
      ),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(upsertSsoConnection).not.toHaveBeenCalled();
  });

  it("stores the discovery module's canonical issuer, not the raw trailing-slash input", async () => {
    const res = await makeApp().fetch(
      request(
        "PUT",
        "/api/orgs/acme/sso",
        { ...validPutBody, issuer: "https://idp.example.com/" },
        authHeader,
      ),
      makeEnv(),
    );
    expect(res.status).toBe(201);
    const input = vi.mocked(upsertSsoConnection).mock.calls[0]?.[2];
    expect(input?.issuer).toBe("https://idp.example.com");
  });

  it("returns 400 (not 500) for a malformed JSON body", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/api/orgs/acme/sso", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: "{not json",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(upsertSsoConnection).not.toHaveBeenCalled();
  });

  it("rejects missing fields", async () => {
    const app = makeApp();
    for (const missing of ["issuer", "clientId", "clientSecret", "emailDomains"]) {
      const body: Record<string, unknown> = { ...validPutBody };
      delete body[missing];
      const res = await app.fetch(
        request("PUT", "/api/orgs/acme/sso", body, authHeader),
        makeEnv(),
      );
      expect(res.status, `missing ${missing} must 400`).toBe(400);
    }
    expect(upsertSsoConnection).not.toHaveBeenCalled();
  });
});

describe("GET /api/orgs/:slug/sso", () => {
  beforeEach(() => {
    grantAdmin();
  });

  it("returns the redacted connection with verification info", async () => {
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection({ domainsVerifiedAt: "2026-02-01T00:00:00.000Z", enabled: true }),
    });
    const res = await makeApp().fetch(
      request("GET", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_CIPHERTEXT);
    expect(text).not.toContain(SCIM_HASH);
    const body = JSON.parse(text) as {
      connection: Record<string, unknown>;
      domainVerification: { token: string };
    };
    expect(body.connection.issuer).toBe("https://idp.example.com");
    expect(body.connection.domainsVerifiedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(body.connection.enabled).toBe(true);
    expect(body.connection.scimTokenSet).toBe(true);
    expect(body.domainVerification.token).toBe("aabbccdd00112233aabbccdd00112233");
  });

  it("returns 404 when the org has no connection", async () => {
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: false,
      error: new NotFoundError("SSO connection", "org_abc"),
    });
    const res = await makeApp().fetch(
      request("GET", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/orgs/:slug/sso", () => {
  beforeEach(() => {
    grantAdmin();
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection(),
    });
    vi.mocked(deleteSsoConnection).mockResolvedValue({ success: true, data: [] });
  });

  it("deletes the connection, re-enabling (atomically) the users it disabled", async () => {
    vi.mocked(deleteSsoConnection).mockResolvedValue({
      success: true,
      data: ["usr_x", "usr_y"],
    });

    const res = await makeApp().fetch(
      request("DELETE", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; reenabledUserIds: string[] };
    expect(body.deleted).toBe(true);
    expect(body.reenabledUserIds).toEqual(["usr_x", "usr_y"]);
    expect(deleteSsoConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "ssoc_1",
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: "sso.connection.deleted",
        detail: expect.objectContaining({ reenabledUserIds: ["usr_x", "usr_y"] }),
      }),
    );
  });

  it("deletes cleanly when no user was disabled", async () => {
    const res = await makeApp().fetch(
      request("DELETE", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reenabledUserIds: string[] };
    expect(body.reenabledUserIds).toEqual([]);
  });

  it("a failed delete-and-re-enable returns the error and records no deletion", async () => {
    const { AppError } = await import("../src/utils/errors");
    vi.mocked(deleteSsoConnection).mockResolvedValue({
      success: false,
      error: new AppError("Failed to delete SSO connection", "STORAGE_ERROR", 500),
    });
    const res = await makeApp().fetch(
      request("DELETE", "/api/orgs/acme/sso", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(500);
    expect(recordAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "sso.connection.deleted" }),
    );
  });
});

describe("POST /api/orgs/:slug/sso/verify-domains", () => {
  beforeEach(() => {
    grantAdmin();
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection({ emailDomains: ["corp.example.com", "eng.example.com"] }),
    });
    vi.mocked(findVerifiedDomainConflicts).mockResolvedValue({ success: true, data: [] });
    vi.mocked(setSsoDomainsVerified).mockResolvedValue({
      success: true,
      data: "2026-02-01T00:00:00.000Z",
    });
  });

  it("verifies when every domain has the TXT record", async () => {
    vi.mocked(checkDomainTxtRecord).mockResolvedValue({ success: true, data: true });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/verify-domains", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verified: boolean; domainsVerifiedAt: string };
    expect(body.verified).toBe(true);
    expect(body.domainsVerifiedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(checkDomainTxtRecord).toHaveBeenCalledTimes(2);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "sso.domain.verified" }),
    );
  });

  it("fails with the missing domains when a TXT record is absent", async () => {
    vi.mocked(checkDomainTxtRecord)
      .mockResolvedValueOnce({ success: true, data: true })
      .mockResolvedValueOnce({ success: true, data: false });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/verify-domains", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { failedDomains: string[] };
    expect(body.failedDomains).toEqual(["eng.example.com"]);
    expect(setSsoDomainsVerified).not.toHaveBeenCalled();
  });

  it("stamps verification against the exact domain list that was checked", async () => {
    vi.mocked(checkDomainTxtRecord).mockResolvedValue({ success: true, data: true });
    await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/verify-domains", undefined, authHeader),
      makeEnv(),
    );
    expect(setSsoDomainsVerified).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "ssoc_1",
      ["corp.example.com", "eng.example.com"],
    );
  });

  it("returns 409 when the connection changed during verification", async () => {
    const { ConflictError } = await import("../src/utils/errors");
    vi.mocked(checkDomainTxtRecord).mockResolvedValue({ success: true, data: true });
    vi.mocked(setSsoDomainsVerified).mockResolvedValue({
      success: false,
      error: new ConflictError("connection changed during verification; retry"),
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/verify-domains", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 when the stored domain list is empty (malformed row), checking nothing", async () => {
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      // rowToConnection parses a malformed email_domains TEXT to [].
      data: mockConnection({ emailDomains: [] }),
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/verify-domains", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(checkDomainTxtRecord).not.toHaveBeenCalled();
    expect(setSsoDomainsVerified).not.toHaveBeenCalled();
  });

  it("returns 409 when a domain is already verified by another connection", async () => {
    vi.mocked(findVerifiedDomainConflicts).mockResolvedValue({
      success: true,
      data: ["corp.example.com"],
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/verify-domains", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(409);
    expect(checkDomainTxtRecord).not.toHaveBeenCalled();
    expect(setSsoDomainsVerified).not.toHaveBeenCalled();
  });
});

describe("POST /api/orgs/:slug/sso/enable and /disable", () => {
  beforeEach(() => {
    grantAdmin();
    vi.mocked(findVerifiedDomainConflicts).mockResolvedValue({ success: true, data: [] });
    vi.mocked(setSsoConnectionEnabled).mockResolvedValue({ success: true, data: undefined });
  });

  it("refuses to enable before domains are verified", async () => {
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection({ domainsVerifiedAt: null }),
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/enable", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(setSsoConnectionEnabled).not.toHaveBeenCalled();
  });

  it("enables a verified connection", async () => {
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection({ domainsVerifiedAt: "2026-02-01T00:00:00.000Z" }),
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/enable", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(setSsoConnectionEnabled).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "ssoc_1",
      true,
    );
  });

  it("returns 409 on an enable-time domain conflict", async () => {
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection({ domainsVerifiedAt: "2026-02-01T00:00:00.000Z" }),
    });
    vi.mocked(findVerifiedDomainConflicts).mockResolvedValue({
      success: true,
      data: ["corp.example.com"],
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/enable", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(409);
    expect(setSsoConnectionEnabled).not.toHaveBeenCalled();
  });

  it("disables regardless of verification state", async () => {
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection({ enabled: true }),
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/disable", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(setSsoConnectionEnabled).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "ssoc_1",
      false,
    );
  });
});

describe("POST /api/orgs/:slug/sso/scim-token", () => {
  beforeEach(() => {
    grantAdmin();
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: true,
      data: mockConnection(),
    });
  });

  it("returns the plaintext once and audits the rotation", async () => {
    vi.mocked(rotateScimToken).mockResolvedValue({
      success: true,
      data: "stratum_scim_00112233445566778899aabbccddeeff",
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/scim-token", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scimToken: string };
    expect(body.scimToken).toBe("stratum_scim_00112233445566778899aabbccddeeff");
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "sso.scim_token.rotated" }),
    );
  });

  it("returns 404 when no connection exists", async () => {
    vi.mocked(getSsoConnectionByOrgId).mockResolvedValue({
      success: false,
      error: new NotFoundError("SSO connection", "org_abc"),
    });
    const res = await makeApp().fetch(
      request("POST", "/api/orgs/acme/sso/scim-token", undefined, authHeader),
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(rotateScimToken).not.toHaveBeenCalled();
  });
});
