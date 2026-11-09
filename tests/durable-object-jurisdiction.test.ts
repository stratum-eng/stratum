/// <reference types="vite/client" />
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { configGuardMiddleware, doJurisdictionConfigError } from "../src/middleware/config-guard";
import type { Env } from "../src/types";
import typesSource from "../src/types.ts?raw";
import {
  DO_JURISDICTIONS,
  DURABLE_OBJECT_BINDINGS,
  DurableObjectJurisdictionError,
  durableObjectNamespace,
  parseDoJurisdiction,
} from "../src/utils/durable-objects";
import wranglerToml from "../wrangler.toml?raw";

/**
 * `DO_JURISDICTION` backs a data-residency claim (issue #453), and the claim is
 * only as good as its weakest call site: one `env.REPO_DO.idFromName()` that
 * skips the helper puts that object outside the region, silently, with every
 * test still green. So besides the helper's own behaviour, this file scans the
 * source for any use of a Durable Object binding that does not go through it.
 */

const HELPER = "../src/utils/durable-objects.ts";
// `types.ts` declares the bindings; the helper reads them. Nothing else may.
const ALLOWED_FILES = new Set([HELPER, "../src/types.ts"]);

const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Blanks comments while keeping line numbers, so prose that names a binding
 * ("USAGE_METER is deliberately absent from this cascade") is not a finding.
 * String literals are kept: `env["REPO_DO"]` is an access the scan must see.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const BINDING = `(?:${DURABLE_OBJECT_BINDINGS.join("|")})`;

/**
 * Every way a binding can be read off an env object: `env.X`, `env?.X`,
 * `env["X"]`, and destructuring or shorthand (`{ X }`, `{ X: alias }`).
 * `Env["X"]` — a type lookup — is the one bracket form that is not an access.
 */
const DIRECT_ACCESS = [
  new RegExp(`\\.\\s*${BINDING}\\b`),
  new RegExp(`(?<!\\bEnv)\\[\\s*["'\`]${BINDING}["'\`]\\s*\\]`),
  new RegExp(`[{,]\\s*${BINDING}\\s*[,}:=]`),
  // The same, with one name per line.
  new RegExp(`^\\s*${BINDING}\\s*[,}:=]`),
];

