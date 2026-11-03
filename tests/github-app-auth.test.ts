import type { KVNamespace } from "@cloudflare/workers-types";
import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GitHubAuthEnv,
  type GitHubCallTarget,
  createAppJwt,
  getInstallationId,
  invalidateInstallationCache,
  resolveGitHubToken,
} from "../src/github/app-auth";
import { handleInstallationChange } from "../src/github/webhooks";
import { resolveAuthConfig } from "../src/storage/git-providers";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

interface KvStub {
  kv: KVNamespace;
  store: Map<string, string>;
  ttls: Map<string, number | undefined>;
}

function makeKv(initial: Record<string, string> = {}): KvStub {
  const store = new Map(Object.entries(initial));
  const ttls = new Map<string, number | undefined>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, value);
      ttls.set(key, opts?.expirationTtl);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
  return { kv, store, ttls };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toPem(der: ArrayBuffer): string {
  const lines = toBase64(new Uint8Array(der)).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function base64UrlDecode(part: string): Uint8Array {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const decodeJson = (part: string): unknown =>
  JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));

let privatePem: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privatePem = toPem((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  publicKey = pair.publicKey;
});

const NOW = Date.parse("2026-11-02T12:00:00Z");
const IN_ONE_HOUR = new Date(NOW + 3600_000).toISOString();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

type Raw = ReturnType<typeof makeSqliteD1>["raw"];
let db: D1Database;
let raw: Raw;

