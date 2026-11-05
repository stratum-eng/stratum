/**
 * Pure pieces of the GitHub issue importer (#421): validating GitHub's JSON
 * into the fields the importer copies, and rewriting `#123` references.
 *
 * Everything here treats its input as untrusted. GitHub's responses are parsed
 * field by field rather than cast, and the text that comes through (titles,
 * bodies, comments) is stored verbatim apart from reference rewriting — it is
 * never interpreted as markup on the way in. Rendering is the issue pages' job,
 * and they escape it like any other issue text.
 */

/** GitHub's own ceiling on an issue or comment body. */
export const MAX_IMPORTED_BODY_LENGTH = 65_536;
/** GitHub's ceiling on an issue title. */
export const MAX_IMPORTED_TITLE_LENGTH = 256;
/** Same caps the issues API applies to labels set through Stratum. */
export const MAX_IMPORTED_LABEL_LENGTH = 50;
export const MAX_IMPORTED_LABELS = 20;

export interface GitHubAuthor {
  login: string;
  /** GitHub's numeric user id, as a string (how `users.github_id` stores it). */
  id: string | null;
}

export interface ParsedGitHubIssue {
  number: number;
  isPullRequest: boolean;
  title: string;
  body: string | null;
  state: "open" | "closed";
  htmlUrl: string;
  author: GitHubAuthor;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** GitHub's comment count, so an issue with none costs no comments request. */
  commentCount: number;
}

export interface ParsedGitHubComment {
  id: number;
  body: string;
  htmlUrl: string;
  author: GitHubAuthor;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalise a GitHub timestamp ("2020-01-02T03:04:05Z") to the
 * millisecond ISO form Stratum writes. The two forms do not sort together as
 * strings ("…05Z" sorts after "…05.000Z"), and comments are ordered by that
 * string, so an imported comment must use the same form as a native one.
 */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Only an https link on github.com is kept as a back-link. The URL comes from
 * the API response, and it is rendered as an `href`, so anything else (a
 * `javascript:` URL, another host) is dropped rather than trusted.
 */
export function safeGitHubUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A deleted GitHub account comes back as `user: null`; GitHub shows it as "ghost". */
function parseAuthor(value: unknown): GitHubAuthor {
  if (!isRecord(value) || typeof value.login !== "string" || !value.login) {
    return { login: "ghost", id: null };
  }
  const id = typeof value.id === "number" && Number.isInteger(value.id) ? String(value.id) : null;
  return { login: value.login.slice(0, 100), id };
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const entry of value) {
    const name = typeof entry === "string" ? entry : isRecord(entry) ? entry.name : undefined;
    if (typeof name !== "string") continue;
    const trimmed = name.trim().slice(0, MAX_IMPORTED_LABEL_LENGTH);
    if (trimmed && !labels.includes(trimmed)) labels.push(trimmed);
  }
  return labels.slice(0, MAX_IMPORTED_LABELS);
}

/**
 * Validate one item from GitHub's issues listing. Returns null for anything
 * that is not shaped like an issue, so one malformed entry is skipped instead of
 * failing the whole page.
 */
export function parseGitHubIssue(raw: unknown): ParsedGitHubIssue | null {
  if (!isRecord(raw)) return null;
  const { number } = raw;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  const isPullRequest = raw.pull_request !== undefined && raw.pull_request !== null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const htmlUrl = safeGitHubUrl(raw.html_url);
  const createdAt = normalizeTimestamp(raw.created_at);
  if (!htmlUrl || !createdAt) return null;
  const state = raw.state === "closed" ? "closed" : "open";
  const body =
    typeof raw.body === "string" && raw.body.trim()
      ? raw.body.slice(0, MAX_IMPORTED_BODY_LENGTH)
      : null;
  return {
    number,
    isPullRequest,
    title: (title || `GitHub issue #${number}`).slice(0, MAX_IMPORTED_TITLE_LENGTH),
    body,
    state,
    htmlUrl,
    author: parseAuthor(raw.user),
    labels: parseLabels(raw.labels),
    createdAt,
    updatedAt: normalizeTimestamp(raw.updated_at) ?? createdAt,
    // A closed issue without a closed_at should still read as closed at some
    // point; its last update is the closest thing GitHub gave us.
    closedAt:
      state === "closed"
        ? (normalizeTimestamp(raw.closed_at) ?? normalizeTimestamp(raw.updated_at) ?? createdAt)
        : null,
    commentCount:
      typeof raw.comments === "number" && Number.isInteger(raw.comments) && raw.comments > 0
        ? raw.comments
        : 0,
  };
}

/** Validate one item from an issue's comments listing (null when malformed). */
export function parseGitHubComment(raw: unknown): ParsedGitHubComment | null {
  if (!isRecord(raw)) return null;
  const { id } = raw;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  const htmlUrl = safeGitHubUrl(raw.html_url);
  const createdAt = normalizeTimestamp(raw.created_at);
  if (!htmlUrl || !createdAt) return null;
  const body = typeof raw.body === "string" ? raw.body.slice(0, MAX_IMPORTED_BODY_LENGTH) : "";
  return { id, body, htmlUrl, author: parseAuthor(raw.user), createdAt };
}

/**
 * Code spans and fenced blocks are copied untouched: `#3` inside code is almost
 * never a reference, and rewriting it would change what the code says.
 */
const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;

/**
 * A bare `#123`. The look-behind excludes word characters (a URL fragment like
 * `page#3`), `/` (an explicit `owner/repo#3`, which already says where it
 * points) and `&` (an HTML entity like `&#123;`).
 */
const BARE_REFERENCE = /(?<![\w/&])#(\d+)\b/g;

/**
 * Rewrite bare `#N` references in imported text so they keep pointing at what
 * the author meant.
 *
 * - `#N` for a GitHub issue that has been imported becomes `#M`, its number in
 *   this project.
 * - Any other `#N` — a pull request, or an issue this run has not reached yet —
 *   becomes `owner/repo#N`, an unambiguous reference to GitHub. Left bare, it
 *   would silently point at whatever unrelated Stratum issue has that number.
 *
 * Text is always rewritten from GitHub's original, never from a previously
 * rewritten copy, so a re-run turns the forward references of the first run
 * into local ones.
 */
export function rewriteIssueReferences(
  text: string,
  numberMap: ReadonlyMap<number, number>,
  githubRepo: string,
): string {
  return text
    .split(CODE_SEGMENT)
    .map((segment, index) =>
      // split() with a capture group interleaves the matched code segments at
      // odd indexes; only the prose between them is rewritten.
      index % 2 === 1
        ? segment
        : segment.replace(BARE_REFERENCE, (_match, digits: string) => {
            const mapped = numberMap.get(Number(digits));
            return mapped !== undefined ? `#${mapped}` : `${githubRepo}#${digits}`;
          }),
    )
    .join("");
}
