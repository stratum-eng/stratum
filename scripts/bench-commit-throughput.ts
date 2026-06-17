/**
 * Single-repo commit/merge throughput harness (ADR 004, Phase 0).
 *
 * Fires N concurrent commit -> merge cycles at ONE project repo and reports
 * commits/sec plus per-phase breakdown, for both conflict modes. Produces the
 * "before" (flag off) and "after" (REPO_DO_ENABLED) numbers for the spike-plan
 * Results table.
 *
 * Usage:
 *   STRATUM_URL=http://localhost:8787 \
 *   STRATUM_SESSION=<cookie> \
 *   npx tsx scripts/bench-commit-throughput.ts --n=1,5,25,100 --conflict=none --repeat=3
 *
 * Safety: refuses production hosts unless --i-understand-this-writes-real-commits
 * is passed, because each merge pushes a real commit to a real Artifacts repo.
 */

// Minimal ambient for the Node runtime (this repo's tsconfig targets Workers and
// does not pull in @types/node; this script runs under tsx).
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};

export interface BenchArgs {
  baseUrl: string;
  concurrencies: number[];
  conflict: "none" | "same";
  repeat: number;
  warmup: number;
  project: string;
  allowProd: boolean;
  /** Drive the Phase 2 R2 object-plane + group-commit endpoint instead of full merges. */
  r2Bench: boolean;
  /** Drive the server-side batch-merge endpoint (N changes per request). */
  batch: boolean;
  bytes: number;
  durationMs: number;
}

const PRODUCTION_HOST_PATTERNS = [/(^|\.)app\.usestratum\.dev$/i, /(^|\.)usestratum\.dev$/i];

/** True when the URL points at a known production host. */
export function isProductionHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return PRODUCTION_HOST_PATTERNS.some((p) => p.test(host));
}

export function parseArgs(argv: string[]): BenchArgs {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    const eq = hit.indexOf("=");
    return eq === -1 ? "true" : hit.slice(eq + 1);
  };

  const conflictRaw = get("conflict") ?? "none";
  if (conflictRaw !== "none" && conflictRaw !== "same") {
    throw new Error(`--conflict must be 'none' or 'same', got '${conflictRaw}'`);
  }

  const concurrencies = (get("n") ?? "1,5,25,100")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (concurrencies.length === 0) throw new Error("--n must list positive integers");

  return {
    baseUrl: (get("url") ?? process.env.STRATUM_URL ?? "http://localhost:8787").replace(/\/$/, ""),
    concurrencies,
    conflict: conflictRaw,
    repeat: Math.max(1, Number.parseInt(get("repeat") ?? "1", 10)),
    warmup: Math.max(0, Number.parseInt(get("warmup") ?? "1", 10)),
    project: get("project") ?? "bench-throughput",
    allowProd: get("i-understand-this-writes-real-commits") === "true",
    r2Bench: get("r2-bench") === "true",
    batch: get("batch") === "true",
    bytes: Math.max(1, Number.parseInt(get("bytes") ?? "256", 10)),
    durationMs: Math.max(200, Number.parseInt(get("duration") ?? "3000", 10)),
  };
}

/** Throws if the target is production and the operator hasn't opted in. */
export function assertSafeTarget(args: BenchArgs): void {
  if (isProductionHost(args.baseUrl) && !args.allowProd) {
    throw new Error(
      `Refusing to run against production host ${args.baseUrl}. ` +
        "This writes real commits. Re-run with --i-understand-this-writes-real-commits if intentional.",
    );
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1);
  return sorted[idx] ?? 0;
}

export interface RunStats {
  n: number;
  conflict: "none" | "same";
  landed: number;
  failed: number;
  wallMs: number;
  commitsPerSec: number;
  /** Per-op latency percentiles are only meaningful at low N (single-DO queue). */
  latency?: { p50: number; p95: number; p99: number };
}

export function summarizeRun(
  n: number,
  conflict: "none" | "same",
  endToEndMs: number[],
  failures: number,
  wallMs: number,
): RunStats {
  const landed = endToEndMs.length;
  const base: RunStats = {
    n,
    conflict,
    landed,
    failed: failures,
    wallMs,
    commitsPerSec: wallMs > 0 ? Math.round((landed / wallMs) * 1000 * 100) / 100 : 0,
  };
  // At N >= 25 the single DO serializes advances, so per-op latency is dominated
  // by queue wait, not work — report throughput only.
  if (n <= 5) {
    base.latency = {
      p50: percentile(endToEndMs, 50),
      p95: percentile(endToEndMs, 95),
      p99: percentile(endToEndMs, 99),
    };
  }
  return base;
}

