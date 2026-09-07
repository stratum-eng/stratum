/**
 * `GET /settings/usage` — the page itself.
 *
 * `vitest.config.ts` restricts coverage to `src/**\/*.ts`, so the `.tsx` route
 * and page contribute nothing to the ratchet; the data behind them is covered
 * by `usage-visibility.test.ts`. What these assertions police is the part a
 * type checker cannot: that the route is reachable, that it is an account page
 * (session only, like every other one), and that a self-hoster — for whom
 * every limit is unlimited — gets a page that reads sensibly instead of one
 * that looks broken.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { uiRouter } from "../src/routes/ui";
import { upsertUsage, usagePeriod } from "../src/storage/usage";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

let env: Env;
let db: D1Database;
let kv: ReturnType<typeof makeFakeKV>;

const silent = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silent,
} as unknown as Logger;

/**
 * The same instance with a billing service and a finite plan: without it the
 * "no bar" assertion below can only ever pass, since an unlimited page has no
 * fraction to draw in the first place.
 */
async function meterOneAt80Percent(): Promise<void> {
  env = {
    ...env,
    BILLING_SERVICE_URL: "https://billing.test",
    BILLING_SERVICE_SECRET: "s3cret",
  } as Env;
  kv.store.set(
    "entitlements:v2:user:usr_1",
    JSON.stringify({
      plan: "free",
      pooled: false,
      meters: { llm_tokens_month: 1000, sandbox_ms_month: -1, deploys_month: -1 },
      counts: { private_projects: -1 },
      rates: { requests_per_minute: 1000, evaluations_per_hour: 60 },
    }),
  );
  const subject = { ownerId: "usr_1", ownerType: "user" as const };
  const seeded = await upsertUsage(db, silent, subject, usagePeriod(), [
    { meter: "llm_tokens_month", quantity: 800, source: "platform" },
  ]);
  if (!seeded.success) throw seeded.error;
}

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

const get = (path = "/settings/usage") => new Request(`http://localhost${path}`);

beforeEach(async () => {
  db = makeSqliteD1().db;
  kv = makeFakeKV();
  env = { DB: db, STATE: kv, ARTIFACTS: {} } as unknown as Env;
  await db
    .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
    .bind("usr_1", "alice@test", "alice", "hash")
    .run();
});

describe("GET /settings/usage", () => {
  it("sends an anonymous visitor to sign in", async () => {
    const res = await makeApp(null).fetch(get(), env);
    expect(res.status).toBe(302);
  });

  it("refuses an API token, like every other account page", async () => {
    const res = await makeApp("usr_1", "token").fetch(get(), env);
    expect(res.status).toBe(403);
  });

  it("renders unlimited allowances as words, with no progress bar to misread", async () => {
    const res = await makeApp().fetch(get(), env);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("Usage");
    expect(html).toContain("LLM tokens");
    expect(html).toContain("Unlimited");
    // A self-hosted instance says why everything is unlimited rather than
    // leaving the reader to conclude the page failed to load.
    expect(html).toContain("not configured with a billing service");
    // The bar only exists where a fraction exists.
    expect(html).not.toContain("progress-fill");
    // Server-rendered: this page carries no script of any kind.
    expect(html).not.toContain("<script");
  });

  it("draws the bar, and only the bar, for a finite allowance", async () => {
    // The other half of the assertion above: on a metered instance the same
    // page DOES render a fill, so "no fill when unlimited" is a fact about the
    // limit rather than a fact about the markup never containing the string.
    await meterOneAt80Percent();

    const res = await makeApp().fetch(get(), env);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("progress-fill");
    expect(html).toContain("width:80%");
    expect(html).toContain("800 of 1,000");
    // Only the metered row gets one; the two unlimited meters still say so.
    expect(html.match(/progress-fill/g)).toHaveLength(1);
    expect(html).toContain("Unlimited");
    expect(html).not.toContain("<script");
  });
});
