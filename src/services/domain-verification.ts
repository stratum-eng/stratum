import { type AppError, ExternalServiceError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * DNS TXT domain verification via DNS-over-HTTPS (Cloudflare's JSON API).
 * An admin proves ownership of an email domain by publishing
 * `stratum-sso-verify=<token>` as a TXT record at `_stratum-sso.<domain>`.
 * Admin-time only (never on the login path), so the external DoH dependency
 * is acceptable.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 10_000;
const TXT_RECORD_TYPE = 16;

export function verificationRecordName(domain: string): string {
  return `_stratum-sso.${domain}`;
}

export function verificationTxtValue(token: string): string {
  return `stratum-sso-verify=${token}`;
}

interface DohAnswer {
  type?: number;
  data?: string;
}

/**
 * Check whether `_stratum-sso.<domain>` publishes a TXT record containing
 * `stratum-sso-verify=<token>`. `ok(false)` means the lookup worked but the
 * record is absent/wrong; `err` means the lookup itself failed (the caller
 * must not treat that as "not verified yet" silently — it is retryable).
 */
export async function checkDomainTxtRecord(
  domain: string,
  token: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  const name = verificationRecordName(domain);
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=TXT`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("DoH TXT lookup failed", { domain });
    return err(
      new ExternalServiceError(
        "dns-over-https",
        "TXT lookup request failed",
        error instanceof Error ? error : undefined,
      ),
    );
  }

  if (!res.ok) {
    logger.warn("DoH TXT lookup returned non-OK status", { domain, status: res.status });
    return err(new ExternalServiceError("dns-over-https", `TXT lookup returned ${res.status}`));
  }

  let answers: DohAnswer[];
  let status: unknown;
  try {
    const parsed = (await res.json()) as { Status?: unknown; Answer?: DohAnswer[] };
    status = parsed.Status;
    answers = Array.isArray(parsed.Answer) ? parsed.Answer : [];
  } catch {
    return err(new ExternalServiceError("dns-over-https", "TXT lookup returned invalid JSON"));
  }

  // Only NOERROR (0) and NXDOMAIN (3) are authoritative answers about the
  // record's presence. Anything else — SERVFAIL (2, incl. DNSSEC-bogus),
  // REFUSED (5), … — is a resolver failure and must surface as retryable, not
  // as "TXT record missing".
  if (status !== 0 && status !== 3) {
    logger.warn("DoH TXT lookup returned non-authoritative DNS status", { domain, status });
    return err(
      new ExternalServiceError(
        "dns-over-https",
        `TXT lookup returned DNS status ${String(status)}`,
      ),
    );
  }

  const expected = verificationTxtValue(token);
  // DoH JSON quotes TXT data (possibly in multiple quoted chunks); strip the
  // quotes, then require the record to equal the expected value exactly.
  const found = answers.some(
    (answer) =>
      answer.type === TXT_RECORD_TYPE &&
      typeof answer.data === "string" &&
      answer.data.replaceAll('"', "") === expected,
  );

  logger.info("DoH TXT verification checked", { domain, found });
  return ok(found);
}
