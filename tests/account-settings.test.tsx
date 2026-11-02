/**
 * The Account section of `/settings`, which absorbed the old `/profile` page:
 * identity, the caller's own invite codes, and the two things about an account
 * that can change — the display name (any time) and the username (only while
 * the account owns no projects, since every project is keyed under it).
 *
 * `vitest.config.ts` restricts coverage to `src/**\/*.ts`, so the `.tsx` route
 * and page contribute nothing to the ratchet — these assertions are the only
 * thing policing them.
 */
import { Hono } from "hono";
import { renderToString } from "hono/jsx/dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { InviteCodesCard } from "../src/ui/pages/invite-codes";

vi.mock("../src/storage/users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/users")>()),
  getUser: vi.fn(),
  rotateUserToken: vi.fn(),
  disableLegacyToken: vi.fn(),
  setUserTelemetryOptOut: vi.fn(),
  setUserDisplayName: vi.fn(),
  renameUser: vi.fn(),
}));
vi.mock("../src/storage/agents", () => ({
  listAgents: vi.fn(async () => ({ success: true, data: [] })),
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getAgent: vi.fn(),
}));
vi.mock("../src/storage/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/state")>()),
  listProjectsByNamespace: vi.fn(),
}));
vi.mock("../src/storage/api-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/api-tokens")>()),
  listApiTokens: vi.fn(async () => ({ success: true, data: [] })),
}));
vi.mock("../src/storage/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/oauth")>()),
  listGrantsForUser: vi.fn(async () => ({ success: true, data: [] })),
}));
vi.mock("../src/storage/audit", () => ({
  recordAudit: vi.fn(async () => ({ success: true, data: undefined })),
}));
vi.mock("../src/storage/project-namespace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/project-namespace")>()),
  ownerHasClaims: vi.fn(),
}));

import { uiRouter } from "../src/routes/ui";
import { recordAudit } from "../src/storage/audit";
import { ownerHasClaims } from "../src/storage/project-namespace";
import { listProjectsByNamespace } from "../src/storage/state";
import { getUser, renameUser, setUserDisplayName } from "../src/storage/users";

