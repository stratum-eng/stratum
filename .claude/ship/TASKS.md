# Task Breakdown: File Tree & File Viewer

Stack: TypeScript / Cloudflare Workers (Hono JSX)
Type check: `tsc --noEmit`
Tests: `vitest run`
Lint: `biome check --write src tests`

---

## Task 1: File tree data utility

Build the pure data-transformation layer that converts a flat file list into a typed tree.

- [ ] 1.1: Create `src/ui/file-tree.ts`. Export `FileTreeNode` discriminated union type (`file` | `dir`). Export `buildFileTree(paths: string[]): FileTreeNode[]` — splits each path on `/`, builds nested structure, sorts dirs before files at each level (case-insensitive).
- [ ] 1.2: Write tests for Task 1 (`tests/unit/file-tree.test.ts`):
  - Empty input → empty array
  - Flat list of root-level files → all `type: "file"` nodes, alphabetical
  - Mixed files and directories → dirs first, then files, at each level
  - Deeply nested paths (4+ levels) → correct nesting
  - Paths with the same prefix that are files, not dirs (e.g. `foo` and `foo/bar.ts`) — `foo` is a file, not a dir
  - Case-insensitive sort (`B.ts` sorts after `a.ts`)
  - `path` on dir nodes equals full relative dir path (e.g. `"src/utils"`)

---

## Task 2: File content wrapper

Build the typed result wrapper that normalises all file reading outcomes.

- [ ] 2.1: Create `src/ui/file-content.ts`. Export `FileContentResult` discriminated union: `{ kind: "content"; value: string } | { kind: "binary" } | { kind: "oversize" } | { kind: "not-found" }`.
- [ ] 2.2: Export `getFileContent(remote: string, token: string, path: string, logger: Logger): Promise<Result<FileContentResult, AppError>>`. Calls `readFileFromRepo()`. After reading: check for null bytes → `binary`; check byte length > 524288 → `oversize`; on `FS_ERROR` with "not found" → `not-found`; otherwise → `content`.
- [ ] 2.3: Export `isValidFilePath(path: string): boolean`. Rejects: any segment equal to `..` or `.`; paths starting with `/`; paths containing `\0`; paths longer than 4096 chars.
- [ ] 2.4: Write tests for Task 2 (`tests/unit/file-content.test.ts`):
  - `isValidFilePath`: valid path passes; `..` segment rejected; `.` segment rejected; absolute path rejected; null-byte path rejected; path > 4096 chars rejected; root-level file name passes; nested path passes
  - `getFileContent` binary detection: content with `\0` → `{ kind: "binary" }`
  - `getFileContent` oversize detection: content > 512 KB → `{ kind: "oversize" }`
  - `getFileContent` not-found: FS_ERROR → `{ kind: "not-found" }`
  - `getFileContent` normal content: returns `{ kind: "content", value: "..." }`

---

## Task 3: FileTree JSX component

Build the server-rendered collapsible tree component.

- [ ] 3.1: Create `src/ui/components/file-tree.tsx`. Export `FileTree: FC<{ nodes: FileTreeNode[]; namespace: string; slug: string }>`. Render `FileTreeNode[]`: dir nodes → `<details open={depth === 0}>` with `<summary>▶ {name}</summary>`; file nodes → `<a href="/{namespace}/{slug}/blob/{encodedPath}">{name}</a>`. Percent-encode the full file path in the `href`. Render empty-state message if `nodes` is empty. Cap total rendered nodes at 500 — if `buildFileTree` produced more, show a notice below the tree.
- [ ] 3.2: Write tests for Task 3 (`tests/unit/file-tree-component.test.ts`):
  - Renders a single file as a link with correct href
  - Encodes spaces in file paths (`my file.ts` → `my%20file.ts` in href)
  - Renders a directory as a `<details>` with correct `<summary>`
  - Root-level dir has `open` attribute; nested dir does not
  - Empty `nodes` → renders empty-state message
  - File with content `<script>alert(1)</script>` in its name renders escaped (no raw HTML)

---

## Task 4: FileViewerPage component

Build the file content display page.

- [ ] 4.1: Create `src/ui/pages/file-viewer.tsx`. Export `FileViewerPage: FC<{ project: { namespace; slug; name }; path: string; content: FileContentResult; user?: ... }>`. Render: breadcrumb (namespace/slug/path segments, directory segments link to `/{namespace}/{slug}`, file segment is plain text); content block based on `content.kind`: `content` → `<pre><code class="language-{ext}">{value}</code></pre>`; `binary` → info message; `oversize` → info message; `not-found` renders nothing (caller returns 404).
- [ ] 4.2: Add `extensionToLanguage` constant: a `Record<string, string>` mapping common extensions to language slugs (`.ts` → `typescript`, `.tsx` → `typescript`, `.js` → `javascript`, `.jsx` → `javascript`, `.py` → `python`, `.go` → `go`, `.rs` → `rust`, `.md` → `markdown`, `.json` → `json`, `.css` → `css`, `.html` → `html`, `.sh` → `shell`, `.yaml` → `yaml`, `.yml` → `yaml`). Unknown extension → `language-plaintext`.
- [ ] 4.3: Write tests for Task 4 (`tests/unit/file-viewer.test.ts`):
  - Renders breadcrumb with correct segments
  - Breadcrumb namespace segment links to `/{namespace}/{slug}`
  - Renders file content in `<pre><code>` with correct language class
  - Content `<script>alert(1)</script>` is HTML-escaped in output (not executed)
  - `{ kind: "binary" }` → renders "Binary file" message, no `<code>` block
  - `{ kind: "oversize" }` → renders size message, no `<code>` block
  - `extensionToLanguage`: `.ts` → `typescript`; unknown ext → `plaintext`

