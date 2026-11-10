/**
 * The title and description a person or agent gives a change.
 *
 * Kept apart from the routes because three front doors take them (the create
 * route, the edit route and the MCP tools behind both) and they must agree on
 * what is accepted.
 */
import { type Result, err, ok } from "./result";

export const MAX_CHANGE_TITLE_LENGTH = 200;
/** Matches the cap on a change comment. */
export const MAX_CHANGE_DESCRIPTION_LENGTH = 20_000;

export interface ChangeText {
  /** `null` clears the field; absent leaves it as it is. */
  title?: string | null;
  description?: string | null;
}

function parseField(
  value: unknown,
  name: "title" | "description",
  max: number,
): Result<string | null | undefined, string> {
  if (value === undefined) return ok(undefined);
  if (value === null) return ok(null);
  if (typeof value !== "string") return err(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed === "") return ok(null);
  if (trimmed.length > max) return err(`${name} must be at most ${max} characters`);
  // A title is one line everywhere it is shown: a list row, a page heading, a
  // pull request title.
  if (name === "title" && /[\r\n]/.test(trimmed)) return err("title must be a single line");
  return ok(trimmed);
}

/** Read `title` and `description` off a request body. The error is a message for the caller. */
export function parseChangeText(body: {
  title?: unknown;
  description?: unknown;
}): Result<ChangeText, string> {
  const title = parseField(body.title, "title", MAX_CHANGE_TITLE_LENGTH);
  if (!title.success) return err(title.error);
  const description = parseField(body.description, "description", MAX_CHANGE_DESCRIPTION_LENGTH);
  if (!description.success) return err(description.error);
  return ok({
    ...(title.data !== undefined ? { title: title.data } : {}),
    ...(description.data !== undefined ? { description: description.data } : {}),
  });
}