beforeEach(() => {
  vi.clearAllMocks();
  const sqlite = makeSqliteD1();
  db = sqlite.db as unknown as D1Database;
  raw = sqlite.raw;
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function appEnv(kv: KVNamespace, extra: Partial<GitHubAuthEnv> = {}): GitHubAuthEnv {
  return {
    STATE: kv,
    DB: db,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: privatePem,
    ...extra,
  };
}

/** Routes the two GitHub App endpoints to canned responses. */
function routeGitHub(opts: { installation?: Response; token?: Response }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/installation")) {
      return opts.installation ?? jsonResponse(200, { id: 777 });
    }
    if (url.includes("/access_tokens")) {
      return (
        opts.token ?? jsonResponse(201, { token: "ghs_installation", expires_at: IN_ONE_HOUR })
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const tokenCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/access_tokens"));

/** `usr_alice` gets username `alice`: real usernames carry no underscore. */
function seedUser(id: string): void {
  raw
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .run(id, `${id}@example.com`, id.replace(/^usr_/, ""), `hash_${id}`);
}

function seedInstallation(
  installationId: number,
  owner?: { type: "user" | "org"; id: string },
  opts: { suspended?: boolean } = {},
): void {
  raw
    .prepare(
      `INSERT INTO github_app_installations
         (installation_id, account_login, account_id, account_type, stratum_owner_type, stratum_owner_id, suspended_at)
       VALUES (?, 'acme', '99', 'Organization', ?, ?, ?)`,
    )
    .run(
      installationId,
      owner?.type ?? null,
      owner?.id ?? null,
      opts.suspended ? "2026-11-01T00:00:00Z" : null,
    );
}

const ALICE = { type: "user", id: "usr_alice" } as const;
const target = (principal: GitHubCallTarget["principal"] = ALICE): GitHubCallTarget => ({
  owner: "acme",
  repo: "api",
  principal,
});

describe("createAppJwt", () => {
  it("signs an RS256 JWT GitHub will accept", async () => {
    const result = await createAppJwt(
      { GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: privatePem },
      NOW,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [header = "", payload = "", signature = ""] = result.data.split(".");
    expect(decodeJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decodeJson(payload) as { iss: number; iat: number; exp: number };
    const nowS = NOW / 1000;
    expect(claims).toEqual({ iss: 12345, iat: nowS - 60, exp: nowS + 540 });
    // GitHub's hard ceiling on app JWT lifetime.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64UrlDecode(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("accepts a key whose newlines were stored as literal \\n", async () => {
    const escaped = privatePem.replace(/\n/g, "\\n");
    const result = await createAppJwt({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: escaped });
    expect(result.success).toBe(true);
  });

  it("refuses a PKCS#1 key with an actionable message", async () => {
    const result = await createAppJwt({
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
    });
    expect(!result.success && result.error.code).toBe("GITHUB_APP_KEY_INVALID");
    expect(!result.success && result.error.message).toContain("pkcs8");
  });

  it("reports an unconfigured app", async () => {
    const result = await createAppJwt({ GITHUB_APP_ID: "1" });
    expect(!result.success && result.error.code).toBe("GITHUB_APP_NOT_CONFIGURED");
  });
});

describe("getInstallationId", () => {
  it("returns a cached id without calling GitHub", async () => {
    const { kv } = makeKv({ "github_installation:acme/api": "42" });
    const result = await getInstallationId(appEnv(kv), "Acme", "API", logger);
    expect(result).toEqual({ success: true, data: { installed: true, installationId: 42 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks the installation up with the app JWT and caches it for a day", async () => {
    const { kv, store, ttls } = makeKv();
    routeGitHub({});

    const result = await getInstallationId(appEnv(kv), "acme", "api", logger);

    expect(result).toEqual({ success: true, data: { installed: true, installationId: 777 } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/repos/acme/api/installation");
    expect(init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(store.get("github_installation:acme/api")).toBe("777");
    expect(ttls.get("github_installation:acme/api")).toBe(86_400);
  });

  it("treats 404 as not installed and caches that briefly", async () => {
    const { kv, store, ttls } = makeKv();
    routeGitHub({ installation: jsonResponse(404, { message: "Not Found" }) });

    const result = await getInstallationId(appEnv(kv), "acme", "api", logger);

    expect(result).toEqual({ success: true, data: { installed: false } });
    expect(store.get("github_installation:acme/api")).toBe("none");
    expect(ttls.get("github_installation:acme/api")).toBe(600);

    fetchMock.mockClear();
    const again = await getInstallationId(appEnv(kv), "acme", "api", logger);
    expect(again).toEqual({ success: true, data: { installed: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an error (not 'not installed') on other GitHub failures", async () => {
    const { kv, store } = makeKv();
    routeGitHub({ installation: jsonResponse(401, { message: "Bad credentials" }) });

    const result = await getInstallationId(appEnv(kv), "acme", "api", logger);

    expect(!result.success && result.error.message).toContain("Bad credentials");
    expect(store.size).toBe(0);
  });
});

describe("installation tokens (via a bound owner)", () => {
  const bound = (kv: KVNamespace, extra: Partial<GitHubAuthEnv> = {}) =>
    appEnv(kv, { GITHUB_ALLOWED_OWNERS: "acme=user:usr_alice", ...extra });
  beforeEach(() => seedUser("usr_alice"));

  it("mints a token and caches it until five minutes before expiry", async () => {
    const { kv, store, ttls } = makeKv();
    routeGitHub({});

    const result = await resolveGitHubToken(bound(kv), target(), logger);

    expect(result).toEqual({
      success: true,
      data: { token: "ghs_installation", expiresAt: IN_ONE_HOUR, source: "app" },
    });
    const tokenCall = tokenCalls()[0];
    expect(tokenCall?.[0]).toBe("https://api.github.com/app/installations/777/access_tokens");
    expect(tokenCall?.[1].method).toBe("POST");
    expect(JSON.parse(store.get("github_inst_token:777") ?? "{}")).toEqual({
      token: "ghs_installation",
      expiresAt: IN_ONE_HOUR,
    });
    expect(ttls.get("github_inst_token:777")).toBe(3600 - 300);
  });

  it("serves a cached token without calling GitHub", async () => {
    const { kv } = makeKv({
      "github_installation:acme/api": "777",
      "github_inst_token:777": JSON.stringify({ token: "ghs_cached", expiresAt: IN_ONE_HOUR }),
    });

    const result = await resolveGitHubToken(bound(kv), target(), logger);

    expect(result.success && result.data.token).toBe("ghs_cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-mints when the cached token is inside the expiry margin", async () => {
    const nearlyExpired = new Date(NOW + 120_000).toISOString();
    const { kv } = makeKv({
      "github_installation:acme/api": "777",
      "github_inst_token:777": JSON.stringify({ token: "ghs_old", expiresAt: nearlyExpired }),
    });
    routeGitHub({});

    const result = await resolveGitHubToken(bound(kv), target(), logger);

    expect(result.success && result.data.token).toBe("ghs_installation");
  });

  it("drops a cached installation id that GitHub no longer recognises", async () => {
    const { kv, store } = makeKv({ "github_installation:acme/api": "777" });
    routeGitHub({ token: jsonResponse(404, { message: "Not Found" }) });

    const result = await resolveGitHubToken(
      bound(kv, { GITHUB_TOKEN: "ghp_pat" }),
      target(),
      logger,
    );

    expect(result.success && result.data.source).toBe("pat");
    expect(store.has("github_installation:acme/api")).toBe(false);
  });

  it("reads the former GITHUB_APP_ALLOWED_OWNERS name too", async () => {
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(
      appEnv(kv, { GITHUB_APP_ALLOWED_OWNERS: "acme=user:usr_alice" }),
      target(),
      logger,
    );
    expect(result.success && result.data.source).toBe("app");
  });

  it("ignores a namespace-bound entry: only ids bind", async () => {
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(
      appEnv(kv, { GITHUB_ALLOWED_OWNERS: "acme=@alice", GITHUB_TOKEN: "ghp_pat" }),
      target(),
      logger,
    );
    expect(!result.success && result.error.code).toBe("GITHUB_APP_NOT_AUTHORIZED");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("githubOwner=org:<orgId> or githubOwner=user:<userId>"),
      { entry: "acme=@alice" },
    );
  });

  it("ignores an entry with no Stratum owner instead of admitting everyone", async () => {
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(
      appEnv(kv, { GITHUB_ALLOWED_OWNERS: "acme", GITHUB_TOKEN: "ghp_pat" }),
      target(),
      logger,
    );
    expect(!result.success && result.error.code).toBe("GITHUB_APP_NOT_AUTHORIZED");
    expect(tokenCalls()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring GitHub allowed-owner entry"),
      expect.anything(),
    );
  });
});

describe("resolveGitHubToken authorization", () => {
  const pat = (kv: KVNamespace, extra: Partial<GitHubAuthEnv> = {}) =>
    appEnv(kv, { GITHUB_TOKEN: "ghp_pat", ...extra });
  const refusedByApp = (result: Awaited<ReturnType<typeof resolveGitHubToken>>) =>
    !result.success && result.error.code === "GITHUB_APP_NOT_AUTHORIZED";

  it("uses the installation token when it is linked to the calling project's owner", async () => {
    seedUser("usr_alice");
    seedInstallation(777, ALICE);
    const { kv } = makeKv();
    routeGitHub({});

    const result = await resolveGitHubToken(pat(kv), target(), logger);

    expect(result).toEqual({
      success: true,
      data: { token: "ghs_installation", expiresAt: IN_ONE_HOUR, source: "app" },
    });
  });

  it("refuses a caller the installation isn't linked to, and does not hand them the PAT", async () => {
    seedUser("usr_alice");
    seedUser("usr_mallory");
    seedInstallation(777, ALICE);
    const { kv } = makeKv();
    routeGitHub({});

    const result = await resolveGitHubToken(
      pat(kv),
      target({ type: "user", id: "usr_mallory" }),
      logger,
    );

    expect(refusedByApp(result)).toBe(true);
    expect(tokenCalls()).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      "GitHub App installation not authorized for this caller",
      expect.objectContaining({ installationId: 777, reason: "not_linked" }),
    );
  });

  it("another user's import of the same repo gets neither the app token nor the PAT", async () => {
    seedUser("usr_alice");
    seedUser("usr_mallory");
    seedInstallation(777, ALICE);
    const { kv } = makeKv();
    routeGitHub({});
    // The operator bound acme to alice, not to whoever imports acme's repos.
    const env = pat(kv, { GITHUB_ALLOWED_OWNERS: "acme=user:usr_alice" });

    const mallory = await resolveGitHubToken(
      env,
      target({ type: "user", id: "usr_mallory" }),
      logger,
    );
    expect(refusedByApp(mallory)).toBe(true);

    const patOnly = await resolveGitHubToken(
      { STATE: kv, DB: db, GITHUB_TOKEN: "ghp_pat", GITHUB_ALLOWED_OWNERS: "acme=user:usr_alice" },
      target({ type: "user", id: "usr_mallory" }),
      logger,
    );
    expect(!patOnly.success && patOnly.error.code).toBe("GITHUB_NOT_AUTHORIZED");
    expect(tokenCalls()).toHaveLength(0);
  });

  it("does not use an installation that is recorded but linked to nobody", async () => {
    seedInstallation(777);
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(pat(kv), target(), logger);
    expect(refusedByApp(result)).toBe(true);
    expect(tokenCalls()).toHaveLength(0);
  });

  it("does not match a user principal against an org link with the same id", async () => {
    seedInstallation(777, { type: "org", id: "usr_alice" });
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(pat(kv), target(), logger);
    expect(refusedByApp(result)).toBe(true);
  });

  it("uses an org-linked installation for that org's projects", async () => {
    seedInstallation(777, { type: "org", id: "org_acme" });
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(
      pat(kv),
      target({ type: "org", id: "org_acme" }),
      logger,
    );
    expect(result.success && result.data.source).toBe("app");
  });

  it("matches an agent-owned project through the agent's owner", async () => {
    seedUser("usr_alice");
    raw
      .prepare("INSERT INTO agents (id, name, owner_id, token_hash) VALUES ('agt_1', 'a', ?, 'h')")
      .run("usr_alice");
    seedInstallation(777, ALICE);
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(
      pat(kv),
      target({ type: "agent", id: "agt_1" }),
      logger,
    );
    expect(result.success && result.data.source).toBe("app");
  });

  it("does not use a suspended installation", async () => {
    seedInstallation(777, ALICE, { suspended: true });
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(pat(kv), target(), logger);
    expect(refusedByApp(result)).toBe(true);
    expect(tokenCalls()).toHaveLength(0);
  });

  it("refuses a call with no principal, even for a bound owner", async () => {
    seedUser("usr_alice");
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(
      pat(kv, { GITHUB_ALLOWED_OWNERS: "acme=user:usr_alice" }),
      target(null),
      logger,
    );
    expect(refusedByApp(result)).toBe(true);
  });

  it("admits an agent through its owner's binding", async () => {
    seedUser("usr_alice");
    raw
      .prepare("INSERT INTO agents (id, name, owner_id, token_hash) VALUES ('agt_1', 'a', ?, 'h')")
      .run("usr_alice");
    const { kv } = makeKv({ "github_installation:acme/api": "none" });
    const result = await resolveGitHubToken(
      pat(kv, { GITHUB_ALLOWED_OWNERS: "acme=user:usr_alice" }),
      target({ type: "agent", id: "agt_1" }),
      logger,
    );
    expect(result.success && result.data.source).toBe("pat");
  });

  it("fails closed when the link check errors: no app token and no PAT", async () => {
    const { kv } = makeKv();
    routeGitHub({});
    const brokenDb = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;
    const result = await resolveGitHubToken(pat(kv, { DB: brokenDb }), target(), logger);
    expect(refusedByApp(result)).toBe(true);
    expect(tokenCalls()).toHaveLength(0);
  });

  it("uses GITHUB_TOKEN when the app isn't installed, only for a bound owner", async () => {
    seedUser("usr_alice");
    const { kv } = makeKv({ "github_installation:acme/api": "none" });

    const unbound = await resolveGitHubToken(pat(kv), target(), logger);
    expect(!unbound.success && unbound.error.code).toBe("GITHUB_NOT_AUTHORIZED");

    const result = await resolveGitHubToken(
      pat(kv, { GITHUB_ALLOWED_OWNERS: "acme=user:usr_alice" }),
      target(),
      logger,
    );
    expect(result).toEqual({ success: true, data: { token: "ghp_pat", source: "pat" } });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses GITHUB_TOKEN, with a warning, when the app path errors, for a bound owner", async () => {
    seedUser("usr_alice");
    const { kv } = makeKv();
    routeGitHub({ installation: jsonResponse(500, { message: "boom" }) });

    const result = await resolveGitHubToken(
      pat(kv, { GITHUB_ALLOWED_OWNERS: "acme=user:usr_alice" }),
      target(),
      logger,
    );

    expect(result).toEqual({ success: true, data: { token: "ghp_pat", source: "pat" } });
    expect(logger.warn).toHaveBeenCalledWith(
      "GitHub App token unavailable",
      expect.objectContaining({ owner: "acme", repo: "api" }),
    );
  });

  it("uses GITHUB_TOKEN without touching GitHub or KV when the app isn't configured", async () => {
    seedUser("usr_alice");
    const { kv } = makeKv();
    const result = await resolveGitHubToken(
      { STATE: kv, DB: db, GITHUB_TOKEN: "ghp_pat", GITHUB_ALLOWED_OWNERS: "acme=user:usr_alice" },
      target(),
      logger,
    );
    expect(result).toEqual({ success: true, data: { token: "ghp_pat", source: "pat" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("returns 'not configured' when neither credential is available", async () => {
    const { kv } = makeKv();
    const result = await resolveGitHubToken({ STATE: kv, DB: db }, target(), logger);
    expect(!result.success && result.error.message).toBe("GitHub integration is not configured");
  });

  it("never logs a token", async () => {
    seedInstallation(777, ALICE);
    const { kv } = makeKv();
    routeGitHub({});
    await resolveGitHubToken(pat(kv), target(), logger);

    const logged = JSON.stringify(
      [logger.debug, logger.info, logger.warn, logger.error].map(
        (fn) => (fn as ReturnType<typeof vi.fn>).mock.calls,
      ),
    );
    expect(logged).not.toContain("ghs_installation");
    expect(logged).not.toContain("ghp_pat");
  });
});

describe("canonical target for writes", () => {
  const PROJECT_A = { id: "prj_a", namespace: "@alice", slug: "api" };
  const PROJECT_B = { id: "prj_b", namespace: "@alice", slug: "api-copy" };

  it("lets the first authorized project claim the repo and refuses a second", async () => {
    seedUser("usr_alice");
    seedInstallation(777, ALICE);
    const { kv } = makeKv();
    kv.put(
      "project:@alice:api",
      JSON.stringify({
        ...PROJECT_A,
        name: "api",
        ownerId: "usr_alice",
        ownerType: "user",
        createdAt: "2026-01-01",
        sourceUrl: "https://github.com/acme/api",
      }),
    );
    routeGitHub({});
    const env = appEnv(kv);

    const first = await resolveGitHubToken(env, { ...target(), project: PROJECT_A }, logger);
    expect(first.success && first.data.source).toBe("app");

    const second = await resolveGitHubToken(env, { ...target(), project: PROJECT_B }, logger);
    expect(!second.success && second.error.code).toBe("GITHUB_REPO_NOT_CANONICAL");

    const row = raw.prepare("SELECT project_id FROM github_repo_links").get() as {
      project_id: string;
    };
    expect(row.project_id).toBe("prj_a");
  });

  it("never lets an unauthorized project claim the repo", async () => {
    seedUser("usr_alice");
    seedUser("usr_mallory");
    seedInstallation(777, ALICE);
    const { kv } = makeKv();
    routeGitHub({});
    const result = await resolveGitHubToken(
      appEnv(kv),
      {
        ...target({ type: "user", id: "usr_mallory" }),
        project: { id: "prj_m", namespace: "@mallory", slug: "api" },
      },
      logger,
    );
    expect(!result.success && result.error.code).toBe("GITHUB_APP_NOT_AUTHORIZED");
    const count = raw.prepare("SELECT COUNT(*) AS n FROM github_repo_links").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});

describe("resolveAuthConfig", () => {
  it("uses the installation token for GitHub when the installation serves the principal", async () => {
    seedInstallation(777, ALICE);
    const { kv } = makeKv();
    routeGitHub({});
    const auth = await resolveAuthConfig(
      "github",
      { owner: "acme", repo: "api" },
      ALICE,
      appEnv(kv, { GITHUB_TOKEN: "ghp_pat" }),
      logger,
    );
    expect(auth).toEqual({ token: "ghs_installation" });
  });

  it("keeps static credentials for other providers", async () => {
    const auth = await resolveAuthConfig(
      "gitlab",
      { owner: "acme", repo: "api" },
      ALICE,
      { GITLAB_TOKEN: "glpat" },
      logger,
    );
    expect(auth).toEqual({ token: "glpat" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined (unauthenticated) when GitHub has no credential", async () => {
    const { kv } = makeKv();
    const auth = await resolveAuthConfig(
      "github",
      { owner: "acme", repo: "api" },
      ALICE,
      { STATE: kv, DB: db },
      logger,
    );
    expect(auth).toBeUndefined();
  });
});

describe("installation webhooks", () => {
  const installationRow = (id: number) =>
    raw.prepare("SELECT * FROM github_app_installations WHERE installation_id = ?").get(id) as
      | Record<string, unknown>
      | undefined;

  const event = (action: string, extra: Record<string, unknown> = {}) => ({
    action,
    installation: { id: 777, account: { login: "acme", id: 99, type: "Organization" } },
    sender: { id: 4242, login: "octo" },
    ...extra,
  });

  it("records the installer from installation.created only", async () => {
    const { kv } = makeKv();
    await handleInstallationChange({ STATE: kv, DB: db }, "installation", event("created"), logger);
    expect(installationRow(777)).toMatchObject({
      account_login: "acme",
      account_id: "99",
      account_type: "Organization",
      installer_github_id: "4242",
      stratum_owner_id: null,
    });

    // A later event's sender changed the repo selection; it is not the installer.
    await handleInstallationChange(
      { STATE: kv, DB: db },
      "installation_repositories",
      event("added", { sender: { id: 1 }, repositories_added: [{ full_name: "acme/new" }] }),
      logger,
    );
    expect(installationRow(777)?.installer_github_id).toBe("4242");
  });

  it("does not take an installer from installation_repositories", async () => {
    const { kv } = makeKv();
    await handleInstallationChange(
      { STATE: kv, DB: db },
      "installation_repositories",
      event("added"),
      logger,
    );
    expect(installationRow(777)?.installer_github_id).toBeNull();
  });

  it("suspends, unsuspends, and forgets on delete", async () => {
    const { kv } = makeKv();
    const env = { STATE: kv, DB: db };
    await handleInstallationChange(env, "installation", event("created"), logger);
    await handleInstallationChange(env, "installation", event("suspend"), logger);
    expect(installationRow(777)?.suspended_at).not.toBeNull();
    await handleInstallationChange(env, "installation", event("unsuspend"), logger);
    expect(installationRow(777)?.suspended_at).toBeNull();
    await handleInstallationChange(env, "installation", event("deleted"), logger);
    expect(installationRow(777)).toBeUndefined();
  });

  it("invalidates the KV caches for the named repos and the installation token", async () => {
    const { kv, store } = makeKv({
      "github_installation:acme/added": "none",
      "github_installation:acme/removed": "777",
      "github_installation:other/keep": "1",
      "github_inst_token:777": "{}",
    });

    await handleInstallationChange(
      { STATE: kv, DB: db },
      "installation_repositories",
      event("added", {
        repositories_added: [{ full_name: "Acme/Added" }],
        repositories_removed: [{ full_name: "acme/removed" }, { not: "a repo" }],
      }),
      logger,
    );

    expect([...store.keys()]).toEqual(["github_installation:other/keep"]);
  });

  it("still invalidates the caches when the D1 write fails", async () => {
    const { kv, store } = makeKv({ "github_installation:acme/removed": "777" });
    const brokenDb = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;

    await expect(
      handleInstallationChange(
        { STATE: kv, DB: brokenDb },
        "installation_repositories",
        event("removed", { repositories_removed: [{ full_name: "acme/removed" }] }),
        logger,
      ),
    ).rejects.toBeDefined();

    expect(store.has("github_installation:acme/removed")).toBe(false);
  });

  it("invalidateInstallationCache is a no-op for malformed names", async () => {
    const { kv, store } = makeKv({ "github_installation:a/b": "1" });
    await invalidateInstallationCache(kv, { repoFullNames: ["nonsense"] });
    expect(store.size).toBe(1);
  });
});
