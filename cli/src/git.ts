import { execFileSync } from "node:child_process";

/** Paths of files currently staged in the local git repository. */
export function getStagedFiles(): string[] {
  const output = execFileSync("git", ["diff", "--cached", "--name-only"], {
    encoding: "utf-8",
  });
  return output
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

/** Staged content of a file (the index version, not the working tree). */
export function getStagedContent(path: string): string {
  return execFileSync("git", ["show", `:${path}`], { encoding: "utf-8" });
}
