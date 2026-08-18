import type { Context } from './context'

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

/** What a plugin is handed during `setup()`. */
export interface PluginSetupContext {
  /** Values from plugins this one declared a dependency on, keyed by plugin name. */
  resolved: Readonly<Record<string, unknown>>
  /** Register routes the plugin owns, such as `/auth/*` or the docs UI. */
  route(method: string, path: string, handler: (ctx: Context) => unknown): void
  /** True outside production, so plugins can pick safe-by-default behaviour. */
  development: boolean
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
