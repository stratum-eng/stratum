import { StratumClient } from "./client.js";
import { getConfig } from "./config.js";

/**
 * Shared command wrapper: resolves config, runs the action, and converts
 * failures into a single-line error plus non-zero exit.
 */
export async function withClient(action: (client: StratumClient) => Promise<void>): Promise<void> {
  let client: StratumClient;
  try {
    const config = await getConfig();
    client = new StratumClient(config.host, config.apiKey);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await action(client);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}
