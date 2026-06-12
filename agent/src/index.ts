#!/usr/bin/env node
/**
 * Reference agent: proves the Stratum platform end-to-end for agent workflows.
 *
 *   npx @stratum/agent --repo @user/api --objective "Fix the N+1 query"
 *
 * Flow: create agent identity → fork workspace → read repo → ask Claude for
 * edits → commit with the agent token → open a Change (which runs evaluation).
 */

import { type RepoContext, planEdits } from "./llm.js";
import { StratumApi, parseProjectRef } from "./stratum.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
/** Bound on how much of the repository is sent to the model. */
const MAX_FILES = 30;
const MAX_FILE_BYTES = 24 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

interface Args {
  repo: string;
  objective: string;
  model: string;
  host: string;
  apiKey: string;
  anthropicKey: string;
  name: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        flags.set(arg.slice(2), "true");
      } else {
        flags.set(arg.slice(2), value);
        i++;
      }
    }
  }

  const repo = flags.get("repo");
  const objective = flags.get("objective");
  const host = flags.get("host") ?? process.env.STRATUM_HOST;
  const apiKey = flags.get("api-key") ?? process.env.STRATUM_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const missing: string[] = [];
  if (!repo) missing.push("--repo");
  if (!objective) missing.push("--objective");
  if (!host) missing.push("--host (or STRATUM_HOST)");
  if (!apiKey) missing.push("--api-key (or STRATUM_API_KEY)");
  if (!anthropicKey) missing.push("ANTHROPIC_API_KEY");
  if (missing.length > 0 || !repo || !objective || !host || !apiKey || !anthropicKey) {
    process.stderr.write(`Missing required arguments: ${missing.join(", ")}\n`);
    process.stderr.write(
      'Usage: stratum-agent --repo <namespace/slug> --objective "..." [--model <id>] [--name <agent-name>]\n',
    );
    process.exit(1);
  }

  return {
    repo,
    objective,
    model: flags.get("model") ?? DEFAULT_MODEL,
    host,
    apiKey,
    anthropicKey,
    name: flags.get("name") ?? "stratum-reference-agent",
  };
}

/** Read a bounded slice of the repository for model context. */
async function readRepoContext(
  api: StratumApi,
  ref: ReturnType<typeof parseProjectRef>,
): Promise<RepoContext> {
  const { files } = await api.listFiles(ref);
  const fileContents = new Map<string, string>();
  let totalBytes = 0;
  let skipped = 0;

  for (const path of files.slice(0, MAX_FILES)) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      skipped++;
      continue;
    }
    try {
      const content = await api.getFileContent(ref, path);
      if (content.kind === "content" && content.value !== undefined) {
        const value = content.value.slice(0, MAX_FILE_BYTES);
        fileContents.set(path, value);
        totalBytes += value.length;
      }
    } catch {
      skipped++;
    }
  }

  if (files.length > MAX_FILES || skipped > 0) {
    process.stdout.write(
      `Context bounded: sending ${fileContents.size} of ${files.length} files to the model\n`,
    );
  }
  return { fileTree: files, fileContents };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ref = parseProjectRef(args.repo);
  const userApi = new StratumApi(args.host, args.apiKey);

  process.stdout.write(`Creating agent identity '${args.name}'…\n`);
  const identity = await userApi.createAgentIdentity(args.name, args.model);
  const agentApi = userApi.withToken(identity.token);

  const project = await userApi.getProject(ref);

  const workspaceName = `agent-${Date.now().toString(36)}`;
  process.stdout.write(`Forking workspace '${workspaceName}' from ${args.repo}…\n`);
  await agentApi.createWorkspace(ref, workspaceName);

  process.stdout.write("Reading repository…\n");
  const context = await readRepoContext(agentApi, ref);

  process.stdout.write(`Asking ${args.model} for edits…\n`);
  const plan = await planEdits(args.anthropicKey, args.model, args.objective, context);
  process.stdout.write(`Plan: ${plan.summary}\n`);
  for (const path of Object.keys(plan.files)) {
    process.stdout.write(`  edit ${path}\n`);
  }

  process.stdout.write("Committing to workspace…\n");
  const commit = await agentApi.commit(workspaceName, project.id, plan.files, plan.commitMessage);
  process.stdout.write(`Committed ${commit.commit}\n`);

  process.stdout.write("Opening Change (runs evaluation)…\n");
  const result = await agentApi.createChange(project.name, workspaceName);
  process.stdout.write(
    `Change ${result.change.id}: ${result.change.status} — eval ${result.eval.score.toFixed(2)} ${result.eval.passed ? "passed" : "failed"}\n`,
  );
  process.stdout.write(`Reason: ${result.eval.reason}\n`);

  if (!result.eval.passed) {
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
