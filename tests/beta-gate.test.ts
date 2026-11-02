import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitUser,
  betaGateEnabled,
  fetchInviteCodes,
  referralServiceConfigured,
  validateInviteCode,
} from "../src/beta/gate";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function env(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("betaGateEnabled", () => {
  it("is off by default (no env)", () => {
    expect(betaGateEnabled(env())).toBe(false);
  });

  it("is off when BETA_GATE set but no service URL", () => {
    expect(betaGateEnabled(env({ BETA_GATE: "1" }))).toBe(false);
  });

  it("is off when service URL set but BETA_GATE not '1'", () => {
    expect(betaGateEnabled(env({ REFERRAL_SERVICE_URL: "https://x.dev" }))).toBe(false);
    expect(betaGateEnabled(env({ BETA_GATE: "true", REFERRAL_SERVICE_URL: "https://x.dev" }))).toBe(
      false,
    );
  });

  it("is on only when both are configured", () => {
    expect(betaGateEnabled(env({ BETA_GATE: "1", REFERRAL_SERVICE_URL: "https://x.dev" }))).toBe(
      true,
    );
  });
});

describe("validateInviteCode", () => {
  const e = env({ BETA_GATE: "1", REFERRAL_SERVICE_URL: "https://x.dev/" });

  it("returns invalid for an empty code without calling the service", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await validateInviteCode(e, "  ", noopLogger);
    expect(result.valid).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes through a valid response and uppercases/trims the code", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ valid: true, referrerUserId: "usr_1" }), {
        status: 200,
      }),
    );
    const result = await validateInviteCode(e, " abc123 ", noopLogger);
    expect(result).toEqual({ valid: true, referrerUserId: "usr_1" });
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.code).toBe("ABC123");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://x.dev/api/referral/validate");
  });

  it("fails closed on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    expect((await validateInviteCode(e, "ABC", noopLogger)).valid).toBe(false);
  });

  it("fails closed when the request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect((await validateInviteCode(e, "ABC", noopLogger)).valid).toBe(false);
  });
});

describe("admitUser", () => {
  const e = env({
    BETA_GATE: "1",
    REFERRAL_SERVICE_URL: "https://x.dev",
    REFERRAL_SERVICE_SECRET: "s3cret",
  });

  it("returns minted codes and sends the bearer secret", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ codes: ["A", "B", "C", "D", "E"], referrerUserId: "usr_ref" }),
          { status: 200 },
        ),
      );
    const result = await admitUser(
      e,
      { userId: "usr_new", email: "a@b.com", code: "abc", source: "magic_link" },
      noopLogger,
    );
    expect(result.codes).toHaveLength(5);
    expect(result.referrerUserId).toBe("usr_ref");
    const init = fetchSpy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(JSON.parse(String(init?.body)).code).toBe("ABC");
  });

  it("returns no codes (never throws) on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    const result = await admitUser(
      e,
      { userId: "u", email: "a@b.com", code: "X", source: "magic_link" },
      noopLogger,
    );
    expect(result.codes).toEqual([]);
  });

  it("returns no codes on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const result = await admitUser(
      e,
      { userId: "u", email: "a@b.com", code: "X", source: "magic_link" },
      noopLogger,
    );
    expect(result).toEqual({ codes: [], referrerUserId: null });
  });
});

describe("referralServiceConfigured", () => {
  it("is false with no service URL", () => {
    expect(referralServiceConfigured(env())).toBe(false);
  });

  // The gate and the service are deliberately decoupled: codes minted while the
  // gate was on must stay listable after it is switched off (production runs
  // BETA_GATE = "0" with the service still pointed at).
  it("is true from the URL alone, whatever BETA_GATE says", () => {
    expect(referralServiceConfigured(env({ REFERRAL_SERVICE_URL: "https://x.dev" }))).toBe(true);
    expect(
      referralServiceConfigured(env({ BETA_GATE: "0", REFERRAL_SERVICE_URL: "https://x.dev" })),
    ).toBe(true);
  });
});

describe("fetchInviteCodes", () => {
  const e = env({ REFERRAL_SERVICE_URL: "https://x.dev/", REFERRAL_SERVICE_SECRET: "s3cret" });

  it("returns an empty list without calling the service when none is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await fetchInviteCodes(env(), "usr_1", noopLogger)).toEqual({ status: "ok", codes: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the shared secret and the user id, against a single-slash URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ codes: [] }), { status: 200 }));
    await fetchInviteCodes(e, "usr 1", noopLogger);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://x.dev/api/referral/codes?userId=usr%201",
    );
    const init = fetchSpy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
  });

  it("parses full entries and bare strings, and drops malformed ones", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          codes: [
            { code: "AAA111", redeemedAt: "2026-01-02T00:00:00Z", redeemedBy: "bob" },
            { code: " BBB222 " },
            "CCC333",
            { code: "   " },
            { redeemedAt: "2026-01-02T00:00:00Z" },
            42,
            null,
            "",
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await fetchInviteCodes(e, "usr_1", noopLogger);
    expect(result).toEqual({
      status: "ok",
      codes: [
        { code: "AAA111", redeemedAt: "2026-01-02T00:00:00Z", redeemedBy: "bob" },
        { code: "BBB222", redeemedAt: null, redeemedBy: null },
        { code: "CCC333", redeemedAt: null, redeemedBy: null },
      ],
    });
  });

  // "Unavailable" and "you have none" must stay distinguishable: the page says
  // something different for each, and conflating them reads as "codes lost".
  it("reports unavailable on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    expect(await fetchInviteCodes(e, "usr_1", noopLogger)).toEqual({ status: "unavailable" });
  });

  it("reports unavailable when the service throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    expect(await fetchInviteCodes(e, "usr_1", noopLogger)).toEqual({ status: "unavailable" });
  });

  it("reports unavailable on a body with no code list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    expect(await fetchInviteCodes(e, "usr_1", noopLogger)).toEqual({ status: "unavailable" });
  });

  it("reports unavailable on an unparseable body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { status: 200 }));
    expect(await fetchInviteCodes(e, "usr_1", noopLogger)).toEqual({ status: "unavailable" });
  });

  it("distinguishes an empty list from an outage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ codes: [] }), { status: 200 }),
    );
    expect(await fetchInviteCodes(e, "usr_1", noopLogger)).toEqual({ status: "ok", codes: [] });
  });
});
