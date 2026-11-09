import type { Agent, AgentCredentialKind } from "../types";
import { generateApiKey, hashToken } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import {
  type CredentialPolicy,
  type MintFactors,
  credentialPolicyFromRow,
  mintFactorColumns,
  unmetPolicyOrgsSql,
} from "./credential-factors";

export interface CreateAgentResult {
  agent: Agent;
  plaintext: string;
}

interface AgentRow {
  id: string;
  name: string;
  owner_id: string;
  model: string | null;
  description: string | null;
  prompt_hash: string | null;
  token_hash: string;
  created_at: string;
  /** Absent on a row read through a stub that predates migration 067. */
  credential?: string | null;
}

/** Anything but an explicit `oauth_grant` is a token agent, the kind every row
 * was before migration 067. */
function narrowCredential(value: string | null | undefined): AgentCredentialKind {
  return value === "oauth_grant" ? "oauth_grant" : "token";
}

function rowToAgent(row: AgentRow): Agent {
  const agent: Agent = {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
  };
  if (row.model !== null) agent.model = row.model;
  if (row.description !== null) agent.description = row.description;
  if (row.prompt_hash !== null) agent.promptHash = row.prompt_hash;
  if (row.credential !== undefined) agent.credential = narrowCredential(row.credential);
  return agent;
}

