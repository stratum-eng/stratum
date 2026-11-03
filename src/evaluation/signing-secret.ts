/**
 * Resolving the key an outbound, Stratum-signed request is signed with.
 *
 * A policy file is repository content: anyone with read access to the repo can
 * read it, and so can the code under evaluation, which carries its own copy. A
 * signing key written there as a literal is therefore a key every reader can
 * forge signatures with (#395). The fix is to let the policy *name* a project
 * secret (`secretRef`) and resolve the value here, at the moment of signing,
 * from the same encrypted store deploys and BYOK read.
 *
 * Deliberately not webhook-specific: anything that signs a request on a
 * project's behalf from a policy-declared key (the webhook evaluator today,
 * check-run callbacks in #414) takes a {@link SigningSecretSpec} and gets back a
 * {@link SigningKeyResolution}, so the precedence and fail-closed rules below
 * live in exactly one place.
 *
 * The rules:
 *
 * 1. **`secretRef` wins over `secret`.** When both are given the literal is
 *    ignored — never used, not even as a fallback when the reference fails to
 *    resolve. A fallback would mean a deleted or mistyped project secret
 *    silently downgrades to the key everyone can read, which is the hole this
 *    closes.
 * 2. **A reference that does not resolve fails closed.** Missing, undecryptable,
 *    empty, or unreadable because `DEPLOY_SECRET_KEY` is unset: every one of
 *    them is `unavailable` with a reason, and the caller must not send the
 *    request. Signing with an empty key would produce a signature anyone can
 *    compute, which is worse than no signature because the receiver trusts it.
 * 3. **The literal still works, with a warning**, for a deprecation window.
 *
 * The plaintext key is held to the rule `loadSecretValues` states: it signs one
 * request and is never returned to a client, rendered, logged, or put in an
 * error or a reason string. Only secret *names* appear in reasons.
 */
import {
  DEPLOY_SECRET_KEY_MISSING,
  SECRET_NAME_PATTERN,
  loadSecretValues,
} from "../storage/project-secrets";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";

/** The two ways a policy entry may supply a signing key. */
export interface SigningSecretSpec {
  /** Deprecated: a literal key, readable by anyone with repo read access. */
  secret?: string;
  /** Name of a project secret holding the key. */
  secretRef?: string;
}

/** Where a `secretRef` is resolved from: one project's secret store. */
export interface ProjectSecretSource {
  env: Pick<Env, "DB" | "DEPLOY_SECRET_KEY">;
  projectId: string;
}

export type SigningKeyResolution =
  /** No key configured — the request goes out unsigned, as it always has. */
  | { status: "unsigned" }
  /** Sign with `key`. `source` says which field supplied it. */
  | { status: "resolved"; key: string; source: "secretRef" | "literal" }
  /** A key was asked for and cannot be produced. The caller must not send. */
  | { status: "unavailable"; reason: string };

/**
 * Resolve the signing key for one policy entry.
 *
 * @param spec - The entry's `secret` / `secretRef` fields
 * @param store - The project's secret store; `undefined` means none is
 *   reachable from this caller, so any `secretRef` fails closed
 * @param label - Names the entry in log lines (e.g. `"webhook evaluator"`)
 */
export async function resolveSigningKey(
  spec: SigningSecretSpec,
  store: ProjectSecretSource | undefined,
  logger: Logger,
  label: string,
): Promise<SigningKeyResolution> {
  const { secretRef } = spec;

  if (secretRef !== undefined) {
    if (spec.secret !== undefined) {
      logger.warn(
        `${label}: both 'secret' and 'secretRef' are set; using 'secretRef' and ignoring the literal 'secret', which should be removed from the policy file`,
        { secretRef },
      );
    }
    return resolveReference(secretRef, store, logger, label);
  }

  if (spec.secret !== undefined && spec.secret !== "") {
    logger.warn(
      `${label}: signing with a literal 'secret' from the policy file is deprecated; anyone with repository read access can read it. Store it as a project secret and use 'secretRef'.`,
    );
    return { status: "resolved", key: spec.secret, source: "literal" };
  }

  return { status: "unsigned" };
}

async function resolveReference(
  name: string,
  store: ProjectSecretSource | undefined,
  logger: Logger,
  label: string,
): Promise<SigningKeyResolution> {
  // The loader already rejects a malformed name and fails the file closed;
  // checked again because a policy can reach here another way (a cached one),
  // and the name is about to be bound into a query and quoted in a reason.
  if (!SECRET_NAME_PATTERN.test(name)) {
    return {
      status: "unavailable",
      reason: "secretRef is not a valid project secret name (^[A-Z][A-Z0-9_]{0,63}$)",
    };
  }
  if (store === undefined) {
    return {
      status: "unavailable",
      reason: `secretRef ${name} cannot be resolved here because no project secret store is available`,
    };
  }

  const loaded = await loadSecretValues(store.env.DB, logger, store.env, {
    projectId: store.projectId,
    names: [name],
  });

  if (!loaded.success) {
    if (loaded.error.code === DEPLOY_SECRET_KEY_MISSING) {
      return {
        status: "unavailable",
        reason: `project secret ${name} cannot be decrypted because the operator has not configured DEPLOY_SECRET_KEY`,
      };
    }
    return {
      status: "unavailable",
      reason: `project secret ${name} could not be read (${loaded.error.code})`,
    };
  }
  if (loaded.data.missing.includes(name)) {
    return {
      status: "unavailable",
      reason: `project secret ${name} is not set for this project`,
    };
  }
  if (loaded.data.undecryptable.includes(name)) {
    return {
      status: "unavailable",
      reason: `project secret ${name} could not be decrypted; DEPLOY_SECRET_KEY was rotated or the value was restored from another project, so it must be re-entered`,
    };
  }

  const key = loaded.data.values.get(name);
  // The store accepts an empty value (some deploy providers need one), so this
  // is reachable. An HMAC under an empty key is a signature anyone can compute.
  if (key === undefined || key === "") {
    logger.warn(`${label}: referenced signing secret is empty; refusing to sign`, {
      secretRef: name,
    });
    return {
      status: "unavailable",
      reason: `project secret ${name} is empty; refusing to sign with an empty key`,
    };
  }

  return { status: "resolved", key, source: "secretRef" };
}
