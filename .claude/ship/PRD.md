# PRD: File Tree & File Viewer

## Problem Statement

The project page (`/:namespace/:slug`) renders every file in a repository as a flat unordered list
— no hierarchy, no links, no way to read a file's content. Any non-trivial repository produces an
unusable wall of paths: directories are invisible, there is no spatial orientation, and there is no
path from "I see a filename" to "I can read that file."

This is a blocking gap for code review — the stated core use case of Stratum. "Unblocked" means:
a reviewer can open a project, orient themselves in the file structure, click through to any source
file, and read it. Until that is possible, Stratum is not a usable code review surface.

## Goals

1. The file section on the repo page renders as a collapsible directory tree. No JavaScript required — `<details>/<summary>` HTML only.
2. Every file in the tree is a link that opens a dedicated file viewer page.
3. The file viewer (`/:namespace/:slug/blob/*path`) renders full file content in a `<pre><code class="language-{ext}">` block. File content is always rendered via JSX string children (never raw HTML markup) so Hono's auto-escaping applies.
4. A new API endpoint (`GET /api/projects/:namespace/:slug/content?path=…`) returns raw file content as JSON for agent/API consumers.
5. All new routes respect existing `canReadProject` auth (including `agentOwnerId` check). A request with no valid session returns 401; a valid session without project access returns 403.

## Non-Goals

- Client-side JavaScript beyond native `<details>` toggle behaviour.
- Runtime syntax highlighting (no Monaco, CodeMirror, Shiki) in this iteration.
- A directory-level `/tree/` route — only `/blob/` for individual files in this iteration.
- Git blame or per-line history.
- Search within files.
- Pagination of large file trees (see Risks for the mitigation).

**Note on binary files:** Binary files are handled minimally (not ignored). Displaying them is a
non-goal; detecting them and showing a safe fallback message is required behavior.

## User Stories

1. **As a developer reviewing a project**, I want to see files grouped by directory in a collapsible tree so I can locate the file I care about in under 5 seconds on any repo with < 1,000 files.
2. **As a developer**, I want to click a filename and read its full content on a dedicated page so I can review code without leaving Stratum.
3. **As an API consumer or agent**, I want to call `GET /api/projects/:namespace/:slug/content?path=src/index.ts` and receive the file content (or a clear typed error) as JSON so I can programmatically inspect source files.
4. **As a developer** who lands on `/blob/` for a binary file, an oversize file, or a missing path, I want to see a clear, distinct message for each case — not a generic error — so I understand what happened.

## Technical Approach

### Data: flat list → tree

`listFilesInRepo()` already returns `string[]` of relative paths (e.g. `["src/index.ts",
"src/utils/helpers.ts", "README.md"]`). Git does not track empty directories, so they will never
appear in the list.

A pure utility `buildFileTree(paths: string[]): FileTreeNode[]` splits each path on `/` and
constructs a sorted tree: directories sort before files at each level; within each group, sort
is case-insensitive alphabetical (`.toLowerCase()` before comparison for cross-environment
consistency).

```ts
export type FileTreeNode =
  | { type: "file"; name: string; path: string }
  | { type: "dir";  name: string; path: string; children: FileTreeNode[] };
// `path` on a dir node is the full relative path to the directory (e.g. "src/utils").
// It is NOT used for linking — it exists for keying and future /tree/ route use.
// Only file nodes produce links; dir nodes produce <details> toggles.
```

Lives in `src/ui/file-tree.ts` — no side effects, easily unit-tested.

### File content result type

All callers of the file reading logic receive a typed discriminated union, **not** a magic string:

```ts
export type FileContentResult =
  | { kind: "content"; value: string }
  | { kind: "binary" }
  | { kind: "oversize" }
  | { kind: "not-found" };
```

A thin wrapper `getFileContent(remote, token, path, logger): Promise<Result<FileContentResult, AppError>>`
wraps `readFileFromRepo()` and applies the binary/oversize guards. Both the UI route and the API
endpoint call this wrapper — no magic string sentinels anywhere.

**Binary detection:** After reading the full content string, check for `\0` (null byte). This is a
heuristic, not a specification — it correctly identifies most compiled binaries and is the same
approach used by git itself. Known limitation: UTF-16 encoded text files may be misidentified.

**Size guard:** If the byte length of the content string exceeds 512 KB, return `{ kind: "oversize" }`.
Note: the full file is read into memory before this check. A 50 MB file will exhaust Worker memory.
This is a known limitation — a future iteration should stream or limit reads at the HTTP layer.
512 KB was chosen over 256 KB because Worker heap is 128 MB and individual file reads are
sequential; the risk is acceptable for typical source repos.

### Component: FileTree

`src/ui/components/file-tree.tsx` renders `FileTreeNode[]` using `<details open>` for root-level
directories and `<details>` (closed) for nested directories. File nodes render as:

```html
<a href="/{namespace}/{slug}/blob/{encodeURIComponent(path)}">name</a>
```

