import { beforeEach, describe, expect, it, vi } from "vitest";
import { parsePolicyContent } from "../src/evaluation/policy-loader";
import { type ProjectSecretSource, resolveSigningKey } from "../src/evaluation/signing-secret";
import type { EvalPolicy, WebhookEvaluatorConfig } from "../src/evaluation/types";
import { WebhookEvaluator } from "../src/evaluation/webhook-evaluator";
import { buildEvaluators } from "../src/services/change-flow";
import { putSecret } from "../src/storage/project-secrets";
import type { Env, ProjectEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

/**
 * #395 — a webhook evaluator's signing key named by `secretRef` and resolved
 * from the project secret store, instead of a literal in the policy file that
 * anyone with repository read access can read.
 */

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const KEY = "a-test-deploy-secret-key";
const PROJECT_ID = "proj_webhook";
const URL = "https://ci.example.com/eval";

async function storeWith(
  values: Record<string, string>,
  deployKey = KEY,
): Promise<ProjectSecretSource> {
  const { db } = makeSqliteD1();
  for (const [name, value] of Object.entries(values)) {
    const stored = await putSecret(
      db,
      logger,
      { DEPLOY_SECRET_KEY: deployKey },
      { projectId: PROJECT_ID, name, value, actorId: "user_alice" },
    );
    expect(stored.success).toBe(true);
  }
  return { env: { DB: db, DEPLOY_SECRET_KEY: KEY }, projectId: PROJECT_ID };
}

function captureFetch(): { calls: Array<{ headers: Record<string, string>; body: string }> } {
  const calls: Array<{ headers: Record<string, string>; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string>, body: init.body as string });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ score: 1, passed: true, reason: "receiver ok" }),
      });
    }),
  );
  return { calls };
}

