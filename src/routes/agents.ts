import { Hono } from "hono";
import { createAgent, deleteAgent, getAgent, listAgents } from "../storage/agents";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { badRequest, created, ok } from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) {
    logger.warn("Unauthorized attempt to create agent");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json<{
    name?: unknown;
    model?: unknown;
    description?: unknown;
    promptHash?: unknown;
  }>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    logger.warn("Missing or invalid agent name");
    return badRequest("name is required");
  }

  const model = typeof body.model === "string" ? body.model : undefined;
  const description = typeof body.description === "string" ? body.description : undefined;
  const promptHash = typeof body.promptHash === "string" ? body.promptHash : undefined;

  const result = await createAgent(
    c.env.DB,
    userId,
    body.name,
    logger,
    model,
    description,
    promptHash,
  );

  if (!result.success) {
    logger.error("Failed to create agent", result.error, { userId });
    return c.json({ error: "Failed to create agent" }, 500);
  }

  const { agent, plaintext } = result.data;
  logger.info("Agent created", { agentId: agent.id, userId });

  return created({
    agent: {
      id: agent.id,
      name: agent.name,
      ownerId: agent.ownerId,
      model: agent.model,
      description: agent.description,
      promptHash: agent.promptHash,
      createdAt: agent.createdAt,
    },
    token: plaintext,
  });
});

app.get("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) {
    logger.warn("Unauthorized attempt to list agents");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await listAgents(c.env.DB, userId, logger);

  if (!result.success) {
    logger.error("Failed to list agents", result.error, { userId });
    return c.json({ error: "Failed to list agents" }, 500);
  }

  const agents = result.data;
  logger.debug("Agents listed", { userId, count: agents.length });

  return ok({
    agents: agents.map(({ id, name, ownerId, model, description, promptHash, createdAt }) => ({
      id,
      name,
      ownerId,
      model,
      description,
      promptHash,
      createdAt,
    })),
  });
});

app.get("/:id", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const { id } = c.req.param();
  const result = await getAgent(c.env.DB, id, logger);

  if (!result.success) {
    if (result.error.name === "NotFoundError") {
      logger.debug("Agent not found", { agentId: id });
      return c.json({ error: "Agent not found" }, 404);
    }
    logger.error("Failed to get agent", result.error, { agentId: id });
    return c.json({ error: "Failed to get agent" }, 500);
  }

  const agent = result.data;
  logger.debug("Agent retrieved", { agentId: id });

  return ok({
    id: agent.id,
    name: agent.name,
    ownerId: agent.ownerId,
    model: agent.model,
    description: agent.description,
    promptHash: agent.promptHash,
    createdAt: agent.createdAt,
  });
});

app.delete("/:id", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) {
    logger.warn("Unauthorized attempt to delete agent");
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { id } = c.req.param();

  // First get the agent to check ownership
  const getResult = await getAgent(c.env.DB, id, logger);
  if (!getResult.success) {
    if (getResult.error.name === "NotFoundError") {
      logger.debug("Agent not found for deletion", { agentId: id });
      return c.json({ error: "Agent not found" }, 404);
    }
    logger.error("Failed to get agent for deletion", getResult.error, { agentId: id });
    return c.json({ error: "Failed to get agent" }, 500);
  }

  const agent = getResult.data;
  if (agent.ownerId !== userId) {
    logger.warn("Forbidden attempt to delete agent", {
      agentId: id,
      userId,
      ownerId: agent.ownerId,
    });
    return c.json({ error: "Forbidden" }, 403);
  }

  const deleteResult = await deleteAgent(c.env.DB, id, logger);
  if (!deleteResult.success) {
    logger.error("Failed to delete agent", deleteResult.error, { agentId: id });
    return c.json({ error: "Failed to delete agent" }, 500);
  }

  logger.info("Agent deleted", { agentId: id, userId });
  return ok({ deleted: true, id });
});

export { app as agentsRouter };
