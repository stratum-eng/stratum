import { describe, expect, it } from "vitest";
import { parseEditPlan } from "../src/llm.js";

describe("parseEditPlan", () => {
  it("parses a plain JSON plan", () => {
    const plan = parseEditPlan(
      JSON.stringify({
        files: { "src/a.ts": "export {};" },
        commitMessage: "Fix it",
        summary: "Fixed the thing",
      }),
    );
    expect(plan.files["src/a.ts"]).toBe("export {};");
    expect(plan.commitMessage).toBe("Fix it");
    expect(plan.summary).toBe("Fixed the thing");
  });

  it("tolerates markdown fences around the JSON", () => {
    const plan = parseEditPlan(
      '```json\n{"files": {"a.ts": "x"}, "commitMessage": "m"}\n```',
    );
    expect(plan.files["a.ts"]).toBe("x");
    expect(plan.summary).toBe("m");
  });

  it("rejects invalid JSON, empty plans, and unsafe paths", () => {
    expect(() => parseEditPlan("not json")).toThrow(/not valid JSON/);
    expect(() => parseEditPlan('{"files": {}, "commitMessage": "m"}')).toThrow(
      /no file changes/,
    );
    expect(() =>
      parseEditPlan('{"files": {"../etc/passwd": "x"}, "commitMessage": "m"}'),
    ).toThrow(/unsafe path/);
    expect(() =>
      parseEditPlan('{"files": {"/abs/path": "x"}, "commitMessage": "m"}'),
    ).toThrow(/unsafe path/);
    expect(() =>
      parseEditPlan('{"files": {"a.ts": 42}, "commitMessage": "m"}'),
    ).toThrow(/non-string content/);
  });
});
