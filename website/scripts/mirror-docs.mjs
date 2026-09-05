// Mirrors the canonical Markdown in ../docs into this site's content
// collection, the same way sync:openapi copies the OpenAPI spec.
//
// The user guide and API reference live twice: under `docs/` in the repo, and
// as Starlight pages here. `docs/` is canonical. The two copies differ only in
// frontmatter and link style, so keeping them in sync by hand is busywork that
// silently fails — and it has: the published site has carried a token model,
// an import options table, and FAQ entries that no longer matched the code.
//
//   node scripts/mirror-docs.mjs           # write the mirrors
//   node scripts/mirror-docs.mjs --check   # exit 1 if any mirror is stale
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";

const REPO = "https://github.com/stratum-eng/stratum";
const DOCS = "../docs";
const OUT = "src/content/docs";

/** Pages published as /guides/<slug>/, keyed by their file in docs/user-guide. */
const GUIDES = [
  ["getting-started", "From sign-up to a merged, evaluation-gated change — policy, agent identity, and the change flow."],
  ["importing", "Import a repository from GitHub, GitLab, or Bitbucket, track progress, and keep the project in sync with its source."],
  ["code-review", "Line-anchored comment threads, replies, resolve/unresolve, and the three review verdicts."],
  ["issues", "Open, triage, search, and link issues — and how a merged change closes them."],
  ["ci-integration", "Bring your own CI: run evaluations on your existing infrastructure and report verdicts back."],
  ["deployments", "Publish the merged tree to Cloudflare or Vercel after a change lands — the deploys: policy block, encrypted project secrets, the approval gate, limits, and what v1 does not do."],
  ["cli", "Install and use @stratum/cli — projects, workspaces, commits, and the change flow from the terminal."],
  ["mcp", "Connect any MCP-capable agent or editor to the evaluation-gated change flow over the hosted /mcp endpoint — OAuth 2.1, nothing to install."],
  ["troubleshooting", "Symptoms and fixes for auth, imports, evaluation, merges, and access."],
  ["faq", "Common questions about Stratum's merge gate, provenance, CI, limitations, and telemetry."],
];

/** Pages published as /reference/<slug>/, keyed by their file in docs/api. */
const REFERENCE = [
  ["errors", "HTTP status codes and the machine-readable error codes Stratum returns."],
  ["authentication", "Named scoped API tokens, agent tokens, session cookies, anonymous access, and the admin API key."],
];

/**
 * `/reference/endpoints/` is one page composed from `docs/api/endpoints/`, in
 * this order. Listed explicitly rather than globbed: a new endpoint file that
 * nobody registers here would be silently unpublished, which is the same class
 * of bug this script exists to prevent. `endpointsAudit()` fails when the
 * directory and this list disagree, so adding a file forces a decision.
 */
const ENDPOINT_ORDER = [
  "projects",
  "workspaces",
  "changes",
  "reviews",
  "issues",
  "deployments",
  "agents",
  "users",
  "organizations",
];

const ENDPOINTS_DESCRIPTION =
  "The Stratum REST API surface — projects, branches, workspaces, changes, reviews, issues, deployments, agents, users, and organizations.";

/**
 * Published pages that are deliberately authored here rather than mirrored,
 * with the reason. Everything else under `src/content/docs` must be generated.
 *
 * This map is the point of the inventory audit: before it, a hand-authored page
 * was indistinguishable from a mirrored one, so `reference/endpoints.md` sat
 * beside a 578-line copy of the same content in `docs/api/endpoints/` and
 * drifted with nothing to notice. Adding a page here is now a decision someone
 * reviews, not an omission.
 */
const SITE_OWNED = new Map([
  ["index.mdx", "The site's landing page. Marketing copy, not documentation."],
  [
    "reference/agent-discovery.md",
    "Documents this site's own machine-readable entry points (llms.txt, webmcp.js), which live in website/ and have no counterpart in docs/.",
  ],
  [
    "reference/openapi.md",
    "A wrapper that embeds docs/api/openapi.yml; the spec itself is synced by sync:openapi, so there is no prose to mirror.",
  ],
]);

const GUIDE_SLUGS = new Set(GUIDES.map(([slug]) => slug));
const REF_SLUGS = new Set([...REFERENCE.map(([slug]) => slug), "endpoints", "openapi", "agent-discovery"]);

/**
 * Map a repo-relative path to its published URL, or null if the site does not
 * publish it. Resolving the link target first (rather than pattern-matching the
 * raw href) is what makes `openapi.yml` from docs/api and `../api/openapi.yml`
 * from docs/user-guide reach the same answer.
 */
function siteUrl(resolved) {
  let m = resolved.match(/^docs\/user-guide\/([a-z0-9-]+)\.md$/);
  if (m && GUIDE_SLUGS.has(m[1])) return `/guides/${m[1]}/`;
  if (resolved === "docs/api/openapi.yml") return "/reference/openapi/";
  m = resolved.match(/^docs\/api\/([a-z0-9-]+)\.md$/);
  if (m && REF_SLUGS.has(m[1])) return `/reference/${m[1]}/`;
  // Endpoint pages are not published individually; the site has one overview.
  // README (uppercase) is the directory's own index, so it maps there too.
  if (/^docs\/api\/endpoints\/[A-Za-z0-9-]+\.md$/.test(resolved)) return "/reference/endpoints/";
  return null;
}

