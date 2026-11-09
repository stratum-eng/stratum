/**
 * The scripts that run INSIDE a job's container, run for real: the supervisor
 * (`container/agent.mjs`) under this machine's Node, and the checkout script
 * (`container/prepare.sh`) under its bash and git, against a fixture
 * repository on disk.
 *
 * What this does not cover is the container itself — the image, the
 * interception CA, the network. Those need Docker and Cloudflare; see the
 * README's "What is not tested here".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const AGENT = fileURLToPath(new URL("../container/agent.mjs", import.meta.url));
const PREPARE = fileURLToPath(new URL("../container/prepare.sh", import.meta.url));

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stratum-ci-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Poll {
  state: "running" | "exited" | "missing";
  exit: { exitCode: number | null; signal: string | null; timedOut: boolean } | null;
  size: number;
  chunk: string;
}

function agent(jobDir: string, args: string[], input = "", env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [AGENT, ...args], {
    input,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      STRATUM_JOB_DIR: jobDir,
      STRATUM_KILL_GRACE_MS: "200",
      ...env,
    },
  });
}

function poll(jobDir: string, id: string, offset = 0, max = 65536): Poll {
  return JSON.parse(agent(jobDir, ["poll", id, String(offset), String(max)]).stdout) as Poll;
}

async function waitForExit(jobDir: string, id: string, timeoutMs = 15_000): Promise<Poll> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const result = poll(jobDir, id);
    if (result.state === "exited") return result;
    if (Date.now() > until) throw new Error(`step ${id} did not exit: ${JSON.stringify(result)}`);
    await sleep(50);
  }
}

const text = (result: Poll): string => Buffer.from(result.chunk, "base64").toString("utf8");

describe("agent.mjs", () => {
  it("returns at once and reports the step's exit code and output", async () => {
    const jobDir = tempDir();
    const started = agent(
      jobDir,
      ["start", "s0", "30", jobDir],
      "sleep 0.3\necho hello\necho oops >&2\n",
    );
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout)).toEqual({ started: true });
    expect(poll(jobDir, "s0").state).toBe("running");

    const done = await waitForExit(jobDir, "s0");
    expect(done.exit).toMatchObject({ exitCode: 0, timedOut: false });
    expect(text(done)).toContain("hello");
    expect(text(done)).toContain("oops");
  });

  it("stops at the first failing command, like `bash -eo pipefail`", async () => {
    const jobDir = tempDir();
    agent(jobDir, ["start", "s0", "30", jobDir], "echo before\nfalse | cat\necho after\n");
    const done = await waitForExit(jobDir, "s0");
    expect(done.exit?.exitCode).toBe(1);
    expect(text(done)).toContain("before");
    expect(text(done)).not.toContain("after");
  });

  it("kills a step at its time limit, along with everything it started", async () => {
    const jobDir = tempDir();
    // A background child that would write a marker if it survived the step.
    const marker = join(jobDir, "survivor");
    agent(jobDir, ["start", "s0", "1", jobDir], `(sleep 3; touch ${marker}) &\nsleep 60\n`);
    const done = await waitForExit(jobDir, "s0");

    expect(done.exit?.timedOut).toBe(true);
    expect(done.exit?.exitCode).not.toBe(0);
    await sleep(3500);
    expect(() => readFileSync(marker)).toThrow();
  });

  it("kills a step that ignores SIGTERM", async () => {
    const jobDir = tempDir();
    agent(jobDir, ["start", "s0", "1", jobDir], "trap '' TERM\nwhile true; do sleep 0.1; done\n");
    const done = await waitForExit(jobDir, "s0");
    expect(done.exit).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("gives the step the environment it was started with and no more", async () => {
    const jobDir = tempDir();
    agent(jobDir, ["start", "s0", "30", jobDir], "env | sort\n", { CI: "true", ONLY_THIS: "1" });
    const done = await waitForExit(jobDir, "s0");
    const names = text(done)
      .trim()
      .split("\n")
      .map((line) => line.split("=")[0])
      // bash sets the first four itself; macOS injects the last into every process.
      .filter(
        (name) => !["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(name ?? ""),
      );
    expect(names.sort()).toEqual(
      ["CI", "ONLY_THIS", "PATH", "STRATUM_JOB_DIR", "STRATUM_KILL_GRACE_MS"].sort(),
    );
  });

  it("serves the log in chunks from an offset", async () => {
    const jobDir = tempDir();
    agent(jobDir, ["start", "s0", "30", jobDir], "printf 0123456789\n");
    const done = await waitForExit(jobDir, "s0");
    expect(done.size).toBe(10);
    expect(text(poll(jobDir, "s0", 0, 4))).toBe("0123");
    expect(text(poll(jobDir, "s0", 4, 4))).toBe("4567");
    expect(text(poll(jobDir, "s0", 8, 4))).toBe("89");
    expect(text(poll(jobDir, "s0", 50, 4))).toBe("");
  });

  it("says a step it never started is missing, and refuses to start one twice", async () => {
    const jobDir = tempDir();
    expect(poll(jobDir, "s9").state).toBe("missing");
    agent(jobDir, ["start", "s0", "30", jobDir], "true\n");
    expect(agent(jobDir, ["start", "s0", "30", jobDir], "true\n").status).toBe(2);
    await waitForExit(jobDir, "s0");
  });

  it("refuses an id that could name a path", () => {
    const jobDir = tempDir();
    expect(agent(jobDir, ["start", "../x", "30", jobDir], "true\n").status).toBe(2);
    expect(agent(jobDir, ["poll", "a/b", "0", "10"]).status).toBe(2);
  });

  it("writes stdin to a file, byte for byte", () => {
    const jobDir = tempDir();
    const target = join(jobDir, "nested", "change.diff");
    const content = "diff --git a/x b/x\r\n+éè 日本\n\\ No newline at end of file";
    expect(agent(jobDir, ["write", target], content).status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(content);
  });
});

/** Run git with no user or system configuration. */
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

