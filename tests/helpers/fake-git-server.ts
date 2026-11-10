/**
 * A git smart-HTTP server in memory, for tests that need BOTH directions.
 *
 * `tests/push-mirror.test.ts` has a fake that accepts pushes. The break-glass
 * resync (#418) also fetches — it clones the project's repository and fetches
 * the GitHub branch into the clone — so this one speaks upload-pack too,
 * including the part that matters most to the code under test: `deepen`. A
 * depth-limited request is answered with a depth-limited pack and the
 * `shallow` lines a real server sends, so "the shallow window could not prove
 * it, load everything" is exercised against real truncated history rather
 * than a simulation of it.
 *
 * Each instance is one repository with a real isomorphic-git object store.
 * What tests assert is therefore what actually arrived or left: which ref
 * moved to which commit, which objects were asked for and at what depth.
 *
 * The server does not authenticate; the test that owns the `fetch` stub
 * decides which credential opens which repository, then calls {@link
 * FakeGitRemote.serve}.
 */
import git from "isomorphic-git";
import { MemoryFS } from "../../src/storage/memory-fs";
import {
  FLUSH_PKT,
  ZERO_OID,
  buildReportStatus,
  encodePktLine,
  encodeSideband,
  parseReceivePackRequest,
} from "../../src/utils/git-protocol";

type GitFs = Parameters<typeof git.init>[0]["fs"];

interface FsPromises {
  mkdir(path: string, opts?: object): Promise<void>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

const BASE_TIMESTAMP = 1_700_000_000;
/** The most pack bytes one side-band-64k packet may carry. */
const SIDEBAND_CHUNK = 65_515;

/**
 * A real git repository in memory.
 *
 * Commits are deterministic: the same sequence of {@link GitRepo.commit} calls
 * on two fresh repositories produces the same SHAs. That is how a test gives
 * the project and its GitHub copy a shared history without copying objects —
 * and how it makes them diverge, by committing different messages to each.
 */
export class GitRepo {
  readonly fs: GitFs = new MemoryFS().toNodeFS() as unknown as GitFs;
  readonly dir = "/";
  private n = 0;

  /** Creates the empty repository with `main` as its branch. */
  async init(): Promise<void> {
    await git.init({ fs: this.fs, dir: this.dir, defaultBranch: "main" });
  }

  private get promises(): FsPromises {
    return (this.fs as unknown as { promises: FsPromises }).promises;
  }

  /**
   * Adds a commit on `main` and returns its sha.
   *
   * @param mergedParents - Extra parents, making this a merge commit of them
   */
  async commit(
    message: string,
    authorName = "Test Author",
    mergedParents: string[] = [],
  ): Promise<string> {
    const path = `file-${this.n++}.txt`;
    await this.promises.writeFile(`/${path}`, `${message} ${this.n}`);
    await git.add({ fs: this.fs, dir: this.dir, filepath: path });
    return git.commit({
      fs: this.fs,
      dir: this.dir,
      message,
      ...(mergedParents.length > 0 ? { parent: [await this.tip(), ...mergedParents] } : {}),
      author: {
        name: authorName,
        email: "author@example.com",
        timestamp: BASE_TIMESTAMP + this.n,
        timezoneOffset: 0,
      },
    });
  }

  /** The commit a ref points at, or undefined when it does not exist. */
  async ref(ref: string): Promise<string | undefined> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref });
    } catch {
      return undefined;
    }
  }

  /** The tip of `main`. Throws when the repository has no commits. */
  async tip(): Promise<string> {
    const oid = await this.ref("refs/heads/main");
    if (oid === undefined) throw new Error("repository has no main branch");
    return oid;
  }

  /** Every branch or tag, by short name. */
  async refs(prefix: "refs/heads" | "refs/tags"): Promise<Record<string, string>> {
    const names =
      prefix === "refs/heads"
        ? await git.listBranches({ fs: this.fs, dir: this.dir })
        : await git.listTags({ fs: this.fs, dir: this.dir });
    const out: Record<string, string> = {};
    for (const name of names) {
      const oid = await this.ref(`${prefix}/${name}`);
      if (oid !== undefined) out[name] = oid;
    }
    return out;
  }

  /** Points a ref at a commit, creating or moving it. */
  async setRef(ref: string, oid: string): Promise<void> {
    await git.writeRef({ fs: this.fs, dir: this.dir, ref, value: oid, force: true });
  }

  /** The parents of a commit, or null when the object is not here. */
  async parents(oid: string): Promise<string[] | null> {
    try {
      return (await git.readCommit({ fs: this.fs, dir: this.dir, oid })).commit.parent;
    } catch {
      return null;
    }
  }

  /** Stores a received packfile and indexes it. */
  async addPack(pack: Uint8Array): Promise<void> {
    const name = `objects/pack/pack-${crypto.randomUUID().replace(/-/g, "")}.pack`;
    await this.promises.mkdir("/.git/objects/pack", { recursive: true }).catch(() => {});
    await this.promises.writeFile(`/.git/${name}`, pack);
    await git.indexPack({ fs: this.fs, dir: this.dir, filepath: `.git/${name}` });
  }
}