// The repo's copies are written for a self-hosted reader; the published site
// documents the hosted instance and uses it consistently in examples. Each page
// still tells the reader to substitute their own host.
const HOSTED_ORIGIN = "https://app.usestratum.dev";
const SELF_HOST_PLACEHOLDER = /https:\/\/your-instance\.workers\.dev/g;

function rewriteLinks(text, srcDir) {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    if (/^(https?:|mailto:|\/|#)/.test(href)) return whole;
    const [path, hash] = href.split("#");
    const anchor = hash ? `#${hash}` : "";
    if (!path || !/\.(md|yml)$/.test(path)) return whole;
    const resolved = normalize(join(srcDir, path)).split("\\").join("/");
    const url = siteUrl(resolved);
    return url ? `[${label}](${url}${anchor})` : `[${label}](${REPO}/blob/main/${resolved}${anchor})`;
  });
}

/** Quote the scalar: a colon in a title or description otherwise parses as a
 *  YAML mapping and fails the Astro build. */
const yamlString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function render(srcPath, srcDir, description, canonicalPath) {
  const raw = await readFile(srcPath, "utf8");
  const lines = raw.split("\n");
  if (!lines[0].startsWith("# ")) throw new Error(`${srcPath}: expected a level-1 heading`);
  const title = lines[0].slice(2).trim();
  let body = rewriteLinks(lines.slice(1).join("\n").replace(/^\n+/, ""), srcDir);
  body = body.replace(SELF_HOST_PLACEHOLDER, HOSTED_ORIGIN);
  // Starlight's default edit link is `editLink.baseUrl + entry.filePath`, which
  // for these pages resolves to the generated copy under src/content/docs — so
  // "Edit this page" would send a contributor to a file the next sync
  // overwrites. A per-page editUrl overrides that and points at the canonical
  // source. Pages actually authored in website/ keep the default.
  const editUrl = `${REPO}/edit/main/${canonicalPath}`;
  return (
    `---\ntitle: ${yamlString(title)}\ndescription: ${yamlString(description)}\n` +
    `editUrl: ${yamlString(editUrl)}\n---\n\n${body}`
  );
}

/** GitHub's heading-anchor slug, so composed in-page links resolve. */
const anchorFor = (heading) =>
  `#${heading.toLowerCase().replace(/[^\w\- ]+/g, "").trim().replace(/ +/g, "-")}`;

/**
 * Demote every heading one level, skipping fenced code.
 *
 * The fence tracking is load-bearing, not defensive: these pages carry YAML and
 * shell examples whose comments start at column 0, and a naive `^#` replace
 * would rewrite `# Create the token` into `## Create the token` inside a code
 * block.
 */
function demoteHeadings(body) {
  let fenced = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join("\n");
}

/**
 * Compose `/reference/endpoints/` from `docs/api/endpoints/`.
 *
 * The site publishes one overview rather than a page per resource, so the
 * per-resource files are concatenated under the README's introduction and every
 * sibling link is turned into an in-page anchor.
 */
async function renderEndpointsPage() {
  const dir = join(DOCS, "api", "endpoints");
  const readme = (await readFile(join(dir, "README.md"), "utf8")).split("\n");
  const title = readme[0].slice(2).trim();

  const sections = [];
  const anchors = new Map();
  for (const slug of ENDPOINT_ORDER) {
    const lines = (await readFile(join(dir, `${slug}.md`), "utf8")).split("\n");
    if (!lines[0].startsWith("# ")) throw new Error(`${slug}.md: expected a level-1 heading`);
    const heading = lines[0].slice(2).trim();
    anchors.set(slug, anchorFor(heading));
    sections.push({ heading, body: lines.slice(1).join("\n").replace(/^\n+/, "") });
  }

  // Sibling links resolve to this same page, so point them at the section
  // rather than at the page they are already on.
  //
  // A link that already carries a fragment (`changes.md#list-changes`) keeps
  // the fragment *instead of* the section anchor: the heading it names is now
  // on this same page, and concatenating the two would emit `#a#b`, a single
  // fragment with two hashes that matches no heading at all.
  const linkToAnchor = (text) =>
    text.replace(/\]\(\.?\/?([a-z0-9-]+)\.md(#[^)]*)?\)/g, (whole, slug, hash) =>
      anchors.has(slug) ? `](${hash ?? anchors.get(slug)})` : whole,
    );

  const composed = [
    linkToAnchor(readme.slice(1).join("\n").replace(/^\n+/, "")),
    ...sections.map(({ heading, body }) => `## ${heading}\n\n${linkToAnchor(demoteHeadings(body))}`),
  ].join("\n\n");

  let body = rewriteLinks(composed, "docs/api/endpoints").replace(
    SELF_HOST_PLACEHOLDER,
    HOSTED_ORIGIN,
  );
  body = body.replace(/\n{3,}/g, "\n\n").trimEnd();

  // A file, not the directory: GitHub's /edit/ route only resolves file paths,
  // so a directory here renders an "Edit this page" link that 404s. The README
  // is the composed page's own introduction, which makes it the right landing
  // spot for someone who clicked edit from the top of the page.
  const editUrl = `${REPO}/edit/main/docs/api/endpoints/README.md`;
  return (
    `---\ntitle: ${yamlString(title)}\ndescription: ${yamlString(ENDPOINTS_DESCRIPTION)}\n` +
    `editUrl: ${yamlString(editUrl)}\n---\n\n${body}\n`
  );
}

/**
 * Every `.md` under `docs/api/endpoints` must be registered in
 * `ENDPOINT_ORDER`, and every registered slug must exist.
 */
async function endpointsAudit() {
  const dir = join(DOCS, "api", "endpoints");
  const present = (await readdir(dir))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  const registered = [...ENDPOINT_ORDER].sort();
  const problems = [];
  for (const slug of present) {
    if (!registered.includes(slug)) {
      problems.push(
        `docs/api/endpoints/${slug}.md is not in ENDPOINT_ORDER, so it is never published`,
      );
    }
  }
  for (const slug of registered) {
    if (!present.includes(slug)) {
      problems.push(`ENDPOINT_ORDER lists "${slug}" but docs/api/endpoints/${slug}.md is missing`);
    }
  }
  return problems;
}

/** Every published page, as a path relative to `src/content/docs`. */
async function publishedPages(dir = OUT, prefix = "") {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await publishedPages(join(dir, entry.name), rel)));
    else if (/\.mdx?$/.test(entry.name)) found.push(rel);
  }
  return found.sort();
}

