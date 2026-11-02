import { describe, expect, it, vi } from "vitest";
import { MAX_FILES, MAX_FILE_BYTES, MAX_LOG_TAIL, MAX_TOTAL_BYTES } from "../src/deploy/limits";
import { REDACTION_PLACEHOLDER, redactAndTruncate, redactSecrets } from "../src/deploy/redact";
import {
  cloudflarePagesTarget,
  extensionOf,
  manifestHash,
} from "../src/deploy/targets/cloudflare-pages";
import { cloudflareWorkersTarget } from "../src/deploy/targets/cloudflare-workers";
import {
  DEPLOY_TARGET_REGISTRY,
  type DeployFetch,
  type DeployOutcome,
  type DeployTarget,
  type DeployTargetInput,
  getDeployTarget,
} from "../src/deploy/targets/index";
import { MAX_INLINE_BODY_BYTES, inlineBodyBytes, vercelTarget } from "../src/deploy/targets/vercel";
import type { DeployConfig, DeployTargetName } from "../src/evaluation/types";
import type { Logger } from "../src/utils/logger";
import type { Result } from "../src/utils/result";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const CF_TOKEN = "cf-token-super-secret-value";
const CF_ACCOUNT = "acct-1234567890";
const VERCEL_TOKEN = "vercel-token-super-secret-value";
const VERCEL_PROJECT = "prj_abc123";

const CLOUDFLARE_SECRETS = {
  CLOUDFLARE_API_TOKEN: CF_TOKEN,
  CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT,
};

const VERCEL_SECRETS = { VERCEL_TOKEN, VERCEL_PROJECT_ID: VERCEL_PROJECT };

function tree(entries: Record<string, string>): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  return new Map(Object.entries(entries).map(([path, text]) => [path, encoder.encode(text)]));
}

function makeInput(overrides: Partial<DeployTargetInput> = {}): DeployTargetInput {
  const config: DeployConfig = { name: "production", target: "vercel", requiresApproval: false };
  return {
    files: tree({ "index.html": "<h1>hi</h1>" }),
    secrets: {},
    config,
    commitSha: "a".repeat(40),
    logger,
    fetch: vi.fn(async () => new Response("{}", { status: 200 })),
    ...overrides,
  };
}

