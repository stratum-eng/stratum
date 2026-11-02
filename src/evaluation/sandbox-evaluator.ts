import { readRepoFiles } from "../storage/git-ops";
import type { SandboxBinding, SandboxInstance } from "../types";
import type { AppError } from "../utils/errors";
import { ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { err, ok } from "../utils/result";
import {
  DEFAULT_COMMAND,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_BUDGET_MS,
  MAX_TOTAL_BUDGET_MS,
  MIN_TOTAL_BUDGET_MS,
} from "./limits";
import type { EvalPolicy, EvalResult, Evaluator, SandboxEvaluatorConfig } from "./types";

const MAX_OUTPUT_IN_REASON = 500;

/**
 * Read access to the workspace repo whose tree is being evaluated. Threaded in
 * by `buildEvaluators` so the sandbox runs against the FULL workspace tree
 * (the evaluated commit), not a reconstruction from diff hunks.
 */
export interface SandboxRepoAccess {
  /** The workspace repo remote. */
  remote: string;
  /** A read-scoped token for that remote. */
  token: string;
  /**
   * The evaluated commit sha (pinned as evaluated_sha). Required — not
   * optional — so a `SandboxRepoAccess` can only be constructed with a commit
   * pinned. `readRepoFiles` takes an unpinned, best-effort branch when `ref`
   * is omitted (see its doc comment); that branch must never be reachable
   * from the sandbox evaluator, which runs a merge gate and cannot let a
   * silently partial tree produce a passing verdict. Requiring `ref` here
   * makes that structural rather than a call-site convention.
   */
  ref: string;
}

/** Reads a repo tree into path → raw bytes; injectable for tests. */
export type RepoFilesReader = (
  remote: string,
  token: string,
  logger: Logger,
  ref: string,
) => Promise<Result<Map<string, Uint8Array>, AppError>>;

/**
 * Derives a pass ratio from a test runner's own summary line.
 *
 * Scored from the summary rather than the exit code because the exit code is
 * binary: a suite where 99 of 100 tests pass is indistinguishable from one
 * where none do. Both patterns are tried because runners disagree on whether
 * a clean run prints a "failed" count at all — vitest and jest omit it, so
 * "N passed" alone has to be accepted, with `failed` re-matched separately
 * rather than assumed zero from the first pattern.
 *
 * Returns `null`, never 0, when nothing parses: an unrecognised format means
 * the score is *unknown*, and reporting that as a zero would fail a change on
 * the runner's output format instead of on its tests.
 */
function parseTestOutput(stdout: string, stderr: string): number | null {
  const combined = `${stdout}\n${stderr}`;

  const match =
    combined.match(/(\d+)\s+passed[,\s]+(\d+)\s+failed/i) ?? combined.match(/(\d+)\s+passed/i);

  if (match) {
    const passed = Number.parseInt(match[1] ?? "0", 10);
    const failedMatch = combined.match(/(\d+)\s+failed/i);
    const failed = failedMatch ? Number.parseInt(failedMatch[1] ?? "0", 10) : 0;
    const total = passed + failed;
    if (total === 0) return null;
    return passed / total;
  }

  return null;
}

/**
 * The phases a sandbox evaluation spends time in, in execution order. Named so
 * a budget-exceeded reason says *where* the time went — an agent reading the
 * verdict can tell "your install is too slow" from "your suite is too slow"
 * without a human reading the output.
 */
export type SandboxPhase = "tree-read" | "create" | "materialize" | "install" | "command";

/**
 * Bring a policy-supplied duration into range, falling back to `fallback` for
 * anything that is not a finite number.
 *
 * Duplicated in spirit by `policy-loader`, which clamps the same fields when a
 * policy file is read. Both exist on purpose: the loader produces the operator
 * warning, and this one is the boundary that actually holds, because
 * `evaluate` is reachable from a policy cache and from callers that never
 * loaded a file.
 */
function clampToRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Stable prefix for a budget-exceeded verdict. Exported because it is the
 * contract callers and tests match on: the free-text remainder may change, this
 * may not.
 */
export function budgetExceededReason(phase: SandboxPhase, totalBudgetMs: number): string {
  return `sandbox budget exceeded (${phase}): evaluation did not finish within ${totalBudgetMs}ms`;
}

/**
 * A wall-clock allowance shared across every phase of one evaluation.
 *
 * Exists because the per-phase timeouts are independent: with defaults, install
 * and the scored command alone permit their sum, and nothing bounded the total.
 * A caller or proxy gives up long before that, leaving the submitter with no
 * verdict.
 *
 * What it does and does not bound is load-bearing, because Workers freeze
 * `Date.now()` between I/O (see `src/utils/phase-timer.ts`): time spent
 * *awaiting the sandbox* advances the clock and is bounded reliably — that is
 * the overrun this exists for — while pure-CPU work inside the Worker (pack
 * decompression, base64 encoding a large tree) may read as ~0ms and is
 * constrained by workerd's CPU limit rather than by this.
 */
export interface Budget {
  /** Milliseconds left before the budget is exhausted; never negative. */
  remaining(): number;
  /** The timeout a phase may actually use: `min(requested, remaining)`. */
  allow(requestedMs: number): number;
  /** True once nothing is left. */
  expired(): boolean;
  /** The total this budget started with, for reporting. */
  readonly totalMs: number;
}

/**
 * Smallest timeout ever handed to `sandbox.run`. Never 0: the Sandbox binding
 * does not document how it reads `timeout: 0`, and "no timeout" is a plausible
 * reading — the exact opposite of what an exhausted budget means.
 */
const MIN_GRANTED_TIMEOUT_MS = 1;

/**
 * `now` is injected so tests drive elapsed time with a fake clock instead of
 * sleeping. Deliberately timer-free: an earlier design raced phases against a
 * `setTimeout`, which a fake clock cannot drive and which leaks a live timer
 * into the test event loop.
 */
export function startBudget(totalMs: number, now: () => number = Date.now): Budget {
  // `Math.max(0, NaN)` is NaN, not 0 — so a non-finite total would produce a
  // budget that never reports expired and hands `NaN` to `sandbox.run`, whose
  // handling of it is undefined. This type is exported, so the guard belongs
  // here rather than only at the call sites.
  const total = Number.isFinite(totalMs) ? totalMs : DEFAULT_TOTAL_BUDGET_MS;
  const startedAt = now();
  const remaining = () => Math.max(0, total - (now() - startedAt));
  return {
    totalMs: total,
    remaining,
    expired: () => remaining() <= 0,
    allow: (requestedMs: number) =>
      Math.max(MIN_GRANTED_TIMEOUT_MS, Math.min(requestedMs, remaining())),
  };
}

/** The lockfile names `npm ci` accepts. */
const NPM_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

/**
 * A lockfile means the dependency tree is already pinned, so `npm ci` installs
 * it verbatim — an evaluation score only means something if every run resolves
 * the same versions. Without one, `npm install` is the best available
 * (unpinned) approximation; without a package.json there is nothing to install,
 * because the repo is not an npm project. `--no-audit --no-fund` skip registry
 * round trips the evaluation has no use for.
 *
 * Only checks which manifest paths are *present* in the tree — it never reads
 * their contents, so no text decode is needed here. `files` carries raw bytes
 * end to end like the rest of the read path; a manifest's actual contents
 * would be decoded at the point that genuinely needs text, not here.
 *
 * `--ignore-scripts` is the default because the tree is authored by an agent or
 * by anyone who can push to the workspace, and `preinstall`/`install`/
 * `postinstall` would otherwise execute before any human has reviewed the
 * change. It narrows the window rather than closing it — a tree-supplied
 * `.npmrc` still redirects the registry, lockfile `resolved` URLs are still
 * fetched verbatim, and the scored command runs untrusted code by design (see
 * `docs/adr/007-sandbox-evaluator-threat-model.md`). `opts` is optional so that
 * omitting it yields the *safe* behaviour.
 */
export function installCommandFor(
  files: ReadonlyMap<string, Uint8Array>,
  opts?: { allowInstallScripts?: boolean },
): string | null {
  if (!files.has("package.json")) return null;
  const base = NPM_LOCKFILES.some((lockfile) => files.has(lockfile)) ? "npm ci" : "npm install";
  const flags = opts?.allowInstallScripts === true ? "" : " --ignore-scripts";
  return `${base} --no-audit --no-fund${flags}`;
}

/**
 * Encodes bytes as base64 without spreading the whole array onto the call
 * stack at once (a naive `String.fromCharCode(...bytes)` blows the stack on
 * large binary files) — chunked through `String.fromCharCode` instead.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Per-file content the sandbox write boundary sends, plus whether it took the
 * binary (base64) path.
 */
interface SandboxWriteContent {
  content: string;
  binary: boolean;
}

// `ignoreBOM: true` is what *keeps* a leading BOM: the option name means
// "do not treat the BOM specially", so U+FEFF survives into the decoded
// string and re-encoding restores the original EF BB BF. The default
// (`false`) strips it, which would silently drop three bytes from every
// UTF-8-with-BOM file — the exact corruption this read path exists to stop.
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Prepares one file's bytes for `SandboxInstance.writeFile`, whose transport
 * boundary only carries strings (the default Cloudflare Sandbox HTTP
 * transport has no binary form for `writeFile`; see `decodeBinaryFilesScript`
 * below for the matching in-sandbox decode step). Bytes that are valid UTF-8
 * are decoded directly — lossless, since re-encoding well-formed UTF-8
 * reproduces the original bytes exactly, byte-order mark included. Anything
 * else (the common case for a binary file) is base64-encoded and flagged so
 * the caller can queue it for in-sandbox decoding.
 */
export function encodeForSandboxWrite(bytes: Uint8Array): SandboxWriteContent {
  try {
    return { content: strictUtf8Decoder.decode(bytes), binary: false };
  } catch {
    return { content: bytesToBase64(bytes), binary: true };
  }
}

/**
 * Preferred staging paths for the base64→binary decode manifest and script.
 *
 * Only *preferred*: a repo may legitimately track files of its own at these
 * names, and staging over one would overwrite the tracked content and then
 * delete it (the decode script unlinks both the manifest and itself when it
 * finishes), so `materializeTree` steps aside to a free neighbouring name
 * whenever the incoming tree already occupies one. Exported because both
 * callers and their tests reason about the ordinary, collision-free case.
 */
export const BINARY_MANIFEST_PATH = ".stratum-binary-manifest.txt";
export const BINARY_DECODE_SCRIPT_PATH = ".stratum-binary-decode.cjs";

/**
 * The command that runs the decode script from wherever it was staged.
 *
 * A function of the path because the script may have had to move aside from
 * `BINARY_DECODE_SCRIPT_PATH` to avoid clobbering a tracked file. The `.cjs`
 * extension the caller passes is load-bearing: it forces CommonJS regardless
 * of the evaluated repo's own package.json `"type"`, so any fallback name
 * must keep it.
 */
export function binaryDecodeCommandFor(scriptPath: string): string {
  return `node ${scriptPath}`;
}

/** The decode command for the ordinary case where nothing displaced the script. */
export const BINARY_DECODE_COMMAND = binaryDecodeCommandFor(BINARY_DECODE_SCRIPT_PATH);

/**
 * Reads the newline-delimited manifest this evaluator wrote, base64-decodes
 * each listed path in place, then removes the manifest and itself. Node is
 * guaranteed present in the sandbox (the evaluator's own default/most common
 * commands are `npm ci`/`npm install`/`npm test`).
 *
 * Takes the manifest path instead of baking in a constant because the
 * manifest is not always staged at `BINARY_MANIFEST_PATH` — a tree that
 * already tracks that name pushes it aside — and the script deletes whatever
 * path it is given, so handing it a stale constant would delete a tracked
 * file and leave the real manifest behind.
 */
export function decodeBinaryFilesScript(manifestPath: string): string {
  return `const fs = require("fs");
const manifest = fs.readFileSync(${JSON.stringify(manifestPath)}, "utf8").split("\\n").filter(Boolean);
for (const p of manifest) {
  const encoded = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, Buffer.from(encoded, "base64"));
}
fs.unlinkSync(${JSON.stringify(manifestPath)});
fs.unlinkSync(__filename);
`;
}

/**
 * Finds a staging path the tree being materialized does not already use.
 *
 * Exists because the decode helpers are written into the same workspace as
 * the repo's own files and are deleted afterwards: a tree that happens to
 * track a file at the preferred name would have that file overwritten and
 * then unlinked before the configured command ever ran — silently evaluating
 * an incomplete tree, or failing an otherwise valid post-merge check. Names
 * are only *derived* (a numeric discriminator before the extension) rather
 * than randomized so the staged paths stay predictable in logs and tests, and
 * the extension is preserved because `.cjs` decides how Node parses the
 * script.
 */
function freeStagingPath(preferred: string, taken: ReadonlySet<string>): string {
  const dot = preferred.lastIndexOf(".");
  const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
  const extension = dot > 0 ? preferred.slice(dot) : "";
  let candidate = preferred;
  let discriminator = 0;
  while (taken.has(candidate)) {
    discriminator += 1;
    candidate = `${stem}-${discriminator}${extension}`;
  }
  return candidate;
}

/** What materializing a tree cost and touched, for callers that meter or log it. */
export interface MaterializedTree {
  /** Repo-relative paths that went in base64-encoded and were decoded in place. */
  binaryPaths: string[];
  /** Wall-clock ms spent running the in-sandbox decode step; 0 when it did not run. */
  decodeMs: number;
}

/**
 * Writes a whole repo tree into a sandbox and restores its binary files to
 * their real bytes, leaving the workspace byte-identical to the commit.
 *
 * Shared by the evaluator and the post-merge smoke check because both need
 * exactly this and the sequence has sharp edges that must not be re-derived
 * per caller: `writeFile` only carries strings on the sandbox's default
 * transport, so non-UTF-8 files must ride in as base64 and be decoded before
 * anything reads them; the writes are batched with `allSettled` rather than
 * `all` so a rejection cannot leave siblings in flight while the caller tears
 * the sandbox down; and the decode helpers must not be staged on top of a
 * file the tree actually tracks.
 *
 * Throws rather than returning a verdict: a tree that could not be written or
 * decoded is not a judgement about the code, and each caller already maps a
 * thrown failure onto its own reporting.
 */
export async function materializeTree(
  sandbox: SandboxInstance,
  files: ReadonlyMap<string, Uint8Array>,
  opts: {
    decodeTimeoutMs: number;
    /**
     * Supplies the decode step's timeout, called *after* the writes — which are
     * unbounded and can consume most of a caller's remaining budget. A grant
     * computed before this function runs would be spent against a stale
     * remaining, letting the decode overrun the total budget on a large tree.
     *
     * Taking the caller's grant function rather than a `Budget` also lets the
     * caller record that this grant was budget-shortened, so a decode that then
     * times out is classified the same way as any other budgeted phase. Callers
     * with no budget (the post-merge check) omit it and get `decodeTimeoutMs`
     * unchanged.
     */
    grant?: (requestedMs: number) => number;
    /** Clock for the decode timing, injectable to match the caller's budget. */
    now?: () => number;
    logger?: Logger;
  },
): Promise<MaterializedTree> {
  // The full tree can hold thousands of files; one round trip per file
  // dominates latency, so write in bounded concurrent batches.
  const WRITE_CONCURRENCY = 16;
  const entries = [...files];
  const binaryPaths: string[] = [];
  for (let i = 0; i < entries.length; i += WRITE_CONCURRENCY) {
    // allSettled, not all: `all` rejects on the first failure while its
    // siblings are still in flight, and a caller's `finally` would then
    // destroy the sandbox out from under them. Wait for the whole batch to
    // settle, then surface the first failure.
    const settled = await Promise.allSettled(
      entries.slice(i, i + WRITE_CONCURRENCY).map(([path, bytes]) => {
        const { content, binary } = encodeForSandboxWrite(bytes);
        if (binary) binaryPaths.push(path);
        return sandbox.writeFile(path, content);
      }),
    );
    const failed = settled.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  opts.logger?.debug("Files written to sandbox", {
    fileCount: files.size,
    binaryFileCount: binaryPaths.length,
  });

  if (binaryPaths.length === 0) return { binaryPaths, decodeMs: 0 };

  // Binary files landed base64-encoded (writeFile has no binary form on this
  // transport) — decode them back to their real bytes in place before the
  // caller's commands see the tree, so a corrupted copy never runs.
  const taken = new Set(files.keys());
  const manifestPath = freeStagingPath(BINARY_MANIFEST_PATH, taken);
  const scriptPath = freeStagingPath(BINARY_DECODE_SCRIPT_PATH, taken);
  await sandbox.writeFile(manifestPath, binaryPaths.join("\n"));
  await sandbox.writeFile(scriptPath, decodeBinaryFilesScript(manifestPath));
  const now = opts.now ?? Date.now;
  const decodeStartedAt = now();
  const decodeResult = await sandbox.run(binaryDecodeCommandFor(scriptPath), {
    timeout: opts.grant ? opts.grant(opts.decodeTimeoutMs) : opts.decodeTimeoutMs,
  });
  const decodeMs = now() - decodeStartedAt;
  if (decodeResult.exitCode !== 0) {
    const output = (decodeResult.stdout + decodeResult.stderr)
      .slice(0, MAX_OUTPUT_IN_REASON)
      .trim();
    throw new Error(`Failed to decode ${binaryPaths.length} binary file(s) in sandbox: ${output}`);
  }
  opts.logger?.debug("Binary files decoded in sandbox", { binaryFileCount: binaryPaths.length });
  return { binaryPaths, decodeMs };
}

export class SandboxEvaluator implements Evaluator {
  /**
   * `readFiles` defaults to the real `readRepoFiles` and is a parameter only
   * so tests can drive the tree read: every interesting failure of this
   * evaluator (an unreadable blob, a partial tree, a binary file that must
   * survive the write boundary) lives in what comes back from that read, and
   * the alternative — standing up a real remote per case — would make those
   * paths expensive enough to go untested.
   *
   * `now` is injectable for the same reason: the total budget's behaviour is
   * entirely a function of elapsed time, and driving it with a fake clock is
   * the only way to test exhaustion without sleeping for minutes.
   */
  constructor(
    private sandbox: SandboxBinding,
    private repo: SandboxRepoAccess,
    private readFiles: RepoFilesReader = readRepoFiles,
    private now: () => number = Date.now,
  ) {}

  /**
   * Runs the configured command against the full evaluated tree in a sandbox.
   *
   * The `_diff` argument is ignored on purpose. The evaluator that this
   * replaced reconstructed a pseudo-tree from the diff's `+` lines, which
   * could not run any real suite — no base tree, no untouched sources, no
   * `package.json` unless it happened to change. The tree is read from the
   * pinned commit instead, so the sandbox holds exactly what the merge would
   * land. The parameter stays because it is part of the `Evaluator` contract
   * shared with the diff-based evaluators.
   *
   * Three kinds of failure, deliberately distinguished:
   *
   * - The suite ran and did not pass, or a dependency install failed: score 0
   *   with `passed: false`. An evaluation that could not run must never read
   *   as one that passed, so these are verdicts, not errors.
   * - The total budget ran out: also a verdict (score 0), with a reason naming
   *   the phase. The sandbox was reachable and simply did not finish in the
   *   time allowed, which is a judgement about the change — its install or its
   *   suite is too slow for a synchronous request — not an infrastructure
   *   failure. Reached two ways: a phase that cannot be started, and a phase
   *   the budget had to shorten which then failed at that shortened timeout.
   *   A phase that hits the project's *own* configured timeout is not this —
   *   it keeps returning `err`, as it always has.
   * - The evaluated tree could not be reached or read, or the sandbox itself
   *   threw for any other reason: `err(ExternalServiceError)`. There is no
   *   verdict to give here — the caller decides whether to retry or surface the
   *   failure, and scoring 0 would fabricate a judgement about code we never
   *   saw.
   *
   * A missing SANDBOX binding or missing repo access never reaches this method
   * at all: `buildEvaluators` substitutes an `UnavailableEvaluator` at
   * construction, which is what fails those closed.
   */
  async evaluate(
    _diff: string,
    policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    logger.debug("Starting sandbox evaluation");

    const config = policy.evaluators.find((e): e is SandboxEvaluatorConfig => e.type === "sandbox");

    if (!config) {
      logger.info("No sandbox evaluator configured");
      return ok({ score: 1.0, passed: true, reason: "No sandbox evaluator configured" });
    }

    const command = config.command ?? DEFAULT_COMMAND;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const installTimeoutMs = config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    // Clamped here, not only at load time: `evaluate` is reachable from a KV
    // policy cache and from callers that never went through `policy-loader`, and
    // a `totalBudgetMs` of 0 would make every change on the project fail before
    // a sandbox was ever created.
    const totalBudgetMs = clampToRange(
      config.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS,
      MIN_TOTAL_BUDGET_MS,
      MAX_TOTAL_BUDGET_MS,
      DEFAULT_TOTAL_BUDGET_MS,
    );
    const minScore = policy.minScore ?? 0.7;

    logger.debug("Sandbox config", { command, timeoutMs, installTimeoutMs, totalBudgetMs });

    // Started before the tree read so a slow clone is charged against what the
    // later phases get, even though the read itself is not interruptible.
    const budget = startBudget(totalBudgetMs, this.now);

    let sb: Awaited<ReturnType<SandboxBinding["create"]>> | null = null;
    let sandboxMs = 0;
    // Tracked so a throw from a phase whose granted timeout fired can be
    // reported against the phase that actually ran out, not a guess.
    let currentPhase: SandboxPhase = "tree-read";
    // When the current phase started, so a phase that throws still contributes
    // the time it burned to `sandbox_ms` instead of losing it.
    let phaseStartedAt: number | null = null;
    /**
     * Whether the budget — rather than the project's own configured timeout —
     * is what shortened the current phase's grant. This is what separates
     * "the total budget ran out" (a verdict) from "your configured phase
     * timeout fired" (an error, as it has always been): without it, every
     * ordinary phase timeout would be relabelled as budget exhaustion.
     */
    let grantWasBudgetCapped = false;

    /** The grant handed to the phase now running, for the timeout check below. */
    let currentGrantMs = 0;

    /** Grant a phase its timeout, recording whether the budget capped it. */
    const grantFor = (requestedMs: number): number => {
      const granted = budget.allow(requestedMs);
      grantWasBudgetCapped = granted < requestedMs;
      currentGrantMs = granted;
      return granted;
    };

    /**
     * Did the phase that just threw actually burn its whole grant?
     *
     * Distinguishes a timeout from a transient failure without matching on
     * error message text, which is binding-specific and would silently rot. A
     * Sandbox API blip 200ms into a 5s grant is infrastructure; a throw at the
     * 5s mark is the timeout firing.
     */
    const phaseConsumedItsGrant = (): boolean =>
      phaseStartedAt !== null && this.now() - phaseStartedAt >= currentGrantMs;

    /**
     * The budget ran out. Reported as a verdict rather than an error — see the
     * method doc. `costs` is omitted before the sandbox exists: there is no
     * sandbox time to report, and clone time is `git_ops`, not `sandbox_ms`.
     */
    const budgetVerdict = (phase: SandboxPhase): Result<EvalResult, AppError> => {
      logger.info("Sandbox evaluation exceeded its total budget", { phase, totalBudgetMs });
      return ok({
        score: 0,
        passed: false,
        reason: budgetExceededReason(phase, totalBudgetMs),
        ...(sb === null ? {} : { costs: [{ kind: "sandbox_ms" as const, quantity: sandboxMs }] }),
      });
    };

    try {
      // Materialize the full workspace tree at the evaluated commit — the same
      // tree the merge would land — so the command runs against real sources,
      // not just the added lines of the diff.
      const filesResult = await this.readFiles(
        this.repo.remote,
        this.repo.token,
        logger,
        this.repo.ref,
      );
      if (!filesResult.success) {
        logger.error("Could not read workspace tree for sandbox", filesResult.error);
        return err(
          new ExternalServiceError(
            "Sandbox",
            `Could not read workspace tree: ${filesResult.error.message}`,
          ) as AppError,
        );
      }
      const files = filesResult.data;

      // The read is not interruptible (`RepoFilesReader` takes no timeout), so
      // the budget cannot cut it short — it can only decline to go further.
      if (budget.expired()) return budgetVerdict("tree-read");

      currentPhase = "create";
      sb = await this.sandbox.create();
      const instance = sb;
      logger.debug("Sandbox created");

      currentPhase = "materialize";
      if (budget.expired()) return budgetVerdict("materialize");

      // Materializing the tree — string-only writeFile, base64 for binaries,
      // in-sandbox decode — is shared with the post-merge check so the write
      // boundary has exactly one implementation. `installTimeoutMs` bounds the
      // decode step because it is setup, not the scored command; the batched
      // `writeFile` loop takes no timeout and so is charged but not bounded.
      //
      // The budget is passed in rather than a precomputed timeout because those
      // unbounded writes happen first: a grant calculated out here would be
      // spent against whatever remained *before* the tree was written, letting
      // the decode overrun the total budget on a large tree.
      // Timed from here rather than from the decode alone: if the writes or the
      // decode throw, the `catch` charges everything this phase burned, and the
      // decode's own grant flows through `grantFor` so a budget-shortened
      // decode that times out is classified like any other phase.
      phaseStartedAt = this.now();
      const materialized = await materializeTree(instance, files, {
        decodeTimeoutMs: installTimeoutMs,
        grant: grantFor,
        now: this.now,
        logger,
      });
      phaseStartedAt = null;
      sandboxMs += materialized.decodeMs;

      const installCommand = installCommandFor(files, {
        allowInstallScripts: config.allowInstallScripts,
      });
      if (installCommand !== null) {
        currentPhase = "install";
        if (budget.expired()) return budgetVerdict("install");
        const installStartedAt = this.now();
        phaseStartedAt = installStartedAt;
        const install = await sb.run(installCommand, { timeout: grantFor(installTimeoutMs) });
        phaseStartedAt = null;
        sandboxMs += this.now() - installStartedAt;
        logger.debug("Sandbox install completed", {
          installCommand,
          exitCode: install.exitCode,
        });
        if (install.exitCode !== 0) {
          const output = (install.stdout + install.stderr).slice(0, MAX_OUTPUT_IN_REASON).trim();
          logger.info("Sandbox evaluation failed at dependency install", { installCommand });
          return ok({
            score: 0,
            passed: false,
            reason: `Dependency install (${installCommand}) failed: ${output}`,
            costs: [{ kind: "sandbox_ms", quantity: sandboxMs }],
          });
        }
      }

      currentPhase = "command";
      if (budget.expired()) return budgetVerdict("command");
      const runStartedAt = this.now();
      phaseStartedAt = runStartedAt;
      const result = await sb.run(command, { timeout: grantFor(timeoutMs) });
      phaseStartedAt = null;
      sandboxMs += this.now() - runStartedAt;
      logger.debug("Sandbox command completed", { exitCode: result.exitCode, sandboxMs });

      let score: number;
      if (result.exitCode === 0) {
        score = 1.0;
      } else {
        const parsed = parseTestOutput(result.stdout, result.stderr);
        score = parsed ?? 0.0;
      }

      const passed = score >= minScore;
      const reason = (result.stdout + result.stderr).slice(0, MAX_OUTPUT_IN_REASON).trim();

      logger.info("Sandbox evaluation complete", { score, passed });
      return ok({ score, passed, reason, costs: [{ kind: "sandbox_ms", quantity: sandboxMs }] });
    } catch (error) {
      // A phase whose granted timeout fired throws rather than returning, so
      // budget exhaustion can arrive here as well as at a phase gate.
      const timedOut = phaseConsumedItsGrant();
      // Charge the time the throwing phase burned before classifying, so it is
      // not lost from the cost record.
      if (phaseStartedAt !== null) sandboxMs += this.now() - phaseStartedAt;

      // Both conditions matter. `grantWasBudgetCapped` says the budget — not
      // the project's own configured timeout — is what shortened this phase;
      // without it, an ordinary configured timeout would be relabelled, quietly
      // changing what every pre-existing sandbox timeout reports.
      // `timedOut` says the phase actually spent its whole grant; without it, a
      // transient Sandbox API failure part-way through a shortened phase would
      // be reported as a definitive judgement about the change rather than the
      // retryable infrastructure error it is.
      //
      // Note `expired()` is deliberately not the test: a capped grant is
      // exactly `remaining`, so a phase that exhausts it lands within a
      // millisecond of zero, and keying on which side of that boundary the
      // clock happens to read would make the outcome nondeterministic.
      if (grantWasBudgetCapped && timedOut) return budgetVerdict(currentPhase);

      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        "Sandbox evaluation failed",
        error instanceof Error ? error : new Error(message),
      );
      return err(
        new ExternalServiceError(
          "Sandbox",
          message,
          error instanceof Error ? error : undefined,
        ) as AppError,
      );
    } finally {
      if (sb !== null) {
        // Contained deliberately: an `await` that rejects inside `finally`
        // replaces the returned Result with a rejection, which would reject the
        // `Promise.all` in `runEvaluation` and discard every other evaluator's
        // result. A sandbox we could not tear down is an operational problem to
        // log, not a reason to lose the verdict.
        try {
          await sb.destroy();
          logger.debug("Sandbox destroyed");
        } catch (destroyError) {
          logger.error(
            "Failed to destroy sandbox; instance may leak",
            destroyError instanceof Error ? destroyError : new Error(String(destroyError)),
          );
        }
      }
    }
  }
}
