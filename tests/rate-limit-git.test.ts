import { describe, expect, it, vi } from "vitest";
import { rateLimitMiddleware } from "../src/middleware/rate-limit";
import type { Env } from "../src/types";

// The middleware skips clone/fetch (reads) but meters push (git-receive-pack).
// We prove the split by observing whether the limiter touches KV: an exempt
// request never reads the counter; a metered one does.
function makeKV(): { kv: KVNamespace; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () => null);
  const kv = {
    get,
    put: vi.fn(async () => undefined),
  } as unknown as KVNamespace;
  return { kv, get };
}

function makeCtx(path: string, service?: string) {
  const { kv, get } = makeKV();
  const query = (name: string) => (name === "service" ? service : undefined);
  const c = {
    req: {
      path,
      query,
      header: () => undefined,
    },
    env: { STATE: kv } as unknown as Env,
    get: () => undefined,
    header: () => undefined,
    json: () => new Response(null),
  };
  return { c, get };
}

async function runsThroughLimiter(path: string, service?: string): Promise<boolean> {
  const { c, get } = makeCtx(path, service);
  const mw = rateLimitMiddleware();
  const next = vi.fn(async () => undefined);
  // biome-ignore lint/suspicious/noExplicitAny: minimal hono context stub for the middleware
  await mw(c as any, next);
  expect(next).toHaveBeenCalledOnce();
  // If the limiter ran, it read the KV counter; if exempt, it did not.
  return get.mock.calls.length > 0;
}

describe("rate-limit git exemption split (S2)", () => {
  it("git-upload-pack (clone RPC) is EXEMPT", async () => {
    expect(await runsThroughLimiter("/@owner/repo.git/git-upload-pack")).toBe(false);
  });

  it("info/refs?service=git-upload-pack (clone advertise) is EXEMPT", async () => {
    expect(await runsThroughLimiter("/@owner/repo.git/info/refs", "git-upload-pack")).toBe(false);
  });

  it("git-receive-pack (push RPC) is NOT exempt — it flows through the limiter", async () => {
    expect(await runsThroughLimiter("/@owner/repo/workspaces/myws.git/git-receive-pack")).toBe(
      true,
    );
  });

  it("info/refs?service=git-receive-pack (push advertise) is NOT exempt", async () => {
    expect(
      await runsThroughLimiter("/@owner/repo/workspaces/myws.git/info/refs", "git-receive-pack"),
    ).toBe(true);
  });
});
