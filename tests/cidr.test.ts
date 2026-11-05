import { describe, expect, it } from "vitest";
import {
  compileIpAllowlist,
  ipAllowedByList,
  validateIpAllowlistInput,
} from "../src/services/org-ip-allowlist";
import { parseStoredIpAllowlist } from "../src/storage/orgs";
import { formatCidr, ipInRanges, parseCidr, parseIp } from "../src/utils/cidr";

function ranges(...entries: string[]) {
  return compileIpAllowlist(entries);
}

describe("parseIp", () => {
  it.each([
    "0.0.0.0",
    "255.255.255.255",
    "203.0.113.7",
    "::",
    "::1",
    "2001:db8::",
    "2001:DB8:0:0:0:0:0:1",
    "::ffff:192.0.2.1",
    "64:ff9b::192.0.2.33",
  ])("accepts %s", (text) => {
    expect(parseIp(text)).not.toBeNull();
  });

  it.each([
    "",
    "256.0.0.1",
    "1.2.3",
    "1.2.3.4.5",
    "01.2.3.4",
    "1.2.3.-4",
    "0x7f.0.0.1",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    ":::",
    "12345::",
    "fe80::1%eth0",
    "[::1]",
    "1.2.3.4::",
    "g::1",
  ])("rejects %s", (text) => {
    expect(parseIp(text)).toBeNull();
  });
});

describe("parseCidr / formatCidr", () => {
  it.each([
    ["10.1.2.3/8", "10.0.0.0/8"],
    ["203.0.113.7", "203.0.113.7/32"],
    ["0.0.0.0/0", "0.0.0.0/0"],
    ["2001:db8:abcd::1/32", "2001:db8::/32"],
    ["::1", "::1/128"],
    ["2001:0db8:0000:0000:0001:0000:0000:0001/128", "2001:db8::1:0:0:1/128"],
    ["fe80::/10", "fe80::/10"],
    ["::/0", "::/0"],
    ["1:0:0:2:0:0:0:3/128", "1:0:0:2::3/128"],
  ])("canonicalises %s as %s", (input, expected) => {
    const parsed = parseCidr(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(formatCidr(parsed.data)).toBe(expected);
  });

  it.each(["10.0.0.0/33", "::/129", "10.0.0.0/", "10.0.0.0/01", "10.0.0.0/-1", "x/8"])(
    "rejects %s",
    (input) => {
      expect(parseCidr(input).success).toBe(false);
    },
  );
});

describe("matching", () => {
  it("handles IPv4 prefixes, including the edges", () => {
    expect(ipInRanges("203.0.113.255", ranges("203.0.113.0/24"))).toBe(true);
    expect(ipInRanges("203.0.114.0", ranges("203.0.113.0/24"))).toBe(false);
    expect(ipInRanges("10.20.30.40", ranges("0.0.0.0/0"))).toBe(true);
    expect(ipInRanges("203.0.113.7", ranges("203.0.113.7/32"))).toBe(true);
    expect(ipInRanges("203.0.113.8", ranges("203.0.113.7/32"))).toBe(false);
    // A non-octet-aligned prefix.
    expect(ipInRanges("172.31.255.255", ranges("172.16.0.0/12"))).toBe(true);
    expect(ipInRanges("172.32.0.0", ranges("172.16.0.0/12"))).toBe(false);
  });

  it("handles IPv6 prefixes, including the edges", () => {
    expect(ipInRanges("2001:db8:ffff::1", ranges("2001:db8::/32"))).toBe(true);
    expect(ipInRanges("2001:db9::1", ranges("2001:db8::/32"))).toBe(false);
    expect(ipInRanges("2606:4700::1", ranges("::/0"))).toBe(true);
    expect(ipInRanges("2001:db8::1", ranges("2001:db8::1/128"))).toBe(true);
    expect(ipInRanges("2001:db8::2", ranges("2001:db8::1/128"))).toBe(false);
    expect(ipInRanges("febf::1", ranges("fe80::/10"))).toBe(true);
    expect(ipInRanges("fec0::1", ranges("fe80::/10"))).toBe(false);
  });

  it("never cross-matches families, except an IPv4-mapped address", () => {
    expect(ipInRanges("10.0.0.1", ranges("::/0"))).toBe(false);
    expect(ipInRanges("2001:db8::1", ranges("0.0.0.0/0"))).toBe(false);
    expect(ipInRanges("::ffff:203.0.113.7", ranges("203.0.113.0/24"))).toBe(true);
  });

  it("matches nothing for an unparseable or empty address", () => {
    expect(ipInRanges("", ranges("0.0.0.0/0", "::/0"))).toBe(false);
    expect(ipInRanges("not-an-ip", ranges("0.0.0.0/0"))).toBe(false);
  });
});

describe("ipAllowedByList", () => {
  it("lets everyone through an empty list", () => {
    expect(ipAllowedByList([], "")).toBe(true);
    expect(ipAllowedByList([], "198.51.100.1")).toBe(true);
  });

  it("fails closed on a restricted list with no client address", () => {
    expect(ipAllowedByList(["0.0.0.0/0"], "")).toBe(false);
  });

  it("caches compiled ranges by list", () => {
    const cache = new Map();
    expect(ipAllowedByList(["10.0.0.0/8"], "10.1.1.1", cache)).toBe(true);
    expect(ipAllowedByList(["10.0.0.0/8"], "11.1.1.1", cache)).toBe(false);
    expect(cache.size).toBe(1);
  });

  it("fails closed on a corrupt stored list", () => {
    const stored = parseStoredIpAllowlist("{not json");
    expect(stored.length).toBe(1);
    expect(ipAllowedByList(stored, "10.0.0.1")).toBe(false);
    expect(parseStoredIpAllowlist(null)).toEqual([]);
    expect(parseStoredIpAllowlist('["10.0.0.0/8"]')).toEqual(["10.0.0.0/8"]);
    expect(parseStoredIpAllowlist('"10.0.0.0/8"')).toHaveLength(1);
  });
});

describe("validateIpAllowlistInput", () => {
  it("canonicalises and de-duplicates in order", () => {
    const result = validateIpAllowlistInput(["10.1.0.0/8", "2001:DB8::/32", "10.0.0.0/8"]);
    expect(result).toEqual({ success: true, data: ["10.0.0.0/8", "2001:db8::/32"] });
  });

  it("rejects non-arrays, non-strings and oversized lists", () => {
    expect(validateIpAllowlistInput("10.0.0.0/8").success).toBe(false);
    expect(validateIpAllowlistInput([null]).success).toBe(false);
    expect(validateIpAllowlistInput(["x".repeat(65)]).success).toBe(false);
    expect(validateIpAllowlistInput(Array.from({ length: 101 }, () => "10.0.0.0/8")).success).toBe(
      false,
    );
  });
});
