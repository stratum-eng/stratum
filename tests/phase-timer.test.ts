import { describe, expect, it } from "vitest";
import { PhaseTimer } from "../src/utils/phase-timer";

describe("PhaseTimer", () => {
  it("records a span around a measured async phase", async () => {
    const timer = new PhaseTimer();
    await timer.measure("push", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(timer.get("push")).toBeGreaterThanOrEqual(0);
    expect(timer.toObject()).toHaveProperty("push");
  });

  it("accumulates repeated measures of the same span", async () => {
    const timer = new PhaseTimer();
    timer.add("net", 10);
    timer.add("net", 15);
    expect(timer.get("net")).toBe(25);
  });

  it("records the span even when the measured fn throws", async () => {
    const timer = new PhaseTimer();
    await expect(
      timer.measure("clone", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(timer.toObject()).toHaveProperty("clone");
  });

  it("returns undefined for an unmeasured span and an empty object initially", () => {
    const timer = new PhaseTimer();
    expect(timer.get("missing")).toBeUndefined();
    expect(timer.toObject()).toEqual({});
  });
});
