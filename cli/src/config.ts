import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StratumConfig {
  host: string;
  apiKey: string;
}

function configPath(): string {
  return join(homedir(), ".stratum", "config.json");
}

export async function readConfig(): Promise<StratumConfig | null> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    return JSON.parse(raw) as StratumConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(config: StratumConfig): Promise<void> {
  await mkdir(join(homedir(), ".stratum"), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Resolve configuration: STRATUM_HOST / STRATUM_API_KEY environment variables
 * override the config file (useful in CI and agents).
 */
export async function getConfig(): Promise<StratumConfig> {
  const envHost = process.env.STRATUM_HOST;
  const envKey = process.env.STRATUM_API_KEY;
  if (envHost && envKey) return { host: envHost, apiKey: envKey };

  const config = await readConfig();
  if (!config) {
    throw new Error("Not configured. Run: stratum login (or set STRATUM_HOST and STRATUM_API_KEY)");
  }
  return {
    host: envHost ?? config.host,
    apiKey: envKey ?? config.apiKey,
  };
}
