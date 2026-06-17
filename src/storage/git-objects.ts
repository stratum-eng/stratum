/**
 * Real git object encoding (ADR 004 Phase 2, object plane).
 *
 * Produces genuine git blob/tree/commit objects addressed by SHA-1 — the same
 * oids stock `git` computes (validated in tests against git's empty-blob oid
 * e69de29…). Objects are stored in R2 uncompressed; standard git deflates loose
 * objects, so a zlib pass belongs in the clone/fetch serving layer (deferred to
 * the native-git Container), not in the write hot path measured here.
 */

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface GitObject {
  oid: string;
  /** Full loose object: `<type> <len>\0<content>`. */
  bytes: Uint8Array;
}

/** Wrap content as a loose git object of the given type and hash it (SHA-1). */
export async function hashObject(
  type: "blob" | "tree" | "commit",
  content: Uint8Array,
): Promise<GitObject> {
  const header = encoder.encode(`${type} ${content.length}\0`);
  const bytes = concat([header, content]);
  return { oid: await sha1Hex(bytes), bytes };
}

export function blobObject(content: Uint8Array): Promise<GitObject> {
  return hashObject("blob", content);
}

export interface TreeEntry {
  /** File mode; regular files are "100644". */
  mode: string;
  name: string;
  oid: string;
}

/** Encode a git tree object. Entries are sorted by name (git's byte order). */
export function treeObject(entries: TreeEntry[]): Promise<GitObject> {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(encoder.encode(`${e.mode} ${e.name}\0`));
    parts.push(hexToBytes(e.oid));
  }
  return hashObject("tree", concat(parts));
}

export interface CommitInput {
  tree: string;
  parents: string[];
  message: string;
  /** Unix seconds; passed in (Workers clock is fine here, it's just metadata). */
  timestamp: number;
  author?: { name: string; email: string };
}

export interface ParsedObject {
  type: "blob" | "tree" | "commit";
  content: Uint8Array;
}

/** Split a loose object (`<type> <len>\0<content>`) into its type and raw content. */
export function parseLoose(bytes: Uint8Array): ParsedObject {
  const nul = bytes.indexOf(0);
  if (nul === -1) throw new Error("invalid loose object: no header NUL");
  const header = new TextDecoder().decode(bytes.subarray(0, nul));
  const type = header.split(" ")[0];
  if (type !== "blob" && type !== "tree" && type !== "commit") {
    throw new Error(`unsupported object type: ${type}`);
  }
  return { type, content: bytes.subarray(nul + 1) };
}

/** Decode a git tree object's content into its entries. */
export function parseTree(content: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < content.length) {
    const space = content.indexOf(0x20, i);
    const nul = content.indexOf(0, space);
    const mode = new TextDecoder().decode(content.subarray(i, space));
    const name = new TextDecoder().decode(content.subarray(space + 1, nul));
    const oidBytes = content.subarray(nul + 1, nul + 21);
    const oid = Array.from(oidBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
}

/** Decode a git commit object's content into its tree + parent oids. */
export function parseCommit(content: Uint8Array): ParsedCommit {
  const text = new TextDecoder().decode(content);
  let tree = "";
  const parents: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") break; // headers end at the blank line before the message
    const [key, value] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
    if (key === "tree") tree = value;
    else if (key === "parent") parents.push(value);
  }
  return { tree, parents };
}

export function commitObject(input: CommitInput): Promise<GitObject> {
  const who = input.author ?? { name: "Stratum", email: "system@usestratum.dev" };
  const stamp = `${who.name} <${who.email}> ${input.timestamp} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const p of input.parents) lines.push(`parent ${p}`);
  lines.push(`author ${stamp}`);
  lines.push(`committer ${stamp}`);
  lines.push("");
  lines.push(input.message);
  return hashObject("commit", encoder.encode(`${lines.join("\n")}\n`));
}
