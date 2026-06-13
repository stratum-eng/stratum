import { afterEach, describe, expect, it, vi } from "vitest";
import { admitUser, betaGateEnabled, validateInviteCode } from "../src/beta/gate";
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
});
