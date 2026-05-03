import { AppError } from "../utils/errors";
import { type Result, err, ok } from "../utils/result";

type FileEntry = { kind: "file"; data: Uint8Array; mtimeMs: number };
type DirEntry = { kind: "dir"; children: Set<string>; mtimeMs: number };
type Entry = FileEntry | DirEntry;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fsError(code: string, message: string): AppError {
  return new AppError(message, code, 500);
}

class MemoryStats {
  constructor(private readonly entry: Entry) {}

  get size(): number {
    return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
  }

  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }

  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }

  get mode(): number {
    return this.entry.kind === "file" ? 0o100644 : 0o040000;
  }

  isFile(): boolean {
    return this.entry.kind === "file";
  }

  isDirectory(): boolean {
    return this.entry.kind === "dir";
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

export class MemoryFS {
  private readonly entries = new Map<string, Entry>([
    ["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
  ]);

  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
  };

  normalize(input: string): string {
    const segments: string[] = [];
    for (const part of input.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join("/")}`;
  }

  private parent(path: string): string {
    const normalized = this.normalize(path);
    if (normalized === "/") return "/";
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length > 0 ? `/${parts.join("/")}` : "/";
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
  }

  private getEntry(path: string): Entry | undefined {
    return this.entries.get(this.normalize(path));
  }

  private getEntryResult(path: string): Result<Entry, AppError> {
    const entry = this.getEntry(path);
    if (!entry) return err(fsError("ENOENT", `ENOENT: no such file or directory: ${path}`));
    return ok(entry);
  }

  private getDirResult(path: string): Result<DirEntry, AppError> {
    const entryResult = this.getEntryResult(path);
    if (!entryResult.success) return entryResult;
    const entry = entryResult.data;
    if (entry.kind !== "dir") return err(fsError("ENOTDIR", `ENOTDIR: not a directory: ${path}`));
    return ok(entry);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<Result<void, AppError>> {
    const target = this.normalize(path);
    if (target === "/") return ok(undefined);
    const recursive = options?.recursive === true;
    const parentPath = this.parent(target);

    if (!this.entries.has(parentPath)) {
      if (!recursive)
        return err(fsError("ENOENT", `ENOENT: no such file or directory: ${parentPath}`));
      const mkdirResult = await this.mkdir(parentPath, { recursive: true });
      if (!mkdirResult.success) return mkdirResult;
    }

    if (this.entries.has(target)) return ok(undefined);

    this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    const dirResult = this.getDirResult(parentPath);
    if (!dirResult.success) return dirResult;
    dirResult.data.children.add(this.basename(target));
    return ok(undefined);
  }

  async writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
  ): Promise<Result<void, AppError>> {
    const target = this.normalize(path);
    const parentPath = this.parent(target);
    const mkdirResult = await this.mkdir(parentPath, { recursive: true });
    if (!mkdirResult.success) return mkdirResult;

    const bytes =
      typeof data === "string"
        ? encoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);

    if (this.getEntry(target)?.kind === "dir")
      return err(fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`));

    this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
    const dirResult = this.getDirResult(parentPath);
    if (!dirResult.success) return dirResult;
    dirResult.data.children.add(this.basename(target));
    return ok(undefined);
  }

  async readFile(
    path: string,
    options?: string | { encoding?: string },
  ): Promise<Result<string | Uint8Array, AppError>> {
    const entryResult = this.getEntryResult(path);
    if (!entryResult.success) return entryResult;
    const entry = entryResult.data;
    if (entry.kind !== "file")
      return err(fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`));

    const encoding = typeof options === "string" ? options : options?.encoding;
    return ok(encoding ? decoder.decode(entry.data) : entry.data);
  }

  async readdir(path: string): Promise<Result<string[], AppError>> {
    const dirResult = this.getDirResult(path);
    if (!dirResult.success) return dirResult;
    return ok([...dirResult.data.children].sort());
  }

  async unlink(path: string): Promise<Result<void, AppError>> {
    const target = this.normalize(path);
    const entryResult = this.getEntryResult(target);
    if (!entryResult.success) return entryResult;
    const entry = entryResult.data;
    if (entry.kind !== "file")
      return err(fsError("EISDIR", `EISDIR: illegal operation on a directory: ${path}`));
    this.entries.delete(target);
    const dirResult = this.getDirResult(this.parent(target));
    if (!dirResult.success) return dirResult;
    dirResult.data.children.delete(this.basename(target));
    return ok(undefined);
  }

  async rmdir(path: string): Promise<Result<void, AppError>> {
    const target = this.normalize(path);
    const entryResult = this.getDirResult(target);
    if (!entryResult.success) return entryResult;
    const entry = entryResult.data;
    if (entry.children.size > 0)
      return err(fsError("ENOTEMPTY", `ENOTEMPTY: directory not empty: ${path}`));
    this.entries.delete(target);
    const dirResult = this.getDirResult(this.parent(target));
    if (!dirResult.success) return dirResult;
    dirResult.data.children.delete(this.basename(target));
    return ok(undefined);
  }

  async stat(path: string): Promise<Result<MemoryStats, AppError>> {
    const entryResult = this.getEntryResult(path);
    if (!entryResult.success) return entryResult;
    return ok(new MemoryStats(entryResult.data));
  }

  async lstat(path: string): Promise<Result<MemoryStats, AppError>> {
    return this.stat(path);
  }

  /**
   * Returns a Node.js fs-compatible interface for isomorphic-git
   * This unwraps Result objects and throws errors like standard Node.js fs
   */
  toNodeFS(): {
    promises: {
      readFile: (
        path: string,
        options?: string | { encoding?: string },
      ) => Promise<string | Uint8Array>;
      writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
      unlink: (path: string) => Promise<void>;
      readdir: (path: string) => Promise<string[]>;
      mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
      rmdir: (path: string) => Promise<void>;
      stat: (path: string) => Promise<MemoryStats>;
      lstat: (path: string) => Promise<MemoryStats>;
    };
  } {
    const nodeFS = {
      promises: {
        readFile: async (path: string, options?: string | { encoding?: string }) => {
          const result = await this.readFile(path, options);
          if (!result.success) throw result.error;
          return result.data;
        },
        writeFile: async (path: string, data: string | Uint8Array) => {
          const result = await this.writeFile(path, data);
          if (!result.success) throw result.error;
        },
        unlink: async (path: string) => {
          const result = await this.unlink(path);
          if (!result.success) throw result.error;
        },
        readdir: async (path: string) => {
          const result = await this.readdir(path);
          if (!result.success) throw result.error;
          return result.data;
        },
        mkdir: async (path: string, options?: { recursive?: boolean }) => {
          const result = await this.mkdir(path, options);
          if (!result.success) throw result.error;
        },
        rmdir: async (path: string) => {
          const result = await this.rmdir(path);
          if (!result.success) throw result.error;
        },
        stat: async (path: string) => {
          const result = await this.stat(path);
          if (!result.success) throw result.error;
          return result.data;
        },
        lstat: async (path: string) => {
          const result = await this.lstat(path);
          if (!result.success) throw result.error;
          return result.data;
        },
      },
    };
    return nodeFS;
  }
}