---

## Task 5: CSS for file tree and file viewer

Add styling to `src/ui/styles.ts`.

- [ ] 5.1: Add file tree classes to `src/ui/styles.ts`:
  - `.file-tree` — `list-style: none; padding: 0; margin: 0; font-family: 'JetBrains Mono', monospace; font-size: 0.85rem;`
  - `.file-tree details summary` — `cursor: pointer; padding: 0.25rem 0; color: #aaa; list-style: none; user-select: none;`
  - `.file-tree details[open] > summary::before` — `content: "▼ ";`
  - `.file-tree details:not([open]) > summary::before` — `content: "▶ ";`
  - `.file-tree a` — `display: block; padding: 0.2rem 0 0.2rem 1.25rem; color: #ccc; text-decoration: none;`
  - `.file-tree a:hover` — `color: #f0f0f0; text-decoration: underline;`
  - `.file-tree-notice` — `font-size: 0.8rem; color: #666; margin-top: 0.5rem;`
- [ ] 5.2: Add file viewer classes to `src/ui/styles.ts`:
  - `.file-viewer-breadcrumb` — `display: flex; gap: 0.25rem; align-items: center; font-size: 0.85rem; font-family: 'JetBrains Mono', monospace; margin-bottom: 0.75rem; color: #888;`
  - `.file-viewer-breadcrumb a` — `color: #7ca9f7; text-decoration: none;`
  - `.file-viewer-breadcrumb a:hover` — `text-decoration: underline;`
  - `.file-viewer-breadcrumb .sep` — `color: #444;`
  - `.file-viewer-content` — `overflow-x: auto; background: #0d0d0d; border-radius: 4px; padding: 1rem;`
  - `.file-viewer-content pre` — `margin: 0; white-space: pre; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; color: #d4d4d4; line-height: 1.5;`
  - `.file-viewer-message` — `padding: 1rem; color: #666; font-style: italic; font-size: 0.85rem;`
- [ ] 5.3: No tests required for CSS. Visual review is sufficient.

---

## Task 6: API content endpoint

Wire up `GET /api/projects/:namespace/:slug/content` in `src/routes/projects.ts`.

- [ ] 6.1: Import `getFileContent` and `isValidFilePath` from `src/ui/file-content.ts`.
- [ ] 6.2: Add handler after the existing `/files` endpoint. Extract and validate `path` query param via `isValidFilePath`. Return 400 if missing or invalid. Auth check: `canReadProject(project, userId, agentOwnerId)` — return 403 if denied. Call `getFileContent()`. Return 200 JSON with `{ namespace, slug, path, kind, value? }` shaped from the `FileContentResult`.
- [ ] 6.3: Write tests for Task 6 (`tests/integration/content-api.test.ts`):
  - Missing `path` param → 400
  - Invalid path (`../etc/passwd`) → 400
  - Unauthenticated → 401
  - No project access → 403
  - Valid path, file exists → 200 `{ kind: "content", value: "..." }`
  - Valid path, binary file → 200 `{ kind: "binary" }`
  - Valid path, file not found in repo → 404

---

## Task 7: UI blob route and repo page update

Wire the new components into the UI routing layer.

- [ ] 7.1: In `src/routes/ui.tsx`, add `import { FileViewerPage } from "../ui/pages/file-viewer"` and `import { getFileContent, isValidFilePath } from "../ui/file-content"`.
- [ ] 7.2: Register `GET /:namespace/:slug/blob/*` route **before** the existing `/:namespace/:slug` catch-all. Extract wildcard path, validate with `isValidFilePath` (return 400 HTML on failure). Auth check (401/403). Call `getFileContent()`. If `kind === "not-found"` return 404 HTML page. Otherwise render `<FileViewerPage>`.
- [ ] 7.3: In `src/ui/pages/repo.tsx`: import `FileTree` from `../components/file-tree` and `buildFileTree` from `../file-tree`. Replace the `<ul class="file-list">` block (lines 228–235) with `<FileTree nodes={buildFileTree(files)} namespace={project.namespace} slug={project.slug} />`.
- [ ] 7.4: Write tests for Task 7 (`tests/integration/ui-routes.test.ts`):
  - `GET /@test/repo/blob/src/index.ts` reaches the file viewer handler (not the catch-all)
  - `GET /@test/repo/blob/../etc/passwd` → 400 HTML response
  - `GET /@test/repo` still renders the repo page (catch-all still works)
  - Unauthenticated blob request → 401
  - Unauthorized blob request → 403

---

## Task 8: End-to-end smoke and quality pass

Final integration verification.

- [ ] 8.1: Run `tsc --noEmit` — zero errors.
- [ ] 8.2: Run `vitest run` — all tests pass including new ones.
- [ ] 8.3: Run `biome check --write src tests` — zero lint errors.
- [ ] 8.4: Verify the HTML-escaping test in Task 4.3 explicitly: render `<script>alert(1)</script>` as file content and assert the rendered HTML contains `&lt;script&gt;`, not `<script>`.
