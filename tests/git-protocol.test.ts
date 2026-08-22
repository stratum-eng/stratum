import { describe, expect, it } from "vitest";
import {
  FLUSH_PKT,
  ZERO_OID,
  buildReportStatus,
  checkWorkspacePushPolicy,
  encodePktLine,
  encodeSideband,
  parseReceivePackRequest,
  parseReportStatus,
  sanitizeStatusText,
  wantsSideband,
} from "../src/utils/git-protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

function pktLine(payload: string): Uint8Array {
  const data = encoder.encode(payload);
  const header = encoder.encode((data.byteLength + 4).toString(16).padStart(4, "0"));
  const out = new Uint8Array(data.byteLength + 4);
  out.set(header, 0);
  out.set(data, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("encodePktLine", () => {
  it("frames a payload with a self-inclusive hex length", () => {
    const line = encodePktLine("unpack ok\n");
    // "unpack ok\n" is 10 bytes; 10 + 4 = 14 = 0x000e.
    expect(decoder.decode(line)).toBe("000eunpack ok\n");
  });

  it("rejects payloads beyond the pkt-line maximum", () => {
    expect(() => encodePktLine("x".repeat(0x10000))).toThrow(RangeError);
  });
});

describe("parseReceivePackRequest", () => {
  it("parses a single command with capabilities after NUL", () => {
    const body = concat(
      pktLine(`${OID_A} ${OID_B} refs/heads/main\0report-status side-band-64k agent=git/2.44`),
      FLUSH_PKT,
      encoder.encode("PACKdata-not-parsed"),
    );
    const result = parseReceivePackRequest(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toEqual([
        { oldOid: OID_A, newOid: OID_B, ref: "refs/heads/main" },
      ]);
      expect(result.data.capabilities).toContain("side-band-64k");
      expect(result.data.capabilities).toContain("report-status");
      expect(wantsSideband(result.data.capabilities)).toBe(true);
    }
  });

  it("parses multiple commands; only the first line carries capabilities", () => {
    const body = concat(
      pktLine(`${OID_A} ${OID_B} refs/heads/main\0report-status`),
      pktLine(`${OID_A} ${OID_B} refs/heads/dev\n`),
      FLUSH_PKT,
    );
    const result = parseReceivePackRequest(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toHaveLength(2);
      expect(result.data.commands[1]?.ref).toBe("refs/heads/dev");
      expect(wantsSideband(result.data.capabilities)).toBe(false);
    }
  });

  it("rejects a body with no flush-pkt", () => {
    const result = parseReceivePackRequest(pktLine(`${OID_A} ${OID_B} refs/heads/main`));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("flush-pkt");
  });

  it("rejects malformed oids", () => {
    const body = concat(pktLine(`not-an-oid ${OID_B} refs/heads/main`), FLUSH_PKT);
    const result = parseReceivePackRequest(body);
    expect(result.success).toBe(false);
  });

  it("rejects an empty command section", () => {
    const result = parseReceivePackRequest(FLUSH_PKT);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("no commands");
  });

  it("rejects garbage framing", () => {
    const result = parseReceivePackRequest(encoder.encode("zzzz not a pkt line"));
    expect(result.success).toBe(false);
  });

  it("parses a DELETE command (zero new-oid) — policy, not the parser, refuses it", () => {
    const body = concat(pktLine(`${OID_A} ${ZERO_OID} refs/heads/main\0report-status`), FLUSH_PKT);
    const result = parseReceivePackRequest(body);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.commands[0]?.newOid).toBe(ZERO_OID);
  });

  it("rejects a truncated pkt-line (declared length beyond the body)", () => {
    // Header says 0x0064 bytes but only the header is present.
    const result = parseReceivePackRequest(encoder.encode("0064"));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("out of range");
  });

  it("rejects a command line with a missing refname", () => {
    const body = concat(pktLine(`${OID_A} ${OID_B} `), FLUSH_PKT);
    const result = parseReceivePackRequest(body);
    expect(result.success).toBe(false);
  });
});

describe("checkWorkspacePushPolicy (S3)", () => {
  const update = (ref: string) => ({ oldOid: OID_A, newOid: OID_B, ref });
  const del = (ref: string) => ({ oldOid: OID_A, newOid: ZERO_OID, ref });

  it("allows an update to refs/heads/main", () => {
    expect(checkWorkspacePushPolicy([update("refs/heads/main")], "myws").allowed).toBe(true);
  });

  it("allows an update to the workspace branch", () => {
    expect(checkWorkspacePushPolicy([update("refs/heads/myws")], "myws").allowed).toBe(true);
  });

  it("allows a multi-command push entirely on allowed refs", () => {
    const verdict = checkWorkspacePushPolicy(
      [update("refs/heads/main"), update("refs/heads/myws")],
      "myws",
    );
    expect(verdict.allowed).toBe(true);
  });

  it("refuses a ref delete, even of an allowed ref, naming the ref", () => {
    const verdict = checkWorkspacePushPolicy([del("refs/heads/main")], "myws");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.ref).toBe("refs/heads/main");
      expect(verdict.reason).toContain("deletion");
    }
  });

  it("refuses off-branch heads, tags, and arbitrary refs", () => {
    for (const ref of ["refs/heads/other", "refs/tags/v1", "refs/evil/x", "HEAD"]) {
      const verdict = checkWorkspacePushPolicy([update(ref)], "myws");
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.ref).toBe(ref);
    }
  });

  it("refuses when any one command in a batch is off-policy", () => {
    const verdict = checkWorkspacePushPolicy(
      [update("refs/heads/main"), del("refs/heads/myws")],
      "myws",
    );
    expect(verdict.allowed).toBe(false);
  });

  it("a branch name of 'main' collapses the allowed set without error", () => {
    expect(checkWorkspacePushPolicy([update("refs/heads/main")], "main").allowed).toBe(true);
    expect(checkWorkspacePushPolicy([update("refs/heads/x")], "main").allowed).toBe(false);
  });

  it("an empty command list is trivially allowed (nothing to police)", () => {
    expect(checkWorkspacePushPolicy([], "myws").allowed).toBe(true);
  });
});

