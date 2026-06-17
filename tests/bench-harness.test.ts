import { describe, expect, it } from "vitest";
import {
  assertSafeTarget,
  formatReport,
  isProductionHost,
  parseArgs,
  percentile,
  summarizeRun,
} from "../scripts/bench-commit-throughput";

describe("parseArgs", () => {
  it("parses concurrency list, conflict mode, and repeat", () => {
    const args = parseArgs(["--n=1,5,25", "--conflict=same", "--repeat=3", "--url=http://x:8787"]);
    expect(args.concurrencies).toEqual([1, 5, 25]);
    expect(args.conflict).toBe("same");
    expect(args.repeat).toBe(3);
    expect(args.baseUrl).toBe("http://x:8787");
  });

  it("defaults to localhost and conflict=none", () => {
    const args = parseArgs([]);
    expect(args.conflict).toBe("none");
    expect(args.allowProd).toBe(false);
    expect(args.concurrencies).toEqual([1, 5, 25, 100]);
  });

  it("rejects an invalid conflict mode", () => {
    expect(() => parseArgs(["--conflict=weird"])).toThrow();
  });
});

describe("isProductionHost / assertSafeTarget", () => {
  it("flags production hosts", () => {
    expect(isProductionHost("https://app.usestratum.dev")).toBe(true);
    expect(isProductionHost("https://usestratum.dev")).toBe(true);
  });

  it("does not flag localhost or staging preview hosts", () => {
    expect(isProductionHost("http://localhost:8787")).toBe(false);
    expect(isProductionHost("https://pr-45.staging.app.workers.dev")).toBe(false);
  });

  it("refuses production without the opt-in flag", () => {
    const args = parseArgs(["--url=https://app.usestratum.dev"]);
    expect(() => assertSafeTarget(args)).toThrow(/production/i);
  });

  it("allows production with the opt-in flag", () => {
    const args = parseArgs([
      "--url=https://app.usestratum.dev",
      "--i-understand-this-writes-real-commits",
    ]);
    expect(() => assertSafeTarget(args)).not.toThrow();
  });
});

describe("summarizeRun / percentile / formatReport", () => {
  it("computes commits/sec and suppresses percentiles at high N", () => {
    const lowN = summarizeRun(5, "none", [10, 20, 30, 40, 50], 0, 1000);
    expect(lowN.commitsPerSec).toBe(5);
    expect(lowN.latency).toBeDefined();

    const highN = summarizeRun(25, "same", new Array(25).fill(100), 0, 1000);
    expect(highN.latency).toBeUndefined();
    expect(highN.commitsPerSec).toBe(25);
  });

  it("nearest-rank percentile", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBe(0);
  });

  it("formats a report including the suppression note at high N", () => {
    const report = formatReport([summarizeRun(25, "same", new Array(25).fill(100), 1, 1000)]);
    expect(report).toContain("suppressed");
    expect(report).toContain("commits/sec");
  });
});
