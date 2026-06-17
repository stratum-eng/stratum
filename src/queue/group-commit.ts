/**
 * Group-commit batch coordinator (ADR 004, the throughput mechanism).
 *
 * The single-repo throughput ceiling is set by the *serialized* ref advance and
 * its durable write — object writes are content-addressed and parallelize freely,
 * so they never gate. Group commit (the database WAL technique) amortizes that
 * one serialized durable write across every ref advance that arrives while it is
 * in flight: drain N queued advances, fold them into ONE batched durable write,
 * then resolve each. Throughput becomes batchSize / durableWriteLatency instead
 * of 1 / durableWriteLatency.
 *
 * `durableWrite` returns a **per-item outcome** (same order + length as the
 * batch), so one item failing/conflicting does NOT fail the rest of the batch —
 * the real merge flow needs "one conflict, the others still land." A thrown
 * `durableWrite` (catastrophic, e.g. the push failed) rejects the whole batch.
 *
 * Decoupled from Cloudflare: `durableWrite` is injected (RepoDO supplies the real
 * merge+push; tests/benchmarks inject a model).
 */

export type ItemOutcome<R> = { ok: true; value: R } | { ok: false; error: unknown };

export interface GroupCommitStats {
  batches: number;
  items: number;
  maxBatchSize: number;
  avgBatchSize: number;
}

export interface GroupCommitOptions<T, R> {
  /** Upper bound on how many advances fold into one durable write. */
  maxBatchSize: number;
  /**
   * Accumulation window (ms) before draining a batch — the WAL `commit_delay`.
   * When submits arrive staggered (e.g. each request does its own reads before
   * submitting), waiting briefly lets them coalesce into one batch instead of
   * draining one-at-a-time. 0/undefined = drain on the next microtask.
   */
  batchWindowMs?: number;
  /**
   * Durably persist one drained batch and return one outcome per item, in the
   * same order. Throwing rejects the entire batch (use for catastrophic failures
   * like a failed push); a per-item `{ ok: false }` rejects only that item.
   */
  durableWrite: (batch: T[]) => Promise<ItemOutcome<R>[]>;
}

interface Pending<T, R> {
  item: T;
  resolve: (value: R) => void;
  reject: (err: unknown) => void;
}

export class GroupCommitCoordinator<T, R = void> {
  private readonly queue: Pending<T, R>[] = [];
  private draining = false;
  private batches = 0;
  private items = 0;
  private maxBatch = 0;

  constructor(private readonly opts: GroupCommitOptions<T, R>) {
    if (!Number.isInteger(opts.maxBatchSize) || opts.maxBatchSize < 1) {
      throw new Error("GroupCommitCoordinator.maxBatchSize must be an integer >= 1");
    }
  }

  /** Submit one advance; resolves with its per-item value (or rejects per-item). */
  submit(item: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      if (!this.draining) void this.drainLoop();
    });
  }

  private async drainLoop(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        // Wait the accumulation window (or one microtask) so a burst of
        // staggered submits coalesces into this batch instead of draining alone.
        const window = this.opts.batchWindowMs ?? 0;
        if (window > 0) await new Promise((r) => setTimeout(r, window));
        else await Promise.resolve();
        const batch = this.queue.splice(0, this.opts.maxBatchSize);
        this.batches += 1;
        this.items += batch.length;
        if (batch.length > this.maxBatch) this.maxBatch = batch.length;
        try {
          const outcomes = await this.opts.durableWrite(batch.map((b) => b.item));
          if (outcomes.length !== batch.length) {
            throw new Error(
              `durableWrite returned ${outcomes.length} outcomes for ${batch.length} items`,
            );
          }
          batch.forEach((b, i) => {
            const outcome = outcomes[i];
            if (outcome?.ok) b.resolve(outcome.value);
            else b.reject(outcome?.error ?? new Error("missing outcome"));
          });
        } catch (err) {
          for (const b of batch) b.reject(err);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  get stats(): GroupCommitStats {
    return {
      batches: this.batches,
      items: this.items,
      maxBatchSize: this.maxBatch,
      avgBatchSize: this.batches > 0 ? this.items / this.batches : 0,
    };
  }
}