/** Independent of the evaluator's own helper, so a bug there cannot hide here. */
async function hmac(key: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(body)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function evaluate(config: WebhookEvaluatorConfig, store?: ProjectSecretSource) {
  const policy: EvalPolicy = { evaluators: [config] };
  return new WebhookEvaluator(config, store).evaluate("diff content", policy, logger);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolveSigningKey", () => {
  it("resolves a secretRef from the project secret store", async () => {
    const store = await storeWith({ WEBHOOK_EVALUATOR_SECRET: "from-the-store" });
    const resolved = await resolveSigningKey(
      { secretRef: "WEBHOOK_EVALUATOR_SECRET" },
      store,
      logger,
      "test",
    );
    expect(resolved).toEqual({ status: "resolved", key: "from-the-store", source: "secretRef" });
  });

  it("prefers secretRef over a literal secret, and warns that the literal is ignored", async () => {
    const store = await storeWith({ WEBHOOK_EVALUATOR_SECRET: "from-the-store" });
    const resolved = await resolveSigningKey(
      { secret: "literal-in-repo", secretRef: "WEBHOOK_EVALUATOR_SECRET" },
      store,
      logger,
      "test",
    );
    expect(resolved).toEqual({ status: "resolved", key: "from-the-store", source: "secretRef" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ignoring the literal"),
      expect.anything(),
    );
  });

  it("never falls back to the literal when the secretRef does not resolve", async () => {
    const store = await storeWith({});
    const resolved = await resolveSigningKey(
      { secret: "literal-in-repo", secretRef: "WEBHOOK_EVALUATOR_SECRET" },
      store,
      logger,
      "test",
    );
    expect(resolved.status).toBe("unavailable");
    expect(JSON.stringify(resolved)).not.toContain("literal-in-repo");
  });

  it("accepts a literal secret with a deprecation warning", async () => {
    const resolved = await resolveSigningKey({ secret: "lit" }, undefined, logger, "test");
    expect(resolved).toEqual({ status: "resolved", key: "lit", source: "literal" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
  });

  it("is unsigned when neither field is set, without touching the store", async () => {
    const store: ProjectSecretSource = {
      env: { DB: makeThrowingD1("must not be read"), DEPLOY_SECRET_KEY: KEY },
      projectId: PROJECT_ID,
    };
    expect(await resolveSigningKey({}, store, logger, "test")).toEqual({ status: "unsigned" });
  });

  it("fails closed on every way a reference can fail to produce a key", async () => {
    const ref = { secretRef: "WEBHOOK_EVALUATOR_SECRET" };

    const missing = await resolveSigningKey(ref, await storeWith({}), logger, "test");
    expect(missing).toEqual({
      status: "unavailable",
      reason: "project secret WEBHOOK_EVALUATOR_SECRET is not set for this project",
    });

    const empty = await resolveSigningKey(
      ref,
      await storeWith({ WEBHOOK_EVALUATOR_SECRET: "" }),
      logger,
      "test",
    );
    expect(empty.status).toBe("unavailable");
    if (empty.status === "unavailable") expect(empty.reason).toContain("empty key");

    const rotated = await resolveSigningKey(
      ref,
      await storeWith({ WEBHOOK_EVALUATOR_SECRET: "v" }, "a-different-deploy-key"),
      logger,
      "test",
    );
    expect(rotated.status).toBe("unavailable");
    if (rotated.status === "unavailable")
      expect(rotated.reason).toContain("could not be decrypted");

    const noMasterKey = await resolveSigningKey(
      ref,
      { env: { DB: makeSqliteD1().db, DEPLOY_SECRET_KEY: undefined }, projectId: PROJECT_ID },
      logger,
      "test",
    );
    expect(noMasterKey.status).toBe("unavailable");
    if (noMasterKey.status === "unavailable")
      expect(noMasterKey.reason).toContain("DEPLOY_SECRET_KEY");

    const dbDown = await resolveSigningKey(
      ref,
      { env: { DB: makeThrowingD1(), DEPLOY_SECRET_KEY: KEY }, projectId: PROJECT_ID },
      logger,
      "test",
    );
    expect(dbDown.status).toBe("unavailable");

    const noStore = await resolveSigningKey(ref, undefined, logger, "test");
    expect(noStore.status).toBe("unavailable");

    const badName = await resolveSigningKey(
      { secretRef: "lower-case" },
      await storeWith({}),
      logger,
      "test",
    );
    expect(badName.status).toBe("unavailable");
  });

  it("scopes a reference to its own project", async () => {
    const store = await storeWith({ WEBHOOK_EVALUATOR_SECRET: "other-project" });
    const resolved = await resolveSigningKey(
      { secretRef: "WEBHOOK_EVALUATOR_SECRET" },
      { ...store, projectId: "proj_someone_else" },
      logger,
      "test",
    );
    expect(resolved.status).toBe("unavailable");
  });
});

describe("WebhookEvaluator with secretRef", () => {
  it("signs the request with the project secret's value", async () => {
    const { calls } = captureFetch();
    const store = await storeWith({ WEBHOOK_EVALUATOR_SECRET: "from-the-store" });

    const result = await evaluate(
      { type: "webhook", url: URL, secretRef: "WEBHOOK_EVALUATOR_SECRET" },
      store,
    );

    expect(result.success && result.data.passed).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.headers["X-Stratum-Signature"]).toBe(
      await hmac("from-the-store", call?.body ?? ""),
    );
    // The reference name is not content either: the payload's policy copy is
    // stripped of it like any credential field.
    expect(call?.body).not.toContain("WEBHOOK_EVALUATOR_SECRET");
    expect(call?.body).not.toContain("from-the-store");
  });

  it("signs with secretRef, not the literal, when both are given", async () => {
    const { calls } = captureFetch();
    const store = await storeWith({ WEBHOOK_EVALUATOR_SECRET: "from-the-store" });

    await evaluate(
      {
        type: "webhook",
        url: URL,
        secret: "literal-in-repo",
        secretRef: "WEBHOOK_EVALUATOR_SECRET",
      },
      store,
    );

    const [call] = calls;
    expect(call?.headers["X-Stratum-Signature"]).toBe(
      await hmac("from-the-store", call?.body ?? ""),
    );
  });

  it("fails closed without contacting the receiver when the secret is missing", async () => {
    const { calls } = captureFetch();

    const result = await evaluate(
      { type: "webhook", url: URL, secretRef: "WEBHOOK_EVALUATOR_SECRET" },
      await storeWith({}),
    );

    expect(calls).toHaveLength(0);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.passed).toBe(false);
      expect(result.data.score).toBe(0);
      expect(result.data.reason).toContain("WEBHOOK_EVALUATOR_SECRET is not set");
    }
  });

  it("fails closed rather than signing with an empty key", async () => {
    const { calls } = captureFetch();

    const result = await evaluate(
      { type: "webhook", url: URL, secretRef: "WEBHOOK_EVALUATOR_SECRET" },
      await storeWith({ WEBHOOK_EVALUATOR_SECRET: "" }),
    );

    expect(calls).toHaveLength(0);
    expect(result.success && result.data.passed).toBe(false);
  });

  it("fails closed when constructed without a secret store", async () => {
    const { calls } = captureFetch();
    const result = await evaluate({
      type: "webhook",
      url: URL,
      secretRef: "WEBHOOK_EVALUATOR_SECRET",
    });
    expect(calls).toHaveLength(0);
    expect(result.success && result.data.passed).toBe(false);
  });

  it("still signs with a deprecated literal secret", async () => {
    const { calls } = captureFetch();
    await evaluate({ type: "webhook", url: URL, secret: "literal-in-repo" });
    const [call] = calls;
    expect(call?.headers["X-Stratum-Signature"]).toBe(
      await hmac("literal-in-repo", call?.body ?? ""),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
  });
});

describe("buildEvaluators wires the project's secret store", () => {
  it("resolves a webhook secretRef against the change's own project", async () => {
    const { calls } = captureFetch();
    const store = await storeWith({ WEBHOOK_EVALUATOR_SECRET: "from-the-store" });
    const env = { DB: store.env.DB, DEPLOY_SECRET_KEY: KEY } as unknown as Env;
    const project: ProjectEntry = {
      id: PROJECT_ID,
      name: "repo",
      slug: "repo",
      namespace: "@alice",
      ownerId: "user_alice",
      ownerType: "user",
      remote: "https://artifacts.example.com/repos/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const policy: EvalPolicy = {
      evaluators: [{ type: "webhook", url: URL, secretRef: "WEBHOOK_EVALUATOR_SECRET" }],
    };

    const evaluators = await buildEvaluators(env, policy, project, logger);
    const webhook = evaluators.find((entry) => entry.type === "webhook");
    expect(webhook).toBeDefined();
    await webhook?.evaluator.evaluate("diff content", policy, logger);

    const [call] = calls;
    expect(call?.headers["X-Stratum-Signature"]).toBe(
      await hmac("from-the-store", call?.body ?? ""),
    );
  });
});

describe("policy loader: webhook secretRef", () => {
  const parse = (yaml: string) => parsePolicyContent(yaml, "yaml", logger);

  it("keeps a valid secretRef", () => {
    const parsed = parse(
      `evaluators:\n  - type: webhook\n    url: ${URL}\n    secretRef: WEBHOOK_EVALUATOR_SECRET\n`,
    );
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") {
      expect(parsed.policy.evaluators).toEqual([
        { type: "webhook", url: URL, secretRef: "WEBHOOK_EVALUATOR_SECRET" },
      ]);
    }
  });

  it("keeps both fields when both are given, and warns", () => {
    const parsed = parse(
      `evaluators:\n  - type: webhook\n    url: ${URL}\n    secret: lit\n    secretRef: WEBHOOK_EVALUATOR_SECRET\n`,
    );
    expect(parsed.status).toBe("ok");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("the literal is ignored"),
      expect.anything(),
    );
  });

  it("warns when a literal secret is used", () => {
    const parsed = parse(`evaluators:\n  - type: webhook\n    url: ${URL}\n    secret: lit\n`);
    expect(parsed.status).toBe("ok");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("deprecated"),
      expect.anything(),
    );
  });

  it.each([
    ["a lower-case name", "secretRef: webhook_secret"],
    ["a non-string", "secretRef: 42"],
    ["an empty string", 'secretRef: ""'],
  ])("fails the file closed on %s", (_label, line) => {
    const parsed = parse(`evaluators:\n  - type: webhook\n    url: ${URL}\n    ${line}\n`);
    expect(parsed.status).toBe("malformed");
    if (parsed.status === "malformed") expect(parsed.reason).toContain("secretRef");
  });
});
