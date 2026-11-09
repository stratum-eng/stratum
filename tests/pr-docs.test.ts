/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
// The real template, so a placeholder in it can never satisfy the check.
import PR_TEMPLATE from "../.github/PULL_REQUEST_TEMPLATE.md?raw";
import { type ChangedFile, checkPullRequest, optOutReason } from "../scripts/pr-docs";

const modified = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ path, status: "modified" }));
const added = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ path, status: "added" }));

describe("optOutReason", () => {
  it("reads a reason on its own line", () => {
    expect(
      optOutReason("Summary\n\nNo docs needed: internal refactor only", "No docs needed"),
    ).toBe("internal refactor only");
  });

  it("accepts it as a list item, in any case", () => {
    expect(optOutReason("- no changelog: test-only change here", "No changelog")).toBe(
      "test-only change here",
    );
  });

  it("rejects a missing or token reason", () => {
    expect(optOutReason("No docs needed:", "No docs needed")).toBeNull();
    expect(optOutReason("No docs needed: n/a", "No docs needed")).toBeNull();
    expect(optOutReason("", "No docs needed")).toBeNull();
  });

  it("ignores anything inside an HTML comment", () => {
    expect(
      optOutReason("<!-- No changelog: <why>                    -->", "No changelog"),
    ).toBeNull();
    expect(
      optOutReason("<!--\n  No docs needed: example of the format here\n-->", "No docs needed"),
    ).toBeNull();
  });

  it("finds a real reason after an unfilled placeholder line", () => {
    expect(
      optOutReason("No changelog:\n\nNo changelog: test-only change here", "No changelog"),
    ).toBe("test-only change here");
  });

  it("rejects an unfilled <placeholder> as the reason", () => {
    expect(optOutReason("No changelog: <explain why it is not needed>", "No changelog")).toBeNull();
    expect(optOutReason("No docs needed: <reason here>.", "No docs needed")).toBeNull();
    expect(
      optOutReason("No docs needed: renames <Foo> to <Bar> internally", "No docs needed"),
    ).toBe("renames <Foo> to <Bar> internally");
  });

  it("ignores the phrase mid-sentence", () => {
    expect(
      optOutReason("I think No docs needed: probably fine to skip", "No docs needed"),
    ).toBeNull();
  });
});

describe("checkPullRequest", () => {
  it("passes a PR that touches nothing user-facing", () => {
    const result = checkPullRequest(modified("tests/foo.test.ts", "docs/developer/x.md"), "");
    expect(result.ok).toBe(true);
    expect(result.docs.needed).toBe(false);
    expect(result.changelog.needed).toBe(false);
  });

  it("requires docs and a fragment for an API route change", () => {
    const result = checkPullRequest(modified("src/routes/projects.ts"), "");
    expect(result.ok).toBe(false);
    expect(result.docs).toMatchObject({ needed: true, satisfied: false });
    expect(result.changelog).toMatchObject({ needed: true, satisfied: false });
    expect(result.docs.because).toEqual(["src/routes/projects.ts"]);
  });

  it("is satisfied by a docs change and a new fragment", () => {
    const result = checkPullRequest(
      [
        ...modified("src/mcp/tools.ts", "docs/user-guide/mcp.md"),
        ...added("changelog.d/460-new-tool.md"),
      ],
      "",
    );
    expect(result.ok).toBe(true);
    expect(result.docs.by).toBe("changed");
    expect(result.changelog.by).toBe("changed");
  });

  it("needs only a fragment for a server-rendered page or service change", () => {
    const result = checkPullRequest(modified("src/routes/login.tsx", "src/services/x.ts"), "");
    expect(result.docs.needed).toBe(false);
    expect(result.changelog.needed).toBe(true);
  });

  it("accepts opt-out reasons in the body", () => {
    const result = checkPullRequest(
      modified("src/evaluation/limits.ts"),
      "No docs needed: tightens an internal limit, no visible change\nNo changelog: no behaviour change at all",
    );
    expect(result.ok).toBe(true);
    expect(result.docs.by).toBe("tightens an internal limit, no visible change");
  });

  it("ignores test files and the release version bump", () => {
    const result = checkPullRequest(
      modified("src/mcp/tools.test.ts", "src/version.ts", "CHANGELOG.md", "package.json"),
      "",
    );
    expect(result.ok).toBe(true);
  });

  it("does not count a removed fragment or the README as a fragment", () => {
    const result = checkPullRequest(
      [
        ...modified("src/services/x.ts", "changelog.d/README.md"),
        { path: "changelog.d/old.md", status: "removed" },
      ],
      "",
    );
    expect(result.changelog.satisfied).toBe(false);
  });

  it("is not satisfied by the unedited PR template", () => {
    const result = checkPullRequest(modified("src/routes/projects.ts"), PR_TEMPLATE);
    expect(result.docs.satisfied).toBe(false);
    expect(result.changelog.satisfied).toBe(false);
  });

  it("does not count the generated website mirror as docs", () => {
    const result = checkPullRequest(
      modified("src/routes/projects.ts", "website/src/content/docs/guides/x.md"),
      "",
    );
    expect(result.docs.satisfied).toBe(false);
  });
});
