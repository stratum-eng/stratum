/**
 * Compact server-side syntax highlighter.
 *
 * Deliberately dependency-free: highlight.js's type definitions reference
 * lib="dom", which corrupts the Workers global type scope, and full grammar
 * engines are oversized for Workers bundles. This lexer covers the token
 * classes that matter for readability — comments, strings, numbers, and
 * keywords — and escapes everything it emits.
 */

interface LanguageConfig {
  lineComment?: string;
  blockComment?: [string, string];
  /** Extra string delimiters beyond ' and " (e.g. backtick). */
  extraStringDelimiters?: string[];
  keywords: ReadonlySet<string>;
}

const C_LIKE_KEYWORDS = [
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "enum",
  "extends",
  "finally",
  "for",
  "if",
  "implements",
  "import",
  "interface",
  "new",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "void",
  "while",
];

const JS_KEYWORDS = new Set([
  ...C_LIKE_KEYWORDS,
  "as",
  "async",
  "await",
  "declare",
  "delete",
  "export",
  "from",
  "function",
  "in",
  "instanceof",
  "let",
  "namespace",
  "of",
  "readonly",
  "satisfies",
  "type",
  "typeof",
  "var",
  "yield",
  "true",
  "false",
  "null",
  "undefined",
]);

const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "True",
  "False",
  "None",
  "self",
]);

const GO_KEYWORDS = new Set([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "type",
  "var",
  "true",
  "false",
  "nil",
]);

const RUST_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "trait",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "true",
  "false",
]);

const JAVA_KEYWORDS = new Set([
  ...C_LIKE_KEYWORDS,
  "abstract",
  "boolean",
  "byte",
  "char",
  "double",
  "final",
  "float",
  "int",
  "long",
  "package",
  "short",
  "synchronized",
  "throws",
  "transient",
  "volatile",
  "true",
  "false",
  "null",
]);

const C_KEYWORDS = new Set([
  ...C_LIKE_KEYWORDS,
  "auto",
  "char",
  "double",
  "extern",
  "float",
  "goto",
  "inline",
  "int",
  "long",
  "register",
  "short",
  "signed",
  "sizeof",
  "struct",
  "typedef",
  "union",
  "unsigned",
  "volatile",
  "namespace",
  "template",
  "typename",
  "using",
  "virtual",
  "nullptr",
  "true",
  "false",
]);

const RUBY_KEYWORDS = new Set([
  "alias",
  "and",
  "begin",
  "break",
  "case",
  "class",
  "def",
  "do",
  "else",
  "elsif",
  "end",
  "ensure",
  "false",
  "if",
  "in",
  "module",
  "next",
  "nil",
  "not",
  "or",
  "raise",
  "require",
  "rescue",
  "retry",
  "return",
  "self",
  "super",
  "then",
  "true",
  "unless",
  "until",
  "when",
  "while",
  "yield",
]);

const SQL_KEYWORDS = new Set(
  [
    "select",
    "from",
    "where",
    "insert",
    "into",
    "values",
    "update",
    "set",
    "delete",
    "create",
    "table",
    "index",
    "drop",
    "alter",
    "add",
    "column",
    "primary",
    "key",
    "foreign",
    "references",
    "not",
    "null",
    "unique",
    "default",
    "join",
    "left",
    "right",
    "inner",
    "outer",
    "on",
    "group",
    "by",
    "order",
    "having",
    "limit",
    "offset",
    "and",
    "or",
    "in",
    "exists",
    "between",
    "like",
    "as",
    "distinct",
    "union",
    "all",
    "case",
    "when",
    "then",
    "else",
    "end",
    "check",
    "constraint",
    "if",
  ].flatMap((kw) => [kw, kw.toUpperCase()]),
);

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "while",
  "case",
  "esac",
  "function",
  "return",
  "local",
  "export",
  "set",
  "echo",
  "exit",
  "shift",
  "source",
]);