File paths are percent-encoded before being placed in the `href` to handle spaces and non-ASCII
names. The folder icon is rendered as a text prefix (`▶ `) in the `<summary>` element, not as a
CSS emoji, for broader screen-reader and OS compatibility.

**Accessibility:** With root-level directories open by default, the full subtree is announced on
page load. This is acceptable for typical repos (< 200 root-level entries). If a repo has more
than 500 files total, the tree renders a notice: "Showing first 500 files. Use the API to browse
the full tree." This caps both rendering performance and accessibility-tree size.

### Page: FileViewerPage

`src/ui/pages/file-viewer.tsx` accepts `{ project, path, content: FileContentResult, user }` and renders:
- Breadcrumb: `namespace / slug / path/segments`. Directory segments link to the repo root for now (no `/tree/` in this iteration — Open Question 3 resolved).
- For `{ kind: "content" }`: `<pre><code class="language-{ext}">{value}</code></pre>`. Content passed as a JSX string child — Hono auto-escapes it.
- For `{ kind: "binary" }`: "Binary file — not shown."
- For `{ kind: "oversize" }`: "File too large to display (> 512 KB)."
- For `{ kind: "not-found" }`: 404 HTML response, matching the existing 404 pattern in ui.tsx.

The `language-{ext}` class maps file extension to a language slug (e.g. `.ts` → `language-typescript`). This mapping lives as a plain `Record<string, string>` constant in `file-viewer.tsx`.

### API endpoint

`GET /api/projects/:namespace/:slug/content?path=<url-decoded-path>` in `src/routes/projects.ts`.

Callers pass the file path as a plain string query param (the `?path=` value is URL-decoded by the
runtime before the handler sees it — no double-decoding). The handler calls `getFileContent()` and
returns:

```jsonc
// content case
{ "namespace": "...", "slug": "...", "path": "...", "kind": "content", "value": "..." }
// binary case
{ "namespace": "...", "slug": "...", "path": "...", "kind": "binary" }
// oversize case
{ "namespace": "...", "slug": "...", "path": "...", "kind": "oversize" }
```

HTTP status codes: 200 for all three above. 400 if `path` param missing or invalid. 401 if no
session. 403 if unauthorized. 404 if project not found. Auth guard: `canReadProject(project,
userId, agentOwnerId)` — same guard as `/files` endpoint, including `agentOwnerId`.

(422 was considered for binary but rejected — the client sent valid input; the server determined
the content type. 200 with a typed `kind` field is more useful for API consumers.)

### UI route

`GET /:namespace/:slug/blob/*` in `src/routes/ui.tsx`, registered **before** the existing
`/:namespace/:slug` catch-all. Extracts the Hono wildcard param as the file path. Calls
`getFileContent()`, renders `FileViewerPage`.

### Path validation

`isValidFilePath(path: string): boolean` — applied in both the UI route (after wildcard extraction)
and the API endpoint (after query param extraction). Rejects:
- Any segment equal to `..` or `.` after splitting on `/`
- Paths starting with `/` (absolute paths)
- Paths containing `\0` (null bytes)
- Paths longer than 4096 characters
- URL-encoding is already decoded by the runtime before the handler sees it — no need to check `%2e%2e`.

### CSS

New classes in `src/ui/styles.ts`:
- `.file-tree` — no list bullets, monospace font, tight line-height
- `.file-tree details summary` — directory row, cursor pointer, `▶ ` prefix
- `.file-tree details[open] summary` — `▼ ` prefix when open
- `.file-tree a` — file row, hover underline, muted colour
- `.file-viewer-breadcrumb` — flex row, separator between segments
- `.file-viewer-content` — wraps `<pre>`, dark background, horizontal scroll, `white-space: pre`

### Touched files

| File | Change |
|---|---|
| `src/ui/file-tree.ts` | New — `buildFileTree()`, `FileTreeNode` types |
| `src/ui/file-content.ts` | New — `FileContentResult` type, `getFileContent()` wrapper |
| `src/ui/components/file-tree.tsx` | New — `FileTree` component |
| `src/ui/pages/file-viewer.tsx` | New — `FileViewerPage` component |
| `src/routes/projects.ts` | Add `/content` API endpoint |
| `src/routes/ui.tsx` | Add `/blob/*` route; import `FileViewerPage` |
| `src/ui/pages/repo.tsx` | Replace flat `<ul>` with `<FileTree>` |
| `src/ui/styles.ts` | Add file-tree + file-viewer CSS |

## Edge Cases & Risks

