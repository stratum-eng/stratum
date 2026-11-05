import type { Context } from "hono";
import { tryGetContext } from "hono/context-storage";
import { recordAudit } from "../storage/audit";
import { findOrgSlugById } from "../storage/orgs";
import type { Env } from "../types";
import { type Cidr, formatCidr, ipInRanges, parseCidr } from "../utils/cidr";
import { getWaitUntil } from "../utils/execution-ctx";
import { createLogger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

declare module "hono" {
  interface ContextVariableMap {
    /**
     * The client address the org IP allowlist (#399) judges this request by.
     * Set by the server only: the MCP sub-request dispatcher writes the
     * ORIGINAL caller's address here, so a tool call is not judged by the
     * Worker's own. Unset on ordinary requests, which read `CF-Connecting-IP`.
     * No request header can set it.
     */
    clientIp?: string;
    /**
     * Id of the org whose IP allowlist refused this request access to one of
     * its resources. Set by the authz check, consumed by
     * `orgIpAllowlistMiddleware` (and git-http), which turn the route's generic
     * 403/404 into an explicit `IP_NOT_ALLOWED`.
     */
    ipDeniedOrgId?: string;
    /** Per-request cache of compiled allowlists, keyed by their stored text. */
    orgIpRangeCache?: Map<string, Cidr[]>;
  }
}

type AppContext = Context<{ Bindings: Env }>;

/** Upper bound on entries in one org's list; enough for any real network plan. */
export const MAX_IP_ALLOWLIST_ENTRIES = 100;

/** Machine-readable refusal code, shared by the JSON, HTML and git answers. */
export const IP_NOT_ALLOWED = "IP_NOT_ALLOWED";

/**
 * The address this request is judged by.
 *
 * `CF-Connecting-IP` only — Cloudflare's edge sets it and overwrites any value
 * a client sends. `X-Forwarded-For` is client-controlled on Workers and is
 * never read. An absent header comes back as "", which no range contains: a
 * restricted org fails CLOSED for a request whose origin is unknown.
 */
export function clientIpOf(c: {
  get(key: "clientIp"): string | undefined;
  req: AppContext["req"];
}): string {
  const fromServer = c.get("clientIp");
  if (fromServer !== undefined) return fromServer;
  return (c.req.header("CF-Connecting-IP") ?? "").trim();
}

/**
 * Compile stored entries to ranges. An entry that does not parse (only
 * possible through corruption — writes are validated) contributes no range,
 * so it can only narrow the list, never widen it.
 */
export function compileIpAllowlist(entries: readonly string[]): Cidr[] {
  const ranges: Cidr[] = [];
  for (const entry of entries) {
    const parsed = parseCidr(entry);
    if (parsed.success) ranges.push(parsed.data);
  }
  return ranges;
}

/** Whether `ip` may reach an org with this allowlist. Empty list: everyone. */
export function ipAllowedByList(
  entries: readonly string[],
  ip: string,
  cache?: Map<string, Cidr[]>,
): boolean {
  if (entries.length === 0) return true;
  const key = JSON.stringify(entries);
  let ranges = cache?.get(key);
  if (ranges === undefined) {
    ranges = compileIpAllowlist(entries);
    cache?.set(key, ranges);
  }
  return ipInRanges(ip, ranges);
}

/**
 * Does the org's allowlist admit the request `c` is serving? Records the
 * denial (when `record`) so the response can say why.
 */
export function orgIpAllowsFor(
  c: AppContext,
  orgId: string,
  entries: readonly string[],
  record = true,
): boolean {
  if (entries.length === 0) return true;
  let cache = c.get("orgIpRangeCache");
  if (cache === undefined) {
    cache = new Map();
    c.set("orgIpRangeCache", cache);
  }
  if (ipAllowedByList(entries, clientIpOf(c), cache)) return true;
  if (record) c.set("ipDeniedOrgId", orgId);
  return false;
}

/**
 * {@link orgIpAllowsFor} for code with no handle on the request — the authz
 * helpers. Outside a request (queue consumers, scheduled jobs) there is no
 * client and nothing to restrict: those run as the system, not as a caller.
 *
 * @param record When true (single-resource checks), remember the denial so the
 *   response can say why. List filters pass false: silently omitting a
 *   project from a listing is not an error.
 */
export function orgIpAllowsCurrentRequest(
  orgId: string,
  entries: readonly string[],
  record = true,
): boolean {
  if (entries.length === 0) return true;
  const c = tryGetContext<{ Bindings: Env }>();
  return c ? orgIpAllowsFor(c, orgId, entries, record) : true;
}

/**
 * Validate an allowlist from a request body: an array of IPv4/IPv6 addresses
 * or CIDR ranges, at most {@link MAX_IP_ALLOWLIST_ENTRIES}. Returns the
 * canonical, de-duplicated form, in the order given.
 */
export function validateIpAllowlistInput(value: unknown): Result<string[], string> {
  if (!Array.isArray(value)) return err("ipAllowlist must be an array of CIDR strings");
  if (value.length > MAX_IP_ALLOWLIST_ENTRIES) {
    return err(`ipAllowlist may hold at most ${MAX_IP_ALLOWLIST_ENTRIES} entries`);
  }
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > 64) {
      return err("ipAllowlist entries must be CIDR strings such as 203.0.113.0/24");
    }
    const parsed = parseCidr(item);
    if (!parsed.success) return err(parsed.error);
    const canonical = formatCidr(parsed.data);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    entries.push(canonical);
  }
  return ok(entries);
}

