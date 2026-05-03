import type { Agent } from "../types";
import { generateApiKey, hashToken } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

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
): Promise<Result<CreateAgentResult, AppError>> {
  try {
    const id = newId("agt");
    const plaintext = await generateApiKey("stratum_agent");
    const tokenHash = await hashToken(plaintext);

    await db
      .prepare(
        "INSERT INTO agents (id, name, owner_id, model, description, prompt_hash, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, name, ownerId, model ?? null, description ?? null, promptHash ?? null, tokenHash)
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

export async function getAgentByToken(
  db: D1Database,
  plaintext: string,
  logger: Logger,
): Promise<Result<Agent, NotFoundError | AppError>> {
  try {
    const tokenHash = await hashToken(plaintext);
    const row = await db
      .prepare("SELECT * FROM agents WHERE token_hash = ?")
      .bind(tokenHash)
      .first<AgentRow>();

    if (!row) {
      const notFoundError = new NotFoundError("Agent", "by_token");
      logger.debug("Agent not found by token");
      return err(notFoundError);
    }

    logger.debug("Agent retrieved by token", { agentId: row.id });
    return ok(rowToAgent(row));
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
