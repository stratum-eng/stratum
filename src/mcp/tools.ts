/**
 * The thirty-seven tools the MCP server exposes.
 *
 * The full agent contribution loop: create or import a project, read it, fork a
 * workspace, commit, open an evaluation-gated change, re-evaluate it, discuss it
 * in comments, follow it through review to merge or promote it to a GitHub PR,
 * keep an imported project in sync, track issues, and manage organizations and
 * their teams. Every one is a call into the REST API through `StratumClient`, so
 * Stratum's governance invariants hold over MCP exactly as they do over HTTP —
 * a change cannot merge past failing evaluators, agent tokens cannot submit
 * review verdicts at all, and every merged change keeps its provenance and cost
 * records. The protocol is a doorway, not a bypass.
 *
 * Tool DESCRIPTIONS are the only documentation a model gets, so they state the
 * refusals as well as the capabilities: a model that knows `stratum_review_change`
 * will reject its agent token asks a human instead of retrying it over and over.
 * Each description also names the ACCESS the call needs, because the API
 * answers a missing grant with a bare 403 or 404 and a model cannot tell those
 * apart from a typo.
 *
 * A read-only grant (`mcp:read`, or a `read` token) can call every list/get
 * tool and none of the mutating ones. That is not enforced here: every
 * mutating tool dispatches a non-GET request, and the auth middleware refuses a
 * read-only credential on any non-GET before routing (`src/middleware/auth.ts`).
 *
 * The billing surface is READ-ONLY and stays that way. `stratum_get_usage`
 * exists because an agent that can see 12% of its allowance left batches its
 * changes, moves the project to its own provider key, or stops and asks its
 * human — where an agent that cannot see it discovers the limit by hitting a
 * wall. There is deliberately no upgrade, top-up or payment-method tool, and no
 * `stratum_set_provider_key`: a limit an agent can raise is not a limit, and a
 * credential must never pass through a model's context window (PRD §4c). Both
 * refusals are stated in `stratum_get_usage`'s own description so a model reads
 * them where it would otherwise go looking.
 */
import type { StratumClient } from "./client";
import { InvalidArgumentError, parseProjectRef } from "./client";
import { type SchemaArgs, type ToolSchema, toJsonSchema, validate } from "./schema";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: (args: unknown) => Promise<ToolResult>;
}

/** A successful tool result: the API's JSON, pretty-printed for a reader. */
function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Wrap a typed handler with validation and error-to-result mapping.
 *
 * Failures come back as `isError` results rather than JSON-RPC errors, which is
 * what the MCP spec prescribes for a tool that ran and failed: the model sees
 * the text and can act on it, where a protocol-level error would surface to the
 * client as a transport fault it cannot reason about.
 *
 * Validation failures are labelled distinctly from API failures — a model that
 * reads "Stratum API error" for a schema violation retries the same invalid
 * arguments instead of fixing them.
 */
