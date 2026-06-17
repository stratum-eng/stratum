/**
 * Accumulates named wall-clock spans for the commit/merge hot path (ADR 004,
 * Phase 0 instrumentation).
 *
 * IMPORTANT measurement caveats — do not over-read the numbers:
 *  - Cloudflare Workers freeze `Date.now()` between I/O for timing-attack
 *    mitigation: the clock advances only across `await`s that perform I/O. A
 *    pure-CPU span (e.g. an in-memory three-way merge) may therefore read ~0 ms,
 *    and the cost can surface in an adjacent I/O-bound span instead.
 *  - The custom git HTTP client buffers the full request body before `fetch()`
 *    and streams the response lazily, so push/fetch CPU can interleave with
 *    later isomorphic-git pack processing.
 * Consequently spans are independent diagnostics and MUST NOT be summed into a
 * synthetic total — record an end-to-end `total_ms` separately. Network-bound
 * spans (clone/fetch/push) are the trustworthy signal for "where do the seconds
 * go"; treat CPU-span values as lower bounds.
 */
export class PhaseTimer {
  private readonly spans = new Map<string, number>();

  /** Time an async phase, accumulating into the named span (summed if repeated). */
  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.add(name, Date.now() - start);
    }
  }

  /** Manually add milliseconds to a span (e.g. an isolated network leg). */
  add(name: string, ms: number): void {
    this.spans.set(name, (this.spans.get(name) ?? 0) + ms);
  }

  get(name: string): number | undefined {
    return this.spans.get(name);
  }

  toObject(): Record<string, number> {
    return Object.fromEntries(this.spans);
  }
}