/** A stub that answers each call from a queue, and records what it was asked for. */
function stubFetch(responses: Response[]): DeployFetch & { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  const stub = vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch to ${url}`);
    return next;
  });
  return Object.assign(stub as unknown as DeployFetch, { calls });
}

/** Read a multipart part as text, whichever way the runtime types `FormData.get`. */
async function partText(form: FormData, name: string): Promise<string> {
  const value: unknown = form.get(name);
  if (typeof value === "string") return value;
  if (value instanceof Blob) return value.text();
  throw new Error(`form part "${name}" is missing`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Collect every string a target returned, so a leak cannot hide in a nested field. */
function allStrings(result: Result<DeployOutcome, { reason: string; logTail?: string }>): string[] {
  if (result.success) {
    return [result.data.url, result.data.providerId, result.data.state, result.data.logTail].filter(
      (value): value is string => typeof value === "string",
    );
  }
  return [result.error.reason, result.error.logTail].filter(
    (value): value is string => typeof value === "string",
  );
}

function expectNoSecrets(
  result: Result<DeployOutcome, { reason: string; logTail?: string }>,
  secrets: readonly string[],
): void {
  for (const text of allStrings(result)) {
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
  }
}

describe("deploy limits", () => {
  it("keeps the per-file cap below the total cap so one file cannot consume the budget", () => {
    expect(MAX_FILE_BYTES).toBeLessThan(MAX_TOTAL_BYTES);
  });
});

describe("redact", () => {
  it("replaces every occurrence of a secret value", () => {
    expect(redactSecrets(`token=${CF_TOKEN} again ${CF_TOKEN}`, [CF_TOKEN])).toBe(
      `token=${REDACTION_PLACEHOLDER} again ${REDACTION_PLACEHOLDER}`,
    );
  });

  it("ignores empty values rather than inserting a placeholder between every character", () => {
    expect(redactSecrets("abc", [""])).toBe("abc");
  });

  it("prefers the longest match when one secret contains another", () => {
    const redacted = redactSecrets("prefix-suffix", ["prefix", "prefix-suffix"]);
    expect(redacted).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts before truncating, so a secret cannot survive by straddling the cut", () => {
    // Positioned so the secret spans the truncation boundary: redacting after
    // truncating would leave its first half in the retained text.
    const secret = "S".repeat(40);
    const head = "x".repeat(MAX_LOG_TAIL - 30);
    const redacted = redactAndTruncate(`${head}${secret}${"y".repeat(100)}`, [secret]);

    expect(redacted.length).toBeLessThanOrEqual(MAX_LOG_TAIL);
    // Truncating first would have kept the secret's first 30 characters here.
    expect(redacted).not.toContain("S");
    expect(redacted).toContain(REDACTION_PLACEHOLDER);
  });

  it("leaves short text untouched", () => {
    expect(redactAndTruncate("all fine", [])).toBe("all fine");
  });
});

describe("target registry", () => {
  it("resolves every policy target name to an implementation that declares that name", () => {
    const names: DeployTargetName[] = ["cloudflare-pages", "cloudflare-workers", "vercel"];
    for (const name of names) {
      const target: DeployTarget = getDeployTarget(name);
      expect(target.name).toBe(name);
      expect(DEPLOY_TARGET_REGISTRY[name]).toBe(target);
    }
  });
});

describe("cloudflare static-asset manifest hashing", () => {
  // Fixtures computed independently of the implementation:
  //   sha256(base64(content) + extensionWithoutDot).hex().slice(0, 32)
  it("hashes the base64 text concatenated with the extension, truncated to 32 hex chars", async () => {
    expect(await manifestHash("aGVsbG8gd29ybGQ=", "html")).toBe("6c9e0757090736584b5a6e5c29b5a8c9");
  });

  it("uses an empty extension when the file has none", async () => {
    expect(await manifestHash("aGVsbG8gd29ybGQ=", "")).toBe("dc9c1c09907c36f5379d615ae61c02b4");
  });

  it("reads the extension without its dot, and treats a dotfile as extensionless", () => {
    expect(extensionOf("a/b/index.html")).toBe("html");
    expect(extensionOf("LICENSE")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("cloudflare-pages target (Workers Static Assets)", () => {
  it("registers a manifest, uploads the requested bucket, then deploys with the completion token", async () => {
    const hash = "81f20b8a74d6ef9cdfa6039a9db5e33a";
    const fetch = stubFetch([
      json({ success: true, result: { jwt: "upload-jwt", buckets: [[hash]] } }),
      json({ success: true, result: { jwt: "completion-jwt" } }, 201),
      json({ success: true, result: { id: "worker-1" } }),
    ]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({
        fetch,
        secrets: { ...CLOUDFLARE_SECRETS, CLOUDFLARE_WORKERS_SUBDOMAIN: "acme" },
        config: { name: "site", target: "cloudflare-pages", requiresApproval: false },
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.url).toBe("https://site.acme.workers.dev");
    expect(result.data.providerId).toBe("worker-1");

    expect(fetch.calls).toHaveLength(3);
    const [sessionUrl, sessionInit] = fetch.calls[0] as [string, RequestInit];
    expect(sessionUrl).toContain("/workers/scripts/site/assets-upload-session");
    expect(JSON.parse(String(sessionInit.body))).toEqual({
      manifest: { "/index.html": { hash, size: 11 } },
    });

    // `base64=true` is required; without it the API rejects the encoded parts.
    expect(fetch.calls[1]?.[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1234567890/workers/assets/upload?base64=true",
    );

    const deployInit = fetch.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(await partText(deployInit.body as FormData, "metadata"))).toMatchObject({
      assets: { jwt: "completion-jwt" },
    });
    expectNoSecrets(result, [CF_TOKEN]);
  });

  it("skips the upload phase and reuses the session token when nothing needs uploading", async () => {
    const fetch = stubFetch([
      json({ success: true, result: { jwt: "upload-jwt", buckets: [] } }),
      json({ success: true, result: { id: "worker-2" } }),
    ]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({ fetch, secrets: CLOUDFLARE_SECRETS }),
    );

    expect(result.success).toBe(true);
    expect(fetch.calls).toHaveLength(2);
    expect(
      JSON.parse(await partText(fetch.calls[1]?.[1].body as FormData, "metadata")),
    ).toMatchObject({ assets: { jwt: "upload-jwt" } });
  });

  it("surfaces a 4xx as a non-retryable failure naming the provider's message", async () => {
    const fetch = stubFetch([
      json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403),
    ]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({ fetch, secrets: CLOUDFLARE_SECRETS }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("HTTP 403");
    expect(result.error.reason).toContain("Authentication error");
    expect(result.error.retryable).toBe(false);
  });

  it("surfaces a 5xx as retryable", async () => {
    const fetch = stubFetch([new Response("upstream boom", { status: 503 })]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({ fetch, secrets: CLOUDFLARE_SECRETS }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("HTTP 503");
    expect(result.error.retryable).toBe(true);
  });

  it("redacts the token out of a provider error payload that echoes it", async () => {
    const fetch = stubFetch([
      json({ errors: [{ message: `bad token ${CF_TOKEN} for ${CF_ACCOUNT}` }] }, 400),
    ]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({ fetch, secrets: CLOUDFLARE_SECRETS }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.logTail).toContain(REDACTION_PLACEHOLDER);
    expectNoSecrets(result, [CF_TOKEN, CF_ACCOUNT]);
  });

  it("rejects a missing secret before any request is made", async () => {
    const fetch = stubFetch([]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({ fetch, secrets: { CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT } }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("CLOUDFLARE_API_TOKEN");
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects a tree over MAX_FILES before any request is made", async () => {
    const fetch = stubFetch([]);
    const files = new Map<string, Uint8Array>();
    for (let i = 0; i <= MAX_FILES; i++) files.set(`f${i}.txt`, new Uint8Array([1]));

    const result = await cloudflarePagesTarget.deploy(
      makeInput({ fetch, files, secrets: CLOUDFLARE_SECRETS }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("too many files");
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects a file over MAX_FILE_BYTES before any request is made", async () => {
    const fetch = stubFetch([]);
    const files = new Map([["big.bin", new Uint8Array(MAX_FILE_BYTES + 1)]]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({ fetch, files, secrets: CLOUDFLARE_SECRETS }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("per-file deploy limit");
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects a total over MAX_TOTAL_BYTES before any request is made", async () => {
    const fetch = stubFetch([]);
    const chunk = Math.floor(MAX_FILE_BYTES);
    const files = new Map<string, Uint8Array>();
    for (let i = 0; i * chunk <= MAX_TOTAL_BYTES; i++)
      files.set(`f${i}.bin`, new Uint8Array(chunk));

    const result = await cloudflarePagesTarget.deploy(
      makeInput({ fetch, files, secrets: CLOUDFLARE_SECRETS }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("total limit");
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects a dir that selects nothing before any request is made", async () => {
    const fetch = stubFetch([]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({
        fetch,
        secrets: CLOUDFLARE_SECRETS,
        config: {
          name: "site",
          target: "cloudflare-pages",
          dir: "dist",
          requiresApproval: false,
        },
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain('under "dist"');
    expect(fetch.calls).toHaveLength(0);
  });

  it("strips the dir prefix from the manifest paths it publishes", async () => {
    const fetch = stubFetch([
      json({ success: true, result: { jwt: "upload-jwt", buckets: [] } }),
      json({ success: true, result: {} }),
    ]);

    const result = await cloudflarePagesTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "dist/index.html": "<h1>hi</h1>", "README.md": "ignored" }),
        secrets: CLOUDFLARE_SECRETS,
        config: {
          name: "site",
          target: "cloudflare-pages",
          dir: "dist",
          requiresApproval: false,
        },
      }),
    );

    expect(result.success).toBe(true);
    const manifest = JSON.parse(String(fetch.calls[0]?.[1].body)) as {
      manifest: Record<string, unknown>;
    };
    expect(Object.keys(manifest.manifest)).toEqual(["/index.html"]);
  });
});

describe("cloudflare-workers target", () => {
  const workerConfig: DeployConfig = {
    name: "api",
    target: "cloudflare-workers",
    requiresApproval: false,
  };

  it("uploads every module with the entry point named in metadata", async () => {
    const fetch = stubFetch([json({ success: true, result: { id: "script-1" } })]);

    const result = await cloudflareWorkersTarget.deploy(
      makeInput({
        fetch,
        files: tree({
          "worker.js": "export default {};",
          "lib/util.js": "export const a = 1;",
          "README.md": "docs",
        }),
        secrets: CLOUDFLARE_SECRETS,
        config: workerConfig,
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.providerId).toBe("script-1");
    // The non-module file is reported, not silently dropped.
    expect(result.data.logTail).toContain("skipped 1");

    const [url, init] = fetch.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1234567890/workers/scripts/api",
    );
    expect(init.method).toBe("PUT");

    const form = init.body as FormData;
    const metadata = JSON.parse(await partText(form, "metadata"));
    expect(metadata.main_module).toBe("worker.js");
    expect(metadata.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(form.get("lib/util.js")).toBeInstanceOf(Blob);
    expect(form.get("README.md")).toBeNull();
    expectNoSecrets(result, [CF_TOKEN]);
  });

  it("prefers an explicit CLOUDFLARE_WORKER_MAIN_MODULE and the CLOUDFLARE_WORKER_NAME override", async () => {
    const fetch = stubFetch([json({ success: true, result: {} })]);

    const result = await cloudflareWorkersTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "worker.js": "export default {};", "src/entry.js": "export default {};" }),
        secrets: {
          ...CLOUDFLARE_SECRETS,
          CLOUDFLARE_WORKER_MAIN_MODULE: "src/entry.js",
          CLOUDFLARE_WORKER_NAME: "renamed",
        },
        config: workerConfig,
      }),
    );

    expect(result.success).toBe(true);
    expect(fetch.calls[0]?.[0]).toContain("/workers/scripts/renamed");
    const form = fetch.calls[0]?.[1].body as FormData;
    const metadata = JSON.parse(await partText(form, "metadata"));
    expect(metadata.main_module).toBe("src/entry.js");
  });

  it("rejects an entry point that is not in the tree before any request is made", async () => {
    const fetch = stubFetch([]);

    const result = await cloudflareWorkersTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "worker.js": "export default {};" }),
        secrets: { ...CLOUDFLARE_SECRETS, CLOUDFLARE_WORKER_MAIN_MODULE: "missing.js" },
        config: workerConfig,
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("missing.js");
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects a tree with no module before any request is made", async () => {
    const fetch = stubFetch([]);

    const result = await cloudflareWorkersTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "index.html": "<h1>hi</h1>" }),
        secrets: CLOUDFLARE_SECRETS,
        config: workerConfig,
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("no .js or .mjs module");
    expect(fetch.calls).toHaveLength(0);
  });

  it("surfaces a 4xx with the provider's reason and no secret", async () => {
    const fetch = stubFetch([
      json({ success: false, errors: [{ message: `token ${CF_TOKEN} lacks permission` }] }, 401),
    ]);

    const result = await cloudflareWorkersTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "worker.js": "export default {};" }),
        secrets: CLOUDFLARE_SECRETS,
        config: workerConfig,
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("HTTP 401");
    expect(result.error.retryable).toBe(false);
    expectNoSecrets(result, [CF_TOKEN, CF_ACCOUNT]);
  });

  it("surfaces a 5xx as retryable", async () => {
    const fetch = stubFetch([new Response("gateway", { status: 502 })]);

    const result = await cloudflareWorkersTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "worker.js": "export default {};" }),
        secrets: CLOUDFLARE_SECRETS,
        config: workerConfig,
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.retryable).toBe(true);
  });

  it("treats a 200 carrying success:false as a failure", async () => {
    const fetch = stubFetch([json({ success: false, errors: [{ message: "nope" }] })]);

    const result = await cloudflareWorkersTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "worker.js": "export default {};" }),
        secrets: CLOUDFLARE_SECRETS,
        config: workerConfig,
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("rejected the script upload");
  });

  it("reports an unreachable provider as retryable without echoing the error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`connect failed for Bearer ${CF_TOKEN}`);
    }) as unknown as DeployFetch;

    const result = await cloudflareWorkersTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "worker.js": "export default {};" }),
        secrets: CLOUDFLARE_SECRETS,
        config: workerConfig,
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.retryable).toBe(true);
    expectNoSecrets(result, [CF_TOKEN]);
  });
});

describe("vercel target", () => {
  const vercelConfig: DeployConfig = {
    name: "production",
    target: "vercel",
    requiresApproval: false,
  };

  it("inlines every file as base64 in a single production deployment request", async () => {
    const fetch = stubFetch([
      json({ id: "dpl_1", url: "site-abc.vercel.app", readyState: "QUEUED" }),
    ]);

    const result = await vercelTarget.deploy(
      makeInput({
        fetch,
        files: tree({ "index.html": "<h1>hi</h1>" }),
        secrets: { ...VERCEL_SECRETS, VERCEL_TEAM_ID: "team_1" },
        config: vercelConfig,
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.url).toBe("https://site-abc.vercel.app");
    expect(result.data.providerId).toBe("dpl_1");
    expect(result.data.state).toBe("QUEUED");

    expect(fetch.calls).toHaveLength(1);
    const [url, init] = fetch.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.vercel.com/v13/deployments?");
    expect(url).toContain("forceNew=1");
    expect(url).toContain("skipAutoDetectionConfirmation=1");
    expect(url).toContain("teamId=team_1");

    const body = JSON.parse(String(init.body));
    expect(body.target).toBe("production");
    expect(body.project).toBe(VERCEL_PROJECT);
    expect(body.files).toEqual([
      { file: "index.html", data: btoa("<h1>hi</h1>"), encoding: "base64" },
    ]);
    expectNoSecrets(result, [VERCEL_TOKEN]);
  });

  it("surfaces a 4xx with the provider's message and no secret", async () => {
    const fetch = stubFetch([
      json({ error: { code: "forbidden", message: `token ${VERCEL_TOKEN} rejected` } }, 403),
    ]);

    const result = await vercelTarget.deploy(
      makeInput({ fetch, secrets: VERCEL_SECRETS, config: vercelConfig }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("HTTP 403");
    expect(result.error.retryable).toBe(false);
    expect(result.error.logTail).toContain(REDACTION_PLACEHOLDER);
    expectNoSecrets(result, [VERCEL_TOKEN, VERCEL_PROJECT]);
  });

  it("surfaces a 5xx as retryable", async () => {
    const fetch = stubFetch([json({ error: { message: "internal" } }, 500)]);

    const result = await vercelTarget.deploy(
      makeInput({ fetch, secrets: VERCEL_SECRETS, config: vercelConfig }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.retryable).toBe(true);
  });

  it("treats a 429 as retryable", async () => {
    const fetch = stubFetch([json({ error: { message: "rate limited" } }, 429)]);

    const result = await vercelTarget.deploy(
      makeInput({ fetch, secrets: VERCEL_SECRETS, config: vercelConfig }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.retryable).toBe(true);
  });

  it("fails when the deployment comes back already in an error state", async () => {
    const fetch = stubFetch([
      json({ id: "dpl_2", readyState: "ERROR", errorMessage: "build failed" }),
    ]);

    const result = await vercelTarget.deploy(
      makeInput({ fetch, secrets: VERCEL_SECRETS, config: vercelConfig }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("ERROR");
    expect(result.error.reason).toContain("build failed");
    expect(result.error.retryable).toBe(true);
  });

  it("does not treat a canceled deployment as retryable", async () => {
    const fetch = stubFetch([json({ id: "dpl_3", readyState: "CANCELED" })]);

    const result = await vercelTarget.deploy(
      makeInput({ fetch, secrets: VERCEL_SECRETS, config: vercelConfig }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.retryable).toBe(false);
  });

  it("rejects a missing secret before any request is made", async () => {
    const fetch = stubFetch([]);

    const result = await vercelTarget.deploy(
      makeInput({ fetch, secrets: { VERCEL_TOKEN }, config: vercelConfig }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("VERCEL_PROJECT_ID");
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects a tree over MAX_FILES before any request is made", async () => {
    const fetch = stubFetch([]);
    const files = new Map<string, Uint8Array>();
    for (let i = 0; i <= MAX_FILES; i++) files.set(`f${i}.txt`, new Uint8Array([1]));

    const result = await vercelTarget.deploy(
      makeInput({ fetch, files, secrets: VERCEL_SECRETS, config: vercelConfig }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("too many files");
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects a file over MAX_FILE_BYTES before any request is made", async () => {
    const fetch = stubFetch([]);
    const files = new Map([["big.bin", new Uint8Array(MAX_FILE_BYTES + 1)]]);

    const result = await vercelTarget.deploy(
      makeInput({ fetch, files, secrets: VERCEL_SECRETS, config: vercelConfig }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("per-file deploy limit");
    expect(fetch.calls).toHaveLength(0);
  });

  it("bounds the inlined request body at roughly a third above the byte limit", () => {
    // The documented cost of resolving PRD Q1 in favour of inlining: this is
    // the number to re-check if MAX_TOTAL_BYTES is ever raised.
    expect(inlineBodyBytes(3)).toBe(4);
    expect(MAX_INLINE_BODY_BYTES).toBe(inlineBodyBytes(MAX_TOTAL_BYTES));
    expect(MAX_INLINE_BODY_BYTES).toBeGreaterThan(MAX_TOTAL_BYTES);
  });

  it("rejects an empty tree before any request is made", async () => {
    const fetch = stubFetch([]);

    const result = await vercelTarget.deploy(
      makeInput({
        fetch,
        files: new Map(),
        secrets: VERCEL_SECRETS,
        config: vercelConfig,
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.reason).toContain("nothing to deploy");
    expect(fetch.calls).toHaveLength(0);
  });
});
