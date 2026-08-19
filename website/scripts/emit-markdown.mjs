// Emits a .md twin of every docs page into dist/, so the Worker can serve
// Markdown to agents that send `Accept: text/markdown` (Markdown for Agents).
// Runs after `astro build`.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";

const SRC = "src/content/docs";
const OUT = "dist";

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = await walk(SRC);
let written = 0;

for (const file of files) {
  const raw = await readFile(file, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const body = match ? raw.slice(match[0].length) : raw;
  const title = match?.[1].match(/^title:\s*(.+)$/m)?.[1].trim() ?? "";

  const slug = relative(SRC, file).replace(/\.md$/, "").split(sep).join("/");
  const dest = join(OUT, `${slug}.md`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, title ? `# ${title}\n\n${body.trimStart()}` : body);
  written++;
}

console.log(`emit-markdown: wrote ${written} markdown twins into ${OUT}/`);
