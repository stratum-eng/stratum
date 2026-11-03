import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StratumApi } from "../src/stratum.js";

const fetchMock = vi.fn();

describe("StratumApi.waitForEvaluation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls the change until it leaves evaluating", async () => {
    const statuses = ["evaluating", "needs_changes"];
    fetchMock.mockImplementation(async () =>
      Response.json({
        change: { id: "chg_1", status: statuses.shift(), evalPassed: false, evalScore: 0.2 },
      }),
    );
    const api = new StratumApi("https://stratum.example.com/", "tok");
    const sleep = vi.fn(async () => undefined);

    const change = await api.waitForEvaluation("chg_1", { sleep });

    expect(change.status).toBe("needs_changes");
    expect(change.evalPassed).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://stratum.example.com/api/changes/chg_1");
  });

  it("throws rather than reporting a verdict when the deadline passes", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ change: { id: "chg_1", status: "evaluating" } }),
    );
    const api = new StratumApi("https://stratum.example.com", "tok");
    let clock = 0;

    await expect(
      api.waitForEvaluation("chg_1", {
        timeoutMs: 6,
        intervalMs: 3,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/still evaluating/);
  });
});
