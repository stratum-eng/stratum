import type { Result } from "../../utils/result";
import { err, ok } from "../../utils/result";
import { redactAndTruncate } from "../redact";
import type { DeployFailure, DeployOutcome, DeployTarget, DeployTargetInput } from "./index";
import {
  enforceLimits,
  providerFailure,
  readJson,
  requireSecrets,
  secretValuesOf,
  selectFiles,
  toBase64,
  toHex,
  transportFailure,
} from "./shared";

/**
 * Publish a static tree to Cloudflare.
 *
 * ## Why this is Workers Static Assets and not Pages Direct Upload
 *
 * The `target:` name stayed `cloudflare-pages` because it is the user-facing
 * name for "publish my static site on Cloudflare" and it is fixed by
 * `DEPLOY_TARGETS` in `src/deploy/config.ts`. The *implementation* is Workers
 * Static Assets, for two reasons:
 *
 * 1. **Pages Direct Upload cannot be implemented without guessing.** Its
 *    public API reference documents only the create-deployment call; the
 *    asset endpoints Wrangler actually drives (an upload-token call, a
 *    check-missing call, an asset upload call) are not in the API reference at
 *    all. Writing a credentialed production deploy against a reverse-engineered
 *    surface is exactly what this feature's research rule forbids.
 * 2. **Cloudflare steers new work to Workers.** Its own Workers best-practices
 *    page says "If you are starting a new project, use Workers instead of
 *    Pages… new features and optimizations are focused on Workers", and the
 *    Pages migration index leads with "Start new projects with Workers."
 *
 * Workers Static Assets is fully documented, and a Worker with an `assets`
 * directory and no `main` is the documented shape for a static site — which is
 * why the metadata below carries no `main_module`. A repo that has a Worker
 * script belongs on the `cloudflare-workers` target.
 *
 * ## The three-phase flow
 *
 * 1. `POST /accounts/{id}/workers/scripts/{name}/assets-upload-session` with a
 *    manifest → an upload JWT (valid one hour) and `buckets`, the batches the
 *    API wants the files uploaded in. Files it already has are absent from
 *    `buckets`; when `buckets` is empty there is nothing to upload and the
 *    upload JWT doubles as the completion token.
 * 2. `POST /accounts/{id}/workers/assets/upload?base64=true` per bucket,
 *    authenticated with that JWT. The 201 that completes the manifest carries
 *    the completion JWT (also valid one hour).
 * 3. `PUT /accounts/{id}/workers/scripts/{name}` with `assets: { jwt }`.
 *
 * The one-hour JWT lifetime is why the limits in `src/deploy/limits.ts` matter
 * here beyond memory: a deploy that took longer than an hour between phase 1
 * and phase 3 would fail with an expired token.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

const SERVICE = "Cloudflare";

/**
 * Requests that are not per-file: the manifest registration and the final
 * script `PUT`. The worst case adds one upload request per file, which is what
 * `enforceLimits` budgets against.
 */
const FIXED_SUBREQUESTS = 2;

/**
 * Length of a manifest hash, in hex characters.
 *
 * The API rejects anything else. It is a *truncated* SHA-256, not a full one.
 */
const MANIFEST_HASH_LENGTH = 32;

/** Sent as an asset's content type when the extension is unrecognised. */
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * The `compatibility_date` sent with every upload from this target. Pinned for
 * the same reason as in `cloudflare-workers.ts`: a date computed at deploy
 * time makes the same commit behave differently on a redeploy.
 */
const COMPATIBILITY_DATE = "2026-08-20";

const REQUIRED_SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

const OPTIONAL_SECRETS = ["CLOUDFLARE_WORKER_NAME", "CLOUDFLARE_WORKERS_SUBDOMAIN"] as const;

/** Extension → served `Content-Type`. Whatever is sent at upload time is what visitors get. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  xml: "application/xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  zip: "application/zip",
};

interface ManifestEntry {
  hash: string;
  size: number;
}

/** One file, prepared once so phase 2 never re-encodes or re-hashes it. */
interface PreparedAsset {
  base64: string;
  contentType: string;
}

