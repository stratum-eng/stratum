#!/usr/bin/env node
// The process supervisor inside a CI job's container (#415, ADR 012).
//
// The Durable Object that owns the container cannot hold a connection open for
// the life of a step: an `exec()` it is awaiting dies with the object on any
// deploy or eviction, and it has no timeout of its own. So a step is started
// DETACHED and the object polls for it. This file is both halves:
//
//   agent.mjs start <id> <timeoutSeconds> <cwd>   script on stdin; returns at once
//   agent.mjs poll  <id> <offset> <maxBytes>      one JSON line: state + a log chunk
//   agent.mjs write <path>                        stdin to a file (the change's diff)
//   agent.mjs read  <path> <maxBytes>             one JSON line: a small file, base64
//                                                 (what a deploy step recorded)
//
// Nothing here is a security boundary. Every process in the container runs with
// root's capabilities, so the code a step runs can kill this supervisor, forge
// an exit file or rewrite this script. The limits that hold are enforced from
// OUTSIDE: the Durable Object destroys the container when a step or the job
// outlives its time, whatever this process says.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const JOB_DIR = process.env.STRATUM_JOB_DIR ?? "/job";
/** How long a step gets between SIGTERM and SIGKILL once its time is up. */
const KILL_GRACE_MS = Number(process.env.STRATUM_KILL_GRACE_MS ?? 5000);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

function fail(message) {
  process.stderr.write(`agent: ${message}\n`);
  process.exit(2);
}

function paths(id) {
  if (!ID_PATTERN.test(id ?? "")) fail(`invalid id '${id}'`);
  const base = join(JOB_DIR, "steps", id);
  return { script: `${base}.sh`, log: `${base}.log`, exit: `${base}.exit` };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

async function start(id, timeoutSeconds, cwd) {
  const p = paths(id);
  const timeout = Number(timeoutSeconds);
  if (!Number.isFinite(timeout) || timeout <= 0) fail("invalid timeout");
  if (existsSync(p.script)) fail(`step '${id}' was already started`);
  mkdirSync(dirname(p.script), { recursive: true });
  writeFileSync(p.script, await readStdin(), { mode: 0o700 });
  writeFileSync(p.log, "");
  // Detached, with no pipe back to this process: the caller's `exec()` returns
  // as soon as this one exits, and the supervisor outlives it.
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "supervise", id, String(timeout), cwd],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
  process.stdout.write(`${JSON.stringify({ started: true })}\n`);
}

function supervise(id, timeoutSeconds, cwd) {
  const p = paths(id);
  const startedAt = Date.now();
  const log = openSync(p.log, "a");
  let timedOut = false;
  const finish = (exitCode, signal) => {
    const result = { exitCode, signal, timedOut, durationMs: Date.now() - startedAt };
    // Written whole or not at all: a poll never reads half a result.
    writeFileSync(`${p.exit}.tmp`, JSON.stringify(result));
    renameSync(`${p.exit}.tmp`, p.exit);
    process.exit(0);
  };

  let child;
  try {
    // Its own process group, so the timeout reaches everything the script
    // started and not just bash.
    child = spawn("bash", ["-eo", "pipefail", p.script], {
      cwd,
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
  } catch (error) {
    writeFileSync(p.log, `could not start the step: ${error.message}\n`, { flag: "a" });
    finish(127, null);
    return;
  }
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
  }, Number(timeoutSeconds) * 1000);
  child.on("error", (error) => {
    clearTimeout(timer);
    writeFileSync(p.log, `could not start the step: ${error.message}\n`, { flag: "a" });
    finish(127, null);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    closeSync(log);
    // Anything the script left running in its group must not outlive the step.
    killGroup("SIGKILL");
    finish(code, signal);
  });
}

function poll(id, offsetArg, maxBytesArg) {
  const p = paths(id);
  const offset = Math.max(0, Number(offsetArg) || 0);
  const maxBytes = Math.min(Math.max(0, Number(maxBytesArg) || 0), 1024 * 1024);
  if (!existsSync(p.script)) {
    process.stdout.write(`${JSON.stringify({ state: "missing" })}\n`);
    return;
  }
  // The exit file is read BEFORE the log, so a chunk reported alongside an
  // exit is never missing output written just before the process ended.
  const exit = existsSync(p.exit) ? JSON.parse(readFileSync(p.exit, "utf8")) : null;
  const size = existsSync(p.log) ? statSync(p.log).size : 0;
  const length = Math.max(0, Math.min(maxBytes, size - offset));
  const buffer = Buffer.alloc(length);
  if (length > 0) {
    const fd = openSync(p.log, "r");
    readSync(fd, buffer, 0, length, offset);
    closeSync(fd);
  }
  process.stdout.write(
    `${JSON.stringify({
      state: exit ? "exited" : "running",
      exit,
      size,
      offset,
      chunk: buffer.toString("base64"),
    })}\n`,
  );
}

async function write(path) {
  if (!path) fail("write needs a path");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await readStdin());
  process.stdout.write(`${JSON.stringify({ written: true })}\n`);
}

function read(path, maxBytesArg) {
  if (!path) fail("read needs a path");
  const maxBytes = Math.min(Math.max(0, Number(maxBytesArg) || 0), 64 * 1024);
  // A directory, a device or a missing file is "nothing was recorded".
  if (!existsSync(path) || !statSync(path).isFile()) {
    process.stdout.write(`${JSON.stringify({ exists: false })}\n`);
    return;
  }
  const length = Math.min(maxBytes, statSync(path).size);
  const buffer = Buffer.alloc(length);
  if (length > 0) {
    const fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, 0);
    closeSync(fd);
  }
  process.stdout.write(
    `${JSON.stringify({ exists: true, content: buffer.toString("base64") })}\n`,
  );
}

const [command, ...args] = process.argv.slice(2);
if (command === "start") await start(...args);
else if (command === "supervise") supervise(...args);
else if (command === "poll") poll(...args);
else if (command === "write") await write(...args);
else if (command === "read") read(...args);
else fail(`unknown command '${command}'`);
