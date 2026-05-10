import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { FileTree } from "../src/ui/components/file-tree";
import { buildFileTree } from "../src/ui/file-tree";

describe("FileTree component", () => {
  it("renders empty state when nodes is empty", () => {
    const html = renderToString(<FileTree nodes={[]} namespace="@user" slug="repo" />);
    expect(html).toContain("No files");
  });

  it("renders a file as a link with correct href", () => {
    const nodes = buildFileTree(["README.md"]);
    const html = renderToString(<FileTree nodes={nodes} namespace="@user" slug="repo" />);
    expect(html).toContain('href="/@user/repo/blob/README.md"');
    expect(html).toContain("README.md");
  });

  it("percent-encodes spaces in file paths", () => {
    const nodes = buildFileTree(["my file.ts"]);
    const html = renderToString(<FileTree nodes={nodes} namespace="@user" slug="repo" />);
    expect(html).toContain("my%20file.ts");
    expect(html).not.toContain('href="/@user/repo/blob/my file.ts"');
  });

  it("renders a directory as a details element with summary", () => {
    const nodes = buildFileTree(["src/index.ts"]);
    const html = renderToString(<FileTree nodes={nodes} namespace="@user" slug="repo" />);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("src");
  });

  it("root-level dir has open attribute", () => {
    const nodes = buildFileTree(["src/index.ts"]);
    const html = renderToString(<FileTree nodes={nodes} namespace="@user" slug="repo" />);
    expect(html).toMatch(/<details[^>]*open[^>]*>/);
  });

  it("nested dir does not have open attribute", () => {
    const nodes = buildFileTree(["src/utils/helpers.ts"]);
    const html = renderToString(<FileTree nodes={nodes} namespace="@user" slug="repo" />);
    const detailsMatches = [...html.matchAll(/<details([^>]*)>/g)];
    expect(detailsMatches.length).toBeGreaterThanOrEqual(2);
    const secondDetails = detailsMatches[1]?.[1] ?? "";
    expect(secondDetails).not.toContain("open");
  });

  it("escapes special characters in file names", () => {
    const nodes = buildFileTree(["<script>.ts"]);
    const html = renderToString(<FileTree nodes={nodes} namespace="@user" slug="repo" />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders multiple files under a shared directory", () => {
    const nodes = buildFileTree(["src/a.ts", "src/b.ts"]);
    const html = renderToString(<FileTree nodes={nodes} namespace="@user" slug="repo" />);
    expect(html).toContain("src/a.ts");
    expect(html).toContain("src/b.ts");
  });
});