describe("encodeSideband", () => {
  it("prefixes the band byte inside the pkt-line", () => {
    const packet = encodeSideband(2, encoder.encode("hello"));
    // length = 4 (header) + 1 (band) + 5 (payload) = 10 = 0x000a
    expect(decoder.decode(packet.subarray(0, 4))).toBe("000a");
    expect(packet[4]).toBe(2);
    expect(decoder.decode(packet.subarray(5))).toBe("hello");
  });

  it("chunks payloads larger than the sideband maximum", () => {
    const packet = encodeSideband(1, new Uint8Array(70_000));
    // Two packets: 65515 bytes + remainder, each with 4-byte header + band byte.
    expect(packet.byteLength).toBe(70_000 + 2 * 5);
  });
});

describe("sanitizeStatusText", () => {
  it("flattens newlines so text cannot smuggle extra pkt-lines", () => {
    expect(sanitizeStatusText("line one\nng refs/heads/main injected\r\nline three")).toBe(
      "line one ng refs/heads/main injected line three",
    );
  });

  it("caps length so encodePktLine cannot overflow", () => {
    const long = sanitizeStatusText("x".repeat(100_000));
    expect(long.length).toBeLessThanOrEqual(513); // cap + ellipsis
    expect(() => encodePktLine(`ng refs/heads/main ${long}\n`)).not.toThrow();
  });

  it("leaves ordinary text alone", () => {
    expect(sanitizeStatusText("gated: change chg_1 created")).toBe("gated: change chg_1 created");
  });
});

