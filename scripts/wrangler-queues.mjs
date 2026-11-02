/**
 * Print the queue names `wrangler.toml` binds for one environment, one per line.
 *
 * Usage: node scripts/wrangler-queues.mjs [env]   (env omitted = top-level config)
 *
 * Exists because a deploy fails outright on a bound queue that does not exist,
 * and the CI jobs that provision queues used to carry their own hardcoded
 * copies of the list. Production had no such job at all until deploys added
 * `stratum-deploys`, so the first deploy after that merge failed — the queue was
 * bound and never created. A second copy of the list only moves that failure
 * rather than removing it: bind a queue in `wrangler.toml`, forget the
 * workflow, and the next deploy breaks the same way. The TOML is therefore the
 * single source, and CI reads it.
 *
 * Hand-rolled rather than parsed with a library: no TOML parser is on the
 * dependency list, and pulling one in to read a file this repo controls is a
 * worse trade than ~30 lines. It understands only what it needs — section
 * headers and `key = "value"` — which is all the queue blocks use.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SECTION = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*$/;
/** Both keys name a queue that must exist before a deploy: a consumer's
 *  `dead_letter_queue` is provisioned exactly like its `queue`. */
const QUEUE_KEY = /^\s*(queue|dead_letter_queue)\s*=\s*"([^"]+)"/;

/**
 * @param {string} toml Raw `wrangler.toml` contents.
 * @param {string} env Environment name; empty string means the top-level config.
 * @returns {string[]} Sorted, de-duplicated queue names.
 */
export function queueNamesFor(toml, env) {
  const prefix = env ? `env.${env}.queues.` : "queues.";
  const names = new Set();
  let inQueueSection = false;

  for (const line of toml.split("\n")) {
    const section = line.match(SECTION);
    if (section) {
      // A named env's blocks are `env.<name>.queues.*`, which also start with
      // the top-level `queues.` prefix only after the env part is stripped —
      // so match the whole prefix, never a substring, or the top-level lookup
      // would sweep up every environment's queues.
      inQueueSection = section[1].startsWith(prefix);
      continue;
    }
    if (!inQueueSection) continue;
    const key = line.match(QUEUE_KEY);
    if (key) names.add(key[2]);
  }

  return [...names].sort();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const env = process.argv[2] ?? "";
  const here = dirname(fileURLToPath(import.meta.url));
  const toml = readFileSync(join(here, "..", "wrangler.toml"), "utf8");
  const names = queueNamesFor(toml, env);

  if (names.length === 0) {
    // Silence here would mean "provision nothing", and the deploy that follows
    // would fail on the first bound queue. A typo'd env name must be loud.
    console.error(`No queues found for env "${env || "(top-level)"}" in wrangler.toml`);
    process.exit(1);
  }
  console.log(names.join("\n"));
}
