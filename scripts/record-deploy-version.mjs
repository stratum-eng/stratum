/**
 * Record what `wrangler deploy` just deployed, for Stratum's deploy pipeline
 * (#416, `.stratum/ci.yaml`).
 *
 * Usage: node scripts/record-deploy-version.mjs <wrangler-output-file>
 *
 * Wrangler writes one JSON record per line to `WRANGLER_OUTPUT_FILE_PATH`; the
 * `deploy` record carries the Worker version id it created. That id is what
 * `wrangler rollback <version-id>` takes, so it is what Stratum stores on the
 * deployment and hands back to a rollback. It is written to the file the
 * executor names in `STRATUM_DEPLOY_VERSION_FILE`.
 *
 * Exits non-zero when no version can be found: a deployment recorded without
 * one can only be rolled back by re-running the whole pipeline at its commit,
 * and that is worth failing loudly over rather than discovering during an
 * incident.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The version id of the last `deploy` record in Wrangler's ND-JSON output.
 *
 * @param {string} ndjson Contents of the file at `WRANGLER_OUTPUT_FILE_PATH`.
 * @returns {string | null} The version id, or null when there is none.
 */
export function deployedVersion(ndjson) {
  let version = null;
  for (const line of ndjson.split("\n")) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A line Wrangler was still writing, or not JSON at all: not a record.
      continue;
    }
    if (record?.type === "deploy" && typeof record.version_id === "string") {
      version = record.version_id;
    }
  }
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [outputFile] = process.argv.slice(2);
  const target = process.env.STRATUM_DEPLOY_VERSION_FILE;
  if (!outputFile || !target) {
    console.error(
      "usage: STRATUM_DEPLOY_VERSION_FILE=<file> node scripts/record-deploy-version.mjs <wrangler-output-file>",
    );
    process.exit(2);
  }
  const version = deployedVersion(readFileSync(outputFile, "utf8"));
  if (version === null) {
    console.error(`No deploy record with a version id in ${outputFile}`);
    process.exit(1);
  }
  writeFileSync(target, `${version}\n`);
  console.log(`Recorded deployed version ${version}`);
}