/** One ref update a push asked for. */
export interface RefUpdate {
  ref: string;
  oldOid: string;
  newOid: string;
}

/** One upload-pack request, as the server understood it. */
export interface FetchRequest {
  wants: string[];
  haves: string[];
  /** The `deepen` the client asked for, or null for full history. */
  depth: number | null;
}

/** Concatenates byte arrays. */
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The first position of `needle` in `haystack`, or -1. */
function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Splits an upload-pack request body into its text pkt-lines, dropping flushes. */
function pktLines(body: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(decoder.decode(body.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) break;
    if (length < 4) {
      offset += 4;
      continue;
    }
    lines.push(decoder.decode(body.subarray(offset + 4, offset + length)).trim());
    offset += length;
  }
  return lines;
}

/** One repository served over git smart HTTP. */
export class FakeGitRemote {
  readonly repo = new GitRepo();
  /** Every ref update a push asked for, accepted or not, in order. */
  updates: RefUpdate[] = [];
  /** Accepted updates that were not fast-forwards. Nothing under test may send one. */
  overwrites: RefUpdate[] = [];
  /** Ref deletions. Nothing under test may send one. */
  deletions: RefUpdate[] = [];
  /** Every upload-pack request, in order. */
  fetches: FetchRequest[] = [];
  /** Requests seen, as `METHOD path?query`. */
  requests: string[] = [];
  /** Runs when a receive-pack POST arrives, before it is applied — the place to stage a race. */
  beforeReceivePack: (() => Promise<void>) | null = null;
  /** When set, every ref in a push is refused with this reason. */
  rejectWith: string | null = null;
  /** When set, every request is answered with this HTTP status. */
  down: number | null = null;

  /** Creates the empty repository. */
  async init(): Promise<void> {
    await this.repo.init();
  }

  /** How many pushes reached this repository. */
  pushCount(): number {
    return this.requests.filter((r) => r.startsWith("POST") && r.includes("git-receive-pack"))
      .length;
  }

