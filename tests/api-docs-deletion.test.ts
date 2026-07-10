import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// This suite validates the API documentation added by this PR:
//   - docs/api/openapi.yml (new DELETE paths for projects + users)
//   - docs/api/endpoints/projects.md (new "Delete Project" section)
//   - docs/api/endpoints/users.md (new "Delete Account" section)
//
// It is not a test of the route implementations (those are covered in
// tests/deletion-routes.test.ts) — it verifies the *documentation itself*
// is well-formed and internally consistent.

const OPENAPI_PATH = join(__dirname, "../docs/api/openapi.yml");
const PROJECTS_MD_PATH = join(__dirname, "../docs/api/endpoints/projects.md");
const USERS_MD_PATH = join(__dirname, "../docs/api/endpoints/users.md");

type OpenApiDoc = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
};

type Operation = {
  summary?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: { type?: string };
  }>;
  requestBody?: {
    required?: boolean;
    content?: {
      "application/json"?: {
        schema?: {
          type?: string;
          properties?: Record<string, { type?: string; description?: string }>;
        };
      };
    };
  };
  responses?: Record<string, { description?: string }>;
};

function loadOpenApiDoc(): OpenApiDoc {
  const raw = readFileSync(OPENAPI_PATH, "utf-8");
  return YAML.parse(raw) as OpenApiDoc;
}

