// Minimal ambient declarations for the Node surface the wrangler migration-chain
// guard uses. The Workers tsconfig ships no @types/node on purpose — pulling it
// in globally would let src/ reference Node APIs that don't exist in workerd — so
// each test that reaches for a built-in declares just what it needs, the same way
// tests/node-sqlite.d.ts does.
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: {
      encoding?: "utf8";
      stdio?: "ignore" | readonly ("ignore" | "pipe")[];
    },
  ): string;
}

declare const process: { env: Record<string, string | undefined> };