/**
 * The inventory audit: every published page is either generated by this script
 * or declared in `SITE_OWNED`.
 *
 * Without this, the freshness check above only ever asked "are the pages I know
 * about stale?" — it could not see a page nobody generated, which is exactly
 * how a hand-authored `reference/endpoints.md` shadowed `docs/api/endpoints/`
 * unnoticed.
 */
async function inventoryAudit(generated) {
  const owned = new Set([...generated, ...SITE_OWNED.keys()]);
  const problems = [];
  for (const page of await publishedPages()) {
    if (!owned.has(page)) {
      problems.push(
        `${page} is published but nothing generates it. Either mirror it from docs/, or add it to SITE_OWNED with a reason.`,
      );
    }
  }
  for (const declared of SITE_OWNED.keys()) {
    if (!(await publishedPages()).includes(declared)) {
      problems.push(`SITE_OWNED lists ${declared}, which no longer exists`);
    }
  }
  return problems;
}

const check = process.argv.includes("--check");
const targets = [
  ...GUIDES.map(([slug, d]) => [join(DOCS, "user-guide", `${slug}.md`), "docs/user-guide", join(OUT, "guides", `${slug}.md`), d]),
  ...REFERENCE.map(([slug, d]) => [join(DOCS, "api", `${slug}.md`), "docs/api", join(OUT, "reference", `${slug}.md`), d]),
];

const outputs = [];
for (const [srcPath, srcDir, destPath, description] of targets) {
  // srcPath is website-relative ("../docs/..."); the edit link needs it
  // relative to the repository root. Normalize separators first: join() emits
  // backslashes on Windows, which would survive into the URL.
  const canonicalPath = srcPath.split("\\").join("/").replace(/^\.\.\//, "");
  outputs.push([destPath, await render(srcPath, srcDir, description, canonicalPath), srcPath]);
}
outputs.push([
  join(OUT, "reference", "endpoints.md"),
  await renderEndpointsPage(),
  `${DOCS}/api/endpoints/`,
]);

const stale = [];
for (const [destPath, rendered, srcPath] of outputs) {
  if (check) {
    const current = await readFile(destPath, "utf8").catch(() => null);
    if (current !== rendered) stale.push(`${destPath} is out of sync with ${srcPath}`);
  } else {
    await writeFile(destPath, rendered);
  }
}

// Run in both modes: writing the mirrors does not make an unmanaged page
// managed, so `sync:guides` must surface the same problem `--check` does
// rather than reporting success and leaving it for CI.
const generated = outputs.map(([destPath]) =>
  relative(OUT, destPath).split("\\").join("/"),
);
const problems = [...(await endpointsAudit()), ...(await inventoryAudit(generated))];
if (problems.length) {
  console.error("mirror-docs: every published page must have exactly one source:\n");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

if (check) {
  if (stale.length) {
    console.error("mirror-docs: the published mirrors are stale:\n");
    for (const s of stale) console.error(`  ${s}`);
    console.error("\nRun `npm run sync:guides` in website/ and commit the result.");
    process.exit(1);
  }
  console.log(
    `mirror-docs: all ${outputs.length} mirrors are in sync; ${SITE_OWNED.size} pages declared site-owned`,
  );
} else {
  console.log(
    `mirror-docs: wrote ${outputs.length} mirrors into ${OUT}/; ${SITE_OWNED.size} pages declared site-owned`,
  );
}