describe("docs/api/openapi.yml", () => {
  it("parses as valid YAML", () => {
    const raw = readFileSync(OPENAPI_PATH, "utf-8");
    expect(() => YAML.parse(raw)).not.toThrow();
  });

  it("still declares the pre-existing paths (no regressions from the append)", () => {
    const doc = loadOpenApiDoc();
    expect(doc.paths).toHaveProperty("/health");
    expect(doc.paths).toHaveProperty("/api/projects");
    expect(doc.paths["/api/projects"]).toHaveProperty("get");
    expect(doc.paths["/api/projects"]).toHaveProperty("post");
  });

  describe("DELETE /api/projects/{namespace}/{slug}", () => {
    function getOperation(): Operation {
      const doc = loadOpenApiDoc();
      const path = doc.paths["/api/projects/{namespace}/{slug}"];
      expect(path).toBeDefined();
      const op = path.delete as Operation;
      expect(op).toBeDefined();
      return op;
    }

    it("declares required path parameters namespace and slug as strings", () => {
      const op = getOperation();
      expect(op.parameters).toHaveLength(2);

      const namespaceParam = op.parameters?.find((p) => p.name === "namespace");
      expect(namespaceParam).toMatchObject({
        in: "path",
        required: true,
        schema: { type: "string" },
      });

      const slugParam = op.parameters?.find((p) => p.name === "slug");
      expect(slugParam).toMatchObject({
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    });

    it("requires a JSON request body with a string confirm field", () => {
      const op = getOperation();
      expect(op.requestBody?.required).toBe(true);
      const schema = op.requestBody?.content?.["application/json"]?.schema;
      expect(schema?.type).toBe("object");
      expect(schema?.properties?.confirm?.type).toBe("string");
    });

    it("documents 202, 400, and 404 responses", () => {
      const op = getOperation();
      expect(Object.keys(op.responses ?? {}).sort()).toEqual(["202", "400", "404"]);
      expect(op.responses?.["202"]?.description).toMatch(/deletion enqueued/i);
      expect(op.responses?.["400"]?.description).toMatch(/confirmation mismatch/i);
      expect(op.responses?.["404"]?.description).toMatch(/not found|not the owner/i);
    });

    it("has a summary noting owner-only, cascading, async semantics", () => {
      const op = getOperation();
      expect(op.summary).toMatch(/owner-only/i);
      expect(op.summary).toMatch(/cascading/i);
      expect(op.summary).toMatch(/async/i);
    });
  });

  describe("DELETE /api/users/me", () => {
    function getOperation(): Operation {
      const doc = loadOpenApiDoc();
      const path = doc.paths["/api/users/me"];
      expect(path).toBeDefined();
      const op = path.delete as Operation;
      expect(op).toBeDefined();
      return op;
    }

    it("has no path parameters (self-only, derived from auth)", () => {
      const op = getOperation();
      expect(op.parameters).toBeUndefined();
    });

    it("requires a JSON request body with a string confirm field", () => {
      const op = getOperation();
      expect(op.requestBody?.required).toBe(true);
      const schema = op.requestBody?.content?.["application/json"]?.schema;
      expect(schema?.type).toBe("object");
      expect(schema?.properties?.confirm?.type).toBe("string");
    });

    it("documents only 202 and 400 responses (no 404 — self-only, always resolves)", () => {
      const op = getOperation();
      expect(Object.keys(op.responses ?? {}).sort()).toEqual(["202", "400"]);
      expect(op.responses?.["202"]?.description).toMatch(/erasure enqueued/i);
      expect(op.responses?.["202"]?.description).toMatch(/credentials invalidated immediately/i);
      expect(op.responses?.["400"]?.description).toMatch(/confirmation mismatch/i);
    });

    it("has a summary noting GDPR erasure, self-only, async semantics", () => {
      const op = getOperation();
      expect(op.summary).toMatch(/gdpr/i);
      expect(op.summary).toMatch(/self-only/i);
      expect(op.summary).toMatch(/async/i);
    });
  });
});

describe("docs/api/endpoints/projects.md", () => {
  const content = readFileSync(PROJECTS_MD_PATH, "utf-8");

  it("documents the DELETE endpoint under a 'Delete Project' heading", () => {
    expect(content).toMatch(/## Delete Project/);
    expect(content).toMatch(/`DELETE \/api\/projects\/\{namespace\}\/\{slug\}`/);
  });

  it("still contains the pre-existing sections (no content was clobbered)", () => {
    expect(content).toMatch(/## List Projects/);
    expect(content).toMatch(/## Create Project/);
    expect(content).toMatch(/## Get Project/);
    expect(content).toMatch(/## Import from GitHub/);
  });

  it("shows a valid JSON example for the confirm body", () => {
    const match = content.match(/```json\s*\n(.*)\n```/);
    expect(match).not.toBeNull();
    const example = JSON.parse(match?.[1] ?? "");
    expect(example).toEqual({ confirm: "@namespace/slug" });
  });

  it("documents owner-only access and the 202/400/404 status codes", () => {
    expect(content).toMatch(/\*\*Owner-only\.\*\*/);
    expect(content).toMatch(/`202 Accepted`/);
    expect(content).toMatch(/returns `400`/);
    expect(content).toMatch(/returns `404`/);
  });

  it("mentions the async, idempotent/resumable cascade and job response shape", () => {
    expect(content).toMatch(/asynchronously/);
    expect(content).toMatch(/idempotent\/resumable/);
    expect(content).toMatch(/"status":\s*"deleting"/);
    expect(content).toMatch(/"jobId":\s*"del_/);
  });
});

describe("docs/api/endpoints/users.md", () => {
  const content = readFileSync(USERS_MD_PATH, "utf-8");
  // Prose in this file is hand-wrapped across lines, so collapse whitespace
  // (including embedded newlines) for assertions that span line breaks.
  const flat = content.replace(/\s+/g, " ");

  it("documents the DELETE endpoint under a 'Delete Account' heading", () => {
    expect(content).toMatch(/## Delete Account/);
    expect(content).toMatch(/`DELETE \/api\/users\/me`/);
  });

  it("still contains the pre-existing 'Get Current User' section", () => {
    expect(content).toMatch(/## Get Current User/);
    expect(content).toMatch(/`GET \/api\/users`/);
  });

  it("shows a request-body example confirming with the username placeholder", () => {
    const match = content.match(/```json\s*\n(.*)\n```/);
    expect(match).not.toBeNull();
    const example = JSON.parse(match?.[1] ?? "");
    expect(example).toEqual({ confirm: "<your-username>" });
  });

  it("describes cascading effects: owned projects, token/session revocation, contribution anonymization", () => {
    expect(flat).toMatch(/account and \*\*all\*\* owned projects/i);
    expect(flat).toMatch(/revokes all tokens\/sessions/);
    expect(content).toMatch(/anonymizes/);
    expect(content).toMatch(/deleted-user/);
  });

  it("documents immediate credential invalidation and the 202/400 status codes", () => {
    expect(flat).toMatch(/immediately invalidates the caller's credentials/);
    expect(flat).toMatch(/subsequent requests return `401`/);
    expect(content).toMatch(/`202 Accepted`/);
    expect(flat).toMatch(/mismatched `confirm` returns `400`/);
  });

  it("notes that org sole-ownership is auto-resolved and never blocks erasure", () => {
    expect(flat).toMatch(/org sole-ownership is auto-resolved/);
    expect(flat).toMatch(/never blocking erasure/);
  });
});

describe("consistency between openapi.yml and the markdown docs", () => {
  const doc = loadOpenApiDoc();
  const projectsMd = readFileSync(PROJECTS_MD_PATH, "utf-8");
  const usersMd = readFileSync(USERS_MD_PATH, "utf-8");

  it("project deletion: markdown status codes match the spec's documented responses", () => {
    const op = doc.paths["/api/projects/{namespace}/{slug}"].delete as Operation;
    for (const status of Object.keys(op.responses ?? {})) {
      expect(projectsMd).toContain(`\`${status}`);
    }
  });

  it("account deletion: markdown status codes match the spec's documented responses", () => {
    const op = doc.paths["/api/users/me"].delete as Operation;
    for (const status of Object.keys(op.responses ?? {})) {
      expect(usersMd).toContain(`\`${status}`);
    }
  });

  it("account deletion spec omits a 404 response, matching the self-only (no path lookup) design", () => {
    const op = doc.paths["/api/users/me"].delete as Operation;
    expect(op.responses).not.toHaveProperty("404");
  });
});