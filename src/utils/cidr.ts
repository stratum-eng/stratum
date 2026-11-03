import { type Result, err, ok } from "./result";

/**
 * IPv4/IPv6 address and CIDR parsing for the org IP allowlist (#399).
 *
 * Hand-rolled rather than a dependency: the surface is small, the rules are
 * fixed by RFC 4291/4632, and a parser that accepts something odd (a zone id,
 * an octal octet, a leading-zero quirk) is exactly how an allowlist ends up
 * matching an address nobody listed. So this is strict: dotted-quad IPv4 with
 * decimal octets, and IPv6 in the usual hex-group form with at most one `::`
 * and an optional trailing dotted-quad. Anything else is refused.
 */

/** An address as its raw bytes: 4 for IPv4, 16 for IPv6. */
export interface IpAddress {
  version: 4 | 6;
  bytes: Uint8Array;
}

/** A network: its address with the host bits cleared, and the prefix length. */
export interface Cidr {
  version: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
}

const IPV4_OCTET = /^(0|[1-9][0-9]{0,2})$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i] ?? "";
    if (!IPV4_OCTET.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6Groups(text: string): number[] | null {
  if (text === "") return [];
  const groups: number[] = [];
  const parts = text.split(":");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    // A trailing dotted quad stands for the last two groups (::ffff:1.2.3.4).
    if (i === parts.length - 1 && part.includes(".")) {
      const v4 = parseIpv4(part);
      if (!v4) return null;
      groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      continue;
    }
    if (!IPV6_GROUP.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseIpv6(text: string): Uint8Array | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  let groups: number[];
  if (halves.length === 2) {
    const head = parseIpv6Groups(halves[0] ?? "");
    const tail = parseIpv6Groups(halves[1] ?? "");
    if (!head || !tail) return null;
    // An embedded IPv4 is only valid at the very end.
    if ((halves[0] ?? "").includes(".")) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    const all = parseIpv6Groups(text);
    if (!all || all.length !== 8) return null;
    groups = all;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] ?? 0;
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}

/** Parse a single address. Zone ids (`fe80::1%eth0`) and brackets are refused. */
export function parseIp(text: string): IpAddress | null {
  const value = text.trim();
  if (value === "" || value.length > 45) return null;
  if (value.includes(":")) {
    const bytes = parseIpv6(value);
    return bytes ? { version: 6, bytes } : null;
  }
  const bytes = parseIpv4(value);
  return bytes ? { version: 4, bytes } : null;
}

/**
 * Parse `addr/prefix`, or a bare address as a single-host network (/32 or
 * /128). Host bits below the prefix are cleared, so `10.1.2.3/8` is stored and
 * shown as `10.0.0.0/8` — the range is the same either way, and the canonical
 * form is what an admin later sees and edits.
 */
export function parseCidr(text: string): Result<Cidr, string> {
  const value = text.trim();
  const slash = value.indexOf("/");
  const addrText = slash === -1 ? value : value.slice(0, slash);
  const address = parseIp(addrText);
  if (!address) return err(`'${text}' is not a valid IPv4 or IPv6 address or CIDR range`);
  const max = address.version === 4 ? 32 : 128;
  let prefix = max;
  if (slash !== -1) {
    const prefixText = value.slice(slash + 1);
    if (!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) {
      return err(`'${text}' has an invalid prefix length`);
    }
    prefix = Number(prefixText);
    if (prefix > max) return err(`'${text}' has a prefix longer than /${max}`);
  }
  const bytes = new Uint8Array(address.bytes);
  for (let bit = prefix; bit < max; bit++) {
    const index = bit >> 3;
    bytes[index] = (bytes[index] ?? 0) & ~(0x80 >> (bit & 7));
  }
  return ok({ version: address.version, bytes, prefix });
}

function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push(((bytes[i * 2] ?? 0) << 8) | (bytes[i * 2 + 1] ?? 0));
  // RFC 5952: compress the longest run (length >= 2) of zero groups, first wins.
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/** Canonical text for a network: `203.0.113.0/24`, `2001:db8::/32`. */
export function formatCidr(cidr: Cidr): string {
  const address = cidr.version === 4 ? Array.from(cidr.bytes).join(".") : formatIpv6(cidr.bytes);
  return `${address}/${cidr.prefix}`;
}

/**
 * The IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) stands for,
 * so a dual-stack client reported in mapped form still matches an IPv4 range.
 */
function unmapIpv4(address: IpAddress): IpAddress {
  if (address.version !== 6) return address;
  const b = address.bytes;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return address;
  if (b[10] !== 0xff || b[11] !== 0xff) return address;
  return { version: 4, bytes: b.slice(12, 16) };
}

/** Whether `address` falls inside `cidr`. Families never cross-match. */
export function cidrContains(cidr: Cidr, address: IpAddress): boolean {
  const ip = unmapIpv4(address);
  if (ip.version !== cidr.version) return false;
  const full = cidr.prefix >> 3;
  for (let i = 0; i < full; i++) if (ip.bytes[i] !== cidr.bytes[i]) return false;
  const rest = cidr.prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((ip.bytes[full] ?? 0) & mask) === ((cidr.bytes[full] ?? 0) & mask);
}

/** Whether `address` (text) falls in any of `ranges`. An unparseable address matches nothing. */
export function ipInRanges(address: string, ranges: readonly Cidr[]): boolean {
  const ip = parseIp(address);
  if (!ip) return false;
  return ranges.some((range) => cidrContains(range, ip));
}
