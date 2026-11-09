import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CurrentGitHubAccess,
  checkInstallationAccess,
  exchangeGitHubAppCode,
  fetchCurrentGitHubAccess,
  githubAppCallbackUrl,
  githubAppOAuthConfig,
  revokeGitHubAppUserToken,
} from "../src/github/user-access";
import {
  ACCESS_SNAPSHOT_MAX_INSTALLATIONS,
  consumeLinkState,
  issueLinkState,
  purgeExpiredLinkStates,
  replaceAccessSnapshot,
} from "../src/storage/github-app-link-states";
import { createLogger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

/**
 * The corners of the current-access check (#442) that the whole-Worker suite
 * (`github-app-link-current-access.test.ts`) cannot reach through a
 * well-behaved GitHub: a network that fails, bodies that are not what the API
 * documents, and an upstream that never stops paging. In every one the answer
 * must be an error or a refusal, never a link.
 */

const logger = createLogger({ component: "Test" });
const CONFIG = { clientId: "Iv1.unit", clientSecret: "unit-secret" };
const TOKEN = "ghu_unit";

type Answer = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const originalFetch = globalThis.fetch;
let requests: string[];

function answerWith(answer: Answer): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return answer(url, init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  requests = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("githubAppOAuthConfig", () => {
  it("is null unless both credentials are present and non-blank", () => {
    expect(githubAppOAuthConfig({})).toBeNull();
    expect(githubAppOAuthConfig({ GITHUB_APP_CLIENT_ID: "id" })).toBeNull();
    expect(githubAppOAuthConfig({ GITHUB_APP_CLIENT_SECRET: "secret" })).toBeNull();
    expect(
      githubAppOAuthConfig({ GITHUB_APP_CLIENT_ID: "  ", GITHUB_APP_CLIENT_SECRET: "secret" }),
    ).toBeNull();
    expect(
      githubAppOAuthConfig({ GITHUB_APP_CLIENT_ID: " id\n", GITHUB_APP_CLIENT_SECRET: "secret " }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });
});

describe("githubAppCallbackUrl", () => {
  const request = "https://preview.example/github/app/setup?installation_id=1";

  it("uses the request's origin when APP_URL is absent, empty, or not a URL", () => {
    for (const APP_URL of [undefined, "", "not a url"]) {
      expect(githubAppCallbackUrl({ ...(APP_URL !== undefined ? { APP_URL } : {}) }, request)).toBe(
        "https://preview.example/github/app/callback",
      );
    }
  });

  it("uses APP_URL's origin, ignoring any path on it", () => {
    expect(githubAppCallbackUrl({ APP_URL: "https://app.example/some/path" }, request)).toBe(
      "https://app.example/github/app/callback",
    );
  });
});

describe("exchangeGitHubAppCode", () => {
  const exchange = () =>
    exchangeGitHubAppCode(CONFIG, "the-code", "https://app.example/github/app/callback", logger);

  it("is an error value, carrying no credential, when the request cannot be made", async () => {
    answerWith(() => {
      throw new TypeError("network down");
    });
    const result = await exchange();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).not.toContain(CONFIG.clientSecret);
    expect(result.error.message).not.toContain("the-code");
  });

  it("is an error when the answer is not JSON, or names no token", async () => {
    for (const body of ["<html>rate limited</html>", "[]", "{}", '{"access_token":""}']) {
      answerWith(() => new Response(body, { status: 200 }));
      expect((await exchange()).success).toBe(false);
    }
  });

  it("sends the code, the redirect URI and the app's credentials, and returns the token", async () => {
    let sent: unknown;
    answerWith((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return json({ access_token: TOKEN });
    });
    expect(await exchange()).toEqual({ success: true, data: TOKEN });
    expect(sent).toEqual({
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
      code: "the-code",
      redirect_uri: "https://app.example/github/app/callback",
    });
  });
});

describe("fetchCurrentGitHubAccess", () => {
  const installation = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    account: { id: 99, login: "acme", type: "Organization" },
    ...extra,
  });

  it("is an error when either question cannot be asked", async () => {
    answerWith((url) => {
      if (url.pathname === "/user") throw new TypeError("network down");
      return json({ installations: [] });
    });
    expect((await fetchCurrentGitHubAccess(TOKEN, logger)).success).toBe(false);

    answerWith((url) => {
      if (url.pathname === "/user") return json({ id: 1 });
      throw new TypeError("network down");
    });
    expect((await fetchCurrentGitHubAccess(TOKEN, logger)).success).toBe(false);
  });

  it("is an error when GitHub does not say who the token belongs to", async () => {
    for (const user of [{}, { id: "1" }, null, []]) {
      answerWith((url) => (url.pathname === "/user" ? json(user) : json({ installations: [] })));
      expect((await fetchCurrentGitHubAccess(TOKEN, logger)).success).toBe(false);
    }
  });

  it("is an error, not an empty list, when the installation list is unreadable", async () => {
    for (const list of [{}, { installations: "none" }, [], null]) {
      answerWith((url) => (url.pathname === "/user" ? json({ id: 1 }) : json(list)));
      expect((await fetchCurrentGitHubAccess(TOKEN, logger)).success).toBe(false);
    }
  });

  it("skips entries it cannot read, and takes target_type over account.type", async () => {
    answerWith((url) =>
      url.pathname === "/user"
        ? json({ id: 1 })
        : json({
            installations: [
              installation(10),
              installation(11, { target_type: "Enterprise" }),
              { id: "12", account: { id: 99, login: "acme", type: "Organization" } },
              { id: 13 },
              { id: 14, account: { id: "99", login: "acme", type: "Organization" } },
              { id: 15, account: { id: 99, login: "acme" } },
              "garbage",
            ],
          }),
    );
    const result = await fetchCurrentGitHubAccess(TOKEN, logger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.githubUserId).toBe("1");
    expect([...result.data.installations.keys()]).toEqual([10, 11]);
    expect(result.data.installations.get(10)?.accountType).toBe("Organization");
    expect(result.data.installations.get(11)?.accountType).toBe("Enterprise");
  });

  it("stops following an upstream that always claims another page", async () => {
    answerWith((url) =>
      url.pathname === "/user"
        ? json({ id: 1 })
        : json({ installations: [installation(Number(url.searchParams.get("page")))] }, 200, {
            // A hostile target too: the next page is built here, never read from this.
            Link: '<https://evil.example/steal>; rel="next"',
          }),
    );
    const result = await fetchCurrentGitHubAccess(TOKEN, logger);
    expect(result.success).toBe(true);
    const pages = requests.filter((r) => r.startsWith("GET /user/installations"));
    expect(pages).toHaveLength(10);
    expect(pages.at(-1)).toBe("GET /user/installations?per_page=100&page=10");
  });

  it("stops at an empty page even when told there is more", async () => {
    answerWith((url) =>
      url.pathname === "/user"
        ? json({ id: 1 })
        : json({ installations: [] }, 200, { Link: '<https://api.github.com/x>; rel="next"' }),
    );
    expect((await fetchCurrentGitHubAccess(TOKEN, logger)).success).toBe(true);
    expect(requests.filter((r) => r.startsWith("GET /user/installations"))).toHaveLength(1);
  });
});

describe("checkInstallationAccess", () => {
  const access = (
    accountId: string,
    accountType: string,
    githubUserId = "1",
  ): CurrentGitHubAccess => ({
    githubUserId,
    installations: new Map([
      [777, { installationId: 777, accountId, accountLogin: "acme", accountType }],
    ]),
  });
  const recorded = { installationId: 777, accountId: "99" };

  it("does not trust a listing that is on a different account than the one recorded", async () => {
    answerWith(() => json({ state: "active", role: "admin", organization: { id: 55 } }));
    const verdict = await checkInstallationAccess(
      TOKEN,
      access("55", "Organization"),
      recorded,
      logger,
    );
    expect(verdict).toEqual({ success: true, data: "not_listed" });
    // Refused on the record alone; GitHub is not even asked about membership.
    expect(requests).toEqual([]);
  });

  it("is an error, not a refusal or an approval, when the membership cannot be read", async () => {
    answerWith(() => json({ message: "Server Error" }, 500));
    const failed = await checkInstallationAccess(
      TOKEN,
      access("99", "Organization"),
      recorded,
      logger,
    );
    expect(failed.success).toBe(false);

    answerWith(() => {
      throw new TypeError("network down");
    });
    const unreachable = await checkInstallationAccess(
      TOKEN,
      access("99", "Organization"),
      recorded,
      logger,
    );
    expect(unreachable.success).toBe(false);
  });

  it("refuses a membership answer that is not the documented shape", async () => {
    for (const body of [null, [], {}, { state: "active", role: "admin" }, "admin"]) {
      answerWith(() => json(body));
      const verdict = await checkInstallationAccess(
        TOKEN,
        access("99", "Organization"),
        recorded,
        logger,
      );
      expect(verdict).toEqual({ success: true, data: "not_manager" });
    }
  });

  it("asks about the org by its login, escaped", async () => {
    answerWith(() => json({ state: "active", role: "admin", organization: { id: 99 } }));
    const odd: CurrentGitHubAccess = {
      githubUserId: "1",
      installations: new Map([
        [
          777,
          {
            installationId: 777,
            accountId: "99",
            accountLogin: "a/../b?x",
            accountType: "Organization",
          },
        ],
      ]),
    };
    expect(await checkInstallationAccess(TOKEN, odd, recorded, logger)).toEqual({
      success: true,
      data: "allowed",
    });
    expect(requests).toEqual(["GET /user/memberships/orgs/a%2F..%2Fb%3Fx"]);
  });
});

describe("revokeGitHubAppUserToken", () => {
  it("never throws: a token left unrevoked must not fail the request that used it", async () => {
    answerWith(() => {
      throw new TypeError("network down");
    });
    await expect(revokeGitHubAppUserToken(CONFIG, TOKEN, logger)).resolves.toBeUndefined();

    answerWith(() => json({ message: "Server Error" }, 500));
    await expect(revokeGitHubAppUserToken(CONFIG, TOKEN, logger)).resolves.toBeUndefined();
    expect(requests).toEqual([
      "DELETE /applications/Iv1.unit/token",
      "DELETE /applications/Iv1.unit/token",
    ]);
  });
});

describe("link state storage", () => {
  type Raw = ReturnType<typeof makeSqliteD1>["raw"];
  let raw: Raw;
  let db: ReturnType<typeof makeSqliteD1>["db"];
  const count = (table: string) =>
    (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(() => {
    const sqlite = makeSqliteD1();
    raw = sqlite.raw;
    db = sqlite.db;
  });

  it("purges only what has expired, from both tables", async () => {
    const live = await issueLinkState(db, "session-a", { userId: "usr_a" }, logger);
    const stale = await issueLinkState(db, "session-b", { userId: "usr_b" }, logger);
    expect(live.success && stale.success).toBe(true);
    await replaceAccessSnapshot(db, "session-a", [1, 2], logger);
    await replaceAccessSnapshot(db, "session-b", [3], logger);
    raw.prepare("UPDATE github_app_link_states SET expires_at = 1 WHERE user_id = 'usr_b'").run();
    raw
      .prepare("UPDATE github_app_access_snapshots SET expires_at = 1 WHERE session_hash = ?")
      .run("session-b");

    expect(await purgeExpiredLinkStates(db, logger)).toEqual({ success: true, data: 2 });
    expect(count("github_app_link_states")).toBe(1);
    expect(count("github_app_access_snapshots")).toBe(2);
    expect(await purgeExpiredLinkStates(db, logger)).toEqual({ success: true, data: 0 });

    // The survivor still redeems for the session it was issued to.
    if (!live.success) return;
    expect(await consumeLinkState(db, live.data, "session-a", "usr_a", logger)).toEqual({
      success: true,
      data: { userId: "usr_a" },
    });
  });

  it("replaces a session's snapshot rather than adding to it, deduplicated and capped", async () => {
    await replaceAccessSnapshot(db, "session-a", [1, 2, 3], logger);
    await replaceAccessSnapshot(db, "session-a", [7, 7, 8], logger);
    expect(
      raw
        .prepare(
          "SELECT installation_id FROM github_app_access_snapshots WHERE session_hash = ? ORDER BY 1",
        )
        .all("session-a"),
    ).toEqual([{ installation_id: 7 }, { installation_id: 8 }]);

    const many = Array.from({ length: ACCESS_SNAPSHOT_MAX_INSTALLATIONS + 20 }, (_, i) => i + 1);
    expect((await replaceAccessSnapshot(db, "session-a", many, logger)).success).toBe(true);
    expect(count("github_app_access_snapshots")).toBe(ACCESS_SNAPSHOT_MAX_INSTALLATIONS);

    await replaceAccessSnapshot(db, "session-a", [], logger);
    expect(count("github_app_access_snapshots")).toBe(0);
  });

  it("answers a database failure as an error value", async () => {
    raw.exec("DROP TABLE github_app_link_states; DROP TABLE github_app_access_snapshots;");
    expect((await issueLinkState(db, "s", { userId: "u" }, logger)).success).toBe(false);
    expect((await consumeLinkState(db, "state", "s", "u", logger)).success).toBe(false);
    expect((await replaceAccessSnapshot(db, "s", [1], logger)).success).toBe(false);
    expect((await purgeExpiredLinkStates(db, logger)).success).toBe(false);
  });
});