/** A jurisdiction set anywhere but the helper is a second source of truth. */
const JURISDICTION_CALL = /\.\s*jurisdiction\s*\(|\bjurisdiction\s*:/;

function findings(path: string, source: string): string[] {
  const out: string[] = [];
  const lines = stripComments(source).split("\n");
  lines.forEach((line, index) => {
    if (DIRECT_ACCESS.some((pattern) => pattern.test(line)) || JURISDICTION_CALL.test(line)) {
      out.push(`${path.replace("../", "")}:${index + 1}: ${line.trim()}`);
    }
  });
  return out;
}

describe("Durable Object namespaces are only reached through durableObjectNamespace", () => {
  it("scans a non-trivial number of source files, including the known call sites", () => {
    const paths = Object.keys(sources);
    expect(paths.length).toBeGreaterThan(100);
    for (const expected of [
      HELPER,
      "../src/routes/changes.ts",
      "../src/routes/email-auth.tsx",
      "../src/billing/enforcement.ts",
      "../src/storage/deletion.ts",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("finds no direct binding access outside the helper", () => {
    const all = Object.entries(sources)
      .filter(([path]) => !ALLOWED_FILES.has(path))
      .flatMap(([path, source]) => findings(path, source));
    expect(
      all,
      'Use durableObjectNamespace(env, "<BINDING>") from src/utils/durable-objects.ts instead of reading the binding directly — a direct read ignores DO_JURISDICTION.',
    ).toEqual([]);
  });

  // The scan above passing proves nothing unless the scanner can fail.
  it.each([
    ["property access", "const stub = c.env.REPO_DO.get(c.env.REPO_DO.idFromName(id));"],
    ["optional chaining", "const ns = env?.USAGE_METER;"],
    ["bracket access", 'const ns = env["MERGE_QUEUE"];'],
    ["destructuring", "const { MAGIC_LINK_LIMITER } = env;"],
    ["destructuring with an alias", "const { DB, REPO_DO: repo } = c.env;"],
    ["a multi-line destructure", "  USAGE_METER,"],
    ["a second jurisdiction call", 'const eu = namespace.jurisdiction("eu");'],
    ["a per-id jurisdiction", 'const id = ns.newUniqueId({ jurisdiction: "eu" });'],
  ])("flags %s", (_label, line) => {
    expect(findings("../src/example.ts", line)).toHaveLength(1);
  });

  it.each([
    ["the helper call", 'const ns = durableObjectNamespace(c.env, "REPO_DO");'],
    ["a type lookup", 'namespace: NonNullable<Env["USAGE_METER"]>,'],
    ["the kill switch, which is a different variable", 'c.env.REPO_DO_ENABLED === "true"'],
    ["a log message", 'logger.error("MAGIC_LINK_LIMITER is not bound");'],
    ["a line comment", "// env.REPO_DO is read by the helper"],
    ["a block comment", "/* MERGE_QUEUE and env.REPO_DO are untyped */"],
  ])("does not flag %s", (_label, line) => {
    expect(findings("../src/example.ts", line)).toEqual([]);
  });

  it("covers every Durable Object binding declared in wrangler.toml, in every environment", () => {
    const declared = [
      ...wranglerToml.matchAll(
        /^\[\[(?:env\.\w+\.)?durable_objects\.bindings\]\]\s*\nname = "(\w+)"/gm,
      ),
    ].map((match) => match[1]);
    // Top level, production and staging each declare all of them.
    expect(declared.length).toBe(DURABLE_OBJECT_BINDINGS.length * 3);
    expect([...new Set(declared)].sort()).toEqual([...DURABLE_OBJECT_BINDINGS].sort());
  });

  it("covers every Durable Object namespace declared on Env", () => {
    const declared = [...typesSource.matchAll(/^\s*(\w+)\??:\s*DurableObjectNamespace\b/gm)].map(
      (match) => match[1],
    );
    expect(declared.sort()).toEqual([...DURABLE_OBJECT_BINDINGS].sort());
  });
});

describe("parseDoJurisdiction", () => {
  it("treats unset and empty as no restriction", () => {
    expect(parseDoJurisdiction(undefined)).toEqual({ success: true, data: null });
    expect(parseDoJurisdiction("")).toEqual({ success: true, data: null });
  });

  it.each(DO_JURISDICTIONS)("accepts %s", (jurisdiction) => {
    expect(parseDoJurisdiction(jurisdiction)).toEqual({ success: true, data: jurisdiction });
  });

  // Each of these is something an operator could plausibly type believing it
  // means "EU". None may be normalised, and none may fall back to unrestricted.
  it.each(["EU", " eu", "eu ", "europe", "weur", "eu,us", "true", "fedramp-high", " "])(
    "rejects %j",
    (raw) => {
      const parsed = parseDoJurisdiction(raw);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error).toContain("DO_JURISDICTION");
        expect(parsed.error).toContain(JSON.stringify(raw));
        expect(parsed.error).toContain('"eu"');
      }
    },
  );
});

/** A namespace whose `jurisdiction()` returns a distinguishable subnamespace. */
function fakeNamespace() {
  const restricted = { restricted: true };
  const jurisdiction = vi.fn(() => restricted);
  const namespace = { jurisdiction } as unknown as NonNullable<Env["REPO_DO"]>;
  return { namespace, restricted, jurisdiction };
}

describe("durableObjectNamespace", () => {
  it("returns the binding untouched when no jurisdiction is configured", () => {
    const { namespace, jurisdiction } = fakeNamespace();
    expect(durableObjectNamespace({ REPO_DO: namespace }, "REPO_DO")).toBe(namespace);
    expect(durableObjectNamespace({ REPO_DO: namespace, DO_JURISDICTION: "" }, "REPO_DO")).toBe(
      namespace,
    );
    expect(jurisdiction).not.toHaveBeenCalled();
  });

  it.each(DO_JURISDICTIONS)("returns the %s subnamespace when configured", (configured) => {
    const { namespace, restricted, jurisdiction } = fakeNamespace();
    const resolved = durableObjectNamespace(
      { REPO_DO: namespace, DO_JURISDICTION: configured },
      "REPO_DO",
    );
    expect(resolved).toBe(restricted);
    expect(jurisdiction).toHaveBeenCalledExactlyOnceWith(configured);
  });

  it.each(DURABLE_OBJECT_BINDINGS)("restricts the %s binding", (binding) => {
    const { namespace, restricted } = fakeNamespace();
    const env = { [binding]: namespace, DO_JURISDICTION: "eu" } as Pick<
      Env,
      typeof binding | "DO_JURISDICTION"
    >;
    expect(durableObjectNamespace(env, binding)).toBe(restricted);
  });

  it("returns undefined for an unbound namespace, restricted or not", () => {
    expect(durableObjectNamespace({}, "MERGE_QUEUE")).toBeUndefined();
    expect(durableObjectNamespace({ DO_JURISDICTION: "eu" }, "MERGE_QUEUE")).toBeUndefined();
  });

  it("throws on an invalid jurisdiction instead of handing back the unrestricted namespace", () => {
    const { namespace, jurisdiction } = fakeNamespace();
    expect(() =>
      durableObjectNamespace({ REPO_DO: namespace, DO_JURISDICTION: "EU" }, "REPO_DO"),
    ).toThrow(DurableObjectJurisdictionError);
    expect(jurisdiction).not.toHaveBeenCalled();
  });

  it("throws on an invalid jurisdiction even when the binding is absent", () => {
    // Otherwise a caller that treats `undefined` as "feature off" would carry
    // on, and the misconfiguration would surface only on a deploy that binds it.
    expect(() => durableObjectNamespace({ DO_JURISDICTION: "europe" }, "USAGE_METER")).toThrow(
      /DO_JURISDICTION/,
    );
  });
});

describe("config guard: DO_JURISDICTION", () => {
  function appWith(env: Partial<Env>) {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", configGuardMiddleware);
    app.get("/health", (c) => c.text("ok"));
    return (path: string) => app.request(path, {}, env as Env);
  }

  it("reports nothing for an unset or supported value", () => {
    expect(doJurisdictionConfigError({})).toBeNull();
    expect(doJurisdictionConfigError({ DO_JURISDICTION: "" })).toBeNull();
    expect(doJurisdictionConfigError({ DO_JURISDICTION: "eu" })).toBeNull();
  });

  it("names the variable and the bad value for an unsupported one", () => {
    const problem = doJurisdictionConfigError({ DO_JURISDICTION: "EU" });
    expect(problem).toContain("DO_JURISDICTION");
    expect(problem).toContain('"EU"');
  });

  it("serves requests when the jurisdiction is unset or valid", async () => {
    expect((await appWith({})("/health")).status).toBe(200);
    expect((await appWith({ DO_JURISDICTION: "eu" })("/health")).status).toBe(200);
  });

  it("answers 503 to every request when the jurisdiction is invalid", async () => {
    const request = appWith({ DO_JURISDICTION: "EU" });
    // Twice: the refusal must not be a once-per-isolate event like the log line.
    for (const path of ["/health", "/health", "/api/projects"]) {
      const response = await request(path);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain("DO_JURISDICTION");
      // The configured value belongs in the logs, not in a public response.
      expect(body).not.toContain("EU");
    }
  });
});