async function deploy(input: DeployTargetInput): Promise<Result<DeployOutcome, DeployFailure>> {
  const secretValues = secretValuesOf(input.secrets);

  const required = requireSecrets(input.secrets, REQUIRED_SECRETS);
  if (!required.success) return required;
  const apiToken = required.data.CLOUDFLARE_API_TOKEN;
  const accountId = required.data.CLOUDFLARE_ACCOUNT_ID;

  const selected = selectFiles(input.files, input.config.dir);
  if (!selected.success) return selected;

  const limits = enforceLimits(selected.data, (fileCount) => fileCount + FIXED_SUBREQUESTS);
  if (!limits.success) return limits;

  const scriptName = input.secrets.CLOUDFLARE_WORKER_NAME || input.config.name;
  const account = encodeURIComponent(accountId);
  const authorization = `Bearer ${apiToken}`;

  const manifest: Record<string, ManifestEntry> = {};
  const assetsByHash = new Map<string, PreparedAsset>();
  for (const [path, bytes] of selected.data) {
    const base64 = toBase64(bytes);
    const hash = await manifestHash(base64, extensionOf(path));
    manifest[`/${path}`] = { hash, size: bytes.byteLength };
    assetsByHash.set(hash, { base64, contentType: contentTypeOf(path) });
  }

  const session = await postJson(
    input,
    `${API_BASE}/accounts/${account}/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`,
    { manifest },
    authorization,
    secretValues,
  );
  if (!session.success) return session;

  const uploadJwt = stringField(session.data, "jwt");
  if (!uploadJwt) {
    return err({
      reason: `${SERVICE} did not return an upload token for the asset manifest`,
      retryable: true,
    });
  }

  const buckets = bucketsField(session.data);

  // An empty `buckets` means every file is already stored; the upload token is
  // then the completion token and phase 2 is skipped entirely.
  let completionJwt = uploadJwt;
  if (buckets.length > 0) {
    const uploaded = await uploadBuckets(input, {
      account,
      buckets,
      assetsByHash,
      uploadJwt,
      secretValues,
    });
    if (!uploaded.success) return uploaded;
    completionJwt = uploaded.data;
  }

  const form = new FormData();
  form.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          compatibility_date: COMPATIBILITY_DATE,
          assets: { jwt: completionJwt },
        }),
      ],
      { type: "application/json" },
    ),
  );

  let response: Response;
  try {
    response = await input.fetch(
      `${API_BASE}/accounts/${account}/workers/scripts/${encodeURIComponent(scriptName)}`,
      { method: "PUT", headers: { Authorization: authorization }, body: form },
    );
  } catch (error) {
    return err(transportFailure(SERVICE, error));
  }

  if (!response.ok) return err(await providerFailure(SERVICE, response, secretValues));

  const document = await readJson(SERVICE, response, secretValues);
  if (!document.success) return document;
  if (document.data.success !== true) {
    return err({
      reason: `${SERVICE} rejected the static-asset deployment`,
      logTail: redactAndTruncate(JSON.stringify(document.data), secretValues),
      retryable: false,
    });
  }

  const outcome: DeployOutcome = {};
  const result = document.data.result;
  if (typeof result === "object" && result !== null) {
    const id = (result as Record<string, unknown>).id;
    if (typeof id === "string") outcome.providerId = id;
  }

  // Only from a value the user supplied — see the same note in
  // `cloudflare-workers.ts`.
  const subdomain = input.secrets.CLOUDFLARE_WORKERS_SUBDOMAIN;
  if (subdomain) outcome.url = `https://${scriptName}.${subdomain}.workers.dev`;

  return ok(outcome);
}

