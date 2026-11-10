/**
 * One CI job, from accepted dispatch to released slot (#415, ADR 012).
 *
 * A job is a state machine advanced by `tick()`, which the owning Durable
 * Object calls from its alarm. Nothing here waits on a running process: a step
 * is started detached inside the container (see `container/agent.mjs`) and
 * each tick asks how it is doing. That is what lets a job outlive the object
 * that started it — a deploy or an eviction costs one tick, not the job — and
 * what lets every limit be enforced from OUTSIDE the container, by a clock the
 * code under test cannot touch.
 *
 * The container is one side of a trust boundary and this file is the other.
 * What crosses INTO the container: the image, the change's diff, the base
 * commit id, the tree id to verify, and each step's command. What never does:
 * the repository credential (it lives in the intercept handler's props), the
 * signing secret, or anything else this Worker holds.
 *
 * Everything the class touches comes in through {@link JobDeps}, so the whole
 * machine runs in tests against a fake container written from the documented
 * `ctx.container` API.
 */
import { GIT_HOST } from "./config";
import type { Job } from "./dispatch";
import type { AllowlistProps, GitProxyProps } from "./egress";

/** The part of the Durable Object Container API a job uses. */
export interface JobContainer {
  readonly running: boolean;
  start(options: {
    image: string;
    enableInternet: boolean;
    instance?: string;
    labels?: Record<string, string>;
  }): void;
  destroy(reason?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>;
  exec(
    cmd: string[],
    options?: {
      stdin?: ReadableStream;
      stdout?: "pipe" | "ignore";
      stderr?: "pipe" | "ignore" | "combined";
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<{
    output(): Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>;
  }>;
}

/** The part of Durable Object storage a job uses. */
export interface JobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export type ReportStatus = "running" | "passed" | "failed" | "errored";

export interface OutgoingReport {
  checkRunId: string;
  status: ReportStatus;
  sequence: number;
  summary?: string;
  detailsUrl: string;
}

/**
 * What Stratum said about a report:
 * - `delivered`: recorded (or already known).
 * - `drop`: refused in a way no retry changes; the job goes on.
 * - `abort`: the revision moved on or the run was superseded — stop the job.
 * - `retry`: not received; try again later.
 */
export type SendOutcome = "delivered" | "drop" | "abort" | "retry";

export interface JobDeps {
  container: JobContainer;
  /** `ctx.container.images`: image name to its digest-pinned reference. */
  images: Record<string, string>;
  storage: JobStorage;
  now(): number;
  egress: {
    git(props: GitProxyProps): Fetcher;
    allowlist(props: AllowlistProps): Fetcher;
  };
  send(job: JobRecord, report: OutgoingReport): Promise<SendOutcome>;
  putLog(checkRunId: string, body: Uint8Array): Promise<void>;
  /** Give the job's slot back to the coordinator. */
  release(): Promise<void>;
  logMaxBytes: number;
}

/** A job as stored: the dispatch without its diff, which is stored in pieces. */
export type JobRecord = Omit<Job, "diff">;

type StepResult = "pending" | ReportStatus;

interface LogCursor {
  /** Next byte of the step's output to read from the container. */
  offset: number;
  /** Bytes kept so far, and how many pieces they are stored in. */
  stored: number;
  chunks: number;
  truncated: boolean;
  /** Kept output not yet written to the log bucket. */
  dirty: boolean;
  flushedAt: number;
}

export interface JobState {
  job: JobRecord;
  diffChunks: number;
  phase: "queued" | "starting" | "preparing" | "running" | "finishing";
  /** Epoch ms the wall-clock limit expires. Set when the job starts. */
  deadlineAt?: number;
  startAttempts: number;
  stepIndex: number;
  stepStartedAt?: number;
  results: StepResult[];
  sequence: number;
  outbox: OutgoingReport[];
  sendFailures: number;
  pollFailures: number;
  finishAttempts: number;
  log: LogCursor;
}

const STATE_KEY = "state";
const AGENT = "/opt/stratum/agent.mjs";
const WORKSPACE = "/workspace";
const CA_FILE = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** How a diff is cut up for storage: far below the 8 MB a stored value may be. */
const DIFF_CHUNK_CHARS = 1_000_000;
const POLL_INTERVAL_MS = 2_000;
const RETRY_INTERVAL_MS = 10_000;
/** No single call into the container may hang a tick: `exec()` has no timeout. */
const EXEC_TIMEOUT_MS = 30_000;
const POLL_CHUNK_BYTES = 256 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_FLUSH_INTERVAL_MS = 10_000;
const PREPARE_TIMEOUT_SECONDS = 10 * 60;
/** Past a step's limit, how long the in-container supervisor gets to stop it. */
const STEP_STOP_GRACE_MS = 30_000;
const MAX_START_ATTEMPTS = 2;
const MAX_POLL_FAILURES = 5;
const MAX_SEND_FAILURES = 30;
const MAX_FINISH_ATTEMPTS = 5;
const MAX_INACTIVITY_MS = 6 * 60 * 60_000;
const MAX_SUMMARY_LENGTH = 3000;

/**
 * The whole environment of a step. `exec()` passes nothing on but `PATH`, so
 * this list is exactly what the code under test can read — and there is no
 * credential in it because the job has none.
 */
const STEP_ENV: Record<string, string> = {
  CI: "true",
  STRATUM_CI: "true",
  HOME: "/root",
  LANG: "C.UTF-8",
  // The interception CA, for tools that do not read the system trust store.
  NODE_EXTRA_CA_CERTS: CA_FILE,
  // A fetch that would prompt for a password must fail, not hang.
  GIT_TERMINAL_PROMPT: "0",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function minutes(seconds: number): string {
  const whole = Math.round(seconds / 60);
  return `${whole} minute${whole === 1 ? "" : "s"}`;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer in time`)),
          EXEC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface PollResult {
  state: "running" | "exited" | "missing";
  exit?: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
  } | null;
  size?: number;
  chunk?: string;
}

function emptyLog(now: number): LogCursor {
  return { offset: 0, stored: 0, chunks: 0, truncated: false, dirty: false, flushedAt: now };
}

export class JobMachine {
  constructor(private readonly deps: JobDeps) {}

  private load(): Promise<JobState | undefined> {
    return this.deps.storage.get<JobState>(STATE_KEY);
  }

  private save(state: JobState): Promise<void> {
    return this.deps.storage.put(STATE_KEY, state);
  }

  /** Store a validated dispatch. The job waits, `queued`, until `begin()`. */
  async accept(job: Job): Promise<boolean> {
    if ((await this.load()) !== undefined) return false;
    const { diff, ...record } = job;
    let diffChunks = 0;
    for (let at = 0; at < diff.length; at += DIFF_CHUNK_CHARS) {
      await this.deps.storage.put(`diff:${diffChunks++}`, diff.slice(at, at + DIFF_CHUNK_CHARS));
    }
    await this.save({
      job: record,
      diffChunks,
      phase: "queued",
      startAttempts: 0,
      stepIndex: 0,
      results: record.steps.map(() => "pending"),
      sequence: 0,
      outbox: [],
      sendFailures: 0,
      pollFailures: 0,
      finishAttempts: 0,
      log: emptyLog(this.deps.now()),
    });
    return true;
  }

  /** The dispatch was refused after being stored: forget it, report nothing. */
  async discard(): Promise<void> {
    await this.deps.storage.deleteAll();
  }

  /** A slot is free. Returns the delay before the first tick, or null. */
  async begin(): Promise<number | null> {
    const state = await this.load();
    if (state === undefined || state.phase !== "queued") return null;
    state.phase = "starting";
    // The clock that bounds the job starts here, outside the container.
    state.deadlineAt = this.deps.now() + state.job.timeoutSeconds * 1000;
    await this.save(state);
    return 0;
  }

  /** The job waited for a slot until it could no longer finish in time. */
  async expire(): Promise<number | null> {
    const state = await this.load();
    if (state === undefined || state.phase !== "queued") return null;
    this.failRemaining(
      state,
      "errored",
      "Not run: the job waited for a free slot on the CI executor until it could no longer finish before the deadline. Re-run the check when the executor is less busy.",
    );
    state.phase = "finishing";
    await this.save(state);
    return 0;
  }

  /**
   * The coordinator took the slot back because the job's time ran out. The
   * job's own clock says the same thing a moment earlier, so this only matters
   * when the job's alarm was lost — which is exactly when it must still stop.
   */
  async abandon(): Promise<number | null> {
    const state = await this.load();
    if (state === undefined || state.phase === "finishing") return null;
    if (state.phase === "queued") return null;
    await this.exceedWallClock(state);
    await this.save(state);
    return 0;
  }

  /** Advance the job. Returns the delay before the next tick, or null when done. */
  async tick(): Promise<number | null> {
    const state = await this.load();
    if (state === undefined || state.phase === "queued") return null;

    const active = state.phase !== "finishing";
    if (active && state.deadlineAt !== undefined && this.deps.now() >= state.deadlineAt) {
      await this.exceedWallClock(state);
    } else if (state.phase === "starting") {
      await this.startContainer(state);
    } else if (state.phase === "preparing") {
      await this.pollPrepare(state);
    } else if (state.phase === "running") {
      await this.pollStep(state);
    }

    await this.flushOutbox(state);
    if (state.phase === "finishing") return this.finish(state);
    await this.save(state);
    return state.phase === "starting" ? RETRY_INTERVAL_MS : POLL_INTERVAL_MS;
  }

  // ---------------------------------------------------------------- reports

  private enqueue(state: JobState, index: number, status: ReportStatus, summary?: string): void {
    const step = state.job.steps[index];
    if (step === undefined) return;
    state.results[index] = status;
    state.outbox.push({
      checkRunId: step.checkRunId,
      status,
      sequence: ++state.sequence,
      detailsUrl: step.logUrl,
      ...(summary !== undefined ? { summary: summary.slice(0, MAX_SUMMARY_LENGTH) } : {}),
    });
  }

  /** Give every step that has no final result yet the same one. */
  private failRemaining(state: JobState, status: "failed" | "errored", summary: string): void {
    state.results.forEach((result, index) => {
      if (result === "pending" || result === "running") this.enqueue(state, index, status, summary);
    });
  }

  private async flushOutbox(state: JobState): Promise<void> {
    while (state.outbox.length > 0) {
      const report = state.outbox[0];
      if (report === undefined) break;
      let outcome: SendOutcome;
      try {
        outcome = await this.deps.send(state.job, report);
      } catch {
        outcome = "retry";
      }
      if (outcome === "retry") {
        state.sendFailures++;
        return;
      }
      state.sendFailures = 0;
      if (outcome === "abort") {
        // Stratum has stopped caring about this run: a newer revision was
        // evaluated or the check was re-run. Nothing more is reported.
        state.outbox = [];
        state.results = state.results.map(() => "errored");
        await this.destroyContainer("superseded");
        state.phase = "finishing";
        return;
      }
      state.outbox.shift();
    }
  }

  // -------------------------------------------------------------- container

  private async destroyContainer(reason: string): Promise<void> {
    try {
      if (this.deps.container.running) await this.deps.container.destroy(reason);
    } catch (error) {
      console.error("job: could not destroy the container", String(error));
    }
  }

  /** Run the in-container agent and parse the one JSON line it prints. */
  private async agent<T>(
    args: string[],
    options: { stdin?: ReadableStream; env?: Record<string, string> } = {},
  ): Promise<T> {
    const process = await withTimeout(
      this.deps.container.exec(["node", AGENT, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      }),
      `agent ${args[0]}`,
    );
    const output = await withTimeout(process.output(), `agent ${args[0]}`);
    if (output.exitCode !== 0) {
      const detail = decoder.decode(output.stderr).trim().slice(0, 300);
      throw new Error(`agent ${args[0]} exited ${output.exitCode}: ${detail}`);
    }
    return JSON.parse(decoder.decode(output.stdout)) as T;
  }

  private textStream(read: () => AsyncGenerator<string>): ReadableStream {
    const source = read();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await source.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
    });
  }

  private async startContainer(state: JobState): Promise<void> {
    const { job } = state;
    if (++state.startAttempts > MAX_START_ATTEMPTS) {
      await this.destroyContainer("start failed");
      this.failRemaining(
        state,
        "errored",
        "Not run: the CI executor could not start a container for this job. Re-run the check; if it keeps happening the executor's operator needs to look at its logs.",
      );
      state.phase = "finishing";
      return;
    }
    const image = this.deps.images[job.profile.image];
    if (image === undefined) {
      this.failRemaining(
        state,
        "errored",
        `Not run: the CI executor has no '${job.profile.image}' image; its operator needs to redeploy it.`,
      );
      state.phase = "finishing";
      return;
    }
    // Recorded before anything else, so an attempt that dies half-way counts.
    await this.save(state);

    try {
      // A fresh container for every job: one left by an earlier attempt of
      // this same job is thrown away, never reused.
      await this.destroyContainer("restarting");

      // Intercepts first, so the interception CA exists when the entrypoint
      // runs. The repository credential goes into the handler's props, which
      // stay in the Worker.
      const { container, egress } = this.deps;
      await container.interceptOutboundHttps(
        GIT_HOST,
        egress.git({ upstream: job.repository.url, authorization: job.repository.authorization }),
      );
      const allowlist = egress.allowlist({ hosts: job.profile.allowedHosts });
      for (const host of job.profile.allowedHosts) {
        await container.interceptOutboundHttps(host, allowlist);
      }

      container.start({
        image,
        enableInternet: false,
        instance: job.instance,
        labels: { profile: job.profile.name },
      });
      // Polling keeps the object busy, but a lost alarm must not strand a
      // container for longer than the job could have run.
      await container.setInactivityTimeout(
        Math.min(MAX_INACTIVITY_MS, job.timeoutSeconds * 1000 + 10 * 60_000),
      );

      const storage = this.deps.storage;
      const chunks = state.diffChunks;
      await this.agent(["write", "/job/change.diff"], {
        stdin: this.textStream(async function* () {
          for (let i = 0; i < chunks; i++) yield (await storage.get<string>(`diff:${i}`)) ?? "";
        }),
      });
      await this.agent(["start", "prepare", String(PREPARE_TIMEOUT_SECONDS), "/"], {
        stdin: this.textStream(async function* () {
          yield "exec /opt/stratum/prepare.sh\n";
        }),
        env: { ...STEP_ENV, BASE_SHA: job.baseSha, HEAD_TREE_SHA: job.headTreeSha },
      });
    } catch (error) {
      console.error("job: container start failed", String(error));
      return;
    }
    state.phase = "preparing";
    state.stepStartedAt = this.deps.now();
    state.pollFailures = 0;
  }

  /** The container vanished, or stopped answering, with work still to do. */
  private async loseContainer(state: JobState): Promise<void> {
    await this.destroyContainer("unresponsive");
    this.failRemaining(
      state,
      "errored",
      "The job's container stopped unexpectedly before this step finished. Its result is unknown; re-run the check.",
    );
    state.phase = "finishing";
  }

  private async poll(state: JobState, id: string, offset: number): Promise<PollResult | null> {
    try {
      const result = await this.agent<PollResult>([
        "poll",
        id,
        String(offset),
        String(POLL_CHUNK_BYTES),
      ]);
      state.pollFailures = 0;
      return result;
    } catch (error) {
      console.error("job: poll failed", String(error));
      if (++state.pollFailures >= MAX_POLL_FAILURES || !this.deps.container.running) {
        await this.loseContainer(state);
      }
      return null;
    }
  }

  private async pollPrepare(state: JobState): Promise<void> {
    const { job } = state;
    const result = await this.poll(state, "prepare", 0);
    if (result === null) return;
    const output = result.chunk ? decoder.decode(fromBase64(result.chunk)) : "";
    const startedAt = state.stepStartedAt ?? this.deps.now();

    let failure: string | undefined;
    if (result.state === "missing") {
      failure = "Not run: the checkout could not be prepared (the job's container lost its state).";
    } else if (result.state === "running") {
      const overdue =
        this.deps.now() > startedAt + PREPARE_TIMEOUT_SECONDS * 1000 + STEP_STOP_GRACE_MS;
      if (!overdue) return;
      failure = `Not run: fetching the base commit and applying the change took longer than ${minutes(PREPARE_TIMEOUT_SECONDS)}.`;
    } else if (result.exit?.exitCode === 3) {
      // The one failure that is about the change rather than the executor.
      failure = `Not run: the base commit ${job.baseSha} plus this change's diff did not reproduce the evaluated tree ${job.headTreeSha}, so the steps would have tested something other than what was evaluated. A change that adds or modifies a binary (non-UTF-8) file cannot be rebuilt from its diff; otherwise re-evaluate the change.`;
    } else if (result.exit?.exitCode !== 0) {
      failure = `Not run: the checkout could not be prepared (exit ${result.exit?.exitCode ?? "unknown"}${result.exit?.timedOut ? ", timed out" : ""}).`;
    }

    if (failure !== undefined) {
      await this.destroyContainer("prepare failed");
      const log = encoder.encode(`${output}\n[stratum] ${failure}\n`);
      for (const step of job.steps) await this.writeLog(step.checkRunId, log);
      const tail = output.trim().split("\n").slice(-5).join("\n").slice(-600);
      this.failRemaining(state, "errored", tail === "" ? failure : `${failure}\n\n${tail}`);
      state.phase = "finishing";
      return;
    }

    // The checkout is built and verified, so the job has no further use for
    // its repository: the proxy is replaced with one that refuses everything,
    // and the credential and the diff are dropped from storage.
    try {
      await this.deps.container.interceptOutboundHttps(
        GIT_HOST,
        this.deps.egress.allowlist({ hosts: [] }),
      );
    } catch (error) {
      // Fail closed. A step must never start while the job can still reach
      // its repository with the executor's credential attached: the steps of
      // a CI job are unreviewed code, and the steps of a deploy job run
      // beside credentials for somewhere that matters more. Nothing has run
      // yet, so stopping here costs a re-run and nothing else.
      console.error("job: could not close the repository proxy", String(error));
      await this.destroyContainer("repository proxy not closed");
      job.repository.authorization = "";
      this.failRemaining(
        state,
        "errored",
        "Not run: the job's access to its repository could not be closed after the checkout, so no step was started. This is a fault in the executor, not in the change; run it again.",
      );
      state.phase = "finishing";
      return;
    }
    job.repository.authorization = "";
    for (let i = 0; i < state.diffChunks; i++) await this.deps.storage.delete(`diff:${i}`);
    state.diffChunks = 0;

    state.phase = "running";
    await this.startStep(state, 0);
  }

  private async startStep(state: JobState, index: number): Promise<void> {
    const step = state.job.steps[index];
    if (step === undefined) {
      state.phase = "finishing";
      return;
    }
    state.stepIndex = index;
    state.stepStartedAt = this.deps.now();
    state.log = emptyLog(this.deps.now());
    try {
      await this.agent(["start", `s${index}`, String(step.timeoutSeconds), WORKSPACE], {
        stdin: this.textStream(async function* () {
          yield step.run.endsWith("\n") ? step.run : `${step.run}\n`;
        }),
        env: STEP_ENV,
      });
    } catch (error) {
      console.error("job: could not start a step", String(error));
      await this.loseContainer(state);
      return;
    }
    this.enqueue(state, index, "running");
  }

  private async pollStep(state: JobState): Promise<void> {
    const index = state.stepIndex;
    const step = state.job.steps[index];
    if (step === undefined) {
      state.phase = "finishing";
      return;
    }
    const now = this.deps.now();
    const startedAt = state.stepStartedAt ?? now;
    const result = await this.poll(state, `s${index}`, state.log.offset);
    if (result === null) return;
    if (result.state === "missing") {
      await this.loseContainer(state);
      return;
    }
    await this.keepOutput(state, result);

    if (result.state === "exited" && result.exit) {
      const { exitCode, signal, timedOut, durationMs } = result.exit;
      const passed = exitCode === 0 && !timedOut;
      const summary = passed
        ? `Passed in ${duration(durationMs)}.`
        : timedOut
          ? `Timed out: the step was stopped after its limit of ${minutes(step.timeoutSeconds)}.`
          : exitCode === null
            ? `Failed: the step was killed by ${signal ?? "a signal"} after ${duration(durationMs)}.`
            : `Failed with exit code ${exitCode} after ${duration(durationMs)}.`;
      await this.flushLog(state, summary, result.size ?? state.log.offset);
      this.enqueue(state, index, passed ? "passed" : "failed", summary);
      // Later steps run whatever this one did: each is its own check, and a
      // failing lint is no reason to withhold the test results.
      if (index + 1 < state.job.steps.length) await this.startStep(state, index + 1);
      else state.phase = "finishing";
      return;
    }

    if (now > startedAt + step.timeoutSeconds * 1000 + STEP_STOP_GRACE_MS) {
      // The supervisor inside should have stopped the step by now. It did
      // not — it runs beside the code it supervises and can be killed by it —
      // so the limit is enforced the only way that cannot be dodged.
      const summary = `Timed out: the step did not stop at its limit of ${minutes(step.timeoutSeconds)}, so the job's container was destroyed.`;
      await this.flushLog(state, summary, result.size ?? state.log.offset);
      await this.destroyContainer("step timeout");
      this.enqueue(state, index, "failed", summary);
      this.failRemaining(
        state,
        "errored",
        `Not run: the job's container was destroyed when step '${step.name}' did not stop at its time limit.`,
      );
      state.phase = "finishing";
      return;
    }

    if (state.log.dirty && now - state.log.flushedAt >= LOG_FLUSH_INTERVAL_MS) {
      await this.flushLog(state, undefined, result.size ?? state.log.offset);
    }
  }

  private async exceedWallClock(state: JobState): Promise<void> {
    const limit = minutes(state.job.timeoutSeconds);
    const running = state.results.indexOf("running");
    if (running >= 0) {
      const summary = `The job exceeded its time limit of ${limit} while this step was running, and was stopped. The step's result is unknown.`;
      await this.flushLog(state, summary, state.log.offset);
      this.enqueue(state, running, "errored", summary);
    }
    // Destroyed from out here, by the Durable Object's clock: nothing the
    // code in the container does can extend the job.
    await this.destroyContainer("job timeout");
    this.failRemaining(state, "errored", `Not run: the job exceeded its time limit of ${limit}.`);
    state.phase = "finishing";
  }

  // ------------------------------------------------------------------- logs

  private async keepOutput(state: JobState, result: PollResult): Promise<void> {
    const { log } = state;
    const bytes = result.chunk ? fromBase64(result.chunk) : new Uint8Array(0);
    if (bytes.length === 0) return;
    log.offset += bytes.length;
    const room = this.deps.logMaxBytes - log.stored;
    if (room <= 0) {
      log.truncated = true;
      return;
    }
    const kept = bytes.length > room ? bytes.slice(0, room) : bytes;
    if (kept.length < bytes.length) log.truncated = true;
    await this.deps.storage.put(`log:${log.chunks++}`, kept);
    log.stored += kept.length;
    log.dirty = true;
  }

  /**
   * Write the current step's log to the bucket. With a `footer` this is the
   * final write: a truncated log gets the end of the output appended, since
   * the end is where a failure says what went wrong.
   */
  private async flushLog(state: JobState, footer: string | undefined, size: number): Promise<void> {
    const step = state.job.steps[state.stepIndex];
    if (step === undefined) return;
    const { log } = state;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < log.chunks; i++) {
      const chunk = await this.deps.storage.get<Uint8Array>(`log:${i}`);
      if (chunk !== undefined) parts.push(chunk);
    }
    if (footer !== undefined) {
      if (log.truncated || size > log.stored) {
        const from = Math.max(log.stored, size - LOG_TAIL_BYTES);
        let tail: Uint8Array = new Uint8Array(0);
        try {
          const result = await this.agent<PollResult>([
            "poll",
            `s${state.stepIndex}`,
            String(from),
            String(LOG_TAIL_BYTES),
          ]);
          if (result.chunk) tail = fromBase64(result.chunk);
        } catch {
          // The container may already be gone; the head of the log stands.
        }
        parts.push(
          encoder.encode(
            `\n[stratum] log truncated: the step wrote ${size} bytes; the first ${log.stored} and the last ${tail.length} are kept\n`,
          ),
          tail,
        );
      }
      parts.push(encoder.encode(`\n[stratum] ${footer}\n`));
      for (let i = 0; i < log.chunks; i++) await this.deps.storage.delete(`log:${i}`);
    }
    await this.writeLog(step.checkRunId, concat(parts));
    log.dirty = false;
    log.flushedAt = this.deps.now();
  }

  private async writeLog(checkRunId: string, body: Uint8Array): Promise<void> {
    try {
      await this.deps.putLog(checkRunId, body);
    } catch (error) {
      // A lost log must not lose the result it describes.
      console.error("job: could not store a log", String(error));
    }
  }

  // ----------------------------------------------------------------- finish

  /**
   * Destroy the container, deliver what is left to report, give the slot back
   * and forget the job — including the credential it was sent.
   */
  private async finish(state: JobState): Promise<number | null> {
    await this.destroyContainer("job finished");
    if (this.deps.container.running) {
      // The slot stands for a live container, not for a job believed to be
      // over (ADR 012). Giving it back now would let another job start beside
      // this one, and a run of failed teardowns would carry the executor past
      // its cap. So the slot is kept and the destroy retried until the
      // container is gone. The coordinator's own clock is the only thing that
      // can take the slot back sooner, when the job's time plus grace runs out.
      await this.save(state);
      return RETRY_INTERVAL_MS;
    }
    const pastDeadline = this.deps.now() > state.job.deadline;
    if (state.outbox.length > 0 && state.sendFailures < MAX_SEND_FAILURES && !pastDeadline) {
      // Stratum is unreachable. The results are kept and retried; past the
      // checks' own deadline Stratum has already written them off.
      await this.save(state);
      return RETRY_INTERVAL_MS;
    }
    try {
      await this.deps.release();
    } catch (error) {
      console.error("job: could not release its slot", String(error));
      if (++state.finishAttempts < MAX_FINISH_ATTEMPTS) {
        await this.save(state);
        return RETRY_INTERVAL_MS;
      }
      // The coordinator reclaims the slot on its own clock.
    }
    await this.deps.storage.deleteAll();
    return null;
  }
}
