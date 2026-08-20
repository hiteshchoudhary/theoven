import type { Handler } from './app'
import type { Context } from './context'
import type { Dependency } from './dependency'
import type { ContextOf } from './file-routes'
import type { Middleware } from './middleware'
import { normalisePath } from './router/router'
import type { HttpMethod } from './router/types'
import type { ResolvedDeps, RouteSchema, ValidatedContext, ValidatedHandler } from './validation'

/**
 * Defaults a router applies to the routes inside it.
 *
 * Deliberately small. A router groups routes and says what they have in common; anything that
 * varies per route belongs on the route, where the reader is already looking.
 */
export interface RouterOptions {
  /**
   * Prefixed onto every path in this router, and onto every nested router's prefix.
   *
   * Segment-aware, like middleware prefixes: `/admin` covers `/admin/users` and never
   * `/administrators`.
   */
  prefix?: string
  /** Added to every route's OpenAPI tags. A route's own tags are kept as well. */
  tags?: readonly string[]
  /**
   * Default authorization requirement for every route in this router.
   *
   * A route's own `auth` wins — including `auth: false`, which is how one public route lives
   * inside an otherwise guarded group without the reader having to know the router's default.
   */
  auth?: unknown
  /**
   * Dependencies every route in this router resolves, as if each had declared them.
   *
   * Unlike `auth`, these **accumulate** with a route's own: a router dependency and a route
   * dependency are both wanted, and dropping either would silently not resolve something a
   * handler is about to read. On a name collision the route wins, as everywhere else.
   */
  deps?: Record<string, Dependency<unknown>>
}

/**
 * A handler on a router, whose `ctx.deps` carries the router's dependencies as well as its own.
 *
 * Router-level deps are resolved for every route in the group, so the handler has to *see* them —
 * otherwise `ctx.deps.tenant` is a type error on the very routes that resolve it, and the group
 * default becomes a trap rather than a convenience.
 *
 * Intersected onto the context rather than folded into a synthesised schema: the schema type is
 * what drives validation, and rewriting it to carry something validation does not use would put
 * a lie in the middle of the inference chain.
 */
export type RouterHandler<
  Schema extends RouteSchema,
  Deps extends Record<string, Dependency<unknown>>,
  Ext,
> = (ctx: ValidatedContext<Schema, Ext> & { deps: ResolvedDeps<Deps> }) => unknown

/**
 * The handler shape an implementation signature accepts.
 *
 * `never` as the parameter type, so every overload's handler is assignable to it. The overloads
 * above are what callers see and what gets type-checked; this only has to be wide enough not to
 * reject any of them.
 */
type AnyHandler = (ctx: never) => unknown

/** One route a router is holding, before it is mounted onto an app. */
export interface CollectedRoute {
  method: HttpMethod
  path: string
  schema: RouteSchema | undefined
  handler: (ctx: Context) => unknown
}

/**
 * Any router, whatever its context and dependency types.
 *
 * Nesting only ever calls `collect`, so the parameter is typed by what is used rather than by
 * the full class — otherwise a router with dependencies could not be nested inside one without,
 * which is the normal case.
 */
export interface MountableRoutes {
  collect(basePrefix?: string, inherited?: RouterOptions): CollectedRoutes
  readonly size: number
}

/** Everything a router contributes, flattened and resolved. */
export interface CollectedRoutes {
  routes: CollectedRoute[]
  middleware: Array<{ prefix: string | undefined; handler: Middleware }>
}

/**
 * Brand used to recognise a router at runtime.
 *
 * `Symbol.for` rather than `instanceof`: a bundler that ends up with two copies of this module
 * would make `instanceof` false for a router built by the other copy, and the failure — a router
 * silently treated as a brick — would be baffling.
 */
const ROUTER = Symbol.for('oven.router')

/** Whether a value is a router. Used by `app.use` to tell routers from bricks. */
export function isRouter(value: unknown): value is Router<never> {
  return typeof value === 'object' && value !== null && ROUTER in value
}