const LANGUAGES: Record<string, LanguageConfig> = {
  javascript: {
    lineComment: "//",
    blockComment: ["/*", "*/"],
    extraStringDelimiters: ["`"],
    keywords: JS_KEYWORDS,
  },
  typescript: {
    lineComment: "//",
    blockComment: ["/*", "*/"],
    extraStringDelimiters: ["`"],
    keywords: JS_KEYWORDS,
  },
  python: { lineComment: "#", keywords: PYTHON_KEYWORDS },
  go: {
    lineComment: "//",
    blockComment: ["/*", "*/"],
    extraStringDelimiters: ["`"],
    keywords: GO_KEYWORDS,
  },
  rust: { lineComment: "//", blockComment: ["/*", "*/"], keywords: RUST_KEYWORDS },
  java: { lineComment: "//", blockComment: ["/*", "*/"], keywords: JAVA_KEYWORDS },
  kotlin: { lineComment: "//", blockComment: ["/*", "*/"], keywords: JAVA_KEYWORDS },
  swift: { lineComment: "//", blockComment: ["/*", "*/"], keywords: JS_KEYWORDS },
  c: { lineComment: "//", blockComment: ["/*", "*/"], keywords: C_KEYWORDS },
  cpp: { lineComment: "//", blockComment: ["/*", "*/"], keywords: C_KEYWORDS },
  csharp: { lineComment: "//", blockComment: ["/*", "*/"], keywords: JAVA_KEYWORDS },
  php: { lineComment: "//", blockComment: ["/*", "*/"], keywords: JS_KEYWORDS },
  ruby: { lineComment: "#", keywords: RUBY_KEYWORDS },
  shell: { lineComment: "#", keywords: SHELL_KEYWORDS },
  sql: { lineComment: "--", blockComment: ["/*", "*/"], keywords: SQL_KEYWORDS },
  yaml: { lineComment: "#", keywords: new Set(["true", "false", "null"]) },
  toml: { lineComment: "#", keywords: new Set(["true", "false"]) },
  json: { keywords: new Set(["true", "false", "null"]) },
  css: { blockComment: ["/*", "*/"], keywords: new Set() },
  graphql: {
    lineComment: "#",
    keywords: new Set([
      "query",
      "mutation",
      "type",
      "input",
      "enum",
      "interface",
      "fragment",
      "on",
      "schema",
    ]),
  },
};

/** Files above this size render unhighlighted to bound CPU per request. */
const MAX_HIGHLIGHT_BYTES = 256 * 1024;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function span(cls: string, text: string): string {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

const WORD_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER_RE = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)/;

/**
 * Highlight source code into HTML. Returns null when the language is not
 * supported or the input is too large — callers fall back to plain text.
 * All emitted text is HTML-escaped.
 */
export function highlightCode(code: string, language: string): string | null {
  const config = LANGUAGES[language];
  if (!config) return null;
  if (code.length > MAX_HIGHLIGHT_BYTES) return null;

  const stringDelimiters = new Set(['"', "'", ...(config.extraStringDelimiters ?? [])]);
  const out: string[] = [];
  let plain = "";
  let i = 0;

  const flushPlain = () => {
    if (plain) {
      out.push(escapeHtml(plain));
      plain = "";
    }
  };

  while (i < code.length) {
    const rest = code.slice(i);

    if (config.blockComment && rest.startsWith(config.blockComment[0])) {
      const end = code.indexOf(config.blockComment[1], i + config.blockComment[0].length);
      const stop = end === -1 ? code.length : end + config.blockComment[1].length;
      flushPlain();
      out.push(span("comment", code.slice(i, stop)));
      i = stop;
      continue;
    }

    if (config.lineComment && rest.startsWith(config.lineComment)) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      flushPlain();
      out.push(span("comment", code.slice(i, stop)));
      i = stop;
      continue;
    }

    const char = code[i] as string;
    if (stringDelimiters.has(char)) {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === char) {
          j += 1;
          break;
        }
        // Unterminated single-line strings stop at the newline (except template literals).
        if (code[j] === "\n" && char !== "`") break;
        j += 1;
      }
      flushPlain();
      out.push(span("string", code.slice(i, Math.min(j, code.length))));
      i = Math.min(j, code.length);
      continue;
    }

    const numberMatch = NUMBER_RE.exec(rest);
    if (numberMatch && !/[A-Za-z0-9_$]/.test(code[i - 1] ?? "")) {
      flushPlain();
      out.push(span("number", numberMatch[0]));
      i += numberMatch[0].length;
      continue;
    }

    const wordMatch = WORD_RE.exec(rest);
    if (wordMatch) {
      const word = wordMatch[0];
      if (config.keywords.has(word)) {
        flushPlain();
        out.push(span("keyword", word));
      } else {
        plain += word;
      }
      i += word.length;
      continue;
    }

    plain += char;
    i += 1;
  }

  flushPlain();
  return out.join("");
}
