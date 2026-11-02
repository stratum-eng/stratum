import { describe, expect, it, vi } from "vitest";
import {
  MAGIC_LINK_IP_RATE_LIMIT,
  MAGIC_LINK_RATE_LIMIT,
  emailAuthRouter,
} from "../src/routes/email-auth";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";
import { makeMagicLinkLimiters } from "./helpers/magic-link-limiter";

vi.mock("../src/storage/magic-links", () => ({
  createMagicLink: vi.fn(async () => ({ success: true, data: undefined })),
  consumeMagicLink: vi.fn(async () => ({ success: true, data: null })),
}));

vi.mock("../src/storage/users", () => ({
  getUserByEmail: vi.fn(async () => ({ success: false, error: new NotFoundError("User", "x") })),
  createUser: vi.fn(),
  getUserByUsername: vi.fn(),
  signInGitHubUser: vi.fn(),
  getUserByToken: vi.fn(),
  getUser: vi.fn(),
  linkGitHub: vi.fn(),
}));

// The production constants, not copies: a cap changed in one place and not the
// other would otherwise leave these tests asserting a limit nothing enforces.
const EMAIL_LIMIT = MAGIC_LINK_RATE_LIMIT;
const IP_LIMIT = MAGIC_LINK_IP_RATE_LIMIT;

function makeHarness(opts: { namespace?: DurableObjectNamespace } = {}) {
  const limiters = makeMagicLinkLimiters();
  const send = vi.fn().mockResolvedValue({ messageId: "m" });
  const env = {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
    EMAIL: { send },
    EMAIL_FROM_ADDRESS: "noreply@stratum.dev",
    MAGIC_LINK_LIMITER: opts.namespace ?? limiters.namespace,
  } as unknown as Env;
  return { env, send, limiters };
}

function sendRequest(email: string, ip: string): Request {
  const body = new FormData();
  body.append("email", email);
  return new Request("http://localhost/send", {
    method: "POST",
    body,
    headers: { "CF-Connecting-IP": ip },
  });
}

async function post(env: Env, email: string, ip: string): Promise<Response> {
  return emailAuthRouter.fetch(sendRequest(email, ip), env);
}

function rateLimited(res: Response): boolean {
  return res.headers.get("location")?.includes("error=rate_limited") ?? false;
}

