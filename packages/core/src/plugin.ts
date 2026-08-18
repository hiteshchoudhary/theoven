import type { Context } from './context'
import type { Logger } from './logger'
import type { HttpMethod } from './router/types'
import type { RouteSchema } from './validation'

/**
 * A plugin: the single extension point for everything Oven does not ship in core.
 *
 * `setup()` runs once at boot and returns the thing the plugin provides. That return value
 * becomes `ctx.<name>`, and its **type** flows through `.use()` into every handler — add the
 * storage plugin and `ctx.storage` is there, fully typed; leave it out and touching
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
 * The value lives on the context prototype, so it is shared across requests and costs nothing
 * per request. Anything genuinely per-request — a session, a transaction — belongs in
 * `onRequest`, which runs with the context in hand.
 */
export interface OvenPlugin<Name extends string = string, Value = unknown> {
  /** Property this plugin contributes to the context. Must not collide with anything on it. */
  name: Name

  /**
   * Plugins that must be set up first.
   *
   * Declaring the dependency rather than relying on registration order means the auth plugin
   * can find the database plugin however the user chose to write their config.
   */
  dependsOn?: readonly string[]

  /** Builds the value exposed as `ctx[name]`. Runs once, at boot. */
  setup(context: PluginSetupContext): Value | Promise<Value>

  /** Runs per request, before middleware. Use for per-request state such as a session. */
  onRequest?(ctx: Context): unknown

  /** Releases resources during graceful shutdown — pools, workers, connections. */
  onShutdown?(value: Value): unknown
}

/** OpenAPI pieces a plugin can contribute, such as the auth module's security schemes. */
export interface OpenApiFragment {
  securitySchemes?: Record<string, unknown>
  tags?: Array<{ name: string; description?: string }>
}

/**
 * The parts of the app a plugin may inspect.
 *
 * Deliberately narrow. A plugin handed the whole `App` could register routes after boot or
 * mutate settings mid-flight; this exposes only what a plugin has a legitimate reason to reach.
 */
export interface PluginHost {
  /**
   * Every registered route with its schemas.
   *
   * Call this lazily — from inside a request handler rather than during `setup()` — because
   * plugins registered after this one are still adding routes while setup runs.
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

/** What a plugin is handed during `setup()`. */
export interface PluginSetupContext {
  /** Values from plugins this one declared a dependency on, keyed by plugin name. */
  resolved: Readonly<Record<string, unknown>>
  /** Register routes the plugin owns, such as `/auth/*` or the docs UI. */
  route(method: string, path: string, handler: (ctx: Context) => unknown): void
  /** True outside production, so plugins can pick safe-by-default behaviour. */
  development: boolean
  /** The app, for plugins that must inspect it — the OpenAPI generator reads the route table. */
  app: PluginHost
}

/**
 * Orders plugins so dependencies are set up first.
 *
 * A cycle is a configuration error that cannot be resolved at runtime, so it throws here — at
 * boot, naming both plugins — rather than deadlocking or silently picking an order.
 */
export function orderPlugins(plugins: readonly OvenPlugin[]): OvenPlugin[] {
  const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]))
  const ordered: OvenPlugin[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (plugin: OvenPlugin, trail: string[]): void => {
    const status = state.get(plugin.name)
    if (status === 'done') return
    if (status === 'visiting') {
      throw new Error(
        `Plugin dependency cycle: ${[...trail, plugin.name].join(' -> ')}. ` +
          'Two plugins cannot each require the other to be set up first.',
      )
    }

    state.set(plugin.name, 'visiting')

    for (const dependency of plugin.dependsOn ?? []) {
      const target = byName.get(dependency)
      if (!target) {
        throw new Error(
          `Plugin "${plugin.name}" depends on "${dependency}", which is not registered. ` +
            `Add it with .use() before starting the app.`,
        )
      }
      visit(target, [...trail, plugin.name])
    }

    state.set(plugin.name, 'done')
    ordered.push(plugin)
  }

  for (const plugin of plugins) visit(plugin, [])
  return ordered
}
