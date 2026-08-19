// Minimal ambient declaration for the subset of node:sqlite the migration test
// uses. The Workers tsconfig ships no @types/node, and node:sqlite is a Node 22+
// built-in; this keeps the test fully type-checked without pulling in node types
// globally (which would let src/ reference Node APIs that don't exist in workerd).
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
    close(): void;
  }
}
