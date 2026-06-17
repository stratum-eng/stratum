import { describe, expect, it } from "vitest";
import { putObject } from "../src/storage/object-store";
import type { Logger } from "../src/utils/logger";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as unknown as Logger;

describe("putObject", () => {
  it("writes under objects/<oid> and returns ok", async () => {
    const writes: string[] = [];
    const bucket = {
      put: async (key: string) => {
        writes.push(key);
      },
    } as unknown as R2Bucket;
    const res = await putObject(bucket, "abc123", new Uint8Array([1]), noopLogger);
    expect(res.success).toBe(true);
    expect(writes).toEqual(["objects/abc123"]);
  });

  it("returns an err Result when R2 put throws", async () => {
    const bucket = {
      put: async () => {
        throw new Error("R2 down");
      },
    } as unknown as R2Bucket;
    const res = await putObject(bucket, "abc", new Uint8Array([1]), noopLogger);
    expect(res.success).toBe(false);
  });
});
