/**
 * Test stub for the `cloudflare:workers` virtual module, which only exists inside
 * the workerd runtime. Mirrors the DurableObject base class shape that
 * src/queue/merge-queue.ts relies on (ctx/env assignment in the constructor).
 */
export class DurableObject<TEnv = unknown> {
  ctx: DurableObjectState;
  env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}
