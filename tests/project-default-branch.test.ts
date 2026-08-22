import { describe, expect, it } from "vitest";
import { projectDefaultBranch } from "../src/types";

describe("projectDefaultBranch", () => {
  it("prefers sourceDefaultBranch", () => {
    expect(
      projectDefaultBranch({ sourceDefaultBranch: "trunk", githubDefaultBranch: "master" }),
    ).toBe("trunk");
  });

  it("falls back to githubDefaultBranch", () => {
    expect(projectDefaultBranch({ githubDefaultBranch: "master" })).toBe("master");
  });

  it("falls back to main when neither field is set", () => {
    expect(projectDefaultBranch({})).toBe("main");
  });

  it("treats empty strings as unset (|| chain, matching the push gate)", () => {
    expect(projectDefaultBranch({ sourceDefaultBranch: "", githubDefaultBranch: "" })).toBe("main");
    expect(projectDefaultBranch({ sourceDefaultBranch: "", githubDefaultBranch: "master" })).toBe(
      "master",
    );
  });
});
