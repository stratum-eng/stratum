#!/usr/bin/env node
import { createInterface } from "node:readline";
import { Command } from "commander";
import { parseProjectRef } from "./client.js";
import { writeConfig } from "./config.js";
import { getStagedContent, getStagedFiles } from "./git.js";
import { print, withClient } from "./run.js";

const program = new Command();

program
  .name("stratum")
  .description("CLI for Stratum — code hosting for the AI engineering era")
  .version("0.2.0");

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── login ─────────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Authenticate with a Stratum instance")
  .option("--host <url>", "Stratum host URL")
  .option("--key <key>", "API key")
  .action(async (opts: { host?: string; key?: string }) => {
    const host = opts.host ?? (await prompt("Stratum host (e.g. https://stratum.example.com): "));
    const apiKey = opts.key ?? (await prompt("API key: "));
    if (!host || !apiKey) {
      process.stderr.write("Error: host and key are required\n");
      process.exitCode = 1;
      return;
    }
    const response = await fetch(`${host.replace(/\/$/, "")}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch((err: unknown) => {
      process.stderr.write(
        `Error: could not connect to ${host}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
      return null;
    });
    if (!response) return;
    if (!response.ok) {
      process.stderr.write(`Error: health check failed: HTTP ${response.status}\n`);
      process.exitCode = 1;
      return;
    }
    await writeConfig({ host, apiKey });
    print(`Logged in to ${host}`);
  });

// ── projects ──────────────────────────────────────────────────────────────

program
  .command("init <name>")
  .description("Create a new Stratum project")
  .option("--org <slug>", "Create under an organization namespace")
  .option("--public", "Make the project public")
  .action(async (name: string, opts: { org?: string; public?: boolean }) =>
    withClient(async (client) => {
      const project = await client.createProject(name, {
        ...(opts.org ? { org: opts.org } : {}),
        ...(opts.public ? { visibility: "public" } : {}),
      });
      print(`Created project ${project.namespace}/${project.slug}`);
      if (project.remote) print(`Remote: ${project.remote}`);
    }),
  );

program
  .command("projects")
  .description("List your projects")
  .action(async () =>
    withClient(async (client) => {
      const { projects } = await client.listProjects();
      if (projects.length === 0) {
        print("No projects.");
        return;
      }
      for (const project of projects) {
        print(`${project.namespace}/${project.slug}\t${project.visibility ?? "private"}`);
      }
    }),
  );

program
  .command("activity <project>")
  .description("Show recent activity for a project (namespace/slug)")
  .action(async (projectRef: string) =>
    withClient(async (client) => {
      const ref = parseProjectRef(projectRef);
      const { events } = await client.getActivity(ref);
      if (events.length === 0) {
        print("No activity.");
        return;
      }
      for (const event of events) {
        print(`${event.createdAt}  ${event.actorType.padEnd(6)}  ${event.type}`);
      }
    }),
  );

const project = program.command("project").description("Manage projects");

project
  .command("delete <ns/slug>")
  .description("Permanently delete a project (owner-only, irreversible)")
  .requiredOption("--confirm <ns/slug>", "Confirmation token — must equal the project ref")
  .action(async (projectRef: string, opts: { confirm: string }) =>
    withClient(async (client) => {
      const ref = parseProjectRef(projectRef);
      // Server requires the confirm token to EXACTLY equal "@namespace/slug".
      // Normalize the user's --confirm the same way so a bare "ns/slug" works.
      const confirmRef = parseProjectRef(opts.confirm);
      const confirm = `${confirmRef.namespace}/${confirmRef.slug}`;
      const result = await client.deleteProject(ref, confirm);
      print(`Deletion enqueued (job ${result.jobId}). The project is being removed.`);
    }),
  );

// ── workspaces ────────────────────────────────────────────────────────────

const workspace = program.command("workspace").description("Manage workspaces");

workspace
  .command("create <project>")
  .description("Fork a workspace from a project (namespace/slug)")
  .option("--name <ws-name>", "Workspace name")
  .action(async (projectRef: string, opts: { name?: string }) =>
    withClient(async (client) => {
      const ref = parseProjectRef(projectRef);
      const result = await client.createWorkspace(ref, opts.name);
      print(`Created workspace '${result.workspace}' from ${projectRef}`);
    }),
  );

