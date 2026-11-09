/**
 * A `ctx.container` for tests, written from Cloudflare's documented Durable
 * Object Container API (developers.cloudflare.com/containers/api/durable-object-container/)
 * rather than from the code under test:
 *
 * - `start()` returns at once and throws when a container is already running.
 * - `exec()` throws when no container is running, runs an argv (no shell),
 *   closes stdin at end of input, and resolves to a process whose `output()`
 *   yields `{ stdout, stderr, exitCode }` as `ArrayBuffer`s.
 * - `destroy()` stops the container; everything in it is gone.
 * - An intercept is a hostname and a `Fetcher`, registered before or after
 *   `start()`; registering a hostname again replaces its handler.
 *
 * Inside, it plays the part of `container/agent.mjs`: `write`, `start`,
 * `poll` and `read`. What a step "does" is scripted per test with {@link script}.
 *
 * It records everything that crosses into the container — the start options,
 * every argv, every environment, every byte of stdin — so a test can assert on
 * exactly what the code under test let in.
 */
import type { JobContainer } from "../../src/job";

export interface StepScript {
  /** Everything the step prints. */
  output?: string;
  /** Leave unset for a step that never finishes by itself. */
  exit?: {
    exitCode: number | null;
    signal?: string | null;
    timedOut?: boolean;
    durationMs?: number;
  };
  /** Files the step leaves behind once it has exited: path to content. */
  writes?: Record<string, string>;
}

export interface RecordedExec {
  cmd: string[];
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  stdin: string;
}

const encoder = new TextEncoder();

async function readAll(stream: ReadableStream | undefined): Promise<string> {
  if (stream === undefined) return "";
  return new Response(stream).text();
}

export class FakeContainer implements JobContainer {
  running = false;
  readonly starts: Array<Parameters<JobContainer["start"]>[0]> = [];
  readonly destroys: unknown[] = [];
  readonly execs: RecordedExec[] = [];
  /** Hostname to its current handler, in registration order. */
  readonly intercepts = new Map<string, unknown>();
  /** Files written with `agent.mjs write`. */
  readonly files = new Map<string, string>();
  inactivityTimeoutMs: number | undefined;
  /** `intercept:<host>`, `start` and `destroy`, in the order they happened. */
  readonly events: string[] = [];

  private readonly scripts = new Map<string, StepScript>();
  /** Steps started in THIS container: id to the script it was given. */
  private started = new Map<string, string>();
  /** When set, every `exec()` rejects: a container that stopped answering. */
  broken = false;
  /** When set, `start()` throws: a container that cannot be started. */
  failStart = false;
  /** How many more `destroy()` calls throw and leave the container running. */
  failDestroys = 0;
  /** When set, registering an intercept on a RUNNING container throws. */
  failInterceptsWhileRunning = false;

  /** Say what the step with this agent id (`prepare`, `s0`, `s1`, …) does. */
  script(id: string, script: StepScript): void {
    this.scripts.set(id, script);
  }

  /** The script a step was started with, or undefined if it never was. */
  startedScript(id: string): string | undefined {
    return this.started.get(id);
  }

  start(options: Parameters<JobContainer["start"]>[0]): void {
    if (this.running) throw new Error("container is already running");
    if (this.failStart) throw new Error("start failed");
    this.running = true;
    this.starts.push(options);
    this.events.push("start");
  }

  async destroy(reason?: unknown): Promise<void> {
    this.destroys.push(reason);
    if (this.failDestroys > 0) {
      this.failDestroys--;
      throw new Error("the container did not stop");
    }
    this.events.push("destroy");
    this.running = false;
    this.started = new Map();
    this.files.clear();
  }

  async setInactivityTimeout(durationMs: number): Promise<void> {
    if (durationMs <= 0 || durationMs > 6 * 60 * 60_000) throw new TypeError("invalid timeout");
    this.inactivityTimeoutMs = durationMs;
  }

  async interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void> {
    if (this.running && this.failInterceptsWhileRunning) throw new Error("intercept failed");
    this.intercepts.set(addr, binding);
    this.events.push(`intercept:${addr}`);
  }

  async exec(
    cmd: string[],
    options?: Parameters<JobContainer["exec"]>[1],
  ): ReturnType<JobContainer["exec"]> {
    if (!this.running) throw new Error("container is not running");
    if (this.broken) throw new Error("internal error");
    if (cmd.length === 0) throw new TypeError("cmd is empty");
    const stdin = await readAll(options?.stdin);
    this.execs.push({ cmd, env: options?.env, cwd: options?.cwd, stdin });

    const [, , command, ...args] = cmd;
    let result: unknown;
    if (command === "write") {
      this.files.set(args[0] ?? "", stdin);
      result = { written: true };
    } else if (command === "start") {
      this.started.set(args[0] ?? "", stdin);
      result = { started: true };
    } else if (command === "poll") {
      const id = args[0] ?? "";
      if (!this.started.has(id)) {
        result = { state: "missing" };
      } else {
        const script = this.scripts.get(id) ?? { output: "", exit: { exitCode: 0 } };
        if (script.exit) {
          for (const [path, content] of Object.entries(script.writes ?? {})) {
            this.files.set(path, content);
          }
        }
        const bytes = encoder.encode(script.output ?? "");
        const offset = Number(args[1]);
        const chunk = bytes.slice(offset, offset + Number(args[2]));
        result = {
          state: script.exit ? "exited" : "running",
          exit: script.exit
            ? { signal: null, timedOut: false, durationMs: 1500, ...script.exit }
            : null,
          size: bytes.length,
          offset,
          chunk: Buffer.from(chunk).toString("base64"),
        };
      }
    } else if (command === "read") {
      const content = this.files.get(args[0] ?? "");
      result =
        content === undefined
          ? { exists: false }
          : {
              exists: true,
              content: Buffer.from(encoder.encode(content).slice(0, Number(args[1]))).toString(
                "base64",
              ),
            };
    } else {
      return {
        output: async () => ({
          stdout: new ArrayBuffer(0),
          stderr: encoder.encode("agent: unknown command").buffer as ArrayBuffer,
          exitCode: 2,
        }),
      };
    }
    return {
      output: async () => ({
        stdout: encoder.encode(`${JSON.stringify(result)}\n`).buffer as ArrayBuffer,
        stderr: new ArrayBuffer(0),
        exitCode: 0,
      }),
    };
  }

  /** Everything that entered the container, as one searchable string. */
  everythingPassedIn(): string {
    return JSON.stringify({
      starts: this.starts,
      execs: this.execs,
      files: [...this.files.entries()],
    });
  }
}

/** Durable Object storage, as far as a job uses it. Values are cloned, as stored ones are. */
export class FakeStorage {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
  }
}
