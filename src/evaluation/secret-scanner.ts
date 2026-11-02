import type { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import type { Result } from "../utils/result";
import { ok } from "../utils/result";
import type { EvalPolicy, EvalResult, Evaluator } from "./types";

const SECRET_PATTERNS = [
  { name: "AWS Access Key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: "AWS Secret Key",
    pattern: /aws.{0,30}?['"][0-9A-Za-z/+=]{40}['"]/i,
  },
  { name: "GitHub Token (Classic)", pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: "GitHub OAuth Token", pattern: /gho_[a-zA-Z0-9]{36}/ },
  { name: "GitHub User-to-Server Token", pattern: /ghu_[a-zA-Z0-9]{36}/ },
  { name: "GitHub App Token", pattern: /ghs_[a-zA-Z0-9]{36}/ },
  { name: "GitHub Refresh Token", pattern: /ghr_[a-zA-Z0-9]{76}/ },
  { name: "GitHub Fine-Grained PAT", pattern: /github_pat_[a-zA-Z0-9_]{82}/ },
  { name: "GitLab Personal Access Token", pattern: /glpat-[0-9a-zA-Z_-]{20}/ },
  { name: "Slack Token", pattern: /xox[baprs]-[0-9a-zA-Z-]{10,}/ },
  {
    name: "Slack Webhook URL",
    pattern: /hooks\.slack\.com\/services\/T[0-9A-Z]+\/B[0-9A-Z]+\/[0-9a-zA-Z]+/,
  },
  { name: "Stripe Live Key", pattern: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/ },
  { name: "OpenAI API Key (Legacy)", pattern: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/ },
  { name: "OpenAI API Key (Project)", pattern: /\bsk-proj-[A-Za-z0-9_-]{40,}\b/ },
  { name: "Anthropic API Key", pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/ },
  { name: "Google API Key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "npm Access Token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "PyPI Upload Token", pattern: /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/ },
  { name: "Hugging Face Token", pattern: /\bhf_[A-Za-z0-9]{34}\b/ },
  {
    name: "SendGrid API Key",
    pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/,
  },
  { name: "Twilio API Key", pattern: /\bSK[0-9a-f]{32}\b/ },
  {
    name: "Private Key Block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/,
  },
  {
    name: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  },
  {
    name: "Connection String Credential",
    pattern:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]+@/,
  },
  { name: "Azure Storage Account Key", pattern: /AccountKey=[A-Za-z0-9+/=]{40,}/ },
  { name: "Stratum User Token", pattern: /stratum_user_[a-f0-9]{32}/ },
  { name: "Stratum Agent Token", pattern: /stratum_agent_[a-f0-9]{32}/ },
  // Every credential the MCP OAuth server mints (#349), in one pattern: the
  // access token (`stratum_mcp_`), its refresh token (`stratum_mcprt_`), an
  // authorization code (`stratum_mcpac_`), and a confidential client's secret
  // (`stratum_mcpcs_`). The infixes are disjoint from the bare `mcp` arm, so
  // each shape matches exactly one alternative.
  {
    name: "Stratum MCP OAuth Credential",
    pattern: /stratum_mcp(?:rt|ac|cs)?_[a-f0-9]{32}/,
  },
];

/**
 * Generic credential assignments the named patterns miss. Gated on a
 * credential-ish keyword on the same line so ordinary identifiers and hashes
 * in test fixtures don't trip a blocking gate.
 */
// The optional `:\s*[^=;\n]*=` arm consumes a TypeScript type annotation
// (`const apiToken: string = "..."`) so typed assignments can't evade the scan.
// The regex matches ANY identifier-like assignment of a long token-ish value
// (global, so every assignment on a line is examined — a low-entropy first
// match can't mask a later credential); whether the NAME is credential-ish is
// decided by `isCredentialName`, which respects snake/camel segment boundaries
// so the `key` inside `monkey` can't trip a blocking false positive.
const ASSIGNMENT_CANDIDATE =
  /([A-Za-z_$][A-Za-z0-9_$]*)['"]?\s*(?:=\s*|:\s*(?:[^=;\n]*=\s*)?)['"`]?([A-Za-z0-9+/_=-]{24,})/g;

const CREDENTIAL_KEYWORDS = [
  "secret",
  "token",
  "key",
  "passwd",
  "password",
  "credential",
  "auth",
] as const;

/**
 * True when the identifier contains a credential keyword starting at a
 * snake/camel segment boundary: `apiKey`, `api_key`, `token`, `mySecret` —
 * but not the `key` buried inside `monkey`.
 */
function isCredentialName(identifier: string): boolean {
  const lower = identifier.toLowerCase();
  for (const keyword of CREDENTIAL_KEYWORDS) {
    let from = 0;
    let idx = lower.indexOf(keyword, from);
    while (idx !== -1) {
      const prev = idx === 0 ? "" : (identifier[idx - 1] ?? "");
      const atBoundary =
        idx === 0 ||
        prev === "_" ||
        prev === "$" ||
        /[0-9]/.test(prev) ||
        (/[a-z]/.test(prev) && /[A-Z]/.test(identifier[idx] ?? ""));
      if (atBoundary) return true;
      from = idx + 1;
      idx = lower.indexOf(keyword, from);
    }
  }
  return false;
}

const ENTROPY_MIN_MIXED = 4.0;
const ENTROPY_MIN_HEX = 3.5;

export function shannonEntropy(value: string): number {
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function highEntropyCandidate(line: string): string | undefined {
  ASSIGNMENT_CANDIDATE.lastIndex = 0;
  let match = ASSIGNMENT_CANDIDATE.exec(line);
  while (match !== null) {
    const identifier = match[1];
    const candidate = match[2];
    if (identifier && candidate && isCredentialName(identifier)) {
      const threshold = /^[0-9a-f]+$/i.test(candidate) ? ENTROPY_MIN_HEX : ENTROPY_MIN_MIXED;
      if (shannonEntropy(candidate) >= threshold) return candidate;
    }
    match = ASSIGNMENT_CANDIDATE.exec(line);
  }
  return undefined;
}

/**
 * Name the first secret pattern a single line of text matches, or undefined.
 *
 * Takes the line already stripped of any diff marker, so the same rules apply
 * to diff-derived and raw content.
 */
function matchSecret(line: string): string | undefined {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(line)) return name;
  }
  return highEntropyCandidate(line) ? "High-Entropy Credential" : undefined;
}

/**
 * Scan raw file content — not a diff — for secrets.
 *
 * Callers that hold the literal bytes about to be committed should use this
 * rather than synthesising a diff to feed `SecretScanEvaluator.evaluate`.
 * Prefixing content lines with "+" is not a lossless encoding — a content line
 * starting with "++" is indistinguishable from a "+++" file header by prefix
 * alone — so the evaluator recovers the distinction from the diff's structure
 * instead. Scanning content directly needs no such recovery, and is the
 * simpler thing to reason about when the bytes are already in hand.
 *
 * @returns One issue string per finding, empty when the content is clean.
 */
export function scanContentForSecrets(files: Array<{ file: string; content: string }>): string[] {
  const issues: string[] = [];
  for (const { file, content } of files) {
    content.split("\n").forEach((line, idx) => {
      const name = matchSecret(line);
      if (name) issues.push(`${name}: ${file} line ${idx + 1}`);
    });
  }
  return issues;
}

export class SecretScanEvaluator implements Evaluator {
  async evaluate(
    diff: string,
    _policy: EvalPolicy,
    logger: Logger,
  ): Promise<Result<EvalResult, AppError>> {
    const issues: string[] = [];

    // Headers are recognised by POSITION, not by prefix. A diff prefixes every
    // added line with "+", so file content beginning with "++" arrives as
    // "+++…" and content beginning with "++ " arrives as "+++ …" — both
    // indistinguishable from a file header to any prefix test, and both
    // therefore a way to walk a credential past an always-on blocking gate.
    //
    // Git's structure decides instead: "+++ b/path" always immediately follows
    // "--- a/path", and only before the first hunk of a file. A "+++ …" line
    // anywhere else is content, so there is no shape a line can take to be
    // mistaken for a header.
    //
    // Anchored on the adjacent header pair rather than on "@@" deliberately.
    // Scanning only after a hunk header would be the stricter reading, but a
    // caller that hands over a diff with no "@@" — or a bare list of "+" lines
    // — would then have every added line skipped, and a scanner that silently
    // scans nothing is a worse failure than the one this fixes.
    let inHunkBody = false;
    let prevWasOldFileHeader = false;

    const lines = diff.split("\n");
    lines.forEach((line, idx) => {
      if (line.startsWith("diff --git ")) {
        inHunkBody = false;
        prevWasOldFileHeader = false;
        return;
      }
      if (line.startsWith("@@")) {
        inHunkBody = true;
        prevWasOldFileHeader = false;
        return;
      }
      // Before any hunk, "--- " can only be the old-file header: content lines
      // carry a "+"/"-"/" " marker and cannot appear here. Inside a hunk it is
      // a removed line whose text starts with "-- ", which is skipped below.
      if (!inHunkBody && line.startsWith("--- ")) {
        prevWasOldFileHeader = true;
        return;
      }
      const isNewFileHeader = !inHunkBody && prevWasOldFileHeader && line.startsWith("+++ ");
      prevWasOldFileHeader = false;
      if (isNewFileHeader) return;

      if (!line.startsWith("+")) return;
      // Exactly one marker, so the patterns see the real file line rather than
      // one with a "+" welded to its first token.
      const content = line.slice(1);
      const lineNumber = idx + 1;
      const name = matchSecret(content);
      if (name) {
        issues.push(`${name}: line ${lineNumber}`);
      }
    });

    if (issues.length > 0) {
      logger.warn("Secrets detected in diff", { issueCount: issues.length });
      return ok({
        score: 0,
        passed: false,
        reason: `Secret detected: ${issues[0]?.split(":")[0] ?? "unknown"}`,
        issues,
      });
    }

    logger.info("Secret scan complete - no secrets detected");
    return ok({
      score: 1,
      passed: true,
      reason: "No secrets detected",
    });
  }
}
