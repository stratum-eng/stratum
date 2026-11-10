import { describe, expect, it } from "vitest";
import {
  MAX_CHANGE_DESCRIPTION_LENGTH,
  MAX_CHANGE_TITLE_LENGTH,
  parseChangeText,
} from "../src/utils/change-text";

describe("parseChangeText", () => {
  it("trims both fields", () => {
    expect(parseChangeText({ title: "  A title ", description: "\nBody\n" })).toEqual({
      success: true,
      data: { title: "A title", description: "Body" },
    });
  });

  it("leaves out a field that was not given", () => {
    expect(parseChangeText({})).toEqual({ success: true, data: {} });
    expect(parseChangeText({ title: "T" })).toEqual({ success: true, data: { title: "T" } });
  });

  it("reads null and blank as clearing the field", () => {
    expect(parseChangeText({ title: null, description: "   " })).toEqual({
      success: true,
      data: { title: null, description: null },
    });
  });

  it("accepts each field at its limit and refuses one character more", () => {
    expect(parseChangeText({ title: "x".repeat(MAX_CHANGE_TITLE_LENGTH) }).success).toBe(true);
    expect(parseChangeText({ title: "x".repeat(MAX_CHANGE_TITLE_LENGTH + 1) })).toEqual({
      success: false,
      error: "title must be at most 200 characters",
    });
    expect(
      parseChangeText({ description: "x".repeat(MAX_CHANGE_DESCRIPTION_LENGTH) }).success,
    ).toBe(true);
    expect(
      parseChangeText({ description: "x".repeat(MAX_CHANGE_DESCRIPTION_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it("refuses a title of more than one line, but not a description", () => {
    expect(parseChangeText({ title: "one\ntwo" })).toEqual({
      success: false,
      error: "title must be a single line",
    });
    expect(parseChangeText({ description: "one\ntwo" }).success).toBe(true);
  });

  it("refuses anything that is not a string", () => {
    expect(parseChangeText({ title: 3 }).success).toBe(false);
    expect(parseChangeText({ description: ["a"] }).success).toBe(false);
  });
});
