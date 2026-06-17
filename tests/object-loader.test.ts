import { describe, expect, it } from "vitest";
import { packObjects, unpackObjects } from "../src/storage/object-loader";

describe("object pack framing", () => {
  it("round-trips packed objects", () => {
    const objs = [
      { oid: "a".repeat(40), bytes: new Uint8Array([1, 2, 3]) },
      { oid: "b".repeat(40), bytes: new Uint8Array([]) },
      { oid: "c".repeat(40), bytes: new Uint8Array([9, 8, 7, 6, 5]) },
    ];
    const out = unpackObjects(packObjects(objs));
    expect(out.map((o) => o.oid)).toEqual(objs.map((o) => o.oid));
    expect([...(out[0]?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect([...(out[2]?.bytes ?? [])]).toEqual([9, 8, 7, 6, 5]);
  });

  it("fails loudly on a truncated pack instead of reading out of bounds", () => {
    const packed = packObjects([{ oid: "a".repeat(40), bytes: new Uint8Array([1, 2, 3]) }]);
    expect(() => unpackObjects(packed.subarray(0, packed.length - 2))).toThrow(/truncated/i);
    expect(() => unpackObjects(new Uint8Array(2))).toThrow(/count header/i);
  });
});
