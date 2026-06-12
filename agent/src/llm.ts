/** Claude API call for the edit step — plain fetch, no SDK dependency. */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;

export interface EditPlan {
  files: Record<string, string>;
  commitMessage: string;
  summary: string;
}

export interface RepoContext {
  fileTree: string[];
  fileContents: Map<string, string>;
}

function buildPrompt(objective: string, context: RepoContext): string {
  const sections: string[] = [
    `Objective: ${objective}`,
    "",
    "Repository file tree:",
    ...context.fileTree.map((f) => `  ${f}`),
    "",
    "File contents:",
  ];
  for (const [path, content] of context.fileContents) {
    sections.push(`--- ${path} ---`, content, "");
  }
  return sections.join("\n");
}

const SYSTEM_PROMPT = `You are a coding agent working on a repository. Given an objective and the
repository contents, produce the complete new contents of every file you need
to create or modify to accomplish the objective. Keep changes minimal and
consistent with the existing code style.

Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{"files": {"path/to/file.ts": "full new content"}, "commitMessage": "...", "summary": "..."}`;

export async function planEdits(
  apiKey: string,
  model: string,
  objective: string,
  context: RepoContext,
): Promise<EditPlan> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(objective, context) }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  const body = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  const text = body.content.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("Claude returned no text content");
  }
  if (body.stop_reason === "max_tokens") {
    throw new Error("Claude response was truncated (max_tokens) — try a narrower objective");
  }

  return parseEditPlan(text);
}

/** Parse the model's JSON response, tolerating accidental markdown fences. */
export function parseEditPlan(text: string): EditPlan {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude response was not valid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as EditPlan).commitMessage !== "string" ||
    typeof (parsed as EditPlan).files !== "object" ||
    (parsed as EditPlan).files === null
  ) {
    throw new Error("Claude response is missing files or commitMessage");
  }

  const plan = parsed as EditPlan;
  const entries = Object.entries(plan.files);
  if (entries.length === 0) {
    throw new Error("Claude proposed no file changes");
  }
  for (const [path, content] of entries) {
    if (typeof content !== "string") {
      throw new Error(`Claude proposed non-string content for '${path}'`);
    }
    if (path.includes("..") || path.startsWith("/")) {
      throw new Error(`Claude proposed an unsafe path: '${path}'`);
    }
  }

  return {
    files: plan.files,
    commitMessage: plan.commitMessage,
    summary: typeof plan.summary === "string" ? plan.summary : plan.commitMessage,
  };
}