const liveUser = {
  id: "usr_1",
  email: "a@b.com",
  username: "alice",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const noProjects = { success: true as const, data: [] };
const oneProject = { success: true as const, data: [{ id: "prj_1" }] as never };
const noClaims = { success: true as const, data: false };
const hasClaims = { success: true as const, data: true };
const claimsUnreadable = { success: false as const, error: new Error("d1 down") as never };

/** Bindings the settings routes touch; every store they read is mocked at module level. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
    ...overrides,
  } as Env;
}

// `null`, not `undefined`, marks the anonymous case: `undefined` would trigger
// the default parameter and silently authenticate the request.
function makeApp(userId: string | null = "usr_1", via: "session" | "token" = "session") {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (userId) {
      c.set("userId", userId);
      c.set("authVia", via);
    }
    await next();
  });
  app.route("/", uiRouter);
  return app;
}

const get = (path = "/settings") => new Request(`http://localhost${path}`);

/** A form submission, as the browser sends it. */
function post(path: string, fields: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

/** The referral service answering with `codes`. */
function codesResponse(codes: unknown[]): Response {
  return new Response(JSON.stringify({ codes }), { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });
  vi.mocked(ownerHasClaims).mockResolvedValue(noClaims);
  vi.mocked(listProjectsByNamespace).mockResolvedValue(noProjects);
});

describe("GET /profile", () => {
  it("redirects to the Account section of settings", async () => {
    const res = await makeApp().fetch(get("/profile"), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings#account");
  });
});

describe("GET /settings: account", () => {
  it("sends an anonymous visitor to sign in", async () => {
    const res = await makeApp(null).fetch(get(), makeEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/email");
  });

  // Same rule as before (#254): the page lists shareable codes and mints
  // credentials, so a leaked read-only API token must not reach it.
  it("refuses an API-token caller", async () => {
    const res = await makeApp("usr_1", "token").fetch(get(), makeEnv());
    expect(res.status).toBe(403);
  });

  it("shows account identity with a written-month date", async () => {
    const res = await makeApp().fetch(get(), makeEnv());
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("@alice");
    expect(html).toContain("a@b.com");
    expect(html).toContain("Member since");
    expect(html).toContain("Jan 1, 2026");
  });

  it("marks the settings link as the current page and drops the profile link", async () => {
    const html = await (await makeApp().fetch(get(), makeEnv())).text();
    // Matched loosely across the attributes between them: pinning the exact
    // rendered attribute string makes an unrelated addition to the link (the
    // analytics `data-ph`, say) fail a test about the current-page marker.
    expect(html).toMatch(/href="\/settings"[^>]*aria-current="page"/);
    expect(html).not.toContain('href="/profile"');
  });

  it("shows the display name in the header when one is set", async () => {
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { ...liveUser, displayName: "Alice Liddell" },
    });
    const html = await (await makeApp().fetch(get(), makeEnv())).text();
    expect(html).toContain('title="@alice">Alice Liddell<');
    expect(html).toContain('value="Alice Liddell"');
  });

  it("offers the username form only while the account owns no projects", async () => {
    const withNone = await (await makeApp().fetch(get(), makeEnv())).text();
    expect(withNone).toContain('action="/settings/username"');
    expect(withNone).toContain("while you own no projects");

    // The claims table is the strongly consistent record of every project
    // created since it existed; a claim alone withholds the form.
    vi.mocked(ownerHasClaims).mockResolvedValue(hasClaims);
    const withClaim = await (await makeApp().fetch(get(), makeEnv())).text();
    expect(withClaim).not.toContain('action="/settings/username"');
    expect(withClaim).toContain("cannot be changed while you own projects");
    expect(listProjectsByNamespace).toHaveBeenCalledTimes(1);

    // Projects that predate the table have no claim; the KV listing finds them.
    vi.mocked(ownerHasClaims).mockResolvedValue(noClaims);
    vi.mocked(listProjectsByNamespace).mockResolvedValue(oneProject);
    const withOne = await (await makeApp().fetch(get(), makeEnv())).text();
    expect(withOne).not.toContain('action="/settings/username"');
  });

  // Fail closed: a store that could not be read is not evidence of no projects.
  // But it is not evidence of projects either, so the page asks for a retry
  // rather than telling the reader to delete something.
  it("withholds the username form when the claims or the project listing cannot be read", async () => {
    vi.mocked(ownerHasClaims).mockResolvedValue(claimsUnreadable);
    const noClaimsRead = await (await makeApp().fetch(get(), makeEnv())).text();
    expect(noClaimsRead).not.toContain('action="/settings/username"');
    expect(noClaimsRead).toContain("could not be confirmed just now");
    expect(noClaimsRead).not.toContain("cannot be changed while you own projects");

    vi.mocked(ownerHasClaims).mockResolvedValue(noClaims);
    vi.mocked(listProjectsByNamespace).mockResolvedValue({
      success: false,
      error: new Error("kv down") as never,
    });
    const noListing = await (await makeApp().fetch(get(), makeEnv())).text();
    expect(noListing).not.toContain('action="/settings/username"');
    expect(noListing).toContain("could not be confirmed just now");
  });

  it("omits the invite section entirely when no referral service is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = await (await makeApp().fetch(get(), makeEnv())).text();
    expect(html).not.toContain("Invite codes");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists codes with share links and redemption status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      codesResponse([
        { code: "AAA111" },
        { code: "BBB222", redeemedAt: "2026-02-03T00:00:00Z", redeemedBy: "bob" },
      ]),
    );
    const html = await (
      await makeApp().fetch(get(), makeEnv({ REFERRAL_SERVICE_URL: "https://ref.example" }))
    ).text();

    expect(html).toContain("AAA111");
    expect(html).toContain("https://ref.example/?ref=AAA111");
    expect(html).toContain("Available");
    expect(html).toContain("bob");
    expect(html).toContain("1 of 2 codes are still available");
  });

  // The gate being off does not retract codes already minted: production runs
  // BETA_GATE = "0" with the service still configured, and those users' codes
  // must remain visible to them.
  it("lists codes even when the beta gate is switched off", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(codesResponse(["AAA111"]));
    const html = await (
      await makeApp().fetch(
        get(),
        makeEnv({ BETA_GATE: "0", REFERRAL_SERVICE_URL: "https://ref.example" }),
      )
    ).text();
    expect(html).toContain("AAA111");
  });

  it("says 'no codes' only when the service actually answered with none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(codesResponse([]));
    const html = await (
      await makeApp().fetch(get(), makeEnv({ REFERRAL_SERVICE_URL: "https://ref.example" }))
    ).text();
    expect(html).toContain("You have no invite codes");
    expect(html).not.toContain("could not be loaded right now");
  });

  it("says the codes could not be loaded — not that there are none — on an outage", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const res = await makeApp().fetch(
      get(),
      makeEnv({ REFERRAL_SERVICE_URL: "https://ref.example" }),
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("could not be loaded right now");
    expect(html).toContain("have not been lost");
    expect(html).not.toContain("You have no invite codes");
    expect(html).toContain("@alice");
  });
});

