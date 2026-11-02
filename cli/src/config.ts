import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AuthServerMetadata,
  type OAuthTokens,
  discover,
  normalizeHost,
  refreshTokens,
} from "./oauth.js";

/**
 * An OAuth grant from `stratum login`. The refresh token rotates on every use,
 * so this record is rewritten each time it is refreshed.
 */
export interface OAuthCredential {
  kind: "oauth";
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
}

/** A long-lived API token, from `stratum login --key` or the environment. */
export interface ApiKeyCredential {
  kind: "apiKey";
  apiKey: string;
}

export type Credential = OAuthCredential | ApiKeyCredential;

export interface StratumConfig {
  host: string;
  credential: Credential;
}

/**
 * On-disk shape. `apiKey` at the top level is the format every previous
 * release wrote and the one the docs describe, so it is read and written
 * unchanged; OAuth grants live under their own key rather than overloading it.
 */
interface ConfigFile {
  host?: string;
  apiKey?: string;
  oauth?: Partial<Omit<OAuthCredential, "kind">>;
}

function configDir(): string {
  return join(homedir(), ".stratum");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export async function readConfig(): Promise<StratumConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf-8");
  } catch (err) {
    // Absence is the "not logged in" case and the only one worth answering with
    // null. A permissions or I/O failure answered the same way becomes "Not
    // configured. Run: stratum login" — advice that cannot work — and, worse,
    // lets rotateGuarded believe nobody else has rotated.
    if (isErrnoCode(err, "ENOENT")) return null;
    throw new Error(
      `could not read ${configPath()}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return fromFile(JSON.parse(raw) as ConfigFile);
  } catch {
    throw new Error(`${configPath()} is not valid JSON. Run: stratum login`);
  }
}

export function fromFile(parsed: ConfigFile): StratumConfig | null {
  if (!parsed.host) return null;
  const oauth = parsed.oauth;
  if (oauth?.accessToken && oauth.refreshToken && oauth.clientId) {
    return {
      host: parsed.host,
      credential: {
        kind: "oauth",
        clientId: oauth.clientId,
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt ?? new Date(0).toISOString(),
        scope: oauth.scope ?? "",
      },
    };
  }
  if (parsed.apiKey) {
    return { host: parsed.host, credential: { kind: "apiKey", apiKey: parsed.apiKey } };
  }
  return null;
}

export function toFile(config: StratumConfig): ConfigFile {
  if (config.credential.kind === "apiKey") {
    return { host: config.host, apiKey: config.credential.apiKey };
  }
  const { kind: _kind, ...oauth } = config.credential;
  return { host: config.host, oauth };
}

function lockPath(): string {
  return join(configDir(), "config.lock");
}

/**
 * Flush the directory entry `rename` just created.
 *
 * Syncing the temp file's contents is only half of durability: the rename
 * itself lives in the parent directory, and after a power cut that entry can be
 * missing even though the data blocks were flushed. Post-rotation that is a
 * lost session, because the refresh token exists nowhere else.
 *
 * Best effort — opening a directory for sync is not portable (Windows refuses),
 * and a platform that cannot do it should not fail an otherwise good write.
 */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Durability improves where the platform allows it and is unchanged where
    // it does not; either way the credential is already renamed into place.
  }
}

/**
 * Write the credential file atomically, and leave it readable only by its owner.
 *
 * Two properties, one mechanism. Writing a temp file and `rename`ing it over the
 * target means a reader never observes a half-written file and a crash mid-write
 * leaves the previous credential intact — which matters more than it looks,
 * because after a rotation the new refresh token exists ONLY here, so a torn
 * write is a permanently lost session.
 *
 * The rename also fixes the permissions of an existing install. `mode` on
 * `writeFile`/`mkdir` is honoured only when the call actually creates the node,
 * so rewriting a file an older release left at 0644 keeps 0644 — the token stays
 * world-readable. Because `rename` replaces the inode, the file inherits the
 * temp file's 0600 no matter what the old one had.
 */
export async function writeConfig(config: StratumConfig): Promise<void> {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Same reasoning as above: mkdir's mode is a no-op on a directory that already
  // exists, so an upgraded install needs this explicitly.
  await chmod(dir, 0o700).catch((err: unknown) => {
    process.stderr.write(
      `Warning: could not restrict ${dir} to owner-only: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });

  const temp = join(dir, `.config.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(toFile(config), null, 2)}\n`, "utf-8");
      // `rename` is atomic against other processes but says nothing about
      // durability: after a power cut the rename can survive while the data
      // blocks do not, leaving an empty config and — post-rotation, when the
      // refresh token exists nowhere else — an unrecoverable session.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, configPath());
    await syncDirectory(dir);
  } catch (err) {
    await rm(temp, { force: true });
    throw new Error(
      `could not write ${configPath()}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Two ordering rules, and both matter:
 *
 * `LOCK_STALE_MS` > the worst-case hold — a discovery round trip plus a token
 * round trip, two 30s timeouts, so 60s. A stale threshold at or below that lets
 * a HEALTHY holder be declared dead, and two processes then present the same
 * refresh token, which the server reads as theft and revokes the whole grant.
 *
 * `LOCK_TIMEOUT_MS` > `LOCK_STALE_MS` — a waiter has to outlive the staleness
 * threshold to be the one that breaks an abandoned lock. Inverted, a process
 * killed mid-rotation wedges every later command: waiters give up before the
 * lock is old enough to remove, so nothing ever clears it.
 */
const LOCK_STALE_MS = 120_000;
const LOCK_TIMEOUT_MS = 150_000;
const LOCK_POLL_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}

/** Raised when another process held the lock for longer than we will wait. */
export class LockTimeoutError extends Error {
  constructor(path: string) {
    super(`timed out waiting for another stratum process to refresh the session (${path})`);
    this.name = "LockTimeoutError";
  }
}

/**
 * Delete the lock only if we still hold it.
 *
 * An unconditional `rm` in the release path is worse than no lock at all: once
 * any holder has been broken as stale, its exit deletes the *next* holder's
 * lock, and from then on every process can enter at once. The nonce is what
 * makes release idempotent and safe.
 */
async function releaseLock(path: string, nonce: string): Promise<void> {
  const held = await readFile(path, "utf-8").catch(() => null);
  if (held === null || held.trim() === nonce) await rm(path, { force: true });
}

/**
 * Hold an exclusive, cross-process lock for the duration of `action`.
 *
 * `wx` fails when the file exists, which is the whole mechanism: it is one
 * atomic filesystem operation, so two processes cannot both believe they hold
 * the lock. A stale lock is broken on age rather than by trusting a recorded
 * pid, because a pid can be recycled.
 *
 * Acquisition failures and failures raised by `action` are deliberately handled
 * apart. Folding them together means an errno that happens to be EEXIST from
 * inside `action` — `mkdir` on a path that exists as a regular file raises
 * exactly that — is mistaken for a busy lock, and the critical section runs a
 * second time with a refresh token the first attempt already retired.
 */
export async function withConfigLock<T>(action: () => Promise<T>): Promise<T> {
  const path = lockPath();
  const nonce = randomBytes(16).toString("hex");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(configDir(), { recursive: true, mode: 0o700 });

  for (;;) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (err) {
      if (!isErrnoCode(err, "EEXIST")) throw err;
      const info = await stat(path).catch(() => null);
      // `open(dir, "wx")` also reports EEXIST, and a plain `rm` of a directory
      // then throws EISDIR — which would wedge every future command behind an
      // error that names neither the cause nor the cure.
      if (info?.isDirectory()) {
        throw new Error(`${path} is a directory; remove it and retry`);
      }
      const age = info === null ? Number.POSITIVE_INFINITY : Date.now() - info.mtimeMs;
      if (age > LOCK_STALE_MS) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(path);
      await delay(LOCK_POLL_MS);
      continue;
    }

    try {
      await handle.writeFile(nonce, "utf-8");
      return await action();
    } finally {
      await handle.close().catch(() => {});
      await releaseLock(path, nonce);
    }
  }
}

export async function clearConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}

/** Refresh this far before the token actually expires, to cover a slow request. */
const REFRESH_SKEW_MS = 60_000;

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at - REFRESH_SKEW_MS <= now;
}

/**
 * Supplies the bearer token for each request, and knows whether a 401 is worth
 * retrying. An API key is a constant; an OAuth grant rotates under us.
 */
export interface TokenProvider {
  token(): Promise<string>;
  /** New token, or null when this credential cannot be renewed. */
  refresh(): Promise<string | null>;
}

class ApiKeyProvider implements TokenProvider {
  constructor(private readonly key: string) {}
  async token(): Promise<string> {
    return this.key;
  }
  async refresh(): Promise<null> {
    return null;
  }
}

/**
 * Raised when the stored credential was replaced while we waited to rotate.
 * Rotating anyway would overwrite whatever the user just did — a fresh
 * `login --key`, or a `logout` — and in the logout case would resurrect a
 * credential file they deliberately deleted.
 */
class CredentialChangedError extends Error {
  constructor(detail: string) {
    super(`the stored credential changed while refreshing (${detail}); rerun the command`);
    this.name = "CredentialChangedError";
  }
}

class OAuthProvider implements TokenProvider {
  /** Collapses refreshes *within* this process; the lockfile handles the rest. */
  private inFlight: Promise<string> | null = null;
  /** Cached so a refresh does not re-run discovery on every renewal. */
  private metadata: AuthServerMetadata | null = null;

  constructor(
    private readonly host: string,
    private credential: OAuthCredential,
    private readonly persist: boolean,
  ) {}

  async token(): Promise<string> {
    if (isExpired(this.credential.expiresAt)) return this.refresh();
    return this.credential.accessToken;
  }

  async refresh(): Promise<string> {
    this.inFlight ??= this.rotateGuarded().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Rotation is not merely a race — it is destructive when lost.
   *
   * The server treats a retired refresh token as evidence of theft: presenting
   * one matches `previous_refresh_token_hash` and revokes the ENTIRE grant
   * (OAuth 2.1 §4.3.1). So two `stratum` processes that both hold token R do not
   * just duplicate work; the loser's replay of R logs the user out of every
   * terminal. An in-process promise cannot prevent that, because the competitors
   * are separate processes — hence a filesystem lock, and a re-read inside it so
   * a process that waited adopts the winner's token instead of replaying its own.
   */
  private async rotateGuarded(): Promise<string> {
    if (!this.persist) return this.rotate(this.credential.refreshToken);
    try {
      return await withConfigLock(async () => this.rotateWithStored());
    } catch (err) {
      // The winner may have finished a moment after we gave up waiting. Its
      // token is on disk and perfectly usable; failing the command because our
      // patience ran out would be gratuitous.
      if (err instanceof LockTimeoutError) {
        const adopted = await this.adoptStored();
        if (adopted !== null) return adopted;
      }
      throw err;
    }
  }

  /** The stored credential, if it is a live grant for THIS host and not ours. */
  private async adoptStored(): Promise<string | null> {
    const stored = await this.storedCredential();
    if (stored === null || stored.refreshToken === this.credential.refreshToken) return null;
    this.credential = stored;
    return isExpired(stored.expiresAt) ? null : stored.accessToken;
  }

  /**
   * Read the credential this host's grant is stored under, refusing anything
   * that is not one. `readConfig` carries a host, and ignoring it is how a
   * concurrent `login --host other` ends with one host's refresh token being
   * POSTed to another.
   */
  private async storedCredential(): Promise<OAuthCredential | null> {
    const fresh = await readConfig();
    if (fresh === null) throw new CredentialChangedError("it was removed, or you logged out");
    if (normalizeHost(fresh.host) !== normalizeHost(this.host)) {
      throw new CredentialChangedError(`it now belongs to ${fresh.host}`);
    }
    if (fresh.credential.kind !== "oauth") {
      throw new CredentialChangedError("it is now an API token");
    }
    return fresh.credential;
  }

  private async rotateWithStored(): Promise<string> {
    const adopted = await this.adoptStored();
    if (adopted !== null) return adopted;
    return this.rotate(this.credential.refreshToken);
  }

  private async rotate(refreshToken: string): Promise<string> {
    this.metadata ??= await discover(this.host);
    const tokens: OAuthTokens = await refreshTokens(this.host, {
      clientId: this.credential.clientId,
      refreshToken,
      metadata: this.metadata,
    });
    this.credential = {
      kind: "oauth",
      clientId: tokens.clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope || this.credential.scope,
    };
    // The presented refresh token is spent, so losing this write means losing
    // the session — it is awaited, not fired and forgotten.
    if (this.persist) await writeConfig({ host: this.host, credential: this.credential });
    return this.credential.accessToken;
  }
}

export function providerFor(config: StratumConfig, persist = true): TokenProvider {
  return config.credential.kind === "apiKey"
    ? new ApiKeyProvider(config.credential.apiKey)
    : new OAuthProvider(config.host, config.credential, persist);
}

/**
 * Resolve configuration. `STRATUM_HOST` + `STRATUM_API_KEY` override the config
 * file entirely (CI and agents); a lone `STRATUM_HOST` retargets a stored
 * credential, which is only meaningful for an API key — an OAuth grant belongs
 * to the host that issued it, so pointing it elsewhere is refused rather than
 * silently sending someone's token to another server.
 */
export async function getConfig(): Promise<StratumConfig> {
  const envHost = process.env.STRATUM_HOST;
  const envKey = process.env.STRATUM_API_KEY;
  if (envHost && envKey) {
    return { host: envHost, credential: { kind: "apiKey", apiKey: envKey } };
  }

  const config = await readConfig();
  if (!config) {
    throw new Error("Not configured. Run: stratum login (or set STRATUM_HOST and STRATUM_API_KEY)");
  }
  if (envKey) {
    return { host: envHost ?? config.host, credential: { kind: "apiKey", apiKey: envKey } };
  }
  if (envHost && normalizeHost(envHost) !== normalizeHost(config.host)) {
    if (config.credential.kind === "oauth") {
      throw new Error(
        `STRATUM_HOST is ${envHost} but the stored session belongs to ${config.host}. ` +
          `Run: stratum login --host ${envHost} (or set STRATUM_API_KEY too).`,
      );
    }
    return { host: envHost, credential: config.credential };
  }
  return config;
}
