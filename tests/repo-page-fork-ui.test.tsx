import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { RepoPage } from "../src/ui/pages/repo";

const baseProject = {
  name: "my-repo",
  namespace: "@alice",
  slug: "my-repo",
  remote: "git@stratum:alice/my-repo.git",
  createdAt: "2024-01-01T00:00:00Z",
};

const baseProps = {
  files: [],
  log: [],
  readme: null,
  user: null,
  importProgress: null,
  syncStatus: null,
  canSync: false,
};

describe("RepoPage — sync card provider label", () => {
  it("(a) shows 'Forked from owner/repo' when both sourceOwner and sourceRepo are present", () => {
    const html = renderToString(
      <RepoPage
        {...baseProps}
        project={{
          ...baseProject,
          sourceUrl: "https://github.com/acme/api",
          sourceProvider: "github",
          sourceOwner: "acme",
          sourceRepo: "api",
        }}
      />,
    );
    expect(html).toContain("Forked from acme/api");
    expect(html).not.toContain("GitHub");
  });

  it("(b) falls back to provider icon/name when sourceOwner or sourceRepo is absent", () => {
    const html = renderToString(
      <RepoPage
        {...baseProps}
        project={{
          ...baseProject,
          sourceUrl: "https://github.com/acme/api",
          sourceProvider: "github",
          // sourceOwner and sourceRepo omitted
        }}
      />,
    );
    expect(html).toContain("GitHub");
    expect(html).not.toContain("Forked from");
  });
});

describe("RepoPage — 'Prepare a pull request' card (GitHub)", () => {
  it("(c) renders the GitHub PR card for a GitHub fork when canSync=true", () => {
    const html = renderToString(
      <RepoPage
        {...baseProps}
        canSync={true}
        project={{
          ...baseProject,
          sourceUrl: "https://github.com/acme/api",
          sourceProvider: "github",
          sourceOwner: "acme",
          sourceRepo: "api",
        }}
      />,
    );
    expect(html).toContain("Prepare a pull request");
    expect(html).toContain("Open Changes");
    expect(html).toContain("/@alice/my-repo/changes");
    expect(html).toContain("as a pull request");
  });

  it("(d) hides the GitHub PR card when canSync=false (non-owner)", () => {
    const html = renderToString(
      <RepoPage
        {...baseProps}
        canSync={false}
        project={{
          ...baseProject,
          sourceUrl: "https://github.com/acme/api",
          sourceProvider: "github",
          sourceOwner: "acme",
          sourceRepo: "api",
        }}
      />,
    );
    expect(html).not.toContain("Prepare a pull request");
  });
});

describe("RepoPage — 'Review your changes' card (non-GitHub)", () => {
  it("(e) renders 'Review your changes' card for GitLab fork when canSync=true", () => {
    const html = renderToString(
      <RepoPage
        {...baseProps}
        canSync={true}
        project={{
          ...baseProject,
          sourceUrl: "https://gitlab.com/acme/api",
          sourceProvider: "gitlab",
          sourceOwner: "acme",
          sourceRepo: "api",
        }}
      />,
    );
    expect(html).toContain("Review your changes");
    expect(html).toContain("Open Changes");
    expect(html).toContain("/@alice/my-repo/changes");
    expect(html).not.toContain("Prepare a pull request");
  });
});

describe("RepoPage — scratch project (no sourceUrl)", () => {
  it("(f) renders neither card for a project with no sourceUrl", () => {
    const html = renderToString(
      <RepoPage {...baseProps} canSync={true} project={{ ...baseProject }} />,
    );
    expect(html).not.toContain("Prepare a pull request");
    expect(html).not.toContain("Review your changes");
    // sync card itself should also be absent
    expect(html).not.toContain("sync-status-card");
  });
});
