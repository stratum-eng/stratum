import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { FileViewerPage } from "../src/ui/pages/file-viewer";

const project = { namespace: "@user", slug: "repo", name: "My Repo" };
const user = null;

describe("FileViewerPage", () => {
  it("renders breadcrumb with namespace and slug linking to repo root", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="src/index.ts"
        content={{ kind: "content", value: "export {}" }}
        user={user}
      />,
    );
    expect(html).toContain('href="/@user/repo"');
    expect(html).toContain("@user");
    expect(html).toContain("repo");
  });

  it("renders breadcrumb segments for nested path", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="src/utils/helpers.ts"
        content={{ kind: "content", value: "" }}
        user={user}
      />,
    );
    expect(html).toContain("src");
    expect(html).toContain("utils");
    expect(html).toContain("helpers.ts");
  });

  it("renders file content in pre/code with correct language class", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="src/index.ts"
        content={{ kind: "content", value: "const x = 1;" }}
        user={user}
      />,
    );
    expect(html).toContain('class="language-typescript"');
    expect(html).toContain("const x = 1;");
  });

  it("HTML-escapes file content — XSS test", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="evil.ts"
        content={{ kind: "content", value: "<script>alert(1)</script>" }}
        user={user}
      />,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders binary message without a code block", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="image.png"
        content={{ kind: "binary" }}
        user={user}
      />,
    );
    expect(html).toContain("Binary file");
    expect(html).not.toContain("<code");
  });

  it("renders oversize message without a code block", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="big.csv"
        content={{ kind: "oversize" }}
        user={user}
      />,
    );
    expect(html).toContain("512 KB");
    expect(html).not.toContain("<code");
  });

  it("uses language-plaintext for unknown extensions", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="Makefile"
        content={{ kind: "content", value: "build:" }}
        user={user}
      />,
    );
    expect(html).toContain('class="language-plaintext"');
  });

  it("maps .ts extension to typescript", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="index.ts"
        content={{ kind: "content", value: "" }}
        user={user}
      />,
    );
    expect(html).toContain("language-typescript");
  });

  it("maps .py extension to python", () => {
    const html = renderToString(
      <FileViewerPage
        project={project}
        path="main.py"
        content={{ kind: "content", value: "" }}
        user={user}
      />,
    );
    expect(html).toContain("language-python");
  });
});