  private async allRefs(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, oid] of Object.entries(await this.repo.refs("refs/heads"))) {
      out[`refs/heads/${name}`] = oid;
    }
    for (const [name, oid] of Object.entries(await this.repo.refs("refs/tags"))) {
      out[`refs/tags/${name}`] = oid;
    }
    return out;
  }

  private async advertisement(service: string): Promise<Response> {
    const caps =
      service === "git-receive-pack"
        ? "report-status side-band-64k delete-refs"
        : "side-band-64k shallow no-done ofs-delta";
    const lines: Uint8Array[] = [encodePktLine(`# service=${service}\n`), FLUSH_PKT];
    const refs = await this.allRefs();
    const head = refs["refs/heads/main"];
    // HEAD first, as a real server advertises it: a clone resolves the
    // requested branch through the advertisement.
    const entries: [string, string][] = [
      ...(head !== undefined && service === "git-upload-pack"
        ? ([["HEAD", head]] as [string, string][])
        : []),
      ...Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : 1)),
    ];
    entries.forEach(([name, oid], index) => {
      const symref = service === "git-upload-pack" ? " symref=HEAD:refs/heads/main" : "";
      lines.push(
        encodePktLine(index === 0 ? `${oid} ${name}\0${caps}${symref}\n` : `${oid} ${name}\n`),
      );
    });
    lines.push(FLUSH_PKT);
    return new Response(concat(lines), {
      status: 200,
      headers: { "Content-Type": `application/x-${service}-advertisement` },
    });
  }

  /** Every commit reachable from `starts` that this repository holds, not walking past `stopAt`. */
  private async closure(starts: string[], stopAt: Set<string>): Promise<Set<string>> {
    const seen = new Set<string>();
    const pending = [...starts];
    for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
      if (seen.has(oid)) continue;
      const parents = await this.repo.parents(oid);
      if (parents === null) continue;
      seen.add(oid);
      if (!stopAt.has(oid)) pending.push(...parents);
    }
    return seen;
  }

  /** Every tree and blob under a tree, the tree itself included. */
  private async treeObjects(tree: string, into: Set<string>): Promise<void> {
    if (into.has(tree)) return;
    into.add(tree);
    const read = await git.readTree({ fs: this.repo.fs, dir: this.repo.dir, oid: tree });
    for (const entry of read.tree) {
      if (entry.type === "tree") await this.treeObjects(entry.oid, into);
      else if (entry.type === "blob") into.add(entry.oid);
    }
  }

  /**
   * Answers a fetch the way a real server does: the commits within `deepen`
   * of the wants that the client does not already have, the `shallow` lines
   * marking where the window was cut, then the pack on side-band 1.
   */
  private async uploadPack(body: Uint8Array): Promise<Response> {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow = new Set<string>();
    let depth: number | null = null;
    for (const line of pktLines(body)) {
      const [verb, value] = line.split(" ");
      if (verb === "want" && value) wants.push(value);
      else if (verb === "have" && value) haves.push(value);
      else if (verb === "shallow" && value) clientShallow.add(value);
      else if (verb === "deepen" && value) depth = Number.parseInt(value, 10);
    }
    this.fetches.push({ wants, haves, depth });

    // What the client has: everything behind its haves, as far as its own
    // shallow boundary lets it see.
    const has = await this.closure(haves, clientShallow);

    const send: string[] = [];
    const newShallow: string[] = [];
    const seen = new Set<string>(wants);
    let level = [...wants];
    for (let d = 1; level.length > 0; d++) {
      const next: string[] = [];
      for (const oid of level) {
        const parents = await this.repo.parents(oid);
        if (parents === null) continue;
        if (!has.has(oid)) send.push(oid);
        if (depth !== null && d >= depth) {
          if (parents.length > 0 && !clientShallow.has(oid)) newShallow.push(oid);
          continue;
        }
        // Nothing behind a commit the client already has needs sending.
        if (has.has(oid)) continue;
        for (const parent of parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            next.push(parent);
          }
        }
      }
      level = next;
    }

    const objects = new Set<string>(send);
    for (const oid of send) {
      const { commit } = await git.readCommit({ fs: this.repo.fs, dir: this.repo.dir, oid });
      await this.treeObjects(commit.tree, objects);
    }
    const packed = await git.packObjects({
      fs: this.repo.fs,
      dir: this.repo.dir,
      oids: [...objects],
      write: false,
    });
    const pack = packed.packfile ?? new Uint8Array();

    const out: Uint8Array[] = [];
    if (depth !== null) {
      for (const oid of newShallow) out.push(encodePktLine(`shallow ${oid}\n`));
      out.push(FLUSH_PKT);
    }
    out.push(encodePktLine("NAK\n"));
    for (let offset = 0; offset < pack.byteLength; offset += SIDEBAND_CHUNK) {
      out.push(encodeSideband(1, pack.subarray(offset, offset + SIDEBAND_CHUNK)));
    }
    out.push(FLUSH_PKT);
    return new Response(concat(out), {
      status: 200,
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
    });
  }

  /**
   * Applies a push. A stale old-oid is refused, as any git server refuses it.
   * A non-fast-forward or a deletion is ACCEPTED and recorded, like a
   * repository with no branch protection — so "nothing was overwritten" is an
   * observation about what was sent, not about what this fake refused.
   */
  private async receivePack(body: Uint8Array): Promise<Response> {
    const parsed = parseReceivePackRequest(body);
    if (!parsed.success) return new Response("bad request", { status: 400 });
    if (this.beforeReceivePack) await this.beforeReceivePack();

    const packAt = indexOf(body, new TextEncoder().encode("PACK"));
    if (packAt >= 0) {
      const pack = body.subarray(packAt);
      const count = new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
      if (count > 0) await this.repo.addPack(pack);
    }

    const results: { ref: string; ok: boolean; reason?: string }[] = [];
    for (const command of parsed.data.commands) {
      this.updates.push(command);
      if (this.rejectWith !== null) {
        results.push({ ref: command.ref, ok: false, reason: this.rejectWith });
        continue;
      }
      const current = (await this.repo.ref(command.ref)) ?? ZERO_OID;
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: "stale info" });
        continue;
      }
      if (command.newOid === ZERO_OID) {
        this.deletions.push(command);
        results.push({ ref: command.ref, ok: true });
        continue;
      }
      if (current !== ZERO_OID) {
        const fastForward = await git
          .isDescendent({
            fs: this.repo.fs,
            dir: this.repo.dir,
            oid: command.newOid,
            ancestor: current,
            depth: -1,
          })
          .catch(() => false);
        if (!fastForward) this.overwrites.push(command);
      }
      await this.repo.setRef(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
    }
    return new Response(buildReportStatus({ unpack: "ok", results, sideband: true }), {
      status: 200,
      headers: { "Content-Type": "application/x-git-receive-pack-result" },
    });
  }

  /**
   * Serves one request addressed to this repository, or 404 for a path that is
   * not a git endpoint.
   */
  async serve(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    if (this.down !== null) return new Response("unavailable", { status: this.down });

    if (url.pathname.endsWith("/info/refs")) {
      return this.advertisement(url.searchParams.get("service") ?? "");
    }
    if (method !== "POST") return new Response("not found", { status: 404 });
    const body = new Uint8Array(init?.body as ArrayBuffer);
    if (url.pathname.endsWith("/git-upload-pack")) return this.uploadPack(body);
    if (url.pathname.endsWith("/git-receive-pack")) return this.receivePack(body);
    return new Response("not found", { status: 404 });
  }
}
