import { describe, expect, it, vi } from "vitest";
import type { DeployQueueMessage } from "../src/deploy/runner";
import type { Env } from "../src/types";

/**
 * `Env.DEPLOY_QUEUE` is parameterized with {@link DeployQueueMessage} rather than
 * left as a bare `Queue`, so a malformed send is a compile error instead of a
 * message the consumer discards at runtime.
 *
 * The `@ts-expect-error` lines below are the actual assertions: `tsc --noEmit`
 * fails if the code beneath one turns out to be *valid*, so widening the binding
 * back to `Queue<unknown>` breaks the typecheck gate, not just this suite.
 */
type DeployQueue = NonNullable<Env["DEPLOY_QUEUE"]>;

function fakeQueue(): { queue: DeployQueue; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => {});
  return { queue: { send, sendBatch: vi.fn(async () => {}) } as unknown as DeployQueue, send };
}

describe("DEPLOY_QUEUE binding typing", () => {
  it("accepts a well-formed merge message", async () => {
    const { queue, send } = fakeQueue();
    const message: DeployQueueMessage = {
      kind: "merge",
      projectId: "prj_1",
      changeId: "chg_1",
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      mergedAt: "2026-09-01T10:00:00.000Z",
    };

    await queue.send(message);

    expect(send).toHaveBeenCalledWith(message);
  });

  it("accepts a well-formed deployment message", async () => {
    const { queue, send } = fakeQueue();

    await queue.send({ kind: "deployment", projectId: "prj_1", deploymentId: "dep_1" });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown kind at compile time", async () => {
    const { queue, send } = fakeQueue();

    // @ts-expect-error - "deploy" is not one of the DeployQueueMessage kinds
    await queue.send({ kind: "deploy", projectId: "prj_1", deploymentId: "dep_1" });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a merge message missing its pinned commit at compile time", async () => {
    const { queue, send } = fakeQueue();

    // @ts-expect-error - a merge message must carry the commitSha it pins
    await queue.send({ kind: "merge", projectId: "prj_1", changeId: "chg_1" });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a deployment message missing its tenant scope at compile time", async () => {
    const { queue, send } = fakeQueue();

    // @ts-expect-error - projectId is the only tenant scope the runner accepts
    await queue.send({ kind: "deployment", deploymentId: "dep_1" });

    expect(send).toHaveBeenCalledTimes(1);
  });
});
