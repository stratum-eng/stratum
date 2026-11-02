/**
 * The eighteen tools the MCP server exposes.
 *
 * The full agent contribution loop: read a project, fork a workspace, commit,
 * open an evaluation-gated change, follow it through review to merge, and track
 * issues. Every one is a call into the REST API through `StratumClient`, so
 * Stratum's governance invariants hold over MCP exactly as they do over HTTP —
 * a change cannot merge past failing evaluators, agent tokens cannot submit
 * review verdicts at all, and every merged change keeps its provenance and cost
 * records. The protocol is a doorway, not a bypass.
 *
 * Tool DESCRIPTIONS are the only documentation a model gets, so they state the
 * refusals as well as the capabilities: a model that knows `stratum_review_change`
 * will reject its agent token asks a human instead of retrying nineteen times.
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
        // Thirteen tools resolve a `namespace/slug` reference inside the
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
      "Identify the authenticated Stratum user. User credentials only — with an agent token this returns a 401; agents should already know who they are.",
      {},
      () => client.me(),
    ),

    // ── Projects ──────────────────────────────────────────────────────────
    tool(
      "stratum_list_projects",
      "List Stratum projects in the caller's own namespace. Org-namespace projects are not included, and an agent token gets an empty list — address a known project by namespace/slug instead.",
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
      "Open a change (merge proposal) from a workspace. This synchronously runs the project's evaluation gates from .stratum/policy.yaml — secret scan, diff policy, LLM review, sandbox tests — and returns the verdicts. A failing gate blocks the merge.",
      { project: projectArg, workspace: { type: "string", description: "Source workspace name" } },
      (a) => {
        const ref = parseProjectRef(a.project);
        return client.createChange(`${ref.namespace}/${ref.slug}`, a.workspace);
      },
    ),
    tool(
      "stratum_list_changes",
      "List changes for a Stratum project, optionally filtered by status (open, merged, rejected, reverted).",
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
      "Get one change with its evaluation runs (per-gate score, pass/fail, reason) and metered costs (LLM tokens, sandbox time, git ops).",
      { change_id: { type: "string", description: "Change id, e.g. chg_abc123" } },
      (a) => client.getChange(a.change_id),
    ),
    tool(
      "stratum_merge_change",
      "Merge a change that has passed its evaluation gates and required human approvals. Fails with the blocking reasons otherwise; a stale base is rejected until re-evaluated. Force requires the policy to allow it. User credentials only — agent tokens cannot merge.",
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
      "Reject an open change, closing it without merging. User credentials only — agent tokens cannot reject.",
      { change_id: { type: "string", description: "Change id" } },
      (a) => client.rejectChange(a.change_id),
    ),
    tool(
      "stratum_review_change",
      "Submit a review verdict on a change. Reviews are a human gate — the server refuses every verdict from an agent token, request_changes as much as approve — so this needs user credentials with write access. An agent's feedback channel is change comments over the REST API.",
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