export function formatReport(stats: RunStats[]): string {
  const lines: string[] = [];
  lines.push("Commit throughput (single repo)");
  lines.push("  N | mode | landed | failed | wall(ms) | commits/sec | p50/p95/p99(ms)");
  for (const s of stats) {
    const lat = s.latency
      ? `${s.latency.p50}/${s.latency.p95}/${s.latency.p99}`
      : "(suppressed: single-DO queue)";
    lines.push(
      `  ${s.n} | ${s.conflict} | ${s.landed} | ${s.failed} | ${s.wallMs} | ${s.commitsPerSec} | ${lat}`,
    );
  }
  return lines.join("\n");
}

// --- Live run (only when executed directly, not when imported by tests) ---

interface ProjectInfo {
  id: string;
  namespace: string;
  slug: string;
  name: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertSafeTarget(args);

  // Node's default fetch pool caps concurrent connections per origin, which would
  // serialize the merge burst at the CLIENT and hide the server's real throughput.
  // Raise it so N concurrent merges actually hit the server concurrently.
  try {
    const { Agent, setGlobalDispatcher } = (await import("undici")) as {
      Agent: new (o: { connections: number }) => unknown;
      setGlobalDispatcher: (d: unknown) => void;
    };
    setGlobalDispatcher(new Agent({ connections: 256 }));
  } catch {
    // undici not available — proceed with the default dispatcher.
  }

  // The R2 throughput probe authenticates with an admin key, not a user session.
  if (args.r2Bench) {
    await runR2Bench(args);
    return;
  }

