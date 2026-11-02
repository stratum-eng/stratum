/**
 * Tool argument schemas for the MCP server (#349).
 *
 * MCP requires every tool to publish a JSON Schema in `tools/list`, and the
 * server has to validate what comes back in `tools/call` — the caller is a
 * language model, so malformed arguments are a routine event rather than an
 * exceptional one. Both halves have to agree, or a model reads one contract and
 * is judged against another.
 *
 * Rather than carry a validator library plus a schema converter, the field
 * spec here IS the schema: `toJsonSchema` and `validate` are two
 * readings of the same declaration, so they cannot drift. The tool surface only
 * needs strings, enums, integers, booleans and one string map, which is far
 * less than a general validator would give us and exactly what a hand-written
 * one can guarantee.
 *
 * Validation messages are written for a MODEL to act on: they name the field,
 * say what was wrong, and state what would be right, because the reader's next
 * move is to retry.
 */

export type FieldSpec =
  | { type: "string"; description: string; optional?: true }
  | { type: "integer"; description: string; optional?: true }
  | { type: "boolean"; description: string; optional?: true }
  | { type: "enum"; values: readonly string[]; description: string; optional?: true }
  | { type: "stringMap"; description: string; optional?: true };

export type ToolSchema = Record<string, FieldSpec>;

/** The TypeScript value a validated field yields. */
type FieldValue<F> = F extends { type: "string" }
  ? string
  : F extends { type: "integer" }
    ? number
    : F extends { type: "boolean" }
      ? boolean
      : F extends { type: "enum"; values: readonly (infer V)[] }
        ? V
        : F extends { type: "stringMap" }
          ? Record<string, string>
          : never;

/**
 * The argument object a handler receives: required fields present, optional
 * fields optional. Written as two mapped types over the same schema so a
 * handler that forgets to narrow an optional field is a compile error rather
 * than a runtime `undefined`.
 */
export type SchemaArgs<S extends ToolSchema> = {
  [K in keyof S as S[K] extends { optional: true } ? never : K]: FieldValue<S[K]>;
} & {
  [K in keyof S as S[K] extends { optional: true } ? K : never]?: FieldValue<S[K]>;
};

export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

/** One field's JSON Schema fragment. Enums render as a `string` with an
 * `enum` list, which is what clients display as a picker. */
function fieldToJsonSchema(field: FieldSpec): Record<string, unknown> {
  switch (field.type) {
    case "string":
      return { type: "string", description: field.description };
    case "integer":
      return { type: "integer", description: field.description };
    case "boolean":
      return { type: "boolean", description: field.description };
    case "enum":
      return { type: "string", enum: [...field.values], description: field.description };
    case "stringMap":
      return {
        type: "object",
        description: field.description,
        additionalProperties: { type: "string" },
      };
  }
}

/**
 * Render the schema as JSON Schema for `tools/list`.
 *
 * `additionalProperties: false` is deliberate and matches `validate` below:
 * an unrecognised argument is a mistake worth reporting, not something to
 * quietly drop. A model that misspells `project` should be told, not left to
 * wonder why the tool ignored it.
 */
export function toJsonSchema(schema: ToolSchema): JsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(schema)) {
    properties[name] = fieldToJsonSchema(field);
    if (field.optional !== true) required.push(name);
  }
  const result: JsonSchema = { type: "object", properties, additionalProperties: false };
  // Omitted rather than emitted empty: `"required": []` is legal but several
  // clients render it as a visible (empty) requirement list.
  if (required.length > 0) result.required = required;
  return result;
}

export type ValidationResult<S extends ToolSchema> =
  | { ok: true; value: SchemaArgs<S> }
  | { ok: false; errors: string[] };

/** How a wrong value is named back to the model — "an array" and "null"
 * rather than the bare `typeof`, which calls both of them "object". */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Validate raw tool arguments against a schema.
 *
 * Collects EVERY problem rather than stopping at the first: a model retrying
 * one field at a time burns a round trip per mistake, and the whole list costs
 * us nothing to produce.
 */
export function validate<S extends ToolSchema>(schema: S, raw: unknown): ValidationResult<S> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [`arguments must be an object, got ${describeType(raw)}`] };
  }
  const input = raw as Record<string, unknown>;
  const errors: string[] = [];
  const value: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    // `Object.hasOwn`, never `key in schema`: `in` walks the prototype chain, so
    // `constructor`, `toString` and every other Object.prototype member would
    // read as a known field. They would then be neither reported here nor
    // picked up by the loop below (which iterates the schema's OWN entries),
    // and would vanish silently — the one outcome `additionalProperties: false`
    // exists to prevent.
    if (!Object.hasOwn(schema, key)) {
      const known = Object.keys(schema);
      errors.push(
        known.length === 0
          ? `unknown argument '${key}': this tool takes no arguments`
          : `unknown argument '${key}': expected one of ${known.join(", ")}`,
      );
    }
  }

  for (const [name, field] of Object.entries(schema) as [string, FieldSpec][]) {
    const present = Object.hasOwn(input, name) && input[name] !== undefined;
    if (!present) {
      // `null` is treated as absent above only when the key is missing; an
      // explicit null for a required field falls through to the type error
      // below, which is the more useful message.
      if (field.optional !== true && input[name] !== null) {
        errors.push(`missing required argument '${name}' (${field.description})`);
      } else if (field.optional !== true) {
        errors.push(`argument '${name}' must not be null`);
      }
      continue;
    }
    const supplied = input[name];

    switch (field.type) {
      case "string":
        if (typeof supplied !== "string") {
          errors.push(`argument '${name}' must be a string, got ${describeType(supplied)}`);
        } else {
          value[name] = supplied;
        }
        break;
      case "integer":
        if (typeof supplied !== "number" || !Number.isInteger(supplied)) {
          errors.push(`argument '${name}' must be an integer, got ${describeType(supplied)}`);
        } else {
          value[name] = supplied;
        }
        break;
      case "boolean":
        if (typeof supplied !== "boolean") {
          errors.push(`argument '${name}' must be a boolean, got ${describeType(supplied)}`);
        } else {
          value[name] = supplied;
        }
        break;
      case "enum":
        if (typeof supplied !== "string" || !field.values.includes(supplied)) {
          errors.push(`argument '${name}' must be one of: ${field.values.join(", ")}`);
        } else {
          value[name] = supplied;
        }
        break;
      case "stringMap":
        if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) {
          errors.push(`argument '${name}' must be an object, got ${describeType(supplied)}`);
        } else {
          const entries = Object.entries(supplied as Record<string, unknown>);
          const bad = entries.filter(([, v]) => typeof v !== "string").map(([k]) => k);
          if (bad.length > 0) {
            errors.push(
              `argument '${name}' must map every key to a string; these are not: ${bad.join(", ")}`,
            );
          } else {
            value[name] = Object.fromEntries(entries) as Record<string, string>;
          }
        }
        break;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as SchemaArgs<S> };
}
