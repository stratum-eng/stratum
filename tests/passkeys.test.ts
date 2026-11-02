import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
/**
 * Passkeys as a second factor (#256): real routers and middleware against a
 * real SQLite D1 (every migration applied), with REAL WebAuthn verification —
 * `tests/helpers/soft-authenticator.ts` produces genuine ES256 attestations and
 * assertions that `@simplewebauthn/server` checks end to end.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { csrfMiddleware } from "../src/middleware/csrf";
import { securityHeadersMiddleware } from "../src/middleware/security-headers";
import { orgSecurityRouter } from "../src/routes/org-security";
import { passkeysRouter } from "../src/routes/passkeys";
import { securitySettingsRouter } from "../src/routes/security-settings";
import { twoFactorRouter } from "../src/routes/two-factor";
import {
  completeBrowserSignIn,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "../src/services/second-factor";
import {
  finishAuthentication,
  finishRegistration,
  relyingParty,
  startAuthentication,
  startRegistration,
} from "../src/services/webauthn";
import { createSession } from "../src/storage/sessions";
import { getPasskeyByCredentialId, insertPasskey, listPasskeys } from "../src/storage/webauthn";
import type { Env } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { type SoftAuthenticator, makeSoftAuthenticator } from "./helpers/soft-authenticator";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const BASE = "https://stratum.test";
const ORIGIN_HEADERS = { Origin: BASE };
const USER = "usr_alice";
const LEGACY_TOKEN = "stratum_user_alice_legacy_token_value";

type Raw = ReturnType<typeof makeSqliteD1>["raw"];

function cookieFrom(res: Response, name: string): string | undefined {
  const header = res.headers.get("Set-Cookie") ?? "";
  const match = new RegExp(`(?:^|, )${name}=([^;]*)`).exec(header);
  return match ? match[1] : undefined;
}

/** Response bodies in these tests are small JSON objects. */
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function auditActions(raw: Raw): string[] {
  return (
    raw.prepare("SELECT action FROM audit_log ORDER BY created_at, rowid").all() as {
      action: string;
    }[]
  ).map((r) => r.action);
}

