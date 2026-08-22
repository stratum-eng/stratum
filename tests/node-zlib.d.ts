// Minimal ambient declaration for the subset of node:zlib the git-http push
// tests use to fabricate Content-Encoding'd push bodies. The Workers tsconfig
// ships no @types/node (src/ must not reference Node APIs); this keeps the
// tests type-checked without pulling node types in globally.
declare module "node:zlib" {
  export function gzipSync(data: Uint8Array): Uint8Array;
  export function deflateSync(data: Uint8Array): Uint8Array;
}