workspace
  .command("list <project>")
  .description("List workspaces for a project (namespace/slug)")
  .action(async (projectRef: string) =>
    withClient(async (client) => {
      const ref = parseProjectRef(projectRef);
      const { workspaces } = await client.listWorkspaces(ref);
      if (workspaces.length === 0) {
        print("No workspaces.");
        return;
      }
      for (const ws of workspaces) {
        print(`${ws.name}\tcreated ${ws.createdAt}`);
      }
    }),
  );

workspace
  .command("delete <project> <name>")
  .description("Delete a workspace")
  .action(async (projectRef: string, name: string) =>
    withClient(async (client) => {
      const ref = parseProjectRef(projectRef);
      const project = await client.getProject(ref);
      await client.deleteWorkspace(name, project.id);
      print(`Deleted workspace '${name}'`);
    }),
  );

// ── commit ────────────────────────────────────────────────────────────────

program
  .command("commit")
  .description("Commit staged git files to a workspace")
  .requiredOption("-m, --message <message>", "Commit message")
  .requiredOption("--project <project>", "Project (namespace/slug)")
  .requiredOption("--workspace <name>", "Target workspace name")
  .action(async (opts: { message: string; project: string; workspace: string }) =>
    withClient(async (client) => {
      const staged = getStagedFiles();
      if (staged.length === 0) {
        throw new Error("no staged files. Stage files with 'git add' first.");
      }
      const files: Record<string, string> = {};
      for (const file of staged) {
        files[file] = getStagedContent(file);
      }
      const ref = parseProjectRef(opts.project);
      const project = await client.getProject(ref);
      const result = await client.commitToWorkspace(
        opts.workspace,
        project.id,
        files,
        opts.message,
      );
      print(`Committed ${staged.length} file(s) to '${opts.workspace}' → ${result.commit}`);
    }),
  );

// ── changes ───────────────────────────────────────────────────────────────

const change = program.command("change").description("Manage changes");

change
  .command("create")
  .description("Create a change (runs evaluation)")
  .requiredOption("--project <project>", "Project (namespace/slug or name)")
  .requiredOption("--workspace <name>", "Source workspace")
  .action(async (opts: { project: string; workspace: string }) =>
    withClient(async (client) => {
      const result = await client.createChange(opts.project, opts.workspace);
      print(`Created change ${result.change.id} (${result.change.status})`);
      print(
        `Evaluation: score ${result.eval.score.toFixed(2)}, ${result.eval.passed ? "passed" : "failed"} — ${result.eval.reason}`,
      );
    }),
  );

change
  .command("list <project>")
  .description("List changes for a project")
  .option("--status <status>", "Filter by status")
  .action(async (projectRef: string, opts: { status?: string }) =>
    withClient(async (client) => {
      const { changes } = await client.listChanges(projectRef, opts.status);
      if (changes.length === 0) {
        print("No changes.");
        return;
      }
      for (const item of changes) {
        const score = item.evalScore !== undefined ? ` score=${item.evalScore.toFixed(2)}` : "";
        print(`${item.id}\t${item.status}${score}\t${item.workspace}`);
      }
    }),
  );

change
  .command("show <id>")
  .description("Show a change with evaluator evidence and costs")
  .action(async (id: string) =>
    withClient(async (client) => {
      const { change: item, evalRuns, costs } = await client.getChange(id);
      print(`${item.id}  ${item.status}  workspace=${item.workspace}`);
      if (item.evalScore !== undefined) {
        print(`Eval: ${item.evalScore.toFixed(2)} ${item.evalPassed ? "passed" : "failed"}`);
      }
      for (const run of evalRuns) {
        print(`  ${run.evaluatorType}: ${run.passed ? "pass" : "FAIL"} (${run.score.toFixed(2)})`);
      }
      for (const cost of costs) {
        print(`  cost ${cost.kind}: ${cost.estimated ? "~" : ""}${cost.total}`);
      }
    }),
  );