/** Joins a prefix onto a path without producing `//` or losing the leading slash. */
function join(prefix: string, path: string): string {
  if (!prefix) return path
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (path === '/') return base || '/'
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * A group of routes that can be built somewhere other than the app and mounted onto it.
 *
 * The unit Oven was missing: file routing groups by directory and `app.use(prefix, middleware)`
 * scopes middleware, but neither lets you write a set of routes once and mount it — with a
 * prefix, shared tags and a shared auth requirement — or ship one from a package (D30).
 *
 * ```ts
 * const admin = router({ prefix: '/admin', tags: ['admin'], auth: 'staff' })
 *
 * admin.get('/users', (ctx) => list())
 * admin.delete('/users/:id', { params: idParam }, (ctx) => remove(ctx.params.id))
 *
 * app.use(admin)
 * ```
 *
 * A router has no lifecycle of its own. It holds routes and middleware until something mounts
 * it, which is what keeps it safe to build at module scope and mount more than once.
 */
export class Router<
  Ext = unknown,
  Deps extends Record<string, Dependency<unknown>> = Record<never, never>,
> {
  readonly [ROUTER] = true

  /** Named `defaults`, not `options`: `options()` is an HTTP verb on this class. */
  private readonly defaults: RouterOptions
  private readonly entries: CollectedRoute[] = []
  private readonly middlewares: Middleware[] = []
  private readonly children: MountableRoutes[] = []

  constructor(options: RouterOptions = {}) {
    this.defaults = options
  }

  /** The prefix this router applies, normalised. Empty when it has none. */
  get prefix(): string {
    return this.defaults.prefix ?? ''
  }

  /** How many routes this router holds, including those of nested routers. */
  get size(): number {
    return this.entries.length + this.children.reduce((total, child) => total + child.size, 0)
  }

  private add(
    method: HttpMethod,
    path: string,
    schemaOrHandler: RouteSchema | AnyHandler,
    maybeHandler?: AnyHandler,
  ): this {
    const hasSchema = typeof schemaOrHandler === 'object'
    const handler = (hasSchema ? maybeHandler : schemaOrHandler) as (ctx: Context) => unknown
    const schema = hasSchema ? (schemaOrHandler as RouteSchema) : undefined

    if (typeof handler !== 'function') {
      throw new Error(`Route ${method} ${path} was registered without a handler function.`)
    }

    this.entries.push({ method, path, schema, handler })
    return this
  }

  route(
    method: HttpMethod,
    path: string,
    handler: RouterHandler<Record<never, never>, Deps, Ext>,
  ): this
  route<const S extends RouteSchema>(
    method: HttpMethod,
    path: string,
    schema: S,
    handler: RouterHandler<S, Deps, Ext>,
  ): this
  route(method: HttpMethod, path: string, b: RouteSchema | AnyHandler, c?: AnyHandler): this {
    return this.add(method, path, b, c)
  }

  get(path: string, handler: RouterHandler<Record<never, never>, Deps, Ext>): this
  get<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: RouterHandler<S, Deps, Ext>,
  ): this
  get(a: string, b: RouteSchema | AnyHandler, c?: AnyHandler): this {
    return this.add('GET', a, b, c)
  }

  post(path: string, handler: RouterHandler<Record<never, never>, Deps, Ext>): this
  post<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: RouterHandler<S, Deps, Ext>,
  ): this
  post(a: string, b: RouteSchema | AnyHandler, c?: AnyHandler): this {
    return this.add('POST', a, b, c)
  }

  put(path: string, handler: RouterHandler<Record<never, never>, Deps, Ext>): this
  put<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: RouterHandler<S, Deps, Ext>,
  ): this
  put(a: string, b: RouteSchema | AnyHandler, c?: AnyHandler): this {
    return this.add('PUT', a, b, c)
  }

  patch(path: string, handler: RouterHandler<Record<never, never>, Deps, Ext>): this
  patch<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: RouterHandler<S, Deps, Ext>,
  ): this
  patch(a: string, b: RouteSchema | AnyHandler, c?: AnyHandler): this {
    return this.add('PATCH', a, b, c)
  }

  delete(path: string, handler: RouterHandler<Record<never, never>, Deps, Ext>): this
  delete<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: RouterHandler<S, Deps, Ext>,
  ): this
  delete(a: string, b: RouteSchema | AnyHandler, c?: AnyHandler): this {
    return this.add('DELETE', a, b, c)
  }

  head(path: string, handler: RouterHandler<Record<never, never>, Deps, Ext>): this
  head<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: RouterHandler<S, Deps, Ext>,
  ): this
  head(a: string, b: RouteSchema | AnyHandler, c?: AnyHandler): this {
    return this.add('HEAD', a, b, c)
  }

  options(path: string, handler: RouterHandler<Record<never, never>, Deps, Ext>): this
  options<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: RouterHandler<S, Deps, Ext>,
  ): this
  options(a: string, b: RouteSchema | AnyHandler, c?: AnyHandler): this {
    return this.add('OPTIONS', a, b, c)
  }

  /** Middleware scoped to this router's prefix, or a nested router. */
  use(middleware: Middleware): this
  use(child: MountableRoutes): this
  use(value: Middleware | MountableRoutes): this {
    if (typeof value === 'function') {
      this.middlewares.push(value)
      return this
    }
    this.children.push(value)
    return this
  }

  /**
   * Flattens this router into routes and middleware, with prefixes joined and defaults applied.
   *
   * Called by `app.use(router)`. Public because a brick that ships routes wants to see what it
   * is about to register, and because it makes the merge rules testable without an app.
   */
  collect(basePrefix = '', inherited: RouterOptions = {}): CollectedRoutes {
    const prefix = join(basePrefix, this.prefix)
    const tags = [...(inherited.tags ?? []), ...(this.defaults.tags ?? [])]
    const auth = this.defaults.auth ?? inherited.auth
    const deps =
      inherited.deps || this.defaults.deps
        ? { ...inherited.deps, ...this.defaults.deps }
        : undefined

    const routes: CollectedRoute[] = this.entries.map((entry) => ({
      method: entry.method,
      path: normalisePath(join(prefix, entry.path)),
      schema: merge(entry.schema, tags, auth, deps),
      handler: entry.handler,
    }))

    const middleware = this.middlewares.map((handler) => ({
      prefix: prefix || undefined,
      handler,
    }))

    for (const child of this.children) {
      const collected = child.collect(prefix, { tags, auth, ...(deps ? { deps } : {}) })
      routes.push(...collected.routes)
      middleware.push(...collected.middleware)
    }

    return { routes, middleware }
  }
}

