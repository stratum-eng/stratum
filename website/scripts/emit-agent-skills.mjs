// Regenerates public/.well-known/agent-skills/index.json from the SKILL.md files
// that sit beside it (Agent Skills Discovery RFC v0.2.0).
//
// The index carries a sha256 digest per skill so an agent can verify what it
// downloaded. A hand-maintained digest silently rots the moment anyone edits a
// skill, and a stale digest is worse than none — it makes a correct download
// look tampered with. So the digests are derived, never typed, and
// `tests/agent-discovery-metadata.test.ts` fails the build if the committed index
// drifts from the files.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SKILLS_DIR = "public/.well-known/agent-skills";
const INDEX_PATH = join(SKILLS_DIR, "index.json");
const SITE = "https://docs.usestratum.dev";

/** Reads `name:` / `description:` out of a SKILL.md YAML front-matter block. */
const frontMatter = (raw, key) =>
  raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();

export async function buildIndex(dir = SKILLS_DIR, site = SITE) {
  const entries = await readdir(dir, { withFileTypes: true });
  const skills = [];

  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name, "SKILL.md");
    const raw = await readFile(path, "utf8");
    const name = frontMatter(raw, "name");
    const description = frontMatter(raw, "description");
    if (!name || !description) {
      throw new Error(`${path}: SKILL.md front matter must set both "name" and "description"`);
    }
    if (name !== entry.name) {
      throw new Error(`${path}: front-matter name "${name}" must match its directory "${entry.name}"`);
    }
    skills.push({
      name,
      type: "skill-md",
      description,
      // Hash the bytes on the wire, not the decoded string: an agent verifies
      // what it downloaded, and re-encoding could differ from the file.
      digest: `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`,
      url: `${site}/.well-known/agent-skills/${name}/SKILL.md`,
    });
  }

  if (skills.length === 0) throw new Error(`${dir}: no skills found`);

  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    name: "Stratum",
    description:
      "Skills for driving Stratum — the open-source, agent-first code forge.",
    homepage: `${site}/`,
    // Deliberately MIT, not the repository's AGPL: these skills exist to be
    // fetched and embedded in third-party agents, which is the one thing
    // copyleft on a discovery artifact would discourage. They carry no
    // implementation. See LICENSING.md — this is an explicit carve-out, not a
    // line that was missed when the project relicensed.
    license: "MIT",
    skills,
  };
}

// Only write when run directly, so the test can import buildIndex without
// rewriting the working tree as a side effect.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const index = await buildIndex();
  await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`emit-agent-skills: indexed ${index.skills.length} skills into ${INDEX_PATH}`);
}