describe("passkeys as a second factor", () => {
  let db: D1Database;
  let raw: Raw;
  let kv: ReturnType<typeof makeFakeKV>;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    ({ db, raw } = makeSqliteD1());
    kv = makeFakeKV();
    env = { DB: db, STATE: kv } as unknown as Env;

    app = new Hono<{ Bindings: Env }>();
    app.use("*", securityHeadersMiddleware);
    app.use("*", authMiddleware);
    app.use("*", csrfMiddleware);
    // Stands in for every primary sign-in (magic link, OAuth, SSO): they all
    // end in completeBrowserSignIn, which is what is under test.
    app.get("/test/primary/:userId", async (c) => {
      const result = await completeBrowserSignIn(c, logger, {
        userId: c.req.param("userId"),
        method: "test",
        rememberMe: true,
        redirectTo: "/landing",
        ...(c.req.query("sso") ? { ssoOrgId: c.req.query("sso") as string } : {}),
      });
      return result.success ? result.data : c.json({ error: "failed" }, 500);
    });
    app.route("/auth/2fa", twoFactorRouter);
    app.route("/api/users/me/passkeys", passkeysRouter);
    app.route("/api/orgs", orgSecurityRouter);
    app.route("/settings/security", securitySettingsRouter);
    app.get("/api/whoami", (c) =>
      c.get("userId") ? c.json({ userId: c.get("userId") }) : c.json({ error: "anon" }, 401),
    );

    raw
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .run(USER, "alice@example.com", "alice", await hashToken(LEGACY_TOKEN));
    raw
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .run("usr_bob", "bob@example.com", "bob", "hash_bob");
  });

  function req(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("Cookie", init.cookie);
    if (init.method && init.method !== "GET") {
      for (const [k, v] of Object.entries(ORIGIN_HEADERS)) headers.set(k, v);
    }
    return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { ...init, headers }), env));
  }

  async function freshSession(userId = USER): Promise<string> {
    const s = await createSession(db, userId, logger);
    if (!s.success) throw new Error("session");
    return `stratum_session=${s.data.id}`;
  }

  /** Register a passkey through the real API; returns the authenticator and codes. */
  async function enroll(
    cookie: string,
    authenticator?: SoftAuthenticator,
  ): Promise<{
    authn: SoftAuthenticator;
    body: { recoveryCodes?: string[]; passkey: { id: string } };
  }> {
    const authn = authenticator ?? (await makeSoftAuthenticator());
    const optRes = await req("/api/users/me/passkeys/registration/options", {
      method: "POST",
      cookie,
    });
    expect(optRes.status).toBe(200);
    const options = (await optRes.json()) as PublicKeyCredentialCreationOptionsJSON;
    const response = await authn.register(options, BASE);
    const verifyRes = await req("/api/users/me/passkeys/registration/verify", {
      method: "POST",
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Laptop", response }),
    });
    expect(verifyRes.status).toBe(201);
    return {
      authn,
      body: (await verifyRes.json()) as { recoveryCodes?: string[]; passkey: { id: string } },
    };
  }

  /** Primary sign-in; returns the pending-2FA cookie (asserts the gate fired). */
  async function primary(userId = USER, query = ""): Promise<string> {
    const res = await req(`/test/primary/${userId}${query}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/2fa");
    expect(cookieFrom(res, "stratum_session")).toBeUndefined();
    const pending = cookieFrom(res, "stratum_2fa");
    expect(pending).toBeTruthy();
    return `stratum_2fa=${pending}`;
  }

  async function assertionOptions(cookie: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const res = await req("/auth/2fa/options", { method: "POST", cookie });
    expect(res.status).toBe(200);
    return (await res.json()) as PublicKeyCredentialRequestOptionsJSON;
  }

  function verify(cookie: string, response: unknown): Promise<Response> {
    return req("/auth/2fa/verify", {
      method: "POST",
      cookie,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    });
  }

  describe("WebAuthn ceremonies (real library)", () => {
    it("verifies a genuine registration and assertion, and refuses a reused challenge", async () => {
      const rp = relyingParty({}, `${BASE}/x`);
      const authn = await makeSoftAuthenticator();
      const regOptions = await startRegistration(
        kv,
        rp,
        { id: USER, name: "alice", displayName: "Alice" },
        [],
      );
      const registration = await authn.register(regOptions, rp.origin);
      const verified = await finishRegistration(kv, rp, USER, registration, logger);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.credential.credentialId).toBe(authn.credentialId);

      // The same registration again: its challenge is spent.
      const replay = await finishRegistration(kv, rp, USER, registration, logger);
      expect(replay).toEqual({ ok: false, reason: "challenge_invalid" });

      const saved = await insertPasskey(db, logger, {
        userId: USER,
        name: "k",
        ...verified.credential,
      });
      expect(saved.success).toBe(true);
      if (!saved.success) return;
      const authOptions = await startAuthentication(kv, rp, "subject-1", [saved.data]);
      const assertion = await authn.authenticate(authOptions, rp.origin);
      // Wrong subject: the challenge was issued to another pending sign-in.
      expect(
        await finishAuthentication(kv, rp, "subject-2", saved.data, assertion, logger),
      ).toEqual({ ok: false, reason: "challenge_invalid" });
    });

    it("refuses an assertion from the wrong origin", async () => {
      const rp = relyingParty({}, `${BASE}/x`);
      const authn = await makeSoftAuthenticator();
      const reg = await startRegistration(kv, rp, { id: USER, name: "a", displayName: "a" }, []);
      const verified = await finishRegistration(
        kv,
        rp,
        USER,
        await authn.register(reg, rp.origin),
        logger,
      );
      if (!verified.ok) throw new Error("registration");
      const saved = await insertPasskey(db, logger, {
        userId: USER,
        name: "k",
        ...verified.credential,
      });
      if (!saved.success) throw new Error("insert");
      const opts = await startAuthentication(kv, rp, "s", [saved.data]);
      const phished = await authn.authenticate(opts, "https://evil.example");
      expect(await finishAuthentication(kv, rp, "s", saved.data, phished, logger)).toEqual({
        ok: false,
        reason: "verification_failed",
      });
    });

    it("binds the relying party to APP_URL when configured", () => {
      expect(
        relyingParty({ APP_URL: "https://app.usestratum.dev" }, "https://preview.dev/x"),
      ).toEqual({ rpID: "app.usestratum.dev", origin: "https://app.usestratum.dev" });
      expect(relyingParty({}, "https://staging.app.usestratum.dev/settings")).toEqual({
        rpID: "staging.app.usestratum.dev",
        origin: "https://staging.app.usestratum.dev",
      });
    });
  });

  describe("registration", () => {
    it("registers a first passkey, issues recovery codes once, and upgrades the session", async () => {
      const cookie = await freshSession();
      const { authn, body } = await enroll(cookie);
      expect(body.recoveryCodes).toHaveLength(10);
      const stored = await listPasskeys(db, logger, USER);
      expect(stored.success && stored.data.map((p) => p.credentialId)).toEqual([
        authn.credentialId,
      ]);
      // Codes are hashed at rest.
      const codeRows = raw
        .prepare("SELECT code_hash FROM recovery_codes WHERE user_id = ?")
        .all(USER) as {
        code_hash: string;
      }[];
      expect(codeRows).toHaveLength(10);
      const firstCode = body.recoveryCodes?.[0] ?? "";
      expect(codeRows.map((r) => r.code_hash)).toContain(await hashRecoveryCode(firstCode));
      expect(codeRows.map((r) => r.code_hash)).not.toContain(firstCode);
      // The registering session now counts as second-factor verified.
      const session = raw.prepare("SELECT second_factor FROM sessions").get() as {
        second_factor: string;
      };
      expect(session.second_factor).toBe("passkey");
      expect(auditActions(raw)).toContain("passkey.registered");

      // A second passkey from the (now verified, still fresh) session: no new codes.
      const second = await enroll(cookie);
      expect(second.body.recoveryCodes).toBeUndefined();
    });

    it("refuses registration from a stale session", async () => {
      const cookie = await freshSession();
      raw.prepare("UPDATE sessions SET created_at = '2020-01-01 00:00:00'").run();
      const res = await req("/api/users/me/passkeys/registration/options", {
        method: "POST",
        cookie,
      });
      expect(res.status).toBe(403);
      expect((await jsonOf(res)).code).toBe("REAUTHENTICATION_REQUIRED");
    });

    it("refuses adding a passkey from a session that skipped the existing one", async () => {
      await enroll(await freshSession());
      // A different, fresh session that never presented the passkey.
      const other = await freshSession();
      const res = await req("/api/users/me/passkeys/registration/options", {
        method: "POST",
        cookie: other,
      });
      expect(res.status).toBe(403);
    });

    it("is unreachable with an API token", async () => {
      const res = await app.fetch(
        new Request(`${BASE}/api/users/me/passkeys`, {
          headers: { Authorization: `Bearer ${LEGACY_TOKEN}` },
        }),
        env,
      );
      expect(res.status).toBe(403);
      expect((await jsonOf(res)).code).toBe("SESSION_REQUIRED");
    });
  });

  describe("sign-in", () => {
    it("mints a session directly when the account has no passkey", async () => {
      const res = await req(`/test/primary/${USER}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/landing");
      expect(cookieFrom(res, "stratum_session")).toBeTruthy();
    });

    it("requires a passkey assertion before issuing the session", async () => {
      const { authn } = await enroll(await freshSession());
      raw.prepare("DELETE FROM sessions").run();

      const pending = await primary();
      expect(raw.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });

      const page = await req("/auth/2fa", { cookie: pending });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Use passkey");

      const options = await assertionOptions(pending);
      const res = await verify(pending, await authn.authenticate(options, BASE));
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toEqual({ redirectTo: "/landing" });
      const sessionCookie = cookieFrom(res, "stratum_session");
      expect(sessionCookie).toBeTruthy();

      const row = raw.prepare("SELECT second_factor FROM sessions").get() as {
        second_factor: string;
      };
      expect(row.second_factor).toBe("passkey");
      const stored = await getPasskeyByCredentialId(db, logger, USER, authn.credentialId);
      expect(stored.success && stored.data.counter).toBe(authn.counter);
      expect(stored.success && stored.data.lastUsedAt).toBeTruthy();
      expect(auditActions(raw)).toEqual(
        expect.arrayContaining(["second_factor.succeeded", "session.created"]),
      );

      // The session works; the pending sign-in is spent.
      const who = await req("/api/whoami", { cookie: `stratum_session=${sessionCookie}` });
      expect(await jsonOf(who)).toEqual({ userId: USER });
      const again = await req("/auth/2fa/options", { method: "POST", cookie: pending });
      expect(again.status).toBe(401);
    });

    it("burns a challenge on first use, even when that use fails", async () => {
      const { authn } = await enroll(await freshSession());
      const pending = await primary();
      const options = await assertionOptions(pending);
      const genuine = await authn.authenticate(options, BASE);
      const tampered = {
        ...genuine,
        response: {
          ...genuine.response,
          signature: genuine.response.signature.replace(/^.{4}/, "AAAA"),
        },
      };
      expect((await verify(pending, tampered)).status).toBe(400);
      const replay = await verify(pending, genuine);
      expect(replay.status).toBe(400);
      expect((await jsonOf(replay)).error).toMatch(/expired/i);
      // Only the enrolling session exists; the sign-in minted nothing.
      expect(raw.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    });

    it("refuses an evicted (expired) challenge", async () => {
      const { authn } = await enroll(await freshSession());
      const pending = await primary();
      const options = await assertionOptions(pending);
      for (const key of [...kv.store.keys()]) {
        if (key.startsWith("webauthn_challenge:")) kv.store.delete(key);
      }
      const res = await verify(pending, await authn.authenticate(options, BASE));
      expect(res.status).toBe(400);
    });

    it("expires the parked sign-in", async () => {
      await enroll(await freshSession());
      const pending = await primary();
      for (const [key, value] of kv.store) {
        if (key.startsWith("second_factor_pending:")) {
          kv.store.set(key, JSON.stringify({ ...JSON.parse(value), expiresAt: Date.now() - 1 }));
        }
      }
      const page = await req("/auth/2fa", { cookie: pending });
      expect(page.status).toBe(302);
      expect(page.headers.get("Location")).toBe("/auth/login?error=second_factor_expired");
    });

    it("refuses a signature counter that goes backwards", async () => {
      const { authn } = await enroll(await freshSession(), await makeSoftAuthenticator(10));
      // First sign-in advances the stored counter to 11.
      let pending = await primary();
      expect(
        (await verify(pending, await authn.authenticate(await assertionOptions(pending), BASE)))
          .status,
      ).toBe(200);

      // A cloned authenticator replaying an older state.
      authn.counter = 3;
      pending = await primary();
      const res = await verify(
        pending,
        await authn.authenticate(await assertionOptions(pending), BASE),
      );
      expect(res.status).toBe(400);
      expect((await jsonOf(res)).error).toMatch(/counter/i);
      expect(auditActions(raw)).toContain("second_factor.failed");
      const stored = await getPasskeyByCredentialId(db, logger, USER, authn.credentialId);
      expect(stored.success && stored.data.counter).toBe(11);
    });

    it("accepts a recovery code exactly once", async () => {
      const { body } = await enroll(await freshSession());
      const code = (body.recoveryCodes?.[3] ?? "").toUpperCase(); // typed in caps: still matches

      let pending = await primary();
      let res = await req("/auth/2fa/recovery", {
        method: "POST",
        cookie: pending,
        body: new URLSearchParams({ code }),
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/landing");
      expect(cookieFrom(res, "stratum_session")).toBeTruthy();
      expect(auditActions(raw)).toContain("recovery_code.used");

      pending = await primary();
      res = await req("/auth/2fa/recovery", {
        method: "POST",
        cookie: pending,
        body: new URLSearchParams({ code }),
      });
      expect(res.headers.get("Location")).toBe("/auth/2fa?error=invalid_code");
      expect(cookieFrom(res, "stratum_session")).toBeUndefined();
      expect(normalizeRecoveryCode(code)).toHaveLength(10);
    });

    it("voids the parked sign-in after repeated failures", async () => {
      await enroll(await freshSession());
      const pending = await primary();
      let location = "";
      for (let i = 0; i < 5; i++) {
        const res = await req("/auth/2fa/recovery", {
          method: "POST",
          cookie: pending,
          body: new URLSearchParams({ code: "wrong-guess" }),
        });
        location = res.headers.get("Location") ?? "";
      }
      expect(location).toBe("/auth/login?error=second_factor_failed");
      expect((await req("/auth/2fa", { cookie: pending })).status).toBe(302);
    });

    it("rejects cross-site POSTs to the second-factor endpoints", async () => {
      await enroll(await freshSession());
      const pending = await primary();
      const res = await app.fetch(
        new Request(`${BASE}/auth/2fa/options`, {
          method: "POST",
          headers: { Cookie: pending, Origin: "https://evil.example" },
        }),
        env,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("managing passkeys", () => {
    it("renames and removes a passkey; removing the last also clears recovery codes", async () => {
      const cookie = await freshSession();
      const { body } = await enroll(cookie);
      const id = body.passkey.id;

      const renamed = await req(`/api/users/me/passkeys/${id}`, {
        method: "PATCH",
        cookie,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Work YubiKey" }),
      });
      expect(renamed.status).toBe(200);
      const listed = (await (await req("/api/users/me/passkeys", { cookie })).json()) as {
        passkeys: { name: string }[];
        recoveryCodesRemaining: number;
      };
      expect(listed.passkeys[0]?.name).toBe("Work YubiKey");
      expect(listed.recoveryCodesRemaining).toBe(10);

      const removed = await req(`/api/users/me/passkeys/${id}`, { method: "DELETE", cookie });
      expect(removed.status).toBe(200);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM recovery_codes").get()).toEqual({ n: 0 });
      expect(auditActions(raw)).toContain("passkey.removed");
    });

    it("refuses to remove the last passkey while an org requires a second factor", async () => {
      const cookie = await freshSession();
      const { body } = await enroll(cookie);
      raw
        .prepare(
          "INSERT INTO orgs (id, name, slug, owner_id, created_at, require_second_factor) VALUES ('org_1', 'Acme', 'acme', 'usr_bob', '2026-01-01', 1)",
        )
        .run();
      raw
        .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES ('org_1', ?, 'member')")
        .run(USER);

      const res = await req(`/api/users/me/passkeys/${body.passkey.id}`, {
        method: "DELETE",
        cookie,
      });
      expect(res.status).toBe(409);
      expect(await jsonOf(res)).toMatchObject({
        code: "LAST_PASSKEY_REQUIRED_BY_ORG",
        orgs: ["acme"],
      });
    });

    it("regenerates recovery codes, invalidating the old set", async () => {
      const cookie = await freshSession();
      const { body } = await enroll(cookie);
      const res = await req("/api/users/me/passkeys/recovery-codes", { method: "POST", cookie });
      expect(res.status).toBe(201);
      const { recoveryCodes } = (await res.json()) as { recoveryCodes: string[] };
      expect(recoveryCodes).toHaveLength(10);
      const hashes = (
        raw.prepare("SELECT code_hash FROM recovery_codes").all() as { code_hash: string }[]
      ).map((r) => r.code_hash);
      expect(hashes).not.toContain(await hashRecoveryCode(body.recoveryCodes?.[0] ?? ""));
      expect(auditActions(raw)).toContain("recovery_codes.regenerated");
    });

    it("renders the settings page with the enrolled passkeys", async () => {
      const cookie = await freshSession();
      await enroll(cookie);
      const res = await req("/settings/security", { cookie });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Laptop");
      expect(html).toContain("StratumPasskey");
    });
  });

  describe("org policy", () => {
    beforeEach(() => {
      raw
        .prepare(
          "INSERT INTO orgs (id, name, slug, owner_id, created_at) VALUES ('org_1', 'Acme', 'acme', 'usr_bob', '2026-01-01')",
        )
        .run();
      raw
        .prepare(
          "INSERT INTO org_members (org_id, user_id, role) VALUES ('org_1', 'usr_bob', 'admin')",
        )
        .run();
      raw
        .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES ('org_1', ?, 'member')")
        .run(USER);
    });

    function requirePolicy(): void {
      raw.prepare("UPDATE orgs SET require_second_factor = 1 WHERE id = 'org_1'").run();
    }

    it("only lets an admin change it, and only once the admin has a passkey", async () => {
      const member = await freshSession(USER);
      const put = (cookie: string, value: boolean) =>
        req("/api/orgs/acme/security", {
          method: "PUT",
          cookie,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requireSecondFactor: value }),
        });
      expect((await put(member, true)).status).toBe(403);

      const admin = await freshSession("usr_bob");
      const blocked = await put(admin, true);
      expect(blocked.status).toBe(409);
      expect((await jsonOf(blocked)).code).toBe("ADMIN_SECOND_FACTOR_REQUIRED");

      await enroll(admin);
      const res = await put(admin, true);
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toEqual({ requireSecondFactor: true });
      expect(auditActions(raw)).toContain("org.second_factor_policy_changed");
      const read = await req("/api/orgs/acme/security", { cookie: admin });
      expect(await jsonOf(read)).toEqual({ requireSecondFactor: true });
    });

    it("confines a member without a passkey to enrollment until they register one", async () => {
      requirePolicy();
      const cookie = await freshSession(USER);

      const api = await req("/api/whoami", { cookie });
      expect(api.status).toBe(403);
      expect(await jsonOf(api)).toMatchObject({
        code: "SECOND_FACTOR_ENROLLMENT_REQUIRED",
        org: "acme",
      });

      const page = await req("/api/whoami", { cookie, headers: { Accept: "text/html" } });
      expect(page.status).toBe(302);
      expect(page.headers.get("Location")).toBe("/settings/security?required=acme");

      const settings = await req("/settings/security", { cookie });
      expect(settings.status).toBe(200);
      expect(await settings.text()).toContain("requires a second factor");

      await enroll(cookie);
      const after = await req("/api/whoami", { cookie });
      expect(after.status).toBe(200);
    });

    it("signs out a member's session that skipped their passkey", async () => {
      await enroll(await freshSession(USER));
      requirePolicy();
      const unverified = await freshSession(USER);
      const res = await req("/api/whoami", { cookie: unverified });
      expect(res.status).toBe(401);
      expect((await jsonOf(res)).code).toBe("SECOND_FACTOR_REQUIRED");
      expect(cookieFrom(res, "stratum_session")).toBe("");
    });

    it("trusts this org's own SSO sign-in as satisfying its policy", async () => {
      requirePolicy();
      const res = await req(`/test/primary/${USER}?sso=org_1`);
      const cookie = `stratum_session=${cookieFrom(res, "stratum_session")}`;
      expect((await req("/api/whoami", { cookie })).status).toBe(200);
      const row = raw.prepare("SELECT sso_org_id FROM sessions").get() as { sso_org_id: string };
      expect(row.sso_org_id).toBe("org_1");
    });

    it("does not apply to API tokens", async () => {
      requirePolicy();
      const res = await app.fetch(
        new Request(`${BASE}/api/whoami`, { headers: { Authorization: `Bearer ${LEGACY_TOKEN}` } }),
        env,
      );
      expect(res.status).toBe(200);
    });
  });
});