/**
 * Applies a router's defaults to one route's schema.
 *
 * `tags` accumulate — a route in `/admin/users` is plausibly tagged both `admin` and `users`, and
 * dropping either would lose a grouping someone asked for. Everything else is override, and the
 * route wins: the declaration in front of the reader is the one that should be true.
 */
function merge(
  schema: RouteSchema | undefined,
  tags: string[],
  auth: unknown,
  deps: Record<string, Dependency<unknown>> | undefined,
): RouteSchema | undefined {
  const hasTags = tags.length > 0
  const hasAuth = auth !== undefined
  const hasDeps = deps !== undefined && Object.keys(deps).length > 0

  if (!hasTags && !hasAuth && !hasDeps) return schema
  if (!schema) {
    return {
      ...(hasTags ? { tags: [...tags] } : {}),
      ...(hasAuth ? { auth } : {}),
      ...(hasDeps ? { deps: { ...deps } } : {}),
    }
  }

  const combined = hasTags ? [...new Set([...tags, ...(schema.tags ?? [])])] : schema.tags
  // Spread the route's own last, so its name wins a collision — the same precedence as `auth`,
  // but accumulating rather than replacing, because two dependencies are both needed.
  const merged = hasDeps ? { ...deps, ...schema.deps } : schema.deps

  return {
    ...schema,
    ...(combined ? { tags: combined } : {}),
    ...(merged ? { deps: merged } : {}),
    // `'auth' in schema` rather than a truthiness check: `auth: false` is an explicit "this one
    // is public", and it has to survive a router that guards everything else.
    auth: 'auth' in schema ? schema.auth : auth,
  }
}

/**
 * A router with no context typing. Use it when the routes touch no bricks.
 *
 * ```ts
 * const health = router({ prefix: '/_health' })
 * health.get('/live', () => ({ ok: true }))
 * ```
 */
export function router<const Options extends RouterOptions>(
  options: Options = {} as Options,
): Router<unknown, DepsOf<Options>> {
  return new Router(options)
}

/** The dependency map an options object declares, or none. */
type DepsOf<Options extends RouterOptions> =
  Options['deps'] extends Record<string, Dependency<unknown>>
    ? Options['deps']
    : Record<never, never>

/**
 * A router whose handlers know which bricks the app registered.
 *
 * The same problem `routesFor` solves, for the same reason (D28): a router in its own module
 * cannot see the app, so the app's type is bound explicitly with a **type-only** import — which
 * does not create a cycle with the module that mounts it.
 *
 * ```ts title="src/routes/admin.ts"
 * import { routerFor } from '@theoven/core'
 * import type { app } from '../app'
 *
 * export const admin = routerFor<typeof app>({ prefix: '/admin', auth: 'staff' })
 *
 * admin.get('/users', (ctx) => ctx.db.select().from(users))
 * //                            ^ typed, because the app type is bound above
 * ```
 */
export function routerFor<Application>(
  options: RouterOptions = {},
): Router<ContextOf<Application>> {
  return new Router<ContextOf<Application>>(options)
}
