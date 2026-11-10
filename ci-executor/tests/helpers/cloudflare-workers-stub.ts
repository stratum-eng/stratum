/**
 * Test stand-in for the `cloudflare:workers` virtual module, which exists only
 * inside workerd. The base classes do what the runtime's do for the code under
 * test: put `ctx` and `env` on the instance.
 */
export class DurableObject<TEnv = unknown> {
  ctx: unknown;
  env: TEnv;
  constructor(ctx: unknown, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<TEnv = unknown, TProps = unknown> {
  ctx: { props: TProps };
  env: TEnv;
  constructor(ctx: { props: TProps }, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}