describe("POST /settings/account (display name)", () => {
  it("refuses an API-token caller", async () => {
    const res = await makeApp("usr_1", "token").fetch(
      post("/settings/account", { displayName: "x" }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(setUserDisplayName).not.toHaveBeenCalled();
  });

  it("saves a trimmed, whitespace-collapsed name and records it", async () => {
    vi.mocked(setUserDisplayName).mockResolvedValue({ success: true, data: undefined });
    const res = await makeApp().fetch(
      post("/settings/account", { displayName: "  Alice \n  Liddell\t" }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings?notice=display-name-saved#account");
    expect(setUserDisplayName).toHaveBeenCalledWith(
      expect.anything(),
      "usr_1",
      "Alice Liddell",
      expect.anything(),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "user.display_name_changed", actorId: "usr_1" }),
    );
  });

  it("clears the name when the field is blank", async () => {
    vi.mocked(setUserDisplayName).mockResolvedValue({ success: true, data: undefined });
    await makeApp().fetch(post("/settings/account", { displayName: "   " }), makeEnv());
    expect(setUserDisplayName).toHaveBeenCalledWith(
      expect.anything(),
      "usr_1",
      null,
      expect.anything(),
    );
  });

  it("rejects a name over the limit without saving", async () => {
    const res = await makeApp().fetch(
      post("/settings/account", { displayName: "x".repeat(61) }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at most 60 characters");
    expect(setUserDisplayName).not.toHaveBeenCalled();
  });

  it("shows the saved notice after the redirect", async () => {
    const html = await (
      await makeApp().fetch(get("/settings?notice=display-name-saved"), makeEnv())
    ).text();
    expect(html).toContain("Display name saved.");
  });
});

describe("POST /settings/username", () => {
  it("renames when the account owns no projects and records old and new names", async () => {
    vi.mocked(renameUser).mockResolvedValue({ success: true, data: "alice-two" });
    const res = await makeApp().fetch(
      post("/settings/username", { username: " Alice-Two " }),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings?notice=username-changed#account");
    // KV keys carry the "@": listing the bare username would find nothing and
    // wave every rename through.
    expect(listProjectsByNamespace).toHaveBeenCalledWith(
      expect.anything(),
      "@alice",
      expect.anything(),
    );
    expect(renameUser).toHaveBeenCalledWith(
      expect.anything(),
      "usr_1",
      "alice-two",
      expect.anything(),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: "user.renamed",
        detail: { from: "alice", to: "alice-two" },
      }),
    );
  });

  it("refuses the rename once the account has a namespace claim", async () => {
    vi.mocked(ownerHasClaims).mockResolvedValue(hasClaims);
    const res = await makeApp().fetch(
      post("/settings/username", { username: "alice-two" }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cannot be changed while you own projects");
    expect(listProjectsByNamespace).not.toHaveBeenCalled();
    expect(renameUser).not.toHaveBeenCalled();
  });

  it("refuses the rename when the KV listing finds a project that predates claims", async () => {
    vi.mocked(listProjectsByNamespace).mockResolvedValue(oneProject);
    const res = await makeApp().fetch(
      post("/settings/username", { username: "alice-two" }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cannot be changed while you own projects");
    expect(renameUser).not.toHaveBeenCalled();
  });

  it("fails closed when the claims cannot be read", async () => {
    vi.mocked(ownerHasClaims).mockResolvedValue(claimsUnreadable);
    const res = await makeApp().fetch(
      post("/settings/username", { username: "alice-two" }),
      makeEnv(),
    );
    expect(res.status).toBe(500);
    expect(renameUser).not.toHaveBeenCalled();
  });

  // The pre-check and the UPDATE are two D1 statements; a claim written between
  // them makes the UPDATE itself refuse, and that refusal is the user's answer,
  // not a server error.
  it("shows the refusal when a claim lands between the check and the update", async () => {
    vi.mocked(renameUser).mockResolvedValue({
      success: false,
      error: {
        statusCode: 403,
        message: "Your username cannot be changed while you own projects.",
      } as never,
    });
    const res = await makeApp().fetch(
      post("/settings/username", { username: "alice-two" }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cannot be changed while you own projects");
    expect(recordAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "user.renamed" }),
    );
  });

  // The ownership check and the rename span KV and D1 with nothing to serialize
  // them. A project created in that window is keyed under the old namespace, so
  // the route looks again after renaming and puts the name back if one appeared.
  it("reverts the rename when a project appears under the old namespace meanwhile", async () => {
    vi.mocked(listProjectsByNamespace)
      .mockResolvedValueOnce(noProjects)
      .mockResolvedValueOnce(oneProject);
    vi.mocked(renameUser)
      .mockResolvedValueOnce({ success: true, data: "alice-two" })
      .mockResolvedValueOnce({ success: true, data: "alice" });
    const res = await makeApp().fetch(
      post("/settings/username", { username: "alice-two" }),
      makeEnv(),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("the change was undone");
    expect(renameUser).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "usr_1",
      "alice",
      expect.anything(),
    );
    expect(recordAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "user.renamed" }),
    );
  });

  // An unreadable second listing proves nothing about the old namespace, so
  // the name is put back on caution and reported as our failure, not a 409
  // that would blame a project nobody has seen.
  it("reverts and reports a server error when the second listing cannot be read", async () => {
    vi.mocked(listProjectsByNamespace)
      .mockResolvedValueOnce(noProjects)
      .mockResolvedValueOnce({ success: false, error: new Error("kv down") as never });
    vi.mocked(renameUser).mockResolvedValue({ success: true, data: "alice-two" });
    const res = await makeApp().fetch(
      post("/settings/username", { username: "alice-two" }),
      makeEnv(),
    );
    expect(res.status).toBe(500);
    expect(renameUser).toHaveBeenCalledTimes(2);
    expect(renameUser).toHaveBeenLastCalledWith(
      expect.anything(),
      "usr_1",
      "alice",
      expect.anything(),
    );
  });

  it("fails closed when the project listing cannot be read", async () => {
    vi.mocked(listProjectsByNamespace).mockResolvedValue({
      success: false,
      error: new Error("kv down") as never,
    });
    const res = await makeApp().fetch(
      post("/settings/username", { username: "alice-two" }),
      makeEnv(),
    );
    expect(res.status).toBe(500);
    expect(renameUser).not.toHaveBeenCalled();
  });

  it("does nothing when the name is unchanged", async () => {
    const res = await makeApp().fetch(post("/settings/username", { username: "ALICE" }), makeEnv());
    expect(res.status).toBe(302);
    expect(listProjectsByNamespace).not.toHaveBeenCalled();
    expect(renameUser).not.toHaveBeenCalled();
  });

  it("shows a taken or invalid name as the user's error, with the form intact", async () => {
    vi.mocked(renameUser).mockResolvedValue({
      success: false,
      error: { statusCode: 409, message: "That username is already taken." } as never,
    });
    const res = await makeApp().fetch(post("/settings/username", { username: "bob" }), makeEnv());
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("already taken");
    expect(html).toContain('action="/settings/username"');
  });

  it("refuses an API-token caller", async () => {
    const res = await makeApp("usr_1", "token").fetch(
      post("/settings/username", { username: "bob" }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(renameUser).not.toHaveBeenCalled();
  });
});

describe("InviteCodesCard rendering", () => {
  it("offers a copy button only for codes that are still available", () => {
    const html = renderToString(
      <InviteCodesCard
        invites={{
          status: "ok",
          codes: [
            { code: "AAA111", redeemedAt: null, redeemedBy: null },
            { code: "BBB222", redeemedAt: "2026-02-03T00:00:00Z", redeemedBy: "bob" },
          ],
        }}
        shareBaseUrl="https://ref.example"
        nonce="n1"
      />,
    );
    expect([...html.matchAll(/data-copy-target=/g)]).toHaveLength(1);
  });

  it("shows the bare code when there is no share origin to build a link from", () => {
    const html = renderToString(
      <InviteCodesCard
        invites={{ status: "ok", codes: [{ code: "AAA111", redeemedAt: null, redeemedBy: null }] }}
        nonce="n1"
      />,
    );
    expect(html).toContain("AAA111");
    expect(html).not.toContain("?ref=");
  });

  // #161: with `script-src 'nonce-…'`, an un-nonced script and any inline
  // handler are both blocked outright.
  it("carries the CSP nonce on its script and uses no inline handlers", () => {
    const html = renderToString(
      <InviteCodesCard
        invites={{ status: "ok", codes: [{ code: "AAA111", redeemedAt: null, redeemedBy: null }] }}
        shareBaseUrl="https://ref.example"
        nonce="n1"
      />,
    );
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((tag) => !tag.includes('nonce="n1"'))).toEqual([]);
    expect([...html.matchAll(/\son[a-z]+="/g)]).toEqual([]);
  });

  // The copy script reads the value out of the DOM; a code must never be
  // interpolated into a script body, where one escaping slip is an XSS.
  it("keeps codes out of the script body and escapes them in markup", () => {
    const html = renderToString(
      <InviteCodesCard
        invites={{
          status: "ok",
          codes: [{ code: "</script><img src=x>", redeemedAt: null, redeemedBy: null }],
        }}
        shareBaseUrl="https://ref.example"
        nonce="n1"
      />,
    );
    const scriptBody = html.slice(html.indexOf("<script"));
    expect(scriptBody).not.toContain("<img src=x>");
    expect(html).not.toContain("<img src=x>");
  });
});
