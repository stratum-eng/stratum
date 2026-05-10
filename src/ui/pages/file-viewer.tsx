import { Fragment } from "hono/jsx";
import type { FC } from "hono/jsx";
import type { FileContentResult } from "../file-content";
import { Layout } from "../layout";

const extensionToLanguage: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  md: "markdown",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  sh: "shell",
  bash: "shell",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  cs: "csharp",
  php: "php",
  xml: "xml",
  svg: "xml",
};

function languageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extensionToLanguage[ext] ?? "plaintext";
}

interface BreadcrumbProps {
  namespace: string;
  slug: string;
  filePath: string;
}

const Breadcrumb: FC<BreadcrumbProps> = ({ namespace, slug, filePath }) => {
  const segments = filePath.split("/").filter((s) => s.length > 0);

  return (
    <div class="file-viewer-breadcrumb">
      <a href={`/${namespace}/${slug}`}>{namespace}</a>
      <span class="sep">/</span>
      <a href={`/${namespace}/${slug}`}>{slug}</a>
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        return (
          <Fragment key={`seg-${i}`}>
            <span class="sep">/</span>
            {isLast ? (
              <span class="file-viewer-breadcrumb-current">{segment}</span>
            ) : (
              <a href={`/${namespace}/${slug}`}>{segment}</a>
            )}
          </Fragment>
        );
      })}
    </div>
  );
};

interface FileViewerPageProps {
  project: { namespace: string; slug: string; name: string };
  path: string;
  content: FileContentResult;
  user?: { id: string; email: string; username: string } | null;
}

export const FileViewerPage: FC<FileViewerPageProps> = ({ project, path, content, user }) => {
  const { namespace, slug } = project;
  const language = languageFromPath(path);
  const fileName = path.split("/").pop() ?? path;

  return (
    <Layout title={`${fileName} — ${project.name}`} user={user}>
      <div class="page-header">
        <Breadcrumb namespace={namespace} slug={slug} filePath={path} />
      </div>

      <div class="card file-viewer-content">
        {content.kind === "content" && (
          <pre>
            <code class={`language-${language}`}>{content.value}</code>
          </pre>
        )}
        {content.kind === "binary" && <p class="file-viewer-message">Binary file — not shown.</p>}
        {content.kind === "oversize" && (
          <p class="file-viewer-message">File too large to display (&gt; 512 KB).</p>
        )}
      </div>
    </Layout>
  );
};
