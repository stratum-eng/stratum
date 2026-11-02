/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs build script, no type declarations
import { buildIndex } from "../website/scripts/emit-agent-skills.mjs";
// @ts-expect-error - plain .js Worker entry point, no type declarations
import docsWorker from "../website/worker/index.js";

/**
 * Guards the machine-readable discovery surface the docs site publishes for
 * agents: the ARD capability manifest, the Agent Skills index, auth.md, the
 * WebMCP registration, and the DNS-AID zone records — plus the Worker behaviour
 * (content types, CORS, Link header) they depend on, and the OAuth documents
 * Stratum deliberately does not publish.
 *
 * These are files no human reads and no page renders, so nothing else fails
 * when one of them drifts. A stale skill digest, a manifest entry that lost its
 * `representativeQueries`, or a missing `Access-Control-Allow-Origin` all
 * degrade silently — the documents keep serving 200 and agents quietly stop
 * being able to use them.
 *
 * Files are loaded through Vite's raw glob rather than `node:fs`, so the suite
 * type-checks under the Workers tsconfig (same reason as `migrations.test.ts`).
 */

const SITE = "https://docs.usestratum.dev";
const SKILLS_DIR = new URL("../website/public/.well-known/agent-skills", import.meta.url).pathname;

const globbed = {
  ...import.meta.glob("../website/public/.well-known/**/*", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../website/public/*.{md,js,txt}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../website/dns/*.zone", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

/** The one authored (not mirrored) page whose prose this suite asserts on. */
const AGENT_DISCOVERY_PAGE = Object.values(
  import.meta.glob("../website/src/content/docs/reference/agent-discovery.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0] as string;

/**
 * Every route Starlight publishes from `src/content/docs/`, as the trailing-slash
 * paths the site actually serves. Only the keys matter here, so the modules are
 * globbed lazily — the bodies are never read.
 */
const docRoutes = Object.keys(import.meta.glob("../website/src/content/docs/**/*.{md,mdx}")).map(
  (path) => {
    const slug = path
      .replace("../website/src/content/docs/", "")
      .replace(/\.mdx?$/, "")
      .replace(/(^|\/)index$/, "");
    return `/${slug}${slug ? "/" : ""}`;
  },
);

const files: Record<string, string> = {};
for (const [path, contents] of Object.entries(globbed)) {
  files[path.replace("../website/public/", "").replace("../website/", "")] = contents;
}

const read = (path: string): string => {
  const contents = files[path];
  if (contents === undefined)
    throw new Error(`${path} is not published (have: ${Object.keys(files).join(", ")})`);
  return contents;
};
// biome-ignore lint/suspicious/noExplicitAny: parsed metadata documents are schemaless by nature
const readJson = (path: string): any => JSON.parse(read(path));

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Minimal stand-in for the Workers assets binding: 200s anything published
 * under `public/`, 404s everything else. Enough to exercise the Worker's
 * routing, content-type overrides, and CORS without workerd.
 */
const assetsEnv = {
  ASSETS: {
    fetch(request: Request) {
      const path = new URL(request.url).pathname.replace(/^\//, "");
      const body = files[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      const type = path.endsWith(".json")
        ? "application/json"
        : path.endsWith(".md")
          ? "text/markdown"
          : "text/plain";
      return new Response(body, { headers: { "content-type": type } });
    },
  },
};

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  docsWorker.fetch(new Request(`${SITE}${path}`, { headers }), assetsEnv);

describe("ARD capability manifest", () => {
  it("carries the fields the spec requires", () => {
    const manifest = readJson(".well-known/ai-catalog.json");

    expect(manifest.specVersion).toBeTruthy();
    expect(manifest.host.displayName).toBeTruthy();
    expect(manifest.host.identifier).toBeTruthy();
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  it("gives every entry a urn:air identifier, one locator, and 2-5 queries", () => {
    for (const entry of readJson(".well-known/ai-catalog.json").entries) {
      expect(entry.identifier).toMatch(/^urn:air:docs\.usestratum\.dev:[a-z0-9-]+:[a-z0-9-]+$/);
      expect(entry.displayName).toBeTruthy();
      // An IANA media type, not a free-form label — registries key off it.
      expect(entry.type).toMatch(/^[a-z]+\/[a-zA-Z0-9.+-]+$/);
      // "Exactly one of url or data": a manifest carrying both is ambiguous
      // about which the agent should trust.
      expect("url" in entry !== "data" in entry).toBe(true);
      expect(entry.representativeQueries.length).toBeGreaterThanOrEqual(2);
      expect(entry.representativeQueries.length).toBeLessThanOrEqual(5);
    }
  });

  it("has no duplicate entry identifiers", () => {
    const ids = readJson(".well-known/ai-catalog.json").entries.map(
      (e: { identifier: string }) => e.identifier,
    );

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("agent skills discovery index", () => {
  it("matches what the generator produces from the committed SKILL.md files", async () => {
    // The digests are the whole point of the index; one that has drifted from
    // its skills makes a correct download look tampered with.
    expect(readJson(".well-known/agent-skills/index.json")).toEqual(
      await buildIndex(SKILLS_DIR, SITE),
    );
  });

  it("declares the RFC v0.2.0 schema and a well-formed entry per skill", () => {
    const index = readJson(".well-known/agent-skills/index.json");

    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    // v0.2.0 replaced the v0.1.0 top-level `version` field with `$schema`.
    // Carrying both makes the document claim two format versions at once.
    expect(index.version).toBeUndefined();
    expect(index.skills.length).toBeGreaterThan(0);

    for (const skill of index.skills) {
      expect(skill.name).toMatch(/^[a-z0-9-]+$/);
      expect(skill.type).toBe("skill-md");
      expect(skill.description).toBeTruthy();
      expect(skill.url).toBe(`${SITE}/.well-known/agent-skills/${skill.name}/SKILL.md`);
      expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("publishes a digest that verifies against the served bytes", async () => {
    for (const skill of readJson(".well-known/agent-skills/index.json").skills) {
      const served = read(`.well-known/agent-skills/${skill.name}/SKILL.md`);
      expect(skill.digest).toBe(`sha256:${await sha256(served)}`);
    }
  });
});

describe("OAuth metadata, which belongs on the API origin", () => {
  // Stratum IS an OAuth 2.1 authorization server now (#349) — for `/mcp`, on
  // `app.usestratum.dev`. What follows is about which ORIGIN serves the
  // metadata, not whether it exists. The distinction is the whole point: these
  // documents were absent before because there was nothing to describe, and are
  // absent here because a client derives their URLs from an origin these docs
  // do not serve.

  it("serves no authorization-server or protected-resource metadata from the docs origin", () => {
    // RFC 9728 §3 has a client derive the protected-resource URL from the
    // resource's own origin, RFC 8414 §3 the AS URL from the issuer's. Both
    // land on https://app.usestratum.dev. A copy here would be found only by
    // agents that already knew to look, while every spec-compliant client got a
    // 404 from the origin that matters.
    expect(() => read(".well-known/oauth-authorization-server")).toThrow();
    expect(() => read(".well-known/oauth-protected-resource")).toThrow();

    // A docs-origin LOCATOR is the failure mode, not the string: naming the
    // API origin's document absolutely (as the server card does) is correct.
    for (const file of [".well-known/ai-catalog.json", "webmcp.js"]) {
      expect(read(file), file).not.toContain(`${SITE}/.well-known/oauth-`);
    }
  });

  it("publishes no OIDC metadata, because Stratum is not an OIDC provider", () => {
    // Opaque access tokens, checked against the database on the call that
    // presents them. There is no jwks_uri and no ID token to validate offline.
    expect(() => read(".well-known/openid-configuration")).toThrow();
  });

  it("names the protected resource and its issuer in the server card, so agents still find them", () => {
    // The docs origin serving neither document is only defensible because the
    // card carries the absolute URL of one and the issuer the other is derived
    // from. Absent that, an agent walking the catalogue reaches a dead end.
    const card = readJson(".well-known/mcp/server-card.json");

    expect(card.authentication.type).toBe("oauth2");
    expect(card.authentication.protected_resource_metadata).toBe(
      "https://app.usestratum.dev/.well-known/oauth-protected-resource",
    );
    expect(card.authentication.authorization_servers).toContain("https://app.usestratum.dev");
  });

  it("no longer tells agents Stratum is not an authorization server", () => {
    // Both documents said exactly that, in prose, until #349 made it false —
    // and nothing failed when it did. An agent that believes it will not
    // attempt the flow that now works.
    // A renamed or moved page must fail here rather than vacuously pass.
    expect(typeof AGENT_DISCOVERY_PAGE, "agent-discovery.md was not globbed").toBe("string");

    for (const [name, text] of [
      ["auth.md", read("auth.md")],
      ["reference/agent-discovery.md", AGENT_DISCOVERY_PAGE],
    ] as const) {
      expect(text, name).not.toMatch(/not an OAuth authorization server/i);
      expect(text, name).not.toMatch(
        /no `?\/?\.well-known\/oauth-authorization-server`? document is/i,
      );
    }
  });
});

describe("auth.md", () => {
  it("leads with an h1 naming itself, which is how agents identify it", () => {
    const h1 = read("auth.md")
      .split("\n")
      .find((line) => line.startsWith("# "));

    expect(h1?.toLowerCase()).toContain("auth.md");
  });

  it("does not claim user-token rotation or expiry revokes an agent", () => {
    const revocation = read("auth.md").split("## Revocation")[1]?.split("\n## ")[0] ?? "";

    expect(revocation, "auth.md has no Revocation section").not.toBe("");

    expect(revocation).toContain("DELETE /api/agents/");
    expect(revocation).toMatch(/do not expire/);
    expect(revocation).not.toMatch(/expire on their own/);
  });

  it("states the registration endpoint and the human-approval invariant", () => {
    const authMd = read("auth.md");

    expect(authMd).toContain("https://app.usestratum.dev/api/agents");
    expect(authMd).toContain("Authorization: Bearer");
    expect(authMd).toMatch(/never approve a change/i);
  });
});

describe("WebMCP registration", () => {
  it("registers tools with a name, description, inputSchema, and execute", () => {
    // A structural read of the source rather than a DOM harness: the file is a
    // plain IIFE, and what matters is that every tool is complete.
    const script = read("webmcp.js");
    const names = [...script.matchAll(/^ {6}name: "([a-z_]+)",$/gm)].map((match) => match[1]);

    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const key of ["description:", "inputSchema:", "execute:"]) {
      expect(script.split(key).length - 1, key).toBeGreaterThanOrEqual(names.length);
    }
  });

  it("lists every page the docs site publishes", () => {
    // `list_stratum_docs` promises "every page", and an agent that believes it
    // will never look for a page the array forgot. Nothing else notices: the
    // page renders, the sitemap has it, and the tool keeps returning 200.
    const listed = [...read("webmcp.js").matchAll(/^ {4}\["([^"]+)", "[^"]*"\],$/gm)].map(
      (match) => match[1],
    );

    expect(docRoutes.length).toBeGreaterThan(1);
    expect(listed.sort()).toEqual(docRoutes.sort());
  });

  it("uses provideContext and degrades to registerTool", () => {
    const script = read("webmcp.js");

    expect(script).toContain("provideContext({ tools })");
    expect(script).toContain("ctx.registerTool(tool)");
    // Must not throw in a browser without the API, which is all of them today.
    expect(script).toContain("if (!ctx) return;");
  });
});

describe("DNS-AID zone records", () => {
  it("publishes ServiceMode SVCB records under the _agents namespace", () => {
    const zone = read("dns/agents.zone");
    const records = [
      ...zone.matchAll(/^(_[\w.-]+\._agents\.[\w.-]+\.)\s+\d+\s+IN\s+SVCB\s+(\d+)/gm),
    ];

    expect(records.length).toBeGreaterThanOrEqual(3);
    // Priority 0 is AliasMode, which carries no SvcParams at all.
    for (const record of records) expect(Number(record[2])).toBeGreaterThan(0);
    expect(zone).toContain("_index._agents.usestratum.dev.");
    expect(zone).toContain("_index._agents.docs.usestratum.dev.");
  });

  it("sets alpn and port on every record and marks them mandatory", () => {
    for (const block of read("dns/agents.zone").split(/^_/m).slice(1)) {
      expect(block).toMatch(/alpn="[^"]+"/);
      expect(block).toMatch(/port=\d+/);
      expect(block).toContain("mandatory=alpn,port");
      // An unregistered SvcParamKey travels in RFC 9460's private-use range and
      // must stay out of `mandatory`, or a client that does not know the key is
      // required to discard the whole record.
      expect(block).not.toMatch(/mandatory=[\w,]*key\d/);
    }
  });
});

describe("docs Worker", () => {
  it("allows cross-origin reads of the metadata agents need", async () => {
    for (const path of [
      "/.well-known/ai-catalog.json",
      "/.well-known/agent-skills/index.json",
      "/auth.md",
      // Listed as an entry point on the agent-discovery page, under a blanket
      // promise that every listed document allows cross-origin reads.
      "/sitemap-index.xml",
      // The numbered file Astro's sitemap plugin emits alongside the index —
      // the index itself carries only <loc> pointers, so the actual page URLs
      // live here.
      "/sitemap-0.xml",
    ]) {
      expect((await get(path)).headers.get("access-control-allow-origin"), path).toBe("*");
    }
  });

  it("answers a preflight on a metadata path instead of letting it 404", async () => {
    const response: Response = await docsWorker.fetch(
      new Request(`${SITE}/.well-known/ai-catalog.json`, { method: "OPTIONS" }),
      assetsEnv,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("leaves ordinary pages same-origin", async () => {
    expect((await get("/index.md")).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("advertises every discovery entry point in the Link header", async () => {
    // Asking for Markdown exercises the negotiated path — the one an agent hits
    // when it wants source rather than rendered HTML.
    const link = (await get("/", { accept: "text/markdown" })).headers.get("link") ?? "";

    for (const path of [
      "/.well-known/ai-catalog.json",
      "/.well-known/agent-skills/index.json",
      "/auth.md",
    ]) {
      expect(link, path).toContain(`<${path}>`);
    }
  });
});