function tool<const S extends ToolSchema>(
  name: string,
  description: string,
  schema: S,
  handler: (args: SchemaArgs<S>) => Promise<unknown>,
): ToolDef {
  return {
    name,
    description,
    schema,
    handler: async (raw) => {
      const parsed = validate(schema, raw ?? {});
      if (!parsed.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid arguments for ${name}:\n  - ${parsed.errors.join("\n  - ")}`,
            },
          ],
          isError: true,
        };
      }
      try {
        return jsonResult(await handler(parsed.value));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Many tools resolve a `namespace/slug` reference inside the
        // handler, which the JSON Schema can only type as "a string". Those
        // failures are argument failures and have to read as such, or the
        // labelling above becomes a lie for the most common mistake a model
        // makes.
        if (error instanceof InvalidArgumentError) {
          return {
            content: [{ type: "text", text: `Invalid arguments for ${name}:\n  - ${message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Stratum API error: ${message}` }],
          isError: true,
        };
      }
    },
  };
}

const projectArg = {
  type: "string",
  description: 'Project reference as "namespace/slug", e.g. "@acme/api" or "acme/api"',
} as const;

const orgArg = {
  type: "string",
  description: 'Organization slug, e.g. "acme" (a leading "@" is accepted)',
} as const;

const changeIdArg = { type: "string", description: "Change id, e.g. chg_abc123" } as const;

const visibilityArg = {
  type: "enum",
  values: ["private", "public"],
  description: "Project visibility (default private)",
  optional: true,
} as const;

/** An org slug as the API takes it in a body, without the namespace's `@`. */
function bareOrgSlug(org: string): string {
  return org.startsWith("@") ? org.slice(1) : org;
}

/**
 * The project name an import defaults to: the source repository's own name,
 * the last path segment of its URL without a `.git` suffix. The server still
 * validates it as a slug; this only saves the model from restating it.
 */
function repoNameFromUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    throw new InvalidArgumentError(`'url' is not a valid URL: ${url}`);
  }
  const last =
    pathname
      .split("/")
      .filter((segment) => segment !== "")
      .pop() ?? "";
  const name = last.replace(/\.git$/, "");
  if (name === "") {
    throw new InvalidArgumentError(
      "could not derive a project name from 'url' — pass 'name' explicitly",
    );
  }
  return name;
}

/**
 * The full Stratum surface an agent needs to propose governed changes: read a
 * project, fork a workspace, commit, open an eval-gated change, and follow it
 * through review to merge.
 *
 * Review verdicts, merge and reject stay human gates — the API behind them
 * refuses an agent token, and the descriptions say so rather than letting a
 * model discover it by retrying.
 */
export function buildTools(client: StratumClient): ToolDef[] {
  return [
    tool(
      "stratum_whoami",
      'Identify who this connection acts as. `actingAs: "user"` means work is recorded as the signed-in user, with no agent provenance. `actingAs: "agent"` means the user bound this connection to an agent when they authorized it: work is recorded as that agent (returned with its id and name) acting for its owner. With a bare agent token this returns a 401; agents holding their own token already know who they are.',
      {},
      () => client.me(),
    ),
    tool(
      "stratum_get_usage",
      'Read this account\'s metered usage against its plan limits for the current billing period: per-meter consumption (LLM tokens, sandbox time, deploys), the limit on each, the rate ceilings, the period, and when it resets. A limit of -1 means unlimited, 0 means the plan forbids that meter outright; when a limit is unlimited there is no percentage to compute. Figures cover platform-billed usage only — spend on a project\'s own provider key (BYOK) is billed by that provider and is never counted against these allowances. `usedSource` says where each `used` figure comes from: "meter" is the live counter a limit is actually compared against, covering work in any namespace; "ledger" means those counters were unavailable and the figures are the usage recorded against this account alone, which excludes work recorded against an organization. An agent token reports its OWNER\'s allowance, because that is the account its evaluations are charged to. Read-only, and the only billing tool there is: nothing here can raise a limit, buy capacity, add a payment method or set a provider key, for the same reason agent tokens cannot submit review verdicts — a spend limit an agent can lift is not a limit. Do not look for one; hand the account owner https://docs.usestratum.dev and let a human do it in a browser.',
      {},
      () => client.getUsage(),
    ),

    // ── Projects ──────────────────────────────────────────────────────────
    tool(
      "stratum_list_projects",
      "List Stratum projects in the caller's own namespace. Org-namespace projects are not included, and an agent (an agent token, or a connection bound to an agent) gets an empty list — address a known project by namespace/slug instead.",
      {},
      () => client.listProjects(),
    ),
    tool(
      "stratum_get_project",
      "Get a Stratum project's metadata (id, namespace, visibility, git remote).",
      { project: projectArg },
      (a) => client.getProject(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_list_files",
      "List file paths at the HEAD of a Stratum project's default branch.",
      { project: projectArg },
      (a) => client.listFiles(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_get_file",
      "Read one file's content from the HEAD of a Stratum project.",
      {
        project: projectArg,
        path: { type: "string", description: "Repo-relative file path" },
      },
      (a) => client.getFileContent(parseProjectRef(a.project), a.path),
    ),
    tool(
      "stratum_get_activity",
      "Get the recent activity feed for a Stratum project (changes, merges, evaluations, issues).",
      { project: projectArg },
      (a) => client.getActivity(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_list_branches",
      "List a Stratum project's branches. Needs read access to the project.",
      { project: projectArg },
      (a) => client.listBranches(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_create_project",
      "Create a new, empty Stratum project. Without `org` it goes in your own namespace; with `org` it goes in that organization's namespace and needs write access there (an org admin, or a member of a team with write permission). A private project counts toward the private-project limit. User credentials only (agent tokens are refused); a token bound to one project cannot create projects, and one bound to an org can create only in that org. Needs a write grant (mcp:write).",
      {
        name: { type: "string", description: "Project name (1-64 alphanumeric, - or _)" },
        org: { ...orgArg, optional: true },
        visibility: visibilityArg,
        seed: {
          type: "boolean",
          description: "Seed the repository with starter files (default: one empty file)",
          optional: true,
        },
      },
      (a) =>
        client.createProject({
          name: a.name,
          ...(a.org !== undefined ? { org: bareOrgSlug(a.org) } : {}),
          ...(a.visibility !== undefined ? { visibility: a.visibility } : {}),
          ...(a.seed !== undefined ? { seed: a.seed } : {}),
        }),
    ),
    tool(
      "stratum_import_project",
      'Import a repository from GitHub, GitLab or Bitbucket as a new Stratum project. The import runs in the background: this returns at once with status "queued", and stratum_get_import_status follows it. Without `org` the project goes in your own namespace; with `org` it goes in that organization\'s namespace and needs write access there (an org admin, or a member of a team with write permission) — anything else is refused with 403. A private import counts toward the private-project limit. Rate limited to 3 imports a minute. User credentials only (agent tokens are refused), and no token bound to one project or org can import. Needs a write grant (mcp:write).',
      {
        url: { type: "string", description: "Source repository URL, e.g. https://github.com/o/r" },
        name: {
          type: "string",
          description: "Project name in Stratum (default: the source repository's name)",
          optional: true,
        },
        org: { ...orgArg, optional: true },
        branch: {
          type: "string",
          description: "Branch to import (default: the source's default branch)",
          optional: true,
        },
        depth: {
          type: "integer",
          description: "Clone depth, 1-1000, or 0 for full history (default 10)",
          optional: true,
        },
        visibility: visibilityArg,
      },
      async (a) => {
        const slug = a.name ?? repoNameFromUrl(a.url);
        let namespace: string;
        if (a.org !== undefined) {
          namespace = `@${bareOrgSlug(a.org)}`;
        } else {
          // The personal namespace is the caller's username, which only the
          // server knows. Resolved per call, never cached: a rename between two
          // calls must not send an import to the old name.
          // A connection bound to an agent works in its owner's namespace.
          const me = await client.me();
          const username = me.actingAs === "agent" ? me.owner.username : me.username;
          if (!username) throw new Error("Could not resolve your namespace; pass 'org'");
          namespace = username.startsWith("@") ? username : `@${username}`;
        }
        return client.importProject(
          { namespace, slug },
          {
            url: a.url,
            ...(a.branch !== undefined ? { branch: a.branch } : {}),
            ...(a.depth !== undefined ? { depth: a.depth } : {}),
            ...(a.visibility !== undefined ? { visibility: a.visibility } : {}),
          },
        );
      },
    ),
    tool(
      "stratum_get_import_status",
      'Get the progress of a project\'s import: status (queued, cloning, processing, completed, failed, cancelled, …), file counts, errors and logs. Until the import completes the project is visible only to people who can write to it, so a read-only org member gets "not found". Needs read access to the project (write access while the import is unfinished).',
      { project: projectArg },
      (a) => client.getImportStatus(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_get_sync_status",
      "Get an imported project's sync state against its source repository: whether a sync is in progress, the last synced commit, and the last error. Needs read access to the project.",
      { project: projectArg },
      (a) => client.getSyncStatus(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_sync_project",
      'Pull new commits from an imported project\'s source repository. Returns at once — "No updates available" or a queued sync job; follow it with stratum_get_sync_status. Allowed in your own namespace or in an organization where you have write access. User credentials only (agent tokens are refused). Needs a write grant (mcp:write).',
      { project: projectArg },
      (a) => client.syncProject(parseProjectRef(a.project)),
    ),

    // ── Workspaces ────────────────────────────────────────────────────────
    tool(
      "stratum_create_workspace",
      "Fork an isolated workspace from a Stratum project. Returns the workspace name and its git remote. Commit work here, then open a change to propose merging it.",
      {
        project: projectArg,
        name: { type: "string", description: "Optional workspace name", optional: true },
      },
      (a) => client.createWorkspace(parseProjectRef(a.project), a.name),
    ),
    tool(
      "stratum_list_workspaces",
      "List all workspaces for a Stratum project (no status filter — workspaces whose changes already merged still appear).",
      { project: projectArg },
      (a) => client.listWorkspaces(parseProjectRef(a.project)),
    ),
    tool(
      "stratum_commit",
      "Commit files to a workspace. Takes a map of repo-relative file paths to full new file contents. Over MCP the whole request is capped at 8 MB (the REST API allows 25 MB); it is also capped at 2,000 files, and it cannot express a deletion or a rename — push over the workspace's git remote for those.",
      {
        workspace: {
          type: "string",
          description: "Workspace name returned by stratum_create_workspace",
        },
        project_id: { type: "string", description: "Project id from stratum_get_project" },
        message: { type: "string", description: "Commit message" },
        files: {
          type: "stringMap",
          description: "Map of repo-relative path to complete new file content",
        },
      },
      (a) => client.commitToWorkspace(a.workspace, a.project_id, a.files, a.message),
    ),

    // ── Changes (eval-gated merge proposals) ──────────────────────────────
    tool(
      "stratum_create_change",
      "Open a change (merge proposal) from a workspace. The project's evaluation gates from .stratum/policy.yaml — secret scan, diff policy, LLM review, sandbox tests — run on it. On instances with an evaluation queue the change comes back with status `evaluating` and no verdict yet: poll stratum_get_change until the status leaves `evaluating` (it becomes `accepted` or `needs_changes`) before deciding anything. Otherwise the verdicts are returned directly. A failing gate blocks the merge, and a change still evaluating cannot be merged.",
      { project: projectArg, workspace: { type: "string", description: "Source workspace name" } },
      (a) => {
        const ref = parseProjectRef(a.project);
        return client.createChange(`${ref.namespace}/${ref.slug}`, a.workspace);
      },
    ),
    tool(
      "stratum_list_changes",
      "List changes for a Stratum project, optionally filtered by status (open, evaluating, needs_changes, accepted, approved, promoted, merged, rejected).",
      {
        project: projectArg,
        status: { type: "string", description: "Optional status filter", optional: true },
      },
      (a) => {
        const ref = parseProjectRef(a.project);
        return client.listChanges(`${ref.namespace}/${ref.slug}`, a.status);
      },
    ),
    tool(
      "stratum_get_change",
      "Get one change with its evaluation runs (per-gate score, pass/fail, reason) and metered costs (LLM tokens, sandbox time, git ops). Status `evaluating` means the gates are still running and no verdict exists yet; poll again rather than treating it as a result.",
      { change_id: { type: "string", description: "Change id, e.g. chg_abc123" } },
      (a) => client.getChange(a.change_id),
    ),
    tool(
      "stratum_merge_change",
      "Merge a change that has passed its evaluation gates and required human approvals. Fails with the blocking reasons otherwise; a change still `evaluating` is refused (EVALUATION_PENDING), even with force, and a stale base is rejected until re-evaluated. Force requires the policy to allow it. User credentials only — agent tokens cannot merge, and neither can a connection bound to an agent; ask the user to merge, or to reconnect acting as themselves.",
      {
        change_id: { type: "string", description: "Change id" },
        force: {
          type: "boolean",
          description: "Request a force merge (denied unless policy allows)",
          optional: true,
        },
        strategy: {
          type: "enum",
          values: ["merge", "squash"],
          description: "Merge strategy",
          optional: true,
        },
      },
      (a) => {
        const opts: { force?: boolean; strategy?: "merge" | "squash" } = {};
        if (a.force !== undefined) opts.force = a.force;
        if (a.strategy !== undefined) opts.strategy = a.strategy;
        return client.mergeChange(a.change_id, opts);
      },
    ),
    tool(
      "stratum_reject_change",
      "Reject an open change, closing it without merging. User credentials only — agent tokens cannot reject, and neither can a connection bound to an agent.",
      { change_id: { type: "string", description: "Change id" } },
      (a) => client.rejectChange(a.change_id),
    ),
    tool(
      "stratum_review_change",
      "Submit a review verdict on a change. Reviews are a human gate. Over MCP only `request_changes` is accepted: `approve` is refused with SESSION_REQUIRED, because an approval must come from the user, who has to approve in the browser (a signed-in session) — ask them to. Every verdict from an agent token, or from a connection bound to an agent, is refused. Needs write access. An agent's feedback channel is change comments — use stratum_comment_change.",
      {
        change_id: { type: "string", description: "Change id" },
        verdict: {
          type: "enum",
          values: ["approve", "request_changes"],
          description: "Review verdict",
        },
        comment: { type: "string", description: "Optional review comment", optional: true },
      },
      (a) => client.reviewChange(a.change_id, a.verdict, a.comment),
    ),

    tool(
      "stratum_evaluate_change",
      "Re-run a change's evaluation gates against its workspace's current state — do this after pushing new commits to the workspace. On instances with an evaluation queue the change comes back `evaluating` with no verdict yet: poll stratum_get_change until the status leaves `evaluating`. Otherwise the verdicts are returned directly. Merged, rejected and promoted changes cannot be re-evaluated. Needs write access to the project; user credentials only (agent tokens are refused). Needs a write grant (mcp:write).",
      { change_id: changeIdArg },
      (a) => client.evaluateChange(a.change_id),
    ),
    tool(
      "stratum_promote_change",
      "Promote an accepted change to a pull request on the project's linked GitHub repository: pushes the change's branch and opens the PR against the project's default branch (as a draft unless `draft` is false), reusing the PR if one is already open for it. The change must be accepted first, and the project must be imported from GitHub. Needs write access to the project; user credentials only (agent tokens are refused). Needs a write grant (mcp:write).",
      {
        change_id: changeIdArg,
        title: {
          type: "string",
          description: 'PR title (default "Stratum: <change id>")',
          optional: true,
        },
        body: { type: "string", description: "PR description", optional: true },
        draft: {
          type: "boolean",
          description: "Open the PR as a draft (default true)",
          optional: true,
        },
      },
      (a) =>
        client.promoteChange(a.change_id, {
          ...(a.title !== undefined ? { title: a.title } : {}),
          ...(a.body !== undefined ? { body: a.body } : {}),
          ...(a.draft !== undefined ? { draft: a.draft } : {}),
        }),
    ),
    tool(
      "stratum_comment_change",
      "Comment on a change — the feedback channel for agents, which cannot submit review verdicts. A comment is change-wide by default; pass `file` and `line` to anchor it to a line of the diff, or `parent_comment_id` to reply in an existing thread (a reply inherits its thread's anchor, so omit file/line with it). Agent tokens may comment. Needs read access to the project and a write grant (mcp:write).",
      {
        change_id: changeIdArg,
        body: { type: "string", description: "Comment text (markdown)" },
        file: { type: "string", description: "Repo-relative path to anchor to", optional: true },
        line: { type: "integer", description: "Line number (>= 1) to anchor to", optional: true },
        side: {
          type: "enum",
          values: ["old", "new"],
          description: "Which side of the diff the line is on (default new)",
          optional: true,
        },
        commit_sha: {
          type: "string",
          description: "Commit the anchored line refers to",
          optional: true,
        },
        parent_comment_id: {
          type: "string",
          description: "Comment id to reply to",
          optional: true,
        },
      },
      (a) =>
        client.commentOnChange(a.change_id, {
          body: a.body,
          ...(a.file !== undefined ? { file: a.file } : {}),
          ...(a.line !== undefined ? { line: a.line } : {}),
          ...(a.side !== undefined ? { side: a.side } : {}),
          ...(a.commit_sha !== undefined ? { commitSha: a.commit_sha } : {}),
          ...(a.parent_comment_id !== undefined ? { parentCommentId: a.parent_comment_id } : {}),
        }),
    ),
    tool(
      "stratum_list_change_comments",
      "List a change's comments in order, each with its author, anchor (file/line, if any), parentCommentId (for replies) and resolved state. Needs read access to the project.",
      { change_id: changeIdArg },
      (a) => client.listChangeComments(a.change_id),
    ),

    // ── Issues ────────────────────────────────────────────────────────────
    tool(
      "stratum_create_issue",
      "Open an issue on a Stratum project. Linking a change id auto-closes the issue when that change merges.",
      {
        project: projectArg,
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body", optional: true },
        linked_change_id: { type: "string", description: "Change id to link", optional: true },
      },
      (a) => client.createIssue(parseProjectRef(a.project), a.title, a.body, a.linked_change_id),
    ),
    tool(
      "stratum_list_issues",
      "List issues for a Stratum project, optionally filtered by status.",
      {
        project: projectArg,
        status: {
          type: "enum",
          values: ["open", "closed"],
          description: "Optional status filter",
          optional: true,
        },
      },
      (a) => client.listIssues(parseProjectRef(a.project), a.status),
    ),
    tool(
      "stratum_update_issue",
      "Update an issue's status, title, or body by its number.",
      {
        project: projectArg,
        number: { type: "integer", description: "Issue number" },
        status: {
          type: "enum",
          values: ["open", "closed"],
          description: "New status",
          optional: true,
        },
        title: { type: "string", description: "New title", optional: true },
        body: { type: "string", description: "New body", optional: true },
      },
      (a) =>
        client.updateIssue(parseProjectRef(a.project), a.number, {
          ...(a.status !== undefined ? { status: a.status } : {}),
          ...(a.title !== undefined ? { title: a.title } : {}),
          ...(a.body !== undefined ? { body: a.body } : {}),
        }),
    ),

    // ── Organizations ─────────────────────────────────────────────────────
    tool(
      "stratum_create_org",
      "Create an organization; you become its admin. Its projects live under the @slug namespace, so the slug cannot match an existing username or org. User credentials only (agent tokens are refused), and not available to a token bound to one project or org. Needs a write grant (mcp:write).",
      {
        name: { type: "string", description: "Display name" },
        slug: { type: "string", description: "URL slug (1-64 alphanumeric, - or _)" },
      },
      (a) => client.createOrg(a.name, a.slug),
    ),
    tool(
      "stratum_list_orgs",
      "List the organizations you are a member of. User credentials only; not available to a token bound to one project or org.",
      {},
      () => client.listOrgs(),
    ),
    tool(
      "stratum_get_org",
      'Get an organization\'s record. Members only — a non-member gets the same "not found" as a missing org. Not available to a token bound to one project or org.',
      { org: orgArg },
      (a) => client.getOrg(a.org),
    ),
    tool(
      "stratum_add_org_member",
      "Add a user to an organization, or change an existing member's role. Org admins only. Needs the user's Stratum user id (usr_…), not a username or email. User credentials only (agent tokens are refused). Needs a write grant (mcp:write).",
      {
        org: orgArg,
        user_id: { type: "string", description: "Stratum user id, e.g. usr_abc123" },
        role: {
          type: "enum",
          values: ["member", "admin"],
          description:
            "Org role (default member). A plain member can read the org's projects; write comes from a team.",
          optional: true,
        },
      },
      (a) => client.addOrgMember(a.org, a.user_id, a.role),
    ),
    tool(
      "stratum_remove_org_member",
      "Remove a user from an organization. Org admins only — except that any member may remove themselves (leave), which the org's owner cannot do. User credentials only (agent tokens are refused). Needs a write grant (mcp:write).",
      {
        org: orgArg,
        user_id: { type: "string", description: "Stratum user id, e.g. usr_abc123" },
      },
      (a) => client.removeOrgMember(a.org, a.user_id),
    ),
    tool(
      "stratum_create_team",
      "Create a team in an organization. A team's permission applies to every project in the org: `write` lets its members push, open changes and import into the org. Org admins only. User credentials only (agent tokens are refused). Needs a write grant (mcp:write).",
      {
        org: orgArg,
        name: { type: "string", description: "Team display name" },
        slug: { type: "string", description: "Team slug (1-64 alphanumeric, - or _)" },
        permissions: {
          type: "enum",
          values: ["read", "write", "admin"],
          description: "Permission the team grants on the org's projects (default read)",
          optional: true,
        },
      },
      (a) =>
        client.createTeam(a.org, {
          name: a.name,
          slug: a.slug,
          ...(a.permissions !== undefined ? { permissions: a.permissions } : {}),
        }),
    ),
    tool(
      "stratum_list_teams",
      'List an organization\'s teams with their permissions. Members only — a non-member gets "not found". Not available to a token bound to one project or org.',
      { org: orgArg },
      (a) => client.listTeams(a.org),
    ),
    tool(
      "stratum_add_team_member",
      "Add a user to a team, granting them the team's permission across the org's projects. Org admins only. Needs the team id from stratum_list_teams and the user's Stratum user id (usr_…). User credentials only (agent tokens are refused). Needs a write grant (mcp:write).",
      {
        org: orgArg,
        team_id: { type: "string", description: "Team id from stratum_list_teams" },
        user_id: { type: "string", description: "Stratum user id, e.g. usr_abc123" },
      },
      (a) => client.addTeamMember(a.org, a.team_id, a.user_id),
    ),
  ];
}

/** The `tools/list` payload: name, description and JSON Schema per tool. */
export function toolListing(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.schema),
  }));
}