change
  .command("merge <id>")
  .description("Merge a change")
  .option("--force", "Bypass status and protection checks (if policy allows)")
  .option("--squash", "Squash merge")
  .action(async (id: string, opts: { force?: boolean; squash?: boolean }) =>
    withClient(async (client) => {
      const result = await client.mergeChange(id, {
        ...(opts.force ? { force: true } : {}),
        ...(opts.squash ? { strategy: "squash" as const } : {}),
      });
      print(`Merged ${id}${result.commit ? ` → ${result.commit}` : ""}`);
      if (result.postMerge && result.postMerge.status !== "skipped") {
        print(`Post-merge check: ${result.postMerge.status}`);
      }
    }),
  );

change
  .command("reject <id>")
  .description("Reject a change")
  .action(async (id: string) =>
    withClient(async (client) => {
      await client.rejectChange(id);
      print(`Rejected ${id}`);
    }),
  );

change
  .command("review <id>")
  .description("Submit a review verdict")
  .requiredOption("--verdict <verdict>", "approve | request_changes")
  .option("--comment <text>", "Review comment")
  .action(async (id: string, opts: { verdict: string; comment?: string }) =>
    withClient(async (client) => {
      if (opts.verdict !== "approve" && opts.verdict !== "request_changes") {
        throw new Error("verdict must be 'approve' or 'request_changes'");
      }
      const result = await client.reviewChange(id, opts.verdict, opts.comment);
      print(`Reviewed ${id}: ${opts.verdict} (change is now ${result.changeStatus})`);
    }),
  );

// ── issues ────────────────────────────────────────────────────────────────

const issue = program.command("issue").description("Manage issues");

issue
  .command("create <project>")
  .description("Open an issue (namespace/slug)")
  .requiredOption("--title <title>", "Issue title")
  .option("--body <body>", "Issue description")
  .option("--change <id>", "Linked change (auto-closes when it merges)")
  .action(async (projectRef: string, opts: { title: string; body?: string; change?: string }) =>
    withClient(async (client) => {
      const ref = parseProjectRef(projectRef);
      const { issue: created } = await client.createIssue(ref, opts.title, opts.body, opts.change);
      print(`Opened issue #${created.number}: ${created.title}`);
    }),
  );

issue
  .command("list <project>")
  .description("List issues (namespace/slug)")
  .option("--status <status>", "open | closed", "open")
  .action(async (projectRef: string, opts: { status: string }) =>
    withClient(async (client) => {
      const ref = parseProjectRef(projectRef);
      const status = opts.status === "closed" ? ("closed" as const) : ("open" as const);
      const { issues } = await client.listIssues(ref, status);
      if (issues.length === 0) {
        print(`No ${status} issues.`);
        return;
      }
      for (const item of issues) {
        print(`#${item.number}\t${item.status}\t${item.title}`);
      }
    }),
  );

issue
  .command("close <project> <number>")
  .description("Close an issue")
  .action(async (projectRef: string, numberRaw: string) =>
    withClient(async (client) => {
      const ref = parseProjectRef(projectRef);
      const number = Number(numberRaw);
      if (!Number.isInteger(number) || number <= 0) throw new Error("invalid issue number");
      await client.updateIssue(ref, number, { status: "closed" });
      print(`Closed issue #${number}`);
    }),
  );

// ── account ───────────────────────────────────────────────────────────────

const account = program.command("account").description("Manage your account");

account
  .command("delete")
  .description("Permanently delete your account (irreversible)")
  .requiredOption("--confirm <username>", "Confirmation token — must equal your username")
  .action(async (opts: { confirm: string }) =>
    withClient(async (client) => {
      const result = await client.deleteAccount(opts.confirm);
      print(`Account deletion enqueued (job ${result.jobId}). Your credentials no longer work.`);
    }),
  );

// ── status ────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show authentication status")
  .action(async () =>
    withClient(async (client) => {
      const user = await client.me();
      print(`Authenticated as ${user.email} (${user.id})`);
    }),
  );

program.parse();