/** How long one member's denials in one org collapse into a single audit row. */
const DENIAL_AUDIT_WINDOW_SECONDS = 600;
/** Isolate-local memory of recent denial audits, to spare the KV round-trip. */
const recentDenialAudits = new Map<string, number>();
const RECENT_DENIAL_AUDITS_MAX = 5000;

/**
 * Audit a refusal, at most once per (org, caller) per
 * {@link DENIAL_AUDIT_WINDOW_SECONDS}.
 *
 * A denial is only ever recorded for a caller the org would otherwise have
 * let in — a member, with a valid credential — so the rows are bounded by the
 * org's own membership, not by how many requests or source addresses a
 * scanner can produce. The window is enforced per isolate in memory and
 * across isolates with a KV marker; the two together are a sampler, not a
 * counter, and an occasional duplicate is harmless.
 */
/** The authenticated caller a denial is recorded against. */
export interface IpDenialActor {
  userId?: string;
  agentId?: string;
}

async function auditIpDenial(
  c: AppContext,
  org: { id: string; slug: string },
  ip: string,
  actor: IpDenialActor | undefined,
) {
  const userId = actor?.userId ?? c.get("userId");
  const agentId = actor?.agentId ?? c.get("agentId");
  const actorId = userId ?? agentId;
  const key = `ip-deny-audit:${org.id}:${actorId ?? "anonymous"}`;
  const now = Date.now();
  const until = recentDenialAudits.get(key);
  if (until !== undefined && until > now) return;
  if (recentDenialAudits.size >= RECENT_DENIAL_AUDITS_MAX) recentDenialAudits.clear();
  recentDenialAudits.set(key, now + DENIAL_AUDIT_WINDOW_SECONDS * 1000);

  const logger = createLogger({ component: "OrgIpAllowlist", orgId: org.id });
  try {
    if ((await c.env.STATE.get(key)) !== null) return;
    await c.env.STATE.put(key, "1", { expirationTtl: DENIAL_AUDIT_WINDOW_SECONDS });
  } catch (error) {
    // The marker only thins the log; without it the in-memory window still
    // applies, so carry on and record.
    logger.warn("IP denial audit marker unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await recordAudit(c.env.DB, logger, {
    action: "org.ip_access_denied",
    actorType: agentId !== undefined && userId === undefined ? "agent" : "user",
    ...(actorId !== undefined ? { actorId } : {}),
    subject: org.id,
    orgId: org.id,
    detail: {
      slug: org.slug,
      ip: ip === "" ? null : ip,
      method: c.req.method,
      path: c.req.path,
      sampledWindowSeconds: DENIAL_AUDIT_WINDOW_SECONDS,
    },
  });
}

/** A refusal ready to render: which org, and the address it refused. */
export interface IpDenial {
  orgId: string;
  slug: string;
  ip: string;
}

/**
 * Resolve a refusal for org `orgId`: look up its slug for the message and
 * schedule the (sampled) audit entry. Clears the recorded denial so an outer
 * middleware does not answer the same refusal twice.
 *
 * @param actor Who was refused, for a router that authenticates for itself and
 *   so never publishes them on the context (git smart-HTTP).
 */
export async function ipDenialFor(
  c: AppContext,
  org: { id: string; slug?: string },
  actor?: IpDenialActor,
): Promise<IpDenial> {
  c.set("ipDeniedOrgId", undefined);
  let slug = org.slug;
  if (slug === undefined) {
    const logger = createLogger({ component: "OrgIpAllowlist", orgId: org.id });
    const found = await findOrgSlugById(c.env.DB, logger, org.id);
    slug = found.success && found.data !== null ? found.data : org.id;
  }
  const ip = clientIpOf(c);
  const audit = auditIpDenial(c, { id: org.id, slug }, ip, actor);
  const waitUntil = getWaitUntil(c);
  if (waitUntil) waitUntil(audit);
  else await audit;
  return { orgId: org.id, slug, ip };
}

/**
 * The denial authz recorded on the current request, if any — for routers
 * (git smart-HTTP) whose narrowed context type has no `get`.
 */
export async function takeRecordedIpDenial(actor?: IpDenialActor): Promise<IpDenial | undefined> {
  const c = tryGetContext<{ Bindings: Env }>();
  const orgId = c?.get("ipDeniedOrgId");
  if (c === undefined || orgId === undefined) return undefined;
  return ipDenialFor(c, { id: orgId }, actor);
}

/** The sentence every refusal carries, whatever its format. */
export function ipNotAllowedMessage(denial: IpDenial): string {
  const where = denial.ip === "" ? "an unidentified address" : denial.ip;
  return `The organization '${denial.slug}' only allows access from its configured networks, and this request came from ${where}. Connect from an allowed network, or ask an org admin to update the IP allowlist.`;
}