describe("parseReportStatus", () => {
  it("parses a plain successful report", () => {
    const body = concat(pktLine("unpack ok\n"), pktLine("ok refs/heads/main\n"), FLUSH_PKT);
    const result = parseReportStatus(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unpack).toBe("ok");
      expect(result.data.results).toEqual([{ ref: "refs/heads/main", ok: true }]);
    }
  });

  it("parses a plain rejection with the reason", () => {
    const body = concat(
      pktLine("unpack ok\n"),
      pktLine("ng refs/heads/main non-fast-forward\n"),
      FLUSH_PKT,
    );
    const result = parseReportStatus(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toEqual([
        { ref: "refs/heads/main", ok: false, reason: "non-fast-forward" },
      ]);
    }
  });

  it("ignores band-2 progress — 'Counting objects' contains 'ng ' and must not read as a verdict", () => {
    const status = concat(pktLine("unpack ok\n"), pktLine("ok refs/heads/main\n"), FLUSH_PKT);
    const body = concat(
      encodeSideband(2, encoder.encode("Counting objects: 100% (3/3), done.\n")),
      encodeSideband(1, status),
      FLUSH_PKT,
    );
    const result = parseReportStatus(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unpack).toBe("ok");
      expect(result.data.results.every((r) => r.ok)).toBe(true);
    }
  });

  it("surfaces a sideband-wrapped rejection", () => {
    const status = concat(
      pktLine("unpack ok\n"),
      pktLine("ng refs/heads/main hook declined\n"),
      FLUSH_PKT,
    );
    const body = concat(encodeSideband(1, status), FLUSH_PKT);
    const result = parseReportStatus(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results[0]).toEqual({
        ref: "refs/heads/main",
        ok: false,
        reason: "hook declined",
      });
    }
  });

  it("reports a failed unpack verbatim", () => {
    const body = concat(pktLine("unpack index-pack failed\n"), FLUSH_PKT);
    const result = parseReportStatus(body);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unpack).toBe("index-pack failed");
  });

  it("rejects a body without an unpack line", () => {
    const body = concat(pktLine("ok refs/heads/main\n"), FLUSH_PKT);
    const result = parseReportStatus(body);
    expect(result.success).toBe(false);
  });

  it("rejects garbage framing and empty bodies", () => {
    expect(parseReportStatus(encoder.encode("zzzz not a pkt")).success).toBe(false);
    expect(parseReportStatus(new Uint8Array(0)).success).toBe(false);
    expect(parseReportStatus(FLUSH_PKT).success).toBe(false);
  });

  it("round-trips buildReportStatus output, both framings", () => {
    for (const sideband of [false, true]) {
      const body = buildReportStatus({
        unpack: "ok",
        results: [{ ref: "refs/heads/main", ok: false, reason: "gated" }],
        messages: ["review the change"],
        sideband,
      });
      const result = parseReportStatus(body);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.results).toEqual([
          { ref: "refs/heads/main", ok: false, reason: "gated" },
        ]);
      }
    }
  });
});

describe("buildReportStatus", () => {
  it("without sideband: plain pkt-line status section", () => {
    const body = buildReportStatus({
      unpack: "ok",
      results: [{ ref: "refs/heads/main", ok: false, reason: "gated" }],
      messages: ["ignored without sideband"],
      sideband: false,
    });
    const text = decoder.decode(body);
    expect(text).toContain("unpack ok\n");
    expect(text).toContain("ng refs/heads/main gated\n");
    expect(text.endsWith("0000")).toBe(true);
    expect(text).not.toContain("ignored");
  });

  it("with sideband: wraps status in band 1 and messages in band 2", () => {
    const body = buildReportStatus({
      unpack: "ok",
      results: [
        { ref: "refs/heads/main", ok: true },
        { ref: "refs/heads/dev", ok: false, reason: "no" },
      ],
      messages: ["use a workspace remote"],
      sideband: true,
    });
    // Band bytes appear right after each 4-byte pkt header.
    expect(body[4]).toBe(2); // first packet: progress message
    const text = decoder.decode(body);
    expect(text).toContain("use a workspace remote");
    expect(text).toContain("unpack ok\n");
    expect(text).toContain("ok refs/heads/main\n");
    expect(text).toContain("ng refs/heads/dev no\n");
    expect(text.endsWith("0000")).toBe(true);
  });

  it("sanitizes reasons and messages: no injected lines, no pkt-line overflow", () => {
    const body = buildReportStatus({
      unpack: "ok",
      results: [
        {
          ref: "refs/heads/main",
          ok: false,
          reason: `bad\nok refs/heads/main\n${"y".repeat(80_000)}`,
        },
      ],
      messages: ["multi\nline\nmessage"],
      sideband: true,
    });
    const parsed = parseReportStatus(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Still exactly one ng result — the embedded "ok refs/heads/main" line
      // was flattened into the reason text, not parsed as a second verdict.
      expect(parsed.data.results).toHaveLength(1);
      expect(parsed.data.results[0]?.ok).toBe(false);
    }
  });
});