/** Phase 2: upload each bucket the manifest registration asked for, returning the completion token. */
async function uploadBuckets(
  input: DeployTargetInput,
  args: {
    account: string;
    buckets: readonly string[][];
    assetsByHash: ReadonlyMap<string, PreparedAsset>;
    uploadJwt: string;
    secretValues: readonly string[];
  },
): Promise<Result<string, DeployFailure>> {
  let completionJwt: string | undefined;

  for (const bucket of args.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const asset = args.assetsByHash.get(hash);
      if (!asset) {
        // The API asked for a hash this deploy never produced. Continuing
        // would upload an incomplete manifest and leave the site half-updated.
        return err({
          reason: `${SERVICE} asked for an asset this deployment did not produce`,
          retryable: true,
        });
      }
      // The *part* is the base64 text; the part's content type is what the
      // asset is later served as. `base64=true` on the URL is what tells the
      // API to decode it.
      form.append(hash, new Blob([asset.base64], { type: asset.contentType }), hash);
    }

    let response: Response;
    try {
      response = await input.fetch(
        `${API_BASE}/accounts/${args.account}/workers/assets/upload?base64=true`,
        {
          method: "POST",
          // Authenticated with the manifest JWT, never with the API token.
          headers: { Authorization: `Bearer ${args.uploadJwt}` },
          body: form,
        },
      );
    } catch (error) {
      return err(transportFailure(SERVICE, error));
    }

    if (!response.ok) return err(await providerFailure(SERVICE, response, args.secretValues));

    const document = await readJson(SERVICE, response, args.secretValues);
    if (!document.success) return document;

    // Only the response that completes the manifest carries the completion
    // token; earlier buckets answer without one.
    const jwt = stringField(document.data, "jwt");
    if (jwt) completionJwt = jwt;
  }

  if (!completionJwt) {
    return err({
      reason: `${SERVICE} did not return a completion token after every asset was uploaded`,
      retryable: true,
    });
  }

  return ok(completionJwt);
}

/**
 * The manifest hash Cloudflare expects.
 *
 * **The recipe is not what it looks like.** It is not a hash of the file: it is
 * SHA-256 over the *base64 text* of the contents concatenated with the file
 * extension (no dot), hex-encoded, truncated to 32 characters. Hashing the raw
 * bytes instead produces a manifest the session call happily accepts and whose
 * uploads are then rejected in phase 2, so this must match exactly. Covered by
 * a known-fixture test.
 */
export async function manifestHash(base64Content: string, extension: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(base64Content + extension),
  );
  return toHex(digest).slice(0, MANIFEST_HASH_LENGTH);
}

/** The extension without its dot, or "" for a file with none (including a dotfile like `.gitignore`). */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extensionOf(path).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/** POST a JSON body and return the Cloudflare envelope, as a value. */
async function postJson(
  input: DeployTargetInput,
  url: string,
  body: unknown,
  authorization: string,
  secretValues: readonly string[],
): Promise<Result<Record<string, unknown>, DeployFailure>> {
  let response: Response;
  try {
    response = await input.fetch(url, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return err(transportFailure(SERVICE, error));
  }

  if (!response.ok) return err(await providerFailure(SERVICE, response, secretValues));
  return readJson(SERVICE, response, secretValues);
}

/** Read a string off the Cloudflare envelope's `result` object. */
function stringField(document: Record<string, unknown>, field: string): string | undefined {
  const result = document.result;
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read `result.buckets`, tolerating its absence — an absent `buckets` means nothing to upload. */
function bucketsField(document: Record<string, unknown>): string[][] {
  const result = document.result;
  if (typeof result !== "object" || result === null) return [];
  const buckets = (result as Record<string, unknown>).buckets;
  if (!Array.isArray(buckets)) return [];

  return buckets
    .filter((bucket): bucket is unknown[] => Array.isArray(bucket))
    .map((bucket) => bucket.filter((hash): hash is string => typeof hash === "string"))
    .filter((bucket) => bucket.length > 0);
}

export const cloudflarePagesTarget: DeployTarget = {
  name: "cloudflare-pages",
  requiredSecrets: REQUIRED_SECRETS,
  optionalSecrets: OPTIONAL_SECRETS,
  deploy,
};