describe("magic-link admission", () => {
  it("admits at most the per-IP cap when requests from one IP race", async () => {
    const { env, send } = makeHarness();

    // 25 distinct addresses, so every per-email counter stays at 1 and the
    // per-IP cap is the only thing that can refuse. All in flight at once —
    // the read-to-write window the KV counters had is exactly here.
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) => post(env, `racer${i}@example.com`, "203.0.113.9")),
    );

    expect(responses.filter((r) => !rateLimited(r))).toHaveLength(IP_LIMIT);
    expect(send).toHaveBeenCalledTimes(IP_LIMIT);
  });

  it("admits at most the per-email cap when requests for one address race", async () => {
    const { env, send } = makeHarness();

    // Distinct IPs, so the per-email cap is the only thing that can refuse.
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post(env, "victim@example.com", `198.51.100.${i}`)),
    );

    expect(responses.filter((r) => !rateLimited(r))).toHaveLength(EMAIL_LIMIT);
    expect(send).toHaveBeenCalledTimes(EMAIL_LIMIT);
  });

  it("holds both caps when addresses and IPs race together", async () => {
    const { env, send } = makeHarness();

    // 8 addresses x 6 sends, all from one IP: each address would allow 5 (40
    // total), the IP allows 20. The tighter cap has to win, exactly.
    const requests = [];
    for (let e = 0; e < 8; e++) {
      for (let n = 0; n < 6; n++) requests.push(post(env, `mix${e}@example.com`, "203.0.113.10"));
    }
    const responses = await Promise.all(requests);

    expect(responses.filter((r) => !rateLimited(r))).toHaveLength(IP_LIMIT);
    expect(send).toHaveBeenCalledTimes(IP_LIMIT);
  });

  it("does not spend an IP reservation on a request the email cap refuses", async () => {
    const { env, limiters } = makeHarness();
    const ip = "203.0.113.11";

    for (let i = 0; i < EMAIL_LIMIT; i++) await post(env, "spent@example.com", ip);
    // Three more for the same address: all refused by the email cap, and none
    // of them may consume the IP budget the other addresses still need.
    for (let i = 0; i < 3; i++)
      expect(rateLimited(await post(env, "spent@example.com", ip))).toBe(true);

    const ipStorage = limiters.storages.get(`ip:${ip}`);
    if (!ipStorage) throw new Error("ip limiter not created");
    expect(await ipStorage.get("bucket")).toMatchObject({ count: EMAIL_LIMIT });
  });

  it("refunds the email reservation when the IP cap refuses the send", async () => {
    const { env, limiters, send } = makeHarness();
    const ip = "203.0.113.12";

    // Burn the IP budget on addresses that are nowhere near their own cap.
    for (let i = 0; i < IP_LIMIT; i++) await post(env, `filler${i}@example.com`, ip);
    expect(send).toHaveBeenCalledTimes(IP_LIMIT);

    // A fresh address now gets past its own cap and is stopped by the IP cap.
    // Its email counter must come back to zero, or an IP-exhausted hour would
    // silently eat the address's whole per-email budget too.
    expect(rateLimited(await post(env, "unlucky@example.com", ip))).toBe(true);

    const emailStorages = [...limiters.storages.entries()]
      .filter(([name]) => name.startsWith("email:"))
      .map(([, storage]) => storage);
    const buckets = await Promise.all(
      emailStorages.map(async (storage) => storage.get<{ count: number }>("bucket")),
    );
    // 20 fillers at 1 each, and the refunded address back at 0.
    expect(buckets.filter((b) => b?.count === 1)).toHaveLength(IP_LIMIT);
    expect(buckets.filter((b) => b?.count === 0)).toHaveLength(1);
  });

  it("issues exactly one reservation RPC per counter, with no separate read", async () => {
    const { env, limiters } = makeHarness();

    await post(env, "single@example.com", "203.0.113.13");

    // The bug being fixed was a Worker-side read followed by a write. One RPC
    // per counter is what keeps the decision inside the object's input gate.
    expect(limiters.calls.filter((call) => call.endsWith(".reserve"))).toHaveLength(2);
    expect(limiters.calls.filter((call) => call.endsWith(".refund"))).toHaveLength(0);
    expect(limiters.calls.some((call) => call.startsWith("email:"))).toBe(true);
    expect(limiters.calls.some((call) => call.startsWith("ip:"))).toBe(true);
  });

  it("fails open when the limiter binding is absent", async () => {
    const { env, send } = makeHarness();
    (env as { MAGIC_LINK_LIMITER?: DurableObjectNamespace }).MAGIC_LINK_LIMITER = undefined;

    // Well past both caps. Failing closed here would be a total login outage on
    // a self-hosted deploy whose config predates the binding.
    for (let i = 0; i < IP_LIMIT + 5; i++) {
      expect(rateLimited(await post(env, "nobinding@example.com", "203.0.113.14"))).toBe(false);
    }
    expect(send).toHaveBeenCalledTimes(IP_LIMIT + 5);
  });

  it("fails open when the limiter throws", async () => {
    const throwing = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        reserve: () => Promise.reject(new Error("storage unavailable")),
        refund: () => Promise.reject(new Error("storage unavailable")),
      }),
    } as unknown as DurableObjectNamespace;
    const { env, send } = makeHarness({ namespace: throwing });

    for (let i = 0; i < EMAIL_LIMIT + 3; i++) {
      expect(rateLimited(await post(env, "outage@example.com", "203.0.113.15"))).toBe(false);
    }
    expect(send).toHaveBeenCalledTimes(EMAIL_LIMIT + 3);
  });

  it("separates the email and IP namespaces so an IP literal cannot name an address bucket", async () => {
    const { env, limiters } = makeHarness();

    await post(env, "ns@example.com", "203.0.113.16");

    const names = [...limiters.instances.keys()];
    expect(names.filter((n) => n.startsWith("email:"))).toHaveLength(1);
    expect(names).toContain("ip:203.0.113.16");
  });
});
