import { describe, expect, it } from "vitest";
import { GroupCommitCoordinator, type ItemOutcome } from "../src/queue/group-commit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const allOk = <T>(batch: T[]): ItemOutcome<void>[] =>
  batch.map(() => ({ ok: true, value: undefined }));

describe("GroupCommitCoordinator correctness", () => {
  it("resolves a single submission after its durable write", async () => {
    const writes: number[] = [];
    const coord = new GroupCommitCoordinator<string>({
      maxBatchSize: 16,
      durableWrite: async (batch) => {
        writes.push(batch.length);
        return allOk(batch);
      },
    });
    await coord.submit("a");
    expect(writes).toEqual([1]);
  });

  it("folds a burst of concurrent advances into far fewer durable writes", async () => {
    const batchSizes: number[] = [];
    const coord = new GroupCommitCoordinator<number>({
      maxBatchSize: 64,
      durableWrite: async (batch) => {
        batchSizes.push(batch.length);
        await sleep(20); // hold the window open so concurrent submits coalesce
        return allOk(batch);
      },
    });
    await Promise.all(Array.from({ length: 50 }, (_u, i) => coord.submit(i)));
    expect(coord.stats.items).toBe(50);
    expect(batchSizes.length).toBeLessThan(50);
    expect(coord.stats.avgBatchSize).toBeGreaterThan(1);
  });

  it("rejects only the conflicting item; others in the batch still resolve", async () => {
    const coord = new GroupCommitCoordinator<string>({
      maxBatchSize: 64,
      durableWrite: async (batch) => {
        await sleep(10);
        // Item "bad" conflicts; everyone else lands.
        return batch.map((item) =>
          item === "bad"
            ? { ok: false as const, error: new Error("conflict") }
            : { ok: true as const, value: undefined },
        );
      },
    });
    const results = await Promise.allSettled([
      coord.submit("a"),
      coord.submit("bad"),
      coord.submit("b"),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]?.status).toBe("fulfilled");
  });

  it("rejects the whole batch when durableWrite throws (catastrophic, e.g. push failed)", async () => {
    let first = true;
    const coord = new GroupCommitCoordinator<string>({
      maxBatchSize: 1,
      durableWrite: async (batch) => {
        if (first) {
          first = false;
          throw new Error("push failed");
        }
        return allOk(batch);
      },
    });
    await expect(coord.submit("x")).rejects.toThrow("push failed");
    await expect(coord.submit("y")).resolves.toBeUndefined();
  });

  it("rejects the batch if durableWrite returns a wrong-length outcome list", async () => {
    const coord = new GroupCommitCoordinator<string>({
      maxBatchSize: 64,
      durableWrite: async () => [], // contract violation
    });
    await expect(coord.submit("x")).rejects.toThrow(/outcomes/);
  });
});

describe("GroupCommitCoordinator throughput (local model of the ref plane)", () => {
  const DURABLE_WRITE_MS = 50;
  const TARGET_CPS = 22.6;

  async function measure(maxBatchSize: number, concurrency: number, durationMs: number) {
    const coord = new GroupCommitCoordinator<number>({
      maxBatchSize,
      durableWrite: async (batch) => {
        await sleep(DURABLE_WRITE_MS);
        return allOk(batch);
      },
    });
    let completed = 0;
    let stop = false;
    const start = Date.now();
    const submitters = Array.from({ length: concurrency }, async () => {
      while (!stop) {
        await coord.submit(completed);
        completed += 1;
      }
    });
    await sleep(durationMs);
    stop = true;
    const counted = completed;
    const elapsedMs = Date.now() - start;
    await Promise.all(submitters);
    return { commitsPerSec: counted / (elapsedMs / 1000), stats: coord.stats };
  }

  it("group commit sustains >> 22.6 commits/sec into one repo; serial does not", async () => {
    const grouped = await measure(64, 24, 500);
    const serial = await measure(1, 24, 500);

    console.log(
      `\n[group-commit benchmark] durableWrite=${DURABLE_WRITE_MS}ms, 24 concurrent writers, single repo:`,
    );
    console.log(
      `  group-commit (batch<=64): ${grouped.commitsPerSec.toFixed(1)} commits/sec ` +
        `(avg batch ${grouped.stats.avgBatchSize.toFixed(1)}, max ${grouped.stats.maxBatchSize})`,
    );
    console.log(
      `  serial      (batch=1):    ${serial.commitsPerSec.toFixed(1)} commits/sec ` +
        `(avg batch ${serial.stats.avgBatchSize.toFixed(1)})`,
    );
    console.log(`  target: ${TARGET_CPS} commits/sec\n`);

    expect(grouped.commitsPerSec).toBeGreaterThan(TARGET_CPS);
    expect(grouped.commitsPerSec).toBeGreaterThan(serial.commitsPerSec * 5);
    expect(grouped.stats.avgBatchSize).toBeGreaterThan(1);
  }, 15000);
});
