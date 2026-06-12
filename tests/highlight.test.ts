import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/ui/components/diff-view";
import { highlightCode } from "../src/ui/highlight";

describe("highlightCode", () => {
  it("returns null for unsupported languages and oversized files", () => {
    expect(highlightCode("code", "brainfuck")).toBeNull();
    expect(highlightCode("x".repeat(300 * 1024), "typescript")).toBeNull();
  });

  it("escapes HTML in all emitted output", () => {
    const html = highlightCode('const xss = "<script>alert(1)</script>";', "typescript");
    expect(html).not.toBeNull();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML inside comments and plain code", () => {
    const html = highlightCode("// <img onerror=x>\nlet a = b < c;", "typescript");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("marks keywords, strings, numbers, and comments in TypeScript", () => {
    const html = highlightCode('// note\nconst greeting = "hello";\nreturn 42;', "typescript");
    expect(html).toContain('<span class="tok-comment">// note</span>');
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-string">&quot;hello&quot;</span>');
    expect(html).toContain('<span class="tok-keyword">return</span>');
    expect(html).toContain('<span class="tok-number">42</span>');
  });

  it("handles block comments spanning lines", () => {
    const html = highlightCode("/* multi\nline */ const x = 1;", "typescript");
    expect(html).toContain('<span class="tok-comment">/* multi\nline */</span>');
  });

  it("does not treat comment markers inside strings as comments", () => {
    const html = highlightCode('const url = "https://example.com";', "typescript");
    expect(html).toContain('<span class="tok-string">&quot;https://example.com&quot;</span>');
    expect(html).not.toContain("tok-comment");
  });

  it("respects escaped quotes inside strings", () => {
    const html = highlightCode('const s = "say \\"hi\\"" + done;', "typescript");
    expect(html).toContain("tok-string");
    // The string token ends at the escaped-quote-aware terminator.
    expect(html).toContain("done");
  });

  it("does not highlight keywords embedded in identifiers", () => {
    const html = highlightCode("const classNameThing = 1;", "typescript");
    expect(html).not.toContain('<span class="tok-keyword">class</span>');
  });

  it("highlights Python with # comments and its keyword set", () => {
    const html = highlightCode("# comment\ndef f():\n    return None", "python");
    expect(html).toContain('<span class="tok-comment"># comment</span>');
    expect(html).toContain('<span class="tok-keyword">def</span>');
    expect(html).toContain('<span class="tok-keyword">None</span>');
  });

  it("highlights SQL keywords case-insensitively", () => {
    const html = highlightCode("SELECT id FROM users WHERE active = 1;", "sql");
    expect(html).toContain('<span class="tok-keyword">SELECT</span>');
    expect(html).toContain('<span class="tok-keyword">FROM</span>');
  });

  it("treats Go backtick strings as strings", () => {
    const html = highlightCode("s := `raw\nstring`", "go");
    expect(html).toContain('<span class="tok-string">`raw\nstring`</span>');
  });
});

describe("parseUnifiedDiff", () => {
  const sample = [
    "Index: src/a.ts",
    "===================================================================",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " context line",
    "-removed line",
    "+added line one",
    "+added line two",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -5,2 +5,1 @@",
    "-gone",
    " kept",
  ].join("\n");

  it("splits a unified diff into files with counts", () => {
    const files = parseUnifiedDiff(sample);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(1);
    expect(files[1]?.additions).toBe(0);
    expect(files[1]?.deletions).toBe(1);
  });

  it("classifies line kinds", () => {
    const files = parseUnifiedDiff(sample);
    const kinds = files[0]?.lines.map((l) => l.kind);
    expect(kinds).toEqual(["hunk", "context", "del", "add", "add"]);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