  const session = process.env.STRATUM_SESSION;
  const token = process.env.STRATUM_TOKEN;
  if (!session && !token) {
    throw new Error("Set STRATUM_SESSION (stratum_session cookie) or STRATUM_TOKEN");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (session) headers.Cookie = `stratum_session=${session}`;

  const api = (path: string, init?: RequestInit) =>
    fetch(`${args.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    });

  const post = async (path: string, body: unknown): Promise<Response> =>
    api(path, { method: "POST", body: JSON.stringify(body) });

  console.log(`\nBenchmarking ${args.baseUrl} (conflict=${args.conflict})`);
  console.log("Throughput is the headline metric. Per-op latency is reported only at N<=5.");
  console.log("Server-side per-phase breakdown: GET /api/admin/metrics (commits block).");
  console.log(
    "Timing caveats: Workers freeze the clock between I/O — CPU spans are lower bounds.\n",
  );

  const me = await api("/api/users/me");
  if (!me.ok) throw new Error(`Auth check failed: ${me.status} — check STRATUM_SESSION/TOKEN`);

  if (args.batch) {
    await runBatchMerge(args, post);
    return;
  }

  // One disposable, uniquely-named project per run, seeded so clones have
  // representative history.
  const projectName = `${args.project}-${Math.random().toString(36).slice(2, 8)}`;
  const project = await createProject(post, projectName);
  console.log(`Target project: ${project.namespace}/${project.slug} (id=${project.id})`);
  // Let the seeded fork settle in Artifacts before forking workspaces off it.
  await new Promise((r) => setTimeout(r, 2000));
  console.log("");

  // Each measured batch needs FRESH changes (a merged change cannot re-merge), so
  // every batch builds N workspaces+changes, then fires N merges concurrently. A
  // warmup batch is discarded; `repeat` measured batches follow.
  const allStats: RunStats[] = [];
  for (const n of args.concurrencies) {
    for (let w = 0; w < args.warmup; w++) {
      await runBatch(post, project, n, args.conflict, /*nonce*/ `warm-${n}-${w}`);
    }
    let landed = 0;
    let failed = 0;
    let wallMs = 0;
    const latencies: number[] = [];
    for (let r = 0; r < args.repeat; r++) {
      const batch = await runBatch(post, project, n, args.conflict, `run-${n}-${r}`);
      landed += batch.latencies.length;
      failed += batch.failed;
      wallMs += batch.wallMs;
      latencies.push(...batch.latencies);
    }
    const stat = summarizeRun(n, args.conflict, latencies, failed, wallMs);
    allStats.push(stat);
    console.log(`  N=${n}: ${stat.commitsPerSec} commits/sec (${landed} landed, ${failed} failed)`);
  }

  console.log(`\n${formatReport(allStats)}`);

  // Let the off-ack-path metric writes settle, then surface the server breakdown.
  await new Promise((res) => setTimeout(res, 1500));
  const metrics = await api("/api/admin/metrics");
  if (metrics.ok) {
    const body = (await metrics.json()) as { commits?: unknown };
    console.log("\nServer-side commit metrics (/api/admin/metrics .commits):");
    console.log(JSON.stringify(body.commits ?? "unavailable (admin access / no rows)", null, 2));
  } else {
    console.log(`\n/api/admin/metrics returned ${metrics.status} (need admin access for breakdown)`);
  }
}

/**
 * Phase 2 throughput run: hammer the admin bench endpoint (R2 object write +
 * group-commit ref advance) concurrently and measure commits/sec. Uses an admin
 * key (STRATUM_ADMIN_KEY); object writes parallelize and the DO batches the ref
 * advances — this is the path that crosses the target.
 */
async function runR2Bench(args: BenchArgs): Promise<void> {
  const adminKey = process.env.STRATUM_ADMIN_KEY;
  if (!adminKey) throw new Error("Set STRATUM_ADMIN_KEY for --r2-bench");
  const headers = { "X-Admin-API-Key": adminKey };
  const repo = `r2bench-${Math.random().toString(36).slice(2, 8)}`;
  // conflict=same -> every writer hits one path (server-side conflict resolution
  // exercised); conflict=none -> distinct path per writer (no conflicts).
  const pathFor = (worker: number) =>
    args.conflict === "same" ? "shared.txt" : `f${worker}.txt`;

  console.log(
    `\n[R2 + real git objects + group-commit] repo=${repo}, conflict=${args.conflict}, bytes=${args.bytes}, ${args.durationMs}ms/level`,
  );
  const stats: RunStats[] = [];
  for (const n of args.concurrencies) {
    let completed = 0;
    let failed = 0;
    let stop = false;
    const start = Date.now();
    const workers = Array.from({ length: n }, async (_u, worker) => {
      const url = `${args.baseUrl}/api/admin/metrics/bench?repo=${repo}&bytes=${args.bytes}&path=${pathFor(worker)}`;
      while (!stop) {
        const res = await fetch(url, { method: "POST", headers });
        if (res.ok) completed += 1;
        else failed += 1;
      }
    });
    await new Promise((r) => setTimeout(r, args.durationMs));
    stop = true;
    const counted = completed;
    const elapsedMs = Date.now() - start;
    await Promise.all(workers);
    const stat = summarizeRun(n, args.conflict, [], failed, elapsedMs);
    stat.landed = counted;
    stat.latency = undefined; // per-op latency not measured in the R2 throughput probe
    stat.commitsPerSec = elapsedMs > 0 ? Math.round((counted / elapsedMs) * 1000 * 100) / 100 : 0;
    stats.push(stat);
    console.log(`  N=${n}: ${stat.commitsPerSec} commits/sec (${counted} landed, ${failed} failed)`);
  }
  console.log(`\n${formatReport(stats)}`);

  const statsRes = await fetch(`${args.baseUrl}/api/admin/metrics/bench-stats?repo=${repo}`, {
    headers,
  });
  if (statsRes.ok) {
    console.log("\nServer bench stats (real git objects):");
    console.log(JSON.stringify(await statsRes.json(), null, 2));
  }
}

/**
 * Server-side batch merge (ADR 004): set up N changes (each staged to R2 at
 * commit), then merge ALL of them in ONE request via /changes/merge-batch — the
 * path that realizes the group-commit throughput despite per-request DO RPC
 * serialization.
 */
async function runBatchMerge(
  args: BenchArgs,
  post: (p: string, b: unknown) => Promise<Response>,
): Promise<void> {
  const projectName = `${args.project}-${Math.random().toString(36).slice(2, 8)}`;
  // Unseeded: minimal base tree, so the merge cost reflects the CHANGE, not the
  // whole seeded repo (merge cost scales with tree size).
  const project = await createProject(post, projectName, false);
  console.log(`Target project: ${project.namespace}/${project.slug} (unseeded)`);
  await new Promise((r) => setTimeout(r, 2000));

  console.log(`\n[batch-merge] conflict=${args.conflict}`);
  for (const n of args.concurrencies) {
    const changeIds = await Promise.all(
      Array.from({ length: n }, (_u, i) =>
        retry(async () => {
          const wsName = `w${Math.random().toString(36).slice(2, 10)}${i}`;
          const ws = await post(`/api/workspaces/${project.namespace}/${project.slug}/workspaces`, {
            name: wsName,
          });
          if (!ws.ok) throw new Error(`workspace ${ws.status} ${await ws.text()}`);
          const { workspace } = (await ws.json()) as { workspace: string };
          const path = args.conflict === "same" ? "shared.txt" : `f${i}.txt`;
          const commit = await post(`/api/workspaces/${workspace}/commit`, {
            projectId: project.id,
            message: `c${i}`,
            files: { [path]: `worker ${i}\n` },
          });
          if (!commit.ok) throw new Error(`commit ${commit.status} ${await commit.text()}`);
          const change = await post(`/api/projects/${project.name}/changes`, { workspace });
          if (!change.ok) throw new Error(`change ${change.status} ${await change.text()}`);
          const created = (await change.json()) as { id?: string; change?: { id: string } };
          const id = created.change?.id ?? created.id;
          if (!id) throw new Error("no change id");
          return id;
        }),
      ),
    );

    const t0 = Date.now();
    const res = await post(`/api/projects/${project.name}/changes/merge-batch`, { changeIds });
    const ms = Date.now() - t0;
    const bodyJson = (res.ok ? await res.json() : { error: await res.text() }) as {
      merged?: string[];
      conflicted?: string[];
      error?: string;
      timings?: { resolveMs: number; batchMs: number; persistMs: number; serverMs: number };
    };
    const merged = bodyJson.merged?.length ?? 0;
    const cps = ms > 0 ? Math.round((merged / (ms / 1000)) * 100) / 100 : 0;
    const t = bodyJson.timings;
    // Server-side throughput excludes client<->edge RTT (the basis the r2flow probe used).
    const serverCps =
      t && t.serverMs > 0 ? Math.round((merged / (t.serverMs / 1000)) * 100) / 100 : 0;
    const phases = t
      ? ` [server=${t.serverMs}ms → ${serverCps} c/s | resolve=${t.resolveMs} batch=${t.batchMs} persist=${t.persistMs}]`
      : "";
    console.log(
      `  N=${n}: ${cps} c/s wall (${merged} merged, ${bodyJson.conflicted?.length ?? 0} conflicted, ${ms}ms)${phases}${bodyJson.error ? ` ERROR: ${bodyJson.error}` : ""}`,
    );
  }
}

async function createProject(
  post: (p: string, b: unknown) => Promise<Response>,
  name: string,
  seed = true,
): Promise<ProjectInfo> {
  const res = await post("/api/projects", { name, visibility: "private", seed });
  if (!res.ok) {
    throw new Error(`Failed to create project '${name}': ${res.status} ${await res.text()}`);
  }
  const p = (await res.json()) as ProjectInfo;
  return { ...p, name };
}

interface BatchResult {
  latencies: number[];
  failed: number;
  wallMs: number;
}

/** Retry transient failures (e.g. Artifacts 500s during setup) with backoff. */
async function retry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw last;
}

async function runBatch(
  post: (p: string, b: unknown) => Promise<Response>,
  project: ProjectInfo,
  n: number,
  conflict: "none" | "same",
  nonce: string,
): Promise<BatchResult> {
  // Setup (not measured): N workspaces, each with one committed file, each yielding
  // a change. conflict=none -> distinct file per worker; conflict=same -> shared file.
  const changeIds = await Promise.all(
    Array.from({ length: n }, (_unused, i) =>
      retry(async () => {
        // Workspace names become Artifacts fork repo names — keep them alphanumeric
        // and globally unique (dashed/multi-segment names are rejected with a 500).
        const wsName = `w${Math.random().toString(36).slice(2, 10)}${i}`;
        const ws = await post(`/api/workspaces/${project.namespace}/${project.slug}/workspaces`, {
          name: wsName,
        });
        if (!ws.ok) throw new Error(`workspace create failed: ${ws.status} ${await ws.text()}`);
        const { workspace } = (await ws.json()) as { workspace: string };

        const path = conflict === "same" ? "bench/shared.txt" : `bench/worker-${i}.txt`;
        const commit = await post(`/api/workspaces/${workspace}/commit`, {
          projectId: project.id,
          message: `bench ${nonce} worker ${i}`,
          files: { [path]: `worker ${i} @ ${nonce}\n` },
        });
        if (!commit.ok) throw new Error(`commit failed: ${commit.status} ${await commit.text()}`);

        const change = await post(`/api/projects/${project.name}/changes`, { workspace });
        if (!change.ok)
          throw new Error(`change create failed: ${change.status} ${await change.text()}`);
        // The create response nests the change: { change: { id, ... }, eval, evalRuns }.
        const created = (await change.json()) as { id?: string; change?: { id: string } };
        const changeId = created.change?.id ?? created.id;
        if (!changeId) throw new Error("change create returned no id");
        return changeId;
      }),
    ),
  );

  // Measured: fire N merges concurrently (force bypasses eval/approval + protection
  // so we measure raw merge mechanics, not the policy gate).
  const wallStart = Date.now();
  const results = await Promise.all(
    changeIds.map(async (id) => {
      const t0 = Date.now();
      const res = await post(`/api/changes/${id}/merge?force=true`, {});
      return { ok: res.ok, ms: Date.now() - t0, status: res.status };
    }),
  );
  const wallMs = Date.now() - wallStart;

  const latencies = results.filter((r) => r.ok).map((r) => r.ms);
  const failed = results.filter((r) => !r.ok).length;
  return { latencies, failed, wallMs };
}

const invokedDirectly =
  typeof process !== "undefined" && /bench-commit-throughput\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("\n❌", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