/**
 * A project repository with a base commit, and a change on top of it: the
 * change's diff and the tree it produces, as Stratum would dispatch them.
 */
function fixture() {
  const remote = tempDir();
  git(remote, ["init", "--quiet", "--initial-branch=main"]);
  mkdirSync(join(remote, "src"));
  writeFileSync(join(remote, "package.json"), '{"name":"app","scripts":{"test":"node test.js"}}\n');
  writeFileSync(join(remote, "src/index.js"), "module.exports = 1;\n");
  git(remote, ["add", "-A"]);
  git(remote, ["commit", "--quiet", "-m", "base"]);
  const baseSha = git(remote, ["rev-parse", "HEAD"]);

  writeFileSync(join(remote, "src/index.js"), "module.exports = 2;\n");
  writeFileSync(
    join(remote, "test.js"),
    "process.exit(require('./src/index.js') === 2 ? 0 : 1);\n",
  );
  git(remote, ["add", "-A"]);
  const diff = `${git(remote, ["diff", "--cached", "HEAD"])}\n`;
  const headTreeSha = git(remote, ["write-tree"]);
  // The change is NOT committed to the project: the job has only base + diff.
  git(remote, ["reset", "--quiet", "--hard", baseSha]);
  return { remote, baseSha, diff, headTreeSha };
}

function prepare(options: { remote: string; baseSha: string; diff: string; headTreeSha: string }) {
  const work = tempDir();
  const diffFile = join(work, "change.diff");
  writeFileSync(diffFile, options.diff);
  const workspace = join(work, "workspace");
  const result = spawnSync("bash", [PREPARE], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: work,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      BASE_SHA: options.baseSha,
      HEAD_TREE_SHA: options.headTreeSha,
      STRATUM_GIT_REMOTE: options.remote,
      STRATUM_WORKSPACE: workspace,
      STRATUM_DIFF: diffFile,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, workspace };
}

describe("prepare.sh", () => {
  it("builds the evaluated tree from the base commit and the diff", () => {
    const change = fixture();
    const result = prepare(change);

    expect(result.output).toContain(`checkout ready at tree ${change.headTreeSha}`);
    expect(result.status).toBe(0);
    expect(readFileSync(join(result.workspace, "src/index.js"), "utf8")).toBe(
      "module.exports = 2;\n",
    );
    expect(git(result.workspace, ["rev-parse", "HEAD^{tree}"])).toBe(change.headTreeSha);
    expect(git(result.workspace, ["status", "--porcelain"])).toBe("");
    // The step the project declared really passes against it.
    expect(spawnSync("node", ["test.js"], { cwd: result.workspace }).status).toBe(0);
  });

  it("exits 3 when the result is not the tree it was told to expect", () => {
    const change = fixture();
    const result = prepare({ ...change, headTreeSha: "0".repeat(40) });

    expect(result.status).toBe(3);
    expect(result.output).toContain("tree mismatch");
    expect(result.output).toContain("0".repeat(40));
  });

  it("exits 3 when the diff leaves anything out", () => {
    const change = fixture();
    // The diff without its last file: applies cleanly, builds a different tree.
    const partial = change.diff.slice(0, change.diff.indexOf("diff --git a/test.js"));
    expect(partial).not.toBe(change.diff);
    expect(prepare({ ...change, diff: partial }).status).toBe(3);
  });

  it("exits 3 when the diff does not apply to the base", () => {
    const change = fixture();
    const result = prepare({ ...change, diff: change.diff.replace("= 1;", "= 7;") });
    expect(result.status).toBe(3);
    expect(result.output).toContain("does not apply");
  });

  it("accepts an empty diff only when the evaluated tree is the base's own", () => {
    const change = fixture();
    const baseTree = git(change.remote, ["rev-parse", `${change.baseSha}^{tree}`]);
    expect(prepare({ ...change, diff: "", headTreeSha: baseTree }).status).toBe(0);
    expect(prepare({ ...change, diff: "" }).status).toBe(3);
  });

  it("fails, but not with 3, when the base commit is not in the repository", () => {
    const change = fixture();
    const result = prepare({ ...change, baseSha: "1".repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(3);
  });

  it("checks out the base commit asked for, not the branch tip", () => {
    const change = fixture();
    // The project moves on after the change was evaluated.
    writeFileSync(join(change.remote, "later.txt"), "later\n");
    git(change.remote, ["add", "-A"]);
    git(change.remote, ["commit", "--quiet", "-m", "later"]);

    const result = prepare(change);
    expect(result.status).toBe(0);
    expect(() => readFileSync(join(result.workspace, "later.txt"))).toThrow();
  });
});
