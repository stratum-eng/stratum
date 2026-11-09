import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sign, verify } from "../src/signature";
import { SECRET } from "./helpers/fixtures";

const BODY = '{"event":"checks.requested","changeId":"chg_1"}';

describe("signature verification", () => {
  it("produces the same signature as an independent HMAC-SHA256", async () => {
    const expected = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(await sign(SECRET, BODY)).toBe(`sha256=${expected}`);
  });

  it("accepts a body signed with the shared secret", async () => {
    expect(await verify(SECRET, BODY, await sign(SECRET, BODY))).toBe(true);
  });

  it("refuses a body that changed by one byte", async () => {
    expect(await verify(SECRET, `${BODY} `, await sign(SECRET, BODY))).toBe(false);
  });

  it("refuses a signature made with another secret", async () => {
    expect(await verify(SECRET, BODY, await sign(`${SECRET}x`, BODY))).toBe(false);
  });

  it("refuses a signature that differs in its last character only", async () => {
    const good = await sign(SECRET, BODY);
    const last = good.at(-1) === "0" ? "1" : "0";
    expect(await verify(SECRET, BODY, `${good.slice(0, -1)}${last}`)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["no scheme", "a".repeat(64)],
    ["wrong scheme", `sha1=${"a".repeat(64)}`],
    ["too short", "sha256=abcd"],
    ["too long", `sha256=${"a".repeat(66)}`],
    ["not hex", `sha256=${"z".repeat(64)}`],
    ["uppercase hex", `sha256=${"A".repeat(64)}`],
  ])("refuses a %s header without throwing", async (_name, header) => {
    expect(await verify(SECRET, BODY, header)).toBe(false);
  });

  it("refuses everything when no secret is configured", async () => {
    // An empty key is still a key: HMAC with it is computable by anyone.
    expect(await verify("", BODY, await sign("x", BODY))).toBe(false);
    const forged = `sha256=${createHmac("sha256", "").update(BODY).digest("hex")}`;
    expect(await verify("", BODY, forged)).toBe(false);
  });
});