export async function createAgent(
  db: D1Database,
  ownerId: string,
  name: string,
  logger: Logger,
  model?: string,
  description?: string,
  promptHash?: string,
  /** How the minting request had authenticated (#441). Omitted = nothing
   * recorded, so the agent satisfies no org's second-factor policy. */
  mintFactors?: MintFactors,
): Promise<Result<CreateAgentResult, AppError>> {
  try {
    const id = newId("agt");
    const plaintext = await generateApiKey("stratum_agent");
    const tokenHash = await hashToken(plaintext);

    await db
      .prepare(
        `INSERT INTO agents (id, name, owner_id, model, description, prompt_hash, token_hash,
                             minted_second_factor, minted_sso_org_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        name,
        ownerId,
        model ?? null,
        description ?? null,
        promptHash ?? null,
        tokenHash,
        ...mintFactorColumns(mintFactors),
      )
      .run();

    const agent: Agent = {
      id,
      name,
      ownerId,
      tokenHash,
      createdAt: new Date().toISOString(),
    };
    if (model !== undefined) agent.model = model;
    if (description !== undefined) agent.description = description;
    if (promptHash !== undefined) agent.promptHash = promptHash;

    logger.debug("Agent created", { agentId: id, ownerId, name });
    return ok({ agent, plaintext });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to create agent",
            "DATABASE_ERROR",
            500,
            { operation: "createAgent", ownerId, name },
          );
    logger.error("Failed to create agent", appError, { ownerId, name });
    return err(appError);
  }
}

/**
 * Create an agent for one MCP connection (#409, ADR 010).
 *
 * Called only when an authorization code is redeemed, and that code exists
 * only because a person clicked Allow in a signed-in browser session. So no
 * credential a client holds can reach this.
 *
 * The agent gets **no token**. `agents.token_hash` is NOT NULL and UNIQUE, so
 * it is filled with the hash of a random value that is generated here and
 * discarded before this function returns. Nobody ever sees the plaintext, and
 * `getAgentByToken` refuses `oauth_grant` rows regardless. The grant bound to
 * the agent is its only way in, which is what makes revoking the grant end the
 * agent's access.
 */
export async function createGrantAgent(
  db: D1Database,
  ownerId: string,
  name: string,
  logger: Logger,
): Promise<Result<Agent, AppError>> {
  try {
    const id = newId("agt");
    const unrevealed = await generateApiKey("stratum_agent");
    const tokenHash = await hashToken(unrevealed);
    const createdAt = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO agents (id, name, owner_id, token_hash, created_at, credential) VALUES (?, ?, ?, ?, ?, 'oauth_grant')",
      )
      .bind(id, name, ownerId, tokenHash, createdAt)
      .run();
    logger.info("Grant-only agent created", { agentId: id, ownerId });
    return ok({ id, name, ownerId, tokenHash, createdAt, credential: "oauth_grant" });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to create agent",
            "DATABASE_ERROR",
            500,
            { operation: "createGrantAgent", ownerId },
          );
    logger.error("Failed to create grant-only agent", appError, { ownerId });
    return err(appError);
  }
}

export async function getAgent(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<Agent, NotFoundError | AppError>> {
  try {
    const row = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<AgentRow>();

    if (!row) {
      const notFoundError = new NotFoundError("Agent", id);
      logger.debug("Agent not found", { agentId: id });
      return err(notFoundError);
    }

    logger.debug("Agent retrieved", { agentId: id });
    return ok(rowToAgent(row));
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to get agent",
            "DATABASE_ERROR",
            500,
            { operation: "getAgent", agentId: id },
          );
    logger.error("Failed to get agent", appError, { agentId: id });
    return err(appError);
  }
}

/** An agent authenticated by its own token, with that token's policy. */
export interface AuthenticatedAgent extends Agent {
  /**
   * What the agent was minted with, and the orgs (of its OWNER's) whose
   * second-factor policy that falls short of (#441). An agent reaches an org
   * only through its owner's membership, so the owner is who the policy is
   * evaluated for. `getAgentByToken` always sets it; optional for the same
   * reason as `LegacyKeyHolder.keyPolicy`.
   */
  policy?: CredentialPolicy;
}

export async function getAgentByToken(
  db: D1Database,
  plaintext: string,
  logger: Logger,
): Promise<Result<AuthenticatedAgent, NotFoundError | AppError>> {
  try {
    const tokenHash = await hashToken(plaintext);
    const row = await db
      .prepare(
        `SELECT agents.*,
                ${unmetPolicyOrgsSql({
                  userId: "agents.owner_id",
                  secondFactor: "agents.minted_second_factor",
                  ssoOrgId: "agents.minted_sso_org_id",
                })} AS unmet_policy_orgs
           FROM agents WHERE token_hash = ?`,
      )
      .bind(tokenHash)
      .first<AgentRow & Parameters<typeof credentialPolicyFromRow>[0]>();

    if (!row) {
      const notFoundError = new NotFoundError("Agent", "by_token");
      logger.debug("Agent not found by token");
      return err(notFoundError);
    }
    // Defence in depth (ADR 010). A grant-only agent's `token_hash` is the hash
    // of a value nobody was ever shown, so no presented token should match it.
    // If one ever did, it must still not authenticate: this agent's access
    // has to end when its grant does.
    if (narrowCredential(row.credential) === "oauth_grant") {
      logger.warn("Refused an agent token for a grant-only agent", { agentId: row.id });
      return err(new NotFoundError("Agent", "by_token"));
    }

    logger.debug("Agent retrieved by token", { agentId: row.id });
    return ok({ ...rowToAgent(row), policy: credentialPolicyFromRow(row) });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to get agent by token",
            "DATABASE_ERROR",
            500,
            { operation: "getAgentByToken" },
          );
    logger.error("Failed to get agent by token", appError);
    return err(appError);
  }
}

export async function listAgents(
  db: D1Database,
  ownerId: string,
  logger: Logger,
): Promise<Result<Agent[], AppError>> {
  try {
    const result = await db
      .prepare("SELECT * FROM agents WHERE owner_id = ?")
      .bind(ownerId)
      .all<AgentRow>();

    const agents = result.results.map(rowToAgent);
    logger.debug("Agents listed", { ownerId, count: agents.length });
    return ok(agents);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to list agents",
            "DATABASE_ERROR",
            500,
            { operation: "listAgents", ownerId },
          );
    logger.error("Failed to list agents", appError, { ownerId });
    return err(appError);
  }
}

export async function deleteAgent(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<void, NotFoundError | AppError>> {
  try {
    // First check if the agent exists
    const existingRow = await db
      .prepare("SELECT id FROM agents WHERE id = ?")
      .bind(id)
      .first<{ id: string }>();
    if (!existingRow) {
      const notFoundError = new NotFoundError("Agent", id);
      logger.debug("Agent not found for deletion", { agentId: id });
      return err(notFoundError);
    }

    await db.prepare("DELETE FROM agents WHERE id = ?").bind(id).run();

    logger.debug("Agent deleted", { agentId: id });
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to delete agent",
            "DATABASE_ERROR",
            500,
            { operation: "deleteAgent", agentId: id },
          );
    logger.error("Failed to delete agent", appError, { agentId: id });
    return err(appError);
  }
}
