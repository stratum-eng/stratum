// Regenerates the raster brand assets from the Stratum mark.
// Run with `npm run brand` after changing the mark; outputs are committed so the
// site build never depends on font availability in CI.
import sharp from "sharp";
import { writeFile } from "node:fs/promises";

const MONO = "JetBrains Mono, DejaVu Sans Mono, monospace";
const INK = "#0a0a0a";
const TILE = "#0d0d0d";
const ACCENT = "#7ca9f7";
const TEXT = "#f0f0f0";
const MUTED = "#8a8a8a";

const mark = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="${TILE}"/>
  <text x="16" y="23" font-family="${MONO}" font-size="20" font-weight="700"
        fill="${ACCENT}" text-anchor="middle">S</text>
</svg>`;

const ogCard = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="${INK}"/>
  <rect x="0" y="0" width="1200" height="4" fill="${ACCENT}"/>
  <g transform="translate(100,120)">
    <rect width="112" height="112" rx="21" fill="${TILE}"/>
    <text x="56" y="81" font-family="${MONO}" font-size="70" font-weight="700"
          fill="${ACCENT}" text-anchor="middle">S</text>
  </g>
  <text x="100" y="221" font-family="${MONO}" font-size="76" font-weight="700"
        fill="${TEXT}" letter-spacing="4" dy="120">stratum</text>
  <text x="100" y="420" font-family="${MONO}" font-size="31" fill="${MUTED}">The governance layer for AI-written code</text>
  <text x="100" y="470" font-family="${MONO}" font-size="31" fill="${MUTED}">Evaluation-gated merges. Provenance. Agent identities.</text>
  <text x="100" y="552" font-family="${MONO}" font-size="27" fill="${ACCENT}">docs.usestratum.dev</text>
</svg>`;

const png = (svg, file) =>
  sharp(Buffer.from(svg)).png().toFile(file).then(() => console.log("wrote", file));

await png(mark(32), "public/favicon-32.png");
await png(mark(180), "public/apple-touch-icon.png");
await png(ogCard, "public/og.png");
await writeFile("public/og.svg", ogCard);
console.log("wrote public/og.svg");
