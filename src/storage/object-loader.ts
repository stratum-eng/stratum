/**
 * Loads R2-staged git objects (ADR 004 Option A) into a MemoryFS so isomorphic-git
 * can read them. Our object plane stores loose objects UNCOMPRESSED
 * (`<type> <len>\0<content>`), but git reads loose objects from
 * `.git/objects/xx/yyyy` as **zlib-deflated** bytes — so each staged object must be
 * deflated and placed at its fanned-out path. The oid is computed over the
 * inflated content, so any valid zlib stream works (compression level is free).
 */

interface FsLike {
  promises: {
    writeFile(path: string, data: Uint8Array): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  };
}

async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate"); // zlib (RFC 1950), matches git loose objects
  const writer = cs.writable.getWriter();
  void writer.write(input);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Frame several git objects into one value so a change's objects stage + load
 * with ONE R2 op instead of one per object (R2 GET count, not deflate, is the
 * load bottleneck — measured ~20ms/get, non-overlapping). Format:
 * `[count u32 LE]` then per object `[40-byte ascii oid][u32 LE len][bytes]`.
 */
export function packObjects(objs: { oid: string; bytes: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, objs.length, true);
  parts.push(count);
  for (const o of objs) {
    parts.push(enc.encode(o.oid));
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, o.bytes.length, true);
    parts.push(lenBuf);
    parts.push(o.bytes);
  }
  const total = parts.reduce((nn, p) => nn + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function unpackObjects(buf: Uint8Array): { oid: string; bytes: Uint8Array }[] {
  const dec = new TextDecoder();
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint32(0, true);
  const out: { oid: string; bytes: Uint8Array }[] = [];
  let off = 4;
  for (let i = 0; i < count; i++) {
    const oid = dec.decode(buf.subarray(off, off + 40));
    off += 40;
    const len = view.getUint32(off, true);
    off += 4;
    out.push({ oid, bytes: buf.subarray(off, off + len) });
    off += len;
  }
  return out;
}

/**
 * Place one staged loose object into the repo so `git` can read it.
 * `gitdir` is the `.git` directory (e.g. `${dir}/.git`).
 */
export async function placeLooseObject(
  fs: FsLike,
  gitdir: string,
  oid: string,
  looseBytes: Uint8Array,
): Promise<void> {
  const deflated = await deflate(looseBytes);
  const objDir = `${gitdir}/objects/${oid.slice(0, 2)}`;
  await fs.promises.mkdir(objDir, { recursive: true });
  await fs.promises.writeFile(`${objDir}/${oid.slice(2)}`, deflated);
}
