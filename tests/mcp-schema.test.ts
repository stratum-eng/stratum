/**
 * Issue #349: the MCP tool-argument schema layer.
 *
 * The contract this file protects is that `toJsonSchema` and `validate` are two
 * readings of ONE declaration. A model reads the JSON Schema and is judged by
 * the validator, so any disagreement between them shows up as a tool that
 * rejects arguments it advertised as valid — the hardest kind of failure for a
 * model to recover from, because the published contract says it was right.
 */
import { describe, expect, it } from "vitest";
import type { StratumClient } from "../src/mcp/client";
import { type ToolSchema, toJsonSchema, validate } from "../src/mcp/schema";
import { buildTools, toolListing } from "../src/mcp/tools";

const SCHEMA = {
  name: { type: "string", description: "A name" },
  count: { type: "integer", description: "How many" },
  flag: { type: "boolean", description: "On or off" },
  mode: { type: "enum", values: ["fast", "slow"], description: "Which mode" },
  files: { type: "stringMap", description: "Path to content" },
  note: { type: "string", description: "Optional note", optional: true },
} satisfies ToolSchema;

const VALID = {
  name: "x",
  count: 2,
  flag: true,
  mode: "fast",
  files: { "a.txt": "hello" },
};

describe("toJsonSchema", () => {
  it("emits every field, marking only the non-optional ones required", () => {
    const json = toJsonSchema(SCHEMA);
    expect(json.type).toBe("object");
    expect(json.required?.sort()).toEqual(["count", "files", "flag", "mode", "name"]);
    expect(json.required).not.toContain("note");
    expect(json.properties.mode).toMatchObject({ type: "string", enum: ["fast", "slow"] });
    expect(json.properties.files).toMatchObject({
      type: "object",
      additionalProperties: { type: "string" },
    });
    expect(json.properties.count).toMatchObject({ type: "integer" });
  });

  it("omits `required` entirely when nothing is required", () => {
    // `"required": []` is legal but several clients render it as a visible
    // (empty) requirement list.
    expect(toJsonSchema({}).required).toBeUndefined();
    expect(
      toJsonSchema({ a: { type: "string", description: "d", optional: true } }).required,
    ).toBeUndefined();
  });

  it("closes the object, matching the validator's rejection of extra keys", () => {
    expect(toJsonSchema(SCHEMA).additionalProperties).toBe(false);
  });
});

describe("validate", () => {
  it("accepts a well-formed argument object", () => {
    const result = validate(SCHEMA, VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject(VALID);
  });

  it("accepts an optional field and tolerates it being omitted or undefined", () => {
    expect(validate(SCHEMA, { ...VALID, note: "hi" }).ok).toBe(true);
    expect(validate(SCHEMA, { ...VALID, note: undefined }).ok).toBe(true);
  });

  it("collects EVERY problem rather than stopping at the first", () => {
    // A model retrying one field at a time burns a round trip per mistake.
    const result = validate(SCHEMA, {
      name: 1,
      count: 1.5,
      flag: "yes",
      mode: "medium",
      files: { a: 2 },
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(6);
    expect(result.errors.join("\n")).toContain("'name' must be a string");
    expect(result.errors.join("\n")).toContain("'count' must be an integer");
    expect(result.errors.join("\n")).toContain("'flag' must be a boolean");
    expect(result.errors.join("\n")).toContain("'mode' must be one of: fast, slow");
    expect(result.errors.join("\n")).toContain("'files' must map every key to a string");
    expect(result.errors.join("\n")).toContain("unknown argument 'extra'");
  });

  it("names what a missing field was for, so the retry can fill it in", () => {
    const result = validate(SCHEMA, { name: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("missing required argument 'count' (How many)");
  });

  it("rejects a required field explicitly set to null", () => {
    const result = validate(SCHEMA, { ...VALID, name: null });
    expect(result.ok).toBe(false);
  });

  it("rejects an argument payload that is not an object", () => {
    for (const bad of [null, 42, "string", ["a"]]) {
      const result = validate(SCHEMA, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]).toContain("arguments must be an object");
    }
  });

  it("tells a no-argument tool's caller that it takes none", () => {
    const result = validate({}, { anything: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("this tool takes no arguments");
  });

  it("rejects Object.prototype member names as unknown arguments", () => {
    // `"constructor" in {}` is true, so an `in` check would read these as known
    // fields — and they would then be silently DROPPED rather than reported,
    // because the schema's own entries do not include them. That is the one
    // outcome `additionalProperties: false` exists to prevent.
    const result = validate({}, { constructor: 1, toString: "x", __proto__: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("unknown argument 'constructor'");
    expect(result.errors.join("\n")).toContain("unknown argument 'toString'");
  });

  it("rejects a prototype member name alongside a real schema", () => {
    const result = validate(SCHEMA, { ...VALID, hasOwnProperty: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("unknown argument 'hasOwnProperty'");
  });

  it("distinguishes an integer from a float and from a numeric string", () => {
    expect(validate(SCHEMA, { ...VALID, count: 3 }).ok).toBe(true);
    expect(validate(SCHEMA, { ...VALID, count: 3.5 }).ok).toBe(false);
    expect(validate(SCHEMA, { ...VALID, count: "3" }).ok).toBe(false);
  });

  it("rejects an array where a string map is expected", () => {
    // `typeof [] === "object"`, so this needs the explicit array check.
    expect(validate(SCHEMA, { ...VALID, files: ["a.txt"] }).ok).toBe(false);
  });
});

describe("the published tool surface", () => {
  // The client is never called: `toolListing` reads only names, descriptions
  // and schemas, all of which are declared statically.
  const tools = buildTools({} as StratumClient);

  it("publishes a schema every advertised argument can satisfy", () => {
    for (const tool of tools) {
      const json = toJsonSchema(tool.schema);
      // Every required name must exist as a property, or a model following the
      // schema would be told to send a field the validator then rejects as
      // unknown.
      for (const name of json.required ?? []) {
        expect(Object.keys(json.properties), tool.name).toContain(name);
      }
      for (const name of Object.keys(json.properties)) {
        expect(tool.schema[name], `${tool.name}.${name}`).toBeDefined();
      }
    }
  });

  it("gives every tool a unique name and a description worth reading", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.name, tool.name).toMatch(/^stratum_[a-z_]+$/);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });

  it("states the human-gate refusals in the descriptions a model actually reads", () => {
    // A model that does not know `stratum_review_change` will refuse its agent
    // token retries it instead of asking a human.
    const review = tools.find((t) => t.name === "stratum_review_change");
    expect(review?.description).toContain("human gate");
    expect(review?.description).toContain("agent token");
    for (const name of ["stratum_merge_change", "stratum_reject_change"]) {
      expect(tools.find((t) => t.name === name)?.description, name).toContain(
        "agent tokens cannot",
      );
    }
  });

  it("renders a listing whose entries are all well-formed", () => {
    const listing = toolListing(tools);
    expect(listing).toHaveLength(19);
    for (const entry of listing) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect((entry.inputSchema as { type: string }).type).toBe("object");
    }
  });
});
