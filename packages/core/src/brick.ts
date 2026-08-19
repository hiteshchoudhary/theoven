import type { Context } from './context'
import type { Logger } from './logger'
import type { HttpMethod } from './router/types'
import type { RouteSchema } from './validation'

/**
 * A brick: the single extension point for everything Oven does not ship in core.
 *
 * `setup()` runs once at boot and returns the thing the brick provides. That return value
 * becomes `ctx.<name>`, and its **type** flows through `.use()` into every handler — add the
 * storage brick and `ctx.storage` is there, fully typed; leave it out and touching
 * `ctx.storage` is a compile error rather than a crash at 3am.
 *
 * ```ts
 * const app = createApp()
 *   .use(storage({ driver: 's3', bucket: 'uploads' }))
 *   .use(queue({ driver: 'redis' }))
 *
 * app.post('/upload', async (ctx) => {
 *   const { url } = await ctx.storage.upload('key', file)  // typed
 *   await ctx.queue.dispatch('resize', { url })            // typed
 * })
 * ```
 *
 * A brick contributes in two places, and the difference matters:
 *
 * - **`setup()`** runs once at boot and returns a *shared* service. It lives on the context
 *   prototype, so ten bricks cost nothing per request.
 * - **`request()`** runs per request and returns *per-request* state — a session, a
 *   transaction, the signed-in user.
 *
 * Both are typed, and both flow into the context through `.use()`. `request()` exists because
 * `ctx.user` cannot come from `setup()`: it is different for every request. The alternative —
 * declaring it globally with module augmentation — was rejected in D5, because it makes
 * `ctx.user` appear in apps that never installed auth.
 *
 * ```ts
 * function clerk(): Brick<'auth', ClerkClient, { user: User | null }> {
 *   return {
 *     name: 'auth',
 *     setup: () => createClerkClient(...),          // shared, once
 *     request: async (ctx) => ({                     // per request
 *       user: await verifyToken(ctx.token),
 *     }),
 *   }
 * }
 *
 * app.get('/me', (ctx) => {
 *   ctx.auth.users.get(...)   // the shared client, typed
 *   ctx.user?.id              // per-request state, typed
 * })
 * ```
 */
export interface Brick<
  Name extends string = string,
  Value = unknown,
  Request extends Record<string, unknown> = Record<never, never>,
> {
  /** Property this brick contributes to the context. Must not collide with anything on it. */
  name: Name

  /**
   * Bricks that must be set up first.
   *
   * Declaring the dependency rather than relying on registration order means the auth brick
   * can find the database brick however the user chose to write their config.
   */
  dependsOn?: readonly string[]

  /** Builds the value exposed as `ctx[name]`. Runs once, at boot. */
  setup(context: BrickSetupContext): Value | Promise<Value>

  /**
   * Contributes per-request state, merged onto the context under its own keys.
   *
   * Runs after routing — so `ctx.params` and the route's schema are available — and before
   * middleware, the handler and any guard. Returning nothing contributes nothing.
   *
   * Throwing here rejects the request, which is how an auth brick turns a bad token into a
   * `401` before a handler ever sees it.
   */
  request?(ctx: Context, route: RouteInfo): RequestResult<Request>

  /** Runs per request, before `request()`. Prefer `request()` when you have state to contribute. */
  onRequest?(ctx: Context): unknown

  /** Releases resources during graceful shutdown — pools, workers, connections. */
  onShutdown?(value: Value): unknown
}

/**
 * What a `request()` hook may return: state to contribute, or nothing at all.
 *
 * `void` in the union is deliberate rather than confusing — a brick that only inspects the
 * request, or that contributes conditionally, has nothing to return, and forcing it to invent
 * an empty object would be worse.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: contributing nothing is a valid outcome
export type RequestResult<Request> = Request | Promise<Request | void> | void

/**
 * What a brick is told about the matched route.
 *
 * This is how a brick enforces something core knows nothing about. Core sees `auth: 'admin'`
 * on a route as opaque metadata and passes it along; the auth brick is what gives it meaning.
 * Without this, every route-level feature would have to be built into core itself.
 */
export interface RouteInfo {
  method: HttpMethod
  pattern: string
  /** The route's declared schema, including any keys core does not interpret. */
  schema: RouteSchema | undefined
}

/** OpenAPI pieces a brick can contribute, such as the auth module's security schemes. */
export interface OpenApiFragment {
  securitySchemes?: Record<string, unknown>
  tags?: Array<{ name: string; description?: string }>
}

/**
 * The parts of the app a brick may inspect.
 *
 * Deliberately narrow. A brick handed the whole `App` could register routes after boot or
 * mutate settings mid-flight; this exposes only what a brick has a legitimate reason to reach.
 */
export interface BrickHost {
  /**
   * Every registered route with its schemas.
   *
   * Call this lazily — from inside a request handler rather than during `setup()` — because
   * bricks registered after this one are still adding routes while setup runs.
   */
  routeTable(): ReadonlyArray<{
    method: HttpMethod
    pattern: string
    schema: RouteSchema | undefined
  }>
  /** Contribute OpenAPI pieces, merged into the generated document. */
  contributeOpenApi(fragment: OpenApiFragment): void
  /** Everything contributed so far. */
  openApiFragments(): Required<OpenApiFragment>
  readonly logger: Logger
}

/** What a brick is handed during `setup()`. */
export interface BrickSetupContext {
  /** Values from bricks this one declared a dependency on, keyed by brick name. */
  resolved: Readonly<Record<string, unknown>>
  /** Register routes the brick owns, such as `/auth/*` or the docs UI. */
  route(method: string, path: string, handler: (ctx: Context) => unknown): void
  /** True outside production, so bricks can pick safe-by-default behaviour. */
  development: boolean
  /** The app, for bricks that must inspect it — the OpenAPI generator reads the route table. */
  app: BrickHost
}

/**
 * Orders bricks so dependencies are set up first.
 *
 * A cycle is a configuration error that cannot be resolved at runtime, so it throws here — at
 * boot, naming both bricks — rather than deadlocking or silently picking an order.
 */
export function orderBricks(bricks: readonly Brick[]): Brick[] {
  const byName = new Map(bricks.map((brick) => [brick.name, brick]))
  const ordered: Brick[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (brick: Brick, trail: string[]): void => {
    const status = state.get(brick.name)
    if (status === 'done') return
    if (status === 'visiting') {
      throw new Error(
        `Brick dependency cycle: ${[...trail, brick.name].join(' -> ')}. ` +
          'Two bricks cannot each require the other to be set up first.',
      )
    }

    state.set(brick.name, 'visiting')

    for (const dependency of brick.dependsOn ?? []) {
      const target = byName.get(dependency)
      if (!target) {
        throw new Error(
          `Brick "${brick.name}" depends on "${dependency}", which is not registered. ` +
            `Add it with .use() before starting the app.`,
        )
      }
      visit(target, [...trail, brick.name])
    }

    state.set(brick.name, 'done')
    ordered.push(brick)
  }

  for (const brick of bricks) visit(brick, [])
  return ordered
}