- **Empty repo**: `files = []` — `buildFileTree([])` returns `[]`; the existing "No files" empty state renders unchanged.
- **File not found**: `getFileContent()` returns `{ kind: "not-found" }` — UI renders 404 page; API returns 404 JSON.
- **Binary files**: Null-byte heuristic; known limitation: UTF-16 text may false-positive. UI shows "Binary file — not shown."
- **Oversize files**: Full read before guard — known memory risk for very large files; acceptable for typical source repos. 512 KB display limit.
- **Path traversal**: `isValidFilePath()` rejects `..`, `.`, absolute paths, null bytes, and paths > 4096 chars. Applied before any FS access.
- **HTML injection**: File content passed as JSX string child — Hono auto-escapes. No raw HTML markup. This assumption must be verified with an explicit test: render a file whose content is `<script>alert(1)</script>` and assert the output is escaped.
- **Route ordering**: `/blob/*` registered before `/:namespace/:slug`. A test must assert `GET /@test/repo/blob/src/index.ts` reaches the file viewer handler.
- **Large repos (> 500 files)**: Tree renders first 500 entries and shows a notice. Prevents unbounded HTML response size.
- **Performance / `cloneRepo()` on every request**: Existing architectural pattern. No mitigation in this iteration. Known limitation for large repos. p99 latency is unknown — monitoring is required post-ship.
- **Concurrency**: 10 simultaneous file view requests = 10 concurrent `cloneRepo()` calls on the Worker. No locking. This is a pre-existing issue, not introduced here. Noted as debt.
- **Auth (unauthenticated vs. unauthorized)**: No session → 401. Valid session, no access → 403. Both cases must be tested.
- **`agentOwnerId` check**: Both the UI route and the API endpoint call `canReadProject(project, userId, agentOwnerId)`. Neither is allowed to call a simplified version that only checks `userId`.
- **`listFilesInRepo()` failure**: If file listing fails at the repo page level, the tree renders the "No files" empty state (existing behaviour — files defaults to `[]`). A log warning is emitted. No change needed.

## Resolved Questions

1. **Root-level directories open by default, nested closed.** Accepted for typical repos. Capped at 500 total entries to bound the accessibility-tree size.
2. **512 KB file size limit.** Accepted. Workers have 128 MB heap; sequential single-file reads are safe at this limit for typical repos.
3. **Breadcrumb directory segments link to the repo root.** No `/tree/` links — that route is out of scope. Breadcrumb is informational, not navigational for directory segments.

---

## Revision Notes

### Binary as a non-goal but with required behavior
**Critique:** Non-Goals said "no binary rendering" but Technical Approach and Edge Cases specified binary behavior — a contradiction.
**Resolution:** Non-Goals clarified to "displaying binary content is a non-goal; detecting and showing a safe fallback is required."

### `__OVERSIZE__` magic string sentinel
**Critique:** Stringly-typed magic value makes the function impossible to type correctly and forces every caller to check an undocumented string.
**Resolution:** Replaced with a `FileContentResult` discriminated union. All callers receive a typed value with no magic strings.

### `path` on directory nodes undefined
**Critique:** `path` on `dir` nodes was never specified — could be accidentally used to construct blob links.
**Resolution:** Explicitly documented: `path` on dir nodes is the full relative directory path, used only for keying. Only file nodes produce links.

### URL encoding of file paths in links
**Critique:** No mention of percent-encoding; spaces and non-ASCII filenames produce broken URLs.
**Resolution:** Links use `encodeURIComponent(path)`. Documented in FileTree component spec.

### 422 for binary files
**Critique:** 422 is semantically wrong — the client sent valid input; the content type is a server-side determination.
**Resolution:** All three content kinds return 200 with a `kind` discriminant. 422 removed.

### Open Question 3 vs. Non-Goals contradiction
**Critique:** OQ3 asked about `/tree/` links in breadcrumbs, but `/tree/` was an explicit non-goal — contradiction.
**Resolution:** OQ3 resolved: directory segments in breadcrumb link to the repo root. `/tree/` remains a non-goal.

### `isValidFilePath` incomplete
**Critique:** Only checked for `..` segments; missed `.`, absolute paths, null bytes, length limits, and encoded traversal.
**Resolution:** `isValidFilePath` now rejects `..`, `.`, absolute paths, null-byte paths, and paths > 4096 chars. Runtime URL-decodes before the handler runs, so `%2e%2e` is already resolved.

### Binary detection reads full file first
**Critique:** The size guard fires after reading the full file into memory — a 50 MB file OOMs before the guard triggers.
**Resolution:** Documented explicitly as a known limitation. Full mitigation (streaming/HTTP-layer limit) deferred to future iteration. Scope is typical source repos.

### Testing requirements missing
**Critique:** PRD said "easily testable" but specified zero required tests.
**Resolution:** Edge Cases now includes explicit test requirements for HTML escaping, route ordering, and auth behavior.

### Auth: `agentOwnerId` missing from API endpoint spec
**Critique:** Edge Cases mentioned agentOwnerId but Technical Approach for the API endpoint omitted it.
**Resolution:** Added explicit `canReadProject(project, userId, agentOwnerId)` requirement to the API endpoint spec and Risks section.

### Large repos: no cap on tree rendering
**Critique:** 10,000-file repo would generate an unbounded HTML response.
**Resolution:** Tree renders first 500 entries and shows a notice. Documented in component spec and Risks.

### Open Questions 1 and 2
**Critique:** Both were resolvable engineering decisions left open.
**Resolution:** Both resolved. Moved to "Resolved Questions" section.
