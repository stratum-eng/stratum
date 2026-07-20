import { describe, expect, it } from "vitest";
import { isValidRepoUrl } from "../src/utils/validation";

describe("isValidRepoUrl — https only (downgrade protection)", () => {
  it("accepts https provider URLs", () => {
    expect(isValidRepoUrl("https://github.com/owner/repo")).toBe(true);
    expect(isValidRepoUrl("https://gitlab.com/group/repo")).toBe(true);
    expect(isValidRepoUrl("https://bitbucket.org/owner/repo")).toBe(true);
  });

  it("rejects cleartext http:// (MITM exposure)", () => {
    expect(isValidRepoUrl("http://github.com/owner/repo")).toBe(false);
    expect(isValidRepoUrl("http://gitlab.com/group/repo")).toBe(false);
    expect(isValidRepoUrl("http://bitbucket.org/owner/repo")).toBe(false);
  });

  it("still rejects non-provider hosts", () => {
    expect(isValidRepoUrl("https://evil.example.com/owner/repo")).toBe(false);
  });
});
