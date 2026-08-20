import type { Server } from 'bun'
import type { BodyOptions } from './body'
import {
  type Brick,
  type BrickHost,
  type RouteInfo as BrickRouteInfo,
  type BrickSetupContext,
  type OpenApiFragment,
  orderBricks,
  type RequestResult,
} from './brick'
import { Context, type ContextInit } from './context'
import type { CookieJarInit } from './cookies'
import { OvenError, toOvenError } from './errors'
import { ConsoleLogger, type Logger, type LogLevel } from './logger'
import { appliesTo, compose, type Middleware } from './middleware'
import type { QueryOptions } from './query'
import { tookControl } from './response'
import { normalisePath, Router as RadixRouter } from './router/router'
import { type HttpMethod, isHttpMethod } from './router/types'
import { isRouter, type Router } from './routes'
import type { TokenOptions } from './token'
import { pathnameOf } from './url'
import {
  type RouteSchema,
  type ValidatedHandler,
  validateRequest,
  validateResponse,
} from './validation'
import {
  isUpgrade,
  type SocketData,
  type SocketHandlers,
  socketRouter,
  UPGRADED,
} from './websocket'

/**
 * A route handler. Returns anything — the value is coerced into a `Response`.
 *
 * `Ext` carries whatever bricks have contributed, so `ctx.storage` exists exactly when the
 * storage brick is registered. There is no `next`, no `res`, and no callback: a handler either
 * returns a value or throws, and async throws are caught identically to synchronous ones.
 */
export type Handler<Ext = unknown> = (ctx: Context & Ext) => unknown

/** Bricks that contribute per-request state, kept so dispatch can run them in order. */
interface RequestContributor {
  name: string
  request: NonNullable<Brick['request']>
}

/** Replaces the default problem+json rendering for failures. */
export type ErrorHandler = (error: OvenError, ctx: Context) => unknown

/** Runs before routing. Returning anything but `undefined` short-circuits the request. */
export type RequestHook = (ctx: Context) => unknown
/** Runs after routing, before the handler. Returning a value skips the handler. */
export type BeforeHandleHook = (ctx: Context) => unknown
/** Transforms the handler's result. Return `undefined` to leave it alone. */
export type AfterHandleHook = (ctx: Context, result: unknown) => unknown
/** Inspects or replaces the finished response. */
export type ResponseHook = (ctx: Context, response: Response) => unknown

export interface AppOptions {
  /** Port for `listen()`. Defaults to `PORT` from the environment, then 3000. */
  port?: number
  hostname?: string
  /** Swap in pino, winston, or anything satisfying `Logger`. */
  logger?: Logger
  logLevel?: LogLevel
  /** Header consulted for an inbound request id. Defaults to `x-request-id`. */
  requestIdHeader?: string
  /** Echo the request id on responses. Defaults to true. */
  echoRequestId?: boolean
  /**
   * Controls whether internal error messages and stacks reach the client.
   * Defaults to `NODE_ENV !== 'production'` — safe by default where it matters.
   */
  development?: boolean
  /** How long `close()` waits for in-flight requests before forcing the socket shut. Default 10s. */
  shutdownTimeout?: number
  onError?: ErrorHandler

  /** Body parsing limits: total size, per-file size, file count, MIME allowlist. */
  body?: BodyOptions
  /** Query parsing limits: nesting depth and key count. */
  query?: QueryOptions
  /** Cookie settings, notably the secret used for signed cookies. */
  cookies?: CookieJarInit
  /** Where `ctx.token` is looked for beyond the `Authorization` header. */
  token?: TokenOptions
  /**
   * Whether `X-Forwarded-For` may set `ctx.ip`. Default `false`.
   *
   * Leave it off unless a proxy you control is in front: the header is client-supplied, so
   * trusting it without one lets callers pick their own IP and walk past anything keyed on it.
   */
  trustProxy?: boolean | number
  /**
   * Check handler results against their declared response schemas. Defaults to `development`.
   *
   * Off in production on purpose. This validates *our* code, not untrusted input, so the bug it
   * catches is one CI and local development should have caught already — and unlike request
   * validation, the cost is paid on every successful response.
   */
  validateResponses?: boolean

  /**
   * Use a response schema's **parsed output** as the response body. Defaults to `true`.
   *
   * This is what makes a response schema a safety property rather than documentation (D29). A
   * Zod object strips keys it does not declare, so a route returning a database row sends only
   * the fields it promised — the `passwordHash` on that row cannot reach the client because it
   * is not in the schema.
   *
   * Only routes that declare a response schema pay for it, which is what keeps this consistent
   * with "lazy, not eager": declaring the schema *is* the opt-in.
   *
   * Set `false` to send the handler's value untouched. `validateResponses` still governs whether
   * a mismatch fails the request.
   */
  serializeResponses?: boolean
}

const PROBLEM_TYPE = 'application/problem+json; charset=utf-8'

/** Shared by every context until routing resolves; frozen so nothing can mutate it. */
/** Distinguishes "never cached" from "cached with no server". */
const UNSET = Symbol('unset')

const EMPTY_PARAMS: Record<string, string> = Object.freeze({})

/** What the router stores: the handler plus the schemas declared alongside it, if any. */
interface RouteEntry {
  handler: (ctx: Context) => unknown
  schema: RouteSchema | undefined
  /** Kept so a brick's `request()` hook can be told which route matched. */
  pattern: string
  /** Present on a route registered with `app.ws()`. */
  socket?: SocketHandlers<never> | undefined
}

/**
 * An Oven application.
 *
 * Two ways in: `listen()` binds a socket, and `fetch()` dispatches a `Request` directly. They
 * run the identical pipeline, which is why the test suite never needs a real port — and why a
 * passing test means the served behaviour is genuinely covered.
 */
export class App<Ext = unknown> implements BrickHost {
  /**
   * Carries `Ext` where a type can read it back off the class.
   *
   * `App<Ext>` uses its parameter only in method signatures, and TypeScript cannot recover a
   * type parameter from those. `routesFor<typeof app>()` needs it, so it is published here.
   * Declared, never assigned, and erased at runtime.
   */
  declare readonly __ext?: Ext

  private readonly router = new RadixRouter<RouteEntry>()
  private readonly sockets = socketRouter()
  /** Socket handlers by route pattern, looked up once a route matches. */
  private readonly socketRoutes = new Map<string, SocketHandlers<unknown>>()
  /**
   * Resolved configuration.
   *
   * Named `settings` rather than `options` because `options()` is a public verb method — a
   * field of the same name silently shadows it on the instance, and the resulting failure
   * (`app.options is not a function`) points nowhere near the cause.
   */
  private readonly settings: Required<
    Omit<
      AppOptions,
      'logger' | 'onError' | 'port' | 'hostname' | 'body' | 'query' | 'cookies' | 'token'
    >
  >
  private readonly rawOptions: AppOptions
  private readonly baseLogger: Logger
  private errorHandler: ErrorHandler | undefined
  private readonly port: number
  private readonly hostname: string | undefined

  private server: Server<unknown> | undefined
  private shutdownHooks: Array<() => unknown> = []

  private readonly middleware: Array<{ prefix: string | undefined; handler: Middleware }> = []
  /**
   * Composed chains, keyed by which middleware apply.
   *
   * Keyed by the applicable set rather than by path: paths containing parameters are unbounded,
   * so a path-keyed cache would grow without limit. The number of distinct applicable sets is
   * tiny — one, in the common case where no middleware is path-scoped.
   */
  private readonly chains = new Map<string, (ctx: Context) => Promise<unknown>>()
  private readonly hooks = {
    request: [] as RequestHook[],
    beforeHandle: [] as BeforeHandleHook[],
    afterHandle: [] as AfterHandleHook[],
    response: [] as ResponseHook[],
  }

  private readonly bricks: Brick[] = []
  /** Bricks with a `request()` hook, in dependency order. Empty for most apps. */
  private contributors: RequestContributor[] = []
  /**
   * Bricks with an `onRequest` hook, filtered at boot.
   *
   * Most bricks contribute a service and nothing per request. Walking every brick to ask each one
   * whether it has a hook is work proportional to how many features an app installs, paid on
   * every request — which is exactly the wrong way round.
   */
  private requestBricks: Array<Brick & { onRequest: NonNullable<Brick['onRequest']> }> = []
  /** Every registered route with its schemas — what OpenAPI generation reads. */
  private readonly registered: Array<{
    method: HttpMethod
    pattern: string
    schema: RouteSchema | undefined
  }> = []
  private readonly openApi: Required<OpenApiFragment> = { securitySchemes: {}, tags: [] }
  private readonly resolved: Record<string, unknown> = {}
  /** Context subclass carrying brick values on its prototype; built once at boot. */
  private ContextClass: new (
    req: Request,
    params: Record<string, string>,
    init: ContextInit,
    path?: string,
  ) => Context = Context
  private readyPromise: Promise<void> | undefined

  /** In-flight request accounting, so shutdown can drain rather than guillotine. */
  private inFlight = 0
  private closing = false
  private drained: (() => void) | undefined
  private signalHandler: (() => void) | undefined

  constructor(options: AppOptions = {}) {
    this.rawOptions = options
    this.port = options.port ?? Number(Bun.env.PORT ?? 3000)
    this.hostname = options.hostname
    this.errorHandler = options.onError
    this.settings = {
      logLevel: options.logLevel ?? 'info',
      requestIdHeader: options.requestIdHeader ?? 'x-request-id',
      echoRequestId: options.echoRequestId ?? true,
      development: options.development ?? Bun.env.NODE_ENV !== 'production',
      shutdownTimeout: options.shutdownTimeout ?? 10_000,
      trustProxy: options.trustProxy ?? false,
      validateResponses:
        options.validateResponses ?? options.development ?? Bun.env.NODE_ENV !== 'production',
      serializeResponses: options.serializeResponses ?? true,
    }
    this.baseLogger = options.logger ?? new ConsoleLogger({ level: this.settings.logLevel })
  }

  /**
   * The context init, built once.
   *
   * This was a getter, so every request rebuilt it — the outer object, the nested `cookies`
   * spread, and then a third object for the `{ ...contextInit, server }` in dispatch. Three
   * allocations per request for values that cannot change after construction.
   *
   * Keyed on the server because that is the only part that varies, and it varies once: `undefined`
   * for a directly dispatched `Request`, and the `Server` after `listen()`.
   */
  private cachedInit: ContextInit | undefined
  private cachedInitServer: Server<unknown> | undefined | typeof UNSET = UNSET

  private initFor(server: Server<unknown> | undefined): ContextInit {
    if (this.cachedInit !== undefined && this.cachedInitServer === server) return this.cachedInit

    this.cachedInit = {
      logger: this.baseLogger,
      requestIdHeader: this.settings.requestIdHeader,
      body: this.rawOptions.body,
      query: this.rawOptions.query,
      // Secure cookies wherever we are not in development, so shipping to production does not
      // quietly downgrade every session cookie.
      cookies: { secureByDefault: !this.settings.development, ...this.rawOptions.cookies },
      token: this.rawOptions.token,
      trustProxy: this.settings.trustProxy,
      server,
    }
    this.cachedInitServer = server
    return this.cachedInit
  }

  // ---------------------------------------------------------------- extension

  /**
   * Registers middleware or a brick.
   *
   * A function is middleware; an object is a brick. They share a name because they are the
   * same idea at two scales — "wrap the request" and "add a capability" — and the runtime can
   * tell them apart with no ambiguity.
   */
  use(middleware: Middleware): this
  use(prefix: string, middleware: Middleware): this
  /**
   * Mounts a [router](./routes.ts) — its routes, its prefix, its defaults and any middleware it
   * carries (D30).
   *
   * Mounting does not tie the router to this app, so the same router can be mounted twice under
   * different prefixes, and a package can export one.
   */
  use(routes: Router<Ext>): this
  /**
   * Registering a brick widens the context type with everything it contributes.
   *
   * Inferred from the brick object rather than from declared type parameters, so a caller
   * writing `{ name: 'auth', setup, request }` never spells out a generic.
   *
   * The parameter is spelled out inline rather than as `Brick<Name, Value, Request>`. Naming
   * the interface fixes its type parameters to their declared defaults during inference, which
   * silently collapses the `request()` return type and loses `ctx.user` — the entire point of
   * the hook. Written inline, all three infer independently, and `onShutdown` still receives
   * the value `setup()` produced.
   */
  use<
    Name extends string,
    Value,
    Request extends Record<string, unknown> = Record<never, never>,
  >(brick: {
    name: Name
    dependsOn?: readonly string[]
    setup(context: BrickSetupContext): Value | Promise<Value>
    request?(ctx: Context, route: BrickRouteInfo): RequestResult<Request>
    onRequest?(ctx: Context): unknown
    onShutdown?(value: Value): unknown
  }): App<Ext & { [K in Name]: Value } & Request>
  // The implementation signature must be compatible with every overload above, and no concrete
  // type is assignable to both `this` and `App<Ext & {...}>`. `any` here is confined to the
  // signature; callers only ever see the typed overloads.
  use(
    first: Middleware | string | Router<Ext> | Brick<string, unknown, Record<string, unknown>>,
    second?: Middleware,
    // biome-ignore lint/suspicious/noExplicitAny: overload implementation signature
  ): any {
    if (typeof first === 'string') {
      if (!second) throw new Error('use(prefix, middleware) needs a middleware function.')
      this.middleware.push({ prefix: first, handler: second })
      this.invalidateChains()
      return this
    }

    if (typeof first === 'function') {
      this.middleware.push({ prefix: undefined, handler: first })
      this.invalidateChains()
      return this
    }

    if (isRouter(first)) {
      const { routes, middleware } = first.collect()
      // Middleware first, so a router's own middleware wraps its routes regardless of the order
      // the two happened to be declared in inside the router.
      for (const entry of middleware) {
        this.middleware.push(entry)
      }
      if (middleware.length > 0) this.invalidateChains()

      for (const route of routes) {
        // The same erasure `register` performs internally: one route table holds handlers for
        // many different schemas, and no single signature covers them all.
        this.register(
          route.method,
          route.path,
          (route.schema ?? route.handler) as RouteSchema,
          route.handler as unknown as ValidatedHandler<RouteSchema, Ext>,
        )
      }
      return this
    }

    const brick = first as Brick<string, unknown, Record<string, unknown>>

    if (this.readyPromise) {
      throw new Error(
        `Brick "${brick.name}" was registered after the app started. Bricks must be added ` +
          'before the first request, because their setup runs at boot.',
      )
    }
    if (this.bricks.some((registered) => registered.name === brick.name)) {
      throw new Error(`Brick "${brick.name}" is already registered.`)
    }

    this.bricks.push(brick)
    return this
  }

  /** Runs before routing. Returning a value short-circuits the request. */
  onRequest(hook: RequestHook): this {
    this.hooks.request.push(hook)
    return this
  }

  /** Runs after routing with params available. Returning a value skips the handler. */
  beforeHandle(hook: BeforeHandleHook): this {
    this.hooks.beforeHandle.push(hook)
    return this
  }

  /** Transforms the handler's result. Returning `undefined` leaves it unchanged. */
  afterHandle(hook: AfterHandleHook): this {
    this.hooks.afterHandle.push(hook)
    return this
  }

  /** Inspects or replaces the finished response. */
  onResponse(hook: ResponseHook): this {
    this.hooks.response.push(hook)
    return this
  }

  /** Replaces the default problem+json error rendering. */
  onError(handler: ErrorHandler): this {
    this.errorHandler = handler
    return this
  }

  /** Runs during `close()`, before the socket is released. */
  onShutdown(hook: () => unknown): this {
    this.shutdownHooks.push(hook)
    return this
  }

  /** Middleware changed, so every cached chain is stale. */
  private invalidateChains(): void {
    this.chains.clear()
  }

  // ---------------------------------------------------------------- routing

  /**
   * Shared registration path.
   *
   * The public verbs are overloaded so a schema is optional, and TypeScript requires one
   * implementation signature compatible with every overload. Funnelling them through one
   * private method keeps that awkwardness in a single place instead of seven.
   */
  private register(
    method: HttpMethod,
    path: string,
    schemaOrHandler: RouteSchema | Handler<Ext>,
    maybeHandler?: ValidatedHandler<RouteSchema, Ext>,
  ): this {
    const hasSchema = typeof schemaOrHandler === 'object'
    const handler = (hasSchema ? maybeHandler : schemaOrHandler) as (ctx: Context) => unknown
    const schema = hasSchema ? (schemaOrHandler as RouteSchema) : undefined

    if (typeof handler !== 'function') {
      throw new Error(`Route ${method} ${path} was registered without a handler function.`)
    }

    const pattern = normalisePath(path)
    this.router.insert(method, path, { handler, schema, pattern })
    this.registered.push({ method, pattern, schema })
    return this
  }

  /**
   * Registers a handler, optionally with schemas.
   *
   * File-based routing (§1.8) is the DX users see, but it compiles down to this, and bricks
   * that contribute endpoints — `/auth/*`, the docs UI — call it directly.
   */
  route(method: HttpMethod, path: string, handler: Handler<Ext>): this
  route<const Schema extends RouteSchema>(
    method: HttpMethod,
    path: string,
    schema: Schema,
    handler: ValidatedHandler<Schema, Ext>,
  ): this
  route(
    method: HttpMethod,
    path: string,
    schemaOrHandler: RouteSchema | Handler<Ext>,
    maybeHandler?: ValidatedHandler<RouteSchema, Ext>,
  ): this {
    return this.register(method, path, schemaOrHandler, maybeHandler)
  }

  get(path: string, handler: Handler<Ext>): this
  get<const S extends RouteSchema>(path: string, schema: S, handler: ValidatedHandler<S, Ext>): this
  get(a: string, b: RouteSchema | Handler<Ext>, c?: ValidatedHandler<RouteSchema, Ext>): this {
    return this.register('GET', a, b, c)
  }

  post(path: string, handler: Handler<Ext>): this
  post<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: ValidatedHandler<S, Ext>,
  ): this
  post(a: string, b: RouteSchema | Handler<Ext>, c?: ValidatedHandler<RouteSchema, Ext>): this {
    return this.register('POST', a, b, c)
  }

  put(path: string, handler: Handler<Ext>): this
  put<const S extends RouteSchema>(path: string, schema: S, handler: ValidatedHandler<S, Ext>): this
  put(a: string, b: RouteSchema | Handler<Ext>, c?: ValidatedHandler<RouteSchema, Ext>): this {
    return this.register('PUT', a, b, c)
  }

  patch(path: string, handler: Handler<Ext>): this
  patch<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: ValidatedHandler<S, Ext>,
  ): this
  patch(a: string, b: RouteSchema | Handler<Ext>, c?: ValidatedHandler<RouteSchema, Ext>): this {
    return this.register('PATCH', a, b, c)
  }

  delete(path: string, handler: Handler<Ext>): this
  delete<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: ValidatedHandler<S, Ext>,
  ): this
  delete(a: string, b: RouteSchema | Handler<Ext>, c?: ValidatedHandler<RouteSchema, Ext>): this {
    return this.register('DELETE', a, b, c)
  }

  head(path: string, handler: Handler<Ext>): this
  head<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: ValidatedHandler<S, Ext>,
  ): this
  head(a: string, b: RouteSchema | Handler<Ext>, c?: ValidatedHandler<RouteSchema, Ext>): this {
    return this.register('HEAD', a, b, c)
  }

  options(path: string, handler: Handler<Ext>): this
  options<const S extends RouteSchema>(
    path: string,
    schema: S,
    handler: ValidatedHandler<S, Ext>,
  ): this
  options(a: string, b: RouteSchema | Handler<Ext>, c?: ValidatedHandler<RouteSchema, Ext>): this {
    return this.register('OPTIONS', a, b, c)
  }

  /**
   * Registers a WebSocket route.
   *
   * ```ts
   * app.ws('/rooms/:id', { auth: true, params: z.object({ id: z.uuid() }) }, {
   *   upgrade: (ctx) => ({ room: ctx.params.id, userId: ctx.user.id }),
   *   open:    (socket) => socket.subscribe(socket.data.data.room),
   *   message: (socket, text) => { app.publish(socket.data.data.room, String(text)) },
   * })
   * ```
   *
   * It is a `GET` route that happens to upgrade, which is the whole point: the guard, the params
   * schema and the brick hooks all run **before** the socket opens. A separate socket entry point
   * would mean a second, weaker authentication story — and that is how socket endpoints become
   * the unguarded way into an application.
   */
  ws<Data, const Schema extends RouteSchema>(
    pattern: string,
    schema: Schema,
    handlers: SocketHandlers<Data>,
  ): this
  ws<Data>(pattern: string, handlers: SocketHandlers<Data>): this
  ws(pattern: string, b: RouteSchema | SocketHandlers<unknown>, c?: SocketHandlers<unknown>): this {
    const schema = c ? (b as RouteSchema) : undefined
    const handlers = (c ?? b) as SocketHandlers<unknown>

    this.register(
      'GET',
      pattern,
      (schema ?? {}) as RouteSchema,
      // Reached only when the client asked for a plain GET on a socket route.
      (() =>
        this.refuse(
          426,
          'Upgrade Required',
          'This endpoint speaks WebSocket. Connect with ws:// or wss://.',
          { upgrade: 'websocket', connection: 'Upgrade' },
        )) as never,
    )

    // The socket handlers ride on the route entry the registration just created.
    const entry = this.router.find('GET', pattern.replace(/:([^/]+)/g, 'x'))
    void entry
    this.socketRoutes.set(pattern, handlers)
    return this
  }

  /**
   * Sends a message to every socket subscribed to a topic.
   *
   * Bun's own pub/sub, so a broadcast does not walk a list of connections in JavaScript.
   */
  publish(topic: string, message: string): number {
    return this.server?.publish(topic, message) ?? 0
  }

  /** Every registered route. Backs `oven routes` and the boot banner. */
  routes(): ReadonlyArray<{ method: HttpMethod; pattern: string }> {
    return this.router.routes()
  }

  /**
   * A brick's contributed service, outside a request.
   *
   * `ctx.db` and `ctx.queue` exist on the context because that is where an application wants
   * them. A migration script, a seed, and `oven worker` all want the same configured value with
   * no request in sight — and reaching it by re-constructing the brick would give them a
   * *second* connection pool and a second set of job definitions.
   *
   * ```ts
   * await app.ready()
   * const db = app.service('db')
   * ```
   *
   * Typed from what `.use()` contributed, so `app.service('storage')` on an app without the
   * storage brick is a compile error rather than `undefined` at runtime.
   */
  service<Name extends keyof Ext & string>(name: Name): Ext[Name]
  service(name: string): unknown {
    if (!(name in this.resolved)) {
      const registered = Object.keys(this.resolved)
      throw new Error(
        `No brick named "${name}" is registered${registered.length > 0 ? `. Registered: ${registered.join(', ')}` : ''}.` +
          (this.readyPromise ? '' : ' Call await app.ready() first — bricks are set up at boot.'),
      )
    }
    return this.resolved[name]
  }

  /** Every registered route with its schemas. Read lazily; see `BrickHost`. */
  routeTable(): ReadonlyArray<{
    method: HttpMethod
    pattern: string
    schema: RouteSchema | undefined
  }> {
    return this.registered
  }

  /** Merges an OpenAPI fragment contributed by a brick. */
  contributeOpenApi(fragment: OpenApiFragment): void {
    Object.assign(this.openApi.securitySchemes, fragment.securitySchemes ?? {})
    if (fragment.tags) this.openApi.tags.push(...fragment.tags)
  }

  /** Everything bricks have contributed to the OpenAPI document. */
  openApiFragments(): Required<OpenApiFragment> {
    return this.openApi
  }

  get logger(): Logger {
    return this.baseLogger
  }

  // ---------------------------------------------------------------- boot

  /**
   * Sets up bricks. Idempotent, and awaited by both `listen()` and `fetch()`.
   *
   * Brick values are installed on a `Context` subclass prototype rather than copied onto each
   * context, so ten bricks cost nothing per request.
   */
  async ready(): Promise<void> {
    this.readyPromise ??= this.boot()
    return this.readyPromise
  }

  private async boot(): Promise<void> {
    if (this.bricks.length === 0) return

    for (const brick of orderBricks(this.bricks)) {
      // Colliding with a core property would shadow the real thing in a way that surfaces far
      // from the brick responsible, so it is rejected here, by name, at boot.
      if (brick.name in Context.prototype || brick.name === 'req' || brick.name === 'params') {
        throw new Error(
          `Brick "${brick.name}" collides with a built-in context property. Choose another name.`,
        )
      }

      const setup: BrickSetupContext = {
        resolved: this.resolved,
        route: (method, path, handler) => {
          if (!isHttpMethod(method)) {
            throw new Error(`Brick "${brick.name}" registered an unsupported method: ${method}`)
          }
          this.route(method, path, handler as Handler<Ext>)
        },
        development: this.settings.development,
        app: this,
      }

      this.resolved[brick.name] = await brick.setup(setup)
    }

    const Extended = class extends Context {}
    for (const [name, value] of Object.entries(this.resolved)) {
      Object.defineProperty(Extended.prototype, name, { value, enumerable: false })
    }
    this.ContextClass = Extended as unknown as typeof this.ContextClass

    // Ordered the same way setup was, so a brick that depends on another also sees its
    // per-request state already contributed.
    this.contributors = orderBricks(this.bricks)
      .filter((brick) => typeof brick.request === 'function')
      .map((brick) => ({
        name: brick.name,
        request: brick.request as RequestContributor['request'],
      }))

    this.requestBricks = this.bricks.filter(
      (brick): brick is Brick & { onRequest: NonNullable<Brick['onRequest']> } =>
        typeof brick.onRequest === 'function',
    )

    for (const brick of this.bricks) {
      const teardown = brick.onShutdown
      if (teardown) {
        const value = this.resolved[brick.name]
        this.onShutdown(() => teardown(value))
      }
    }
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * Handles one request.
   *
   * Bound rather than declared as a method so it can be handed straight to `Bun.serve` and to
   * tests without losing `this`.
   */
  /**
   * Handles a request and always answers with a `Response`.
   *
   * This is the surface tests and `app.fetch()` callers use. The variant Bun gets is `serve`
   * below, which may answer with nothing — but making *this* return `Response | undefined` would
   * force every test in every application to handle a case only the socket upgrade can produce.
   */
  readonly fetch = async (request: Request, server?: Server<unknown>): Promise<Response> => {
    const response = await this.serve(request, server)

    // Only reachable when a socket upgrade succeeded, which needs a listening server — so never
    // from a directly dispatched Request.
    return response ?? new Response(null, { status: 101 })
  }

  /**
   * The handler `Bun.serve` gets.
   *
   * Returns `undefined` for an accepted upgrade: answering with a `Response` there makes Bun
   * close the socket it has just opened.
   */
  private readonly serve = async (
    request: Request,
    server?: Server<unknown>,
  ): Promise<Response | undefined> => {
    // Refuse new work once draining has started, so a rolling deploy sheds load in a way
    // clients can act on rather than by dropping connections.
    if (this.closing) {
      return this.refuse(503, 'Service Unavailable', 'The server is shutting down.', {
        'retry-after': '5',
      })
    }

    if (this.readyPromise === undefined) await this.ready()

    this.inFlight++
    try {
      const response = await this.dispatch(request, server)
      // An accepted upgrade must answer with nothing: returning a Response here makes Bun close
      // the socket it has just opened.
      return response === UPGRADED ? undefined : response
    } finally {
      this.inFlight--
      if (this.closing && this.inFlight === 0) this.drained?.()
    }
  }

  /**
   * Builds the context, runs the request hooks, then routes inside the middleware chain.
   *
   * Middleware wraps *routing*, not just the handler. A CORS preflight, a 404 that still needs
   * security headers, a request log that should include misses — none of those work if
   * middleware only runs once a route has matched. This is the ordering Express and Koa use,
   * and getting it wrong makes CORS impossible to configure correctly.
   */
  private async dispatch(
    request: Request,
    server: Server<unknown> | undefined,
  ): Promise<Response | typeof UPGRADED> {
    /**
     * Scanned once, here, and shared by everything downstream.
     *
     * Middleware prefix-matching and routing must agree on what the path *is*. When they did
     * not — `chainFor` scanning while `runRoute` read a `URL`-parsed `ctx.path` — a request whose
     * two readings differed would have been matched by one and not the other, which is how a
     * guard mounted on a prefix gets skipped on a route that still resolves. They cannot
     * disagree now because there is only one value.
     */
    const path = pathnameOf(request.url)
    const ctx = new this.ContextClass(request, EMPTY_PARAMS, this.initFor(server), path)

    try {
      if (this.hooks.request.length > 0) {
        for (const hook of this.hooks.request) {
          const result = await hook(ctx)
          if (result !== undefined) return await this.finish(ctx, result)
        }
      }

      const chain = this.chainFor(path)
      return await this.finish(ctx, await chain(ctx))
    } catch (thrown) {
      return this.handleError(thrown, ctx)
    }
  }

  /**
   * Routes the request and runs its handler. This is what the middleware chain wraps.
   *
   * Refusals are returned as `Response` objects rather than thrown, so middleware still sees
   * them on the way out and can add its headers.
   */
  private readonly runRoute = async (ctx: Context): Promise<unknown> => {
    const method = ctx.method
    const path = ctx.path

    if (!isHttpMethod(method)) {
      return this.refuse(501, 'Not Implemented', `Method ${method} is not supported.`)
    }

    let match = this.router.find(method, path)

    // HEAD is GET without a body. Serving it from the GET handler is what RFC 9110 requires,
    // and it means nobody has to remember to register HEAD routes.
    let headOfGet = false
    if (!match.found && method === 'HEAD') {
      const getMatch = this.router.find('GET', path)
      if (getMatch.found) {
        match = getMatch
        headOfGet = true
      }
    }

    if (!match.found) {
      // A path that exists under other methods deserves a correct OPTIONS reply for free.
      if (method === 'OPTIONS' && match.allowed.length > 0) {
        const allow = [...match.allowed, 'OPTIONS'].join(', ')
        return new Response(null, { status: 204, headers: { allow } })
      }
      if (match.allowed.length > 0) {
        return this.refuse(405, 'Method Not Allowed', `${method} is not allowed on ${path}.`, {
          allow: match.allowed.join(', '),
        })
      }
      return this.refuse(404, 'Not Found', `No route matches ${path}.`)
    }

    ctx.assignParams(match.params)
    ctx.assignRoutePattern(match.payload.pattern)

    if (this.requestBricks.length > 0) {
      for (const brick of this.requestBricks) await brick.onRequest?.(ctx)
    }

    const { handler, schema, pattern } = match.payload

    // Per-request contributions land as own properties, which shadow the prototype. A brick
    // that contributes nothing costs nothing: apps with no contributors skip this entirely.
    if (this.contributors.length > 0) {
      const route: BrickRouteInfo = { method, pattern, schema }
      for (const contributor of this.contributors) {
        const contributed = await contributor.request(ctx, route)
        if (!contributed) continue

        for (const [key, value] of Object.entries(contributed)) {
          Object.defineProperty(ctx, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        }
      }
    }

    // Validation runs after beforeHandle would have a chance to reject cheaply, but before the
    // handler — a handler should never see input it did not ask for.
    if (this.hooks.beforeHandle.length > 0) {
      for (const hook of this.hooks.beforeHandle) {
        const short = await hook(ctx)
        if (short !== undefined) return short
      }
    }

    if (schema) await validateRequest(ctx, schema)

    /**
     * The upgrade point.
     *
     * Everything protective has already run: the brick hooks populated `ctx.user`, the guard
     * refused an anonymous request, and the params schema rejected a malformed id. Only now does
     * the connection become a socket.
     */
    const socket = this.socketRoutes.get(pattern)
    if (socket && isUpgrade(ctx.req)) {
      const upgraded = await this.upgradeSocket(ctx, socket)
      if (upgraded !== undefined) return upgraded
      // `undefined` means Bun took the connection; there is no response to send.
      return UPGRADED
    }

    let result = await handler(ctx)

    // `tookControl` first: a handler that returned a Response or a stream is not describable by
    // a response schema, and checking it produced a 500 on a route that was working.
    if (
      schema?.response &&
      (this.settings.serializeResponses || this.settings.validateResponses) &&
      !tookControl(result)
    ) {
      const status = ctx.status ?? 200
      const outcome = await validateResponse(schema, status, result)

      if (outcome.issues.length > 0) {
        /**
         * A mismatch is loud in development and non-fatal in production, deliberately (D29).
         *
         * Failing closed in production would turn a schema that has drifted into an outage on
         * the deploy that introduced it — a working endpoint replaced by a 500 because of a
         * field nobody reads. Failing open keeps it serving.
         *
         * The cost of failing open is stated in the log line rather than left to be inferred:
         * a schema that did not parse did not filter either, so the unfiltered value is what
         * goes out.
         */
        ctx.log.error('Response does not match its declared schema', {
          path: ctx.path,
          status,
          issues: outcome.issues,
          // Said plainly, because the safety property people rely on is the one that just did
          // not happen: an unparsed value is an unfiltered one.
          filtered: false,
        })

        if (this.settings.validateResponses) {
          // The detail is withheld in production for the same reason any internal error is: it
          // describes our own data shapes, which is not the caller's business.
          throw new OvenError(
            500,
            'Internal Server Error',
            'Response validation failed.',
            this.settings.development ? { detail: { errors: outcome.issues } } : undefined,
          )
        }
      } else if (outcome.checked && this.settings.serializeResponses) {
        result = outcome.value
      }
    }

    if (this.hooks.afterHandle.length > 0) {
      for (const hook of this.hooks.afterHandle) {
        const transformed = await hook(ctx, result)
        if (transformed !== undefined) result = transformed
      }
    }

    if (headOfGet) {
      const response = ctx.respond(result)
      return new Response(null, { status: response.status, headers: response.headers })
    }

    return result
  }

  /**
   * Returns the composed chain for a path, building it at most once per applicable set.
   *
   * Composing per request would allocate a closure per layer on the hot path, for a structure
   * that does not change between requests to the same kind of path.
   */
  private chainFor(path: string): (ctx: Context) => Promise<unknown> {
    if (this.middleware.length === 0) return this.runRoute

    const applicable: number[] = []
    for (let index = 0; index < this.middleware.length; index++) {
      const entry = this.middleware[index]
      if (entry && appliesTo(entry.prefix, path)) applicable.push(index)
    }

    const key = applicable.join(',')
    let chain = this.chains.get(key)
    if (chain === undefined) {
      const layers = applicable.map(
        (index) => (this.middleware[index] as { handler: Middleware }).handler,
      )
      chain = compose(layers, this.runRoute)
      this.chains.set(key, chain)
    }
    return chain
  }

  /**
   * Performs the upgrade, or returns a `Response` explaining why it did not happen.
   *
   * `upgrade()` runs first so an application can attach per-connection state or refuse — and it
   * receives the same context the handler would have, so `ctx.user` and `ctx.params` are there.
   */
  private async upgradeSocket(
    ctx: Context,
    handlers: SocketHandlers<unknown>,
  ): Promise<Response | undefined> {
    const server = this.server
    if (!server) {
      // Dispatching a Request directly, as tests do. There is no socket to hand back.
      return this.refuse(
        426,
        'Upgrade Required',
        'WebSocket upgrades need a listening server; this request was dispatched directly.',
      )
    }

    // A throw here is an ordinary framework error: it becomes problem+json and no socket opens.
    const data = handlers.upgrade ? await handlers.upgrade(ctx) : undefined

    const payload: SocketData<unknown> = { data, requestId: ctx.id, route: handlers }

    const accepted = server.upgrade(ctx.req, {
      data: payload,
      ...(ctx.responseHeaders ? { headers: ctx.responseHeaders } : {}),
    })

    if (!accepted) {
      return this.refuse(400, 'Bad Request', 'The WebSocket upgrade was refused.')
    }

    // Bun owns the connection now, and finds its handlers on `socket.data.route`.
    return undefined
  }

  /** Coerces a result to a Response and runs the response hooks. */
  private async finish(ctx: Context, result: unknown): Promise<Response | typeof UPGRADED> {
    // An upgraded connection has no response to coerce or stamp.
    if (result === UPGRADED) return UPGRADED
    let response = ctx.respond(result)

    if (this.hooks.response.length > 0) {
      for (const hook of this.hooks.response) {
        const replacement = await hook(ctx, response)
        if (replacement instanceof Response) response = replacement
      }
    }

    this.stampRequestId(response, ctx)
    return response
  }

  private async handleError(thrown: unknown, ctx: Context): Promise<Response> {
    const error = toOvenError(thrown, !this.settings.development)

    // 5xx means we broke something; the operator needs the original, including the stack.
    if (error.status >= 500) {
      ctx.log.error(error.message, {
        status: error.status,
        path: ctx.path,
        method: ctx.method,
        stack: this.settings.development ? (error.cause ?? error) : undefined,
      })
    }

    if (this.errorHandler) {
      try {
        const handled = await this.errorHandler(error, ctx)
        if (handled !== undefined) {
          ctx.status ??= error.status
          const response = ctx.respond(handled)
          this.stampRequestId(response, ctx)
          return response
        }
      } catch (handlerFailure) {
        // A failing error handler must not mask the original problem.
        ctx.log.error('onError handler threw', { cause: String(handlerFailure) })
      }
    }

    return this.problem(error, ctx)
  }

  /**
   * Renders a problem document without constructing an `Error`.
   *
   * 404s and 405s are not exceptional — a scanner can produce thousands a second — and building
   * an `Error` for each captures a stack trace, one of the most expensive things a runtime does.
   * These refusals never surface a stack to anyone, so paying for one is pure waste.
   */
  private refuse(
    status: number,
    title: string,
    detail: string,
    headers?: Record<string, string>,
  ): Response {
    const body =
      detail === title
        ? `{"type":"about:blank","title":${JSON.stringify(title)},"status":${status}}`
        : `{"type":"about:blank","title":${JSON.stringify(title)},"status":${status},"detail":${JSON.stringify(detail)}}`

    return new Response(body, {
      status,
      headers: headers
        ? { ...headers, 'content-type': PROBLEM_TYPE }
        : { 'content-type': PROBLEM_TYPE },
    })
  }

  /** Renders an `OvenError` as RFC 9457 `application/problem+json`. */
  private problem(error: OvenError, ctx: Context): Response {
    const headers = new Headers(error.headers)
    headers.set('content-type', PROBLEM_TYPE)

    const body = error.toProblem()
    if (ctx.hasId) body.requestId = ctx.id

    const response = new Response(JSON.stringify(body), { status: error.status, headers })
    this.stampRequestId(response, ctx)
    return response
  }

  /**
   * Echoes the request id, but only when something actually used it.
   *
   * Generating an id for a request nobody traced would violate the lazy rule for no benefit.
   */
  private stampRequestId(response: Response, ctx: Context): void {
    if (!this.settings.echoRequestId || !ctx.hasId) return
    if (!response.headers.has(this.settings.requestIdHeader)) {
      response.headers.set(this.settings.requestIdHeader, ctx.id)
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts the server. Signal handlers are installed so SIGTERM drains rather than kills. */
  async listen(port = this.port): Promise<Server<unknown>> {
    if (this.server) throw new Error('This app is already listening.')

    await this.ready()

    this.server = Bun.serve({
      port,
      ...(this.hostname !== undefined ? { hostname: this.hostname } : {}),
      fetch: this.serve as (request: Request, server: Server<unknown>) => Promise<Response>,
      websocket: this.sockets as never,
    })

    this.signalHandler = () => {
      void this.close().then(() => process.exit(0))
    }
    process.on('SIGTERM', this.signalHandler)
    process.on('SIGINT', this.signalHandler)

    return this.server
  }

  /** The bound URL, or undefined when not listening. */
  get url(): string | undefined {
    return this.server?.url.href
  }

  /**
   * Shuts down gracefully.
   *
   * Stops accepting new requests, lets in-flight ones finish, runs shutdown hooks, then
   * releases the socket. Requests arriving during the drain get a 503 with `Retry-After`
   * rather than a dropped connection — the difference between a clean rolling deploy and a
   * burst of client-side errors.
   */
  async close(options: { timeout?: number } = {}): Promise<void> {
    if (this.closing) return
    this.closing = true

    const timeout = options.timeout ?? this.settings.shutdownTimeout

    if (this.signalHandler) {
      process.off('SIGTERM', this.signalHandler)
      process.off('SIGINT', this.signalHandler)
      this.signalHandler = undefined
    }

    // Stop accepting connections but keep serving what is already in flight.
    this.server?.stop(false)

    if (this.inFlight > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.drained = resolve
        }),
        Bun.sleep(timeout),
      ])
      if (this.inFlight > 0) {
        this.baseLogger.warn('Shutdown timed out with requests still in flight', {
          inFlight: this.inFlight,
          timeout,
        })
      }
    }

    for (const hook of this.shutdownHooks) {
      try {
        await hook()
      } catch (failure) {
        this.baseLogger.error('Shutdown hook failed', { cause: String(failure) })
      }
    }
    this.shutdownHooks = []

    // Force anything still hanging on; the drain window has already passed.
    this.server?.stop(true)
    this.server = undefined
  }
}

/** Creates an Oven application. */
export function createApp(options: AppOptions = {}): App {
  return new App(options)
}

/**
 * A project's configuration in one declarative object.
 *
 * `defineConfig` is sugar over the same brick mechanism `.use()` drives — the config surface
 * and the chaining surface are two views of one implementation, not two implementations.
 *
 * ```ts
 * export default defineConfig({
 *   trustProxy: 1,
 *   cookies: { secret: process.env.COOKIE_SECRET },
 *   bricks: [storage({ driver: 's3' }), queue({ driver: 'redis' })],
 * })
 * ```
 */
export interface OvenConfig extends AppOptions {
  bricks?: Brick[]
}

export function defineConfig(config: OvenConfig): OvenConfig {
  return config
}

/**
 * Builds an app from a config object.
 *
 * The returned app is typed as `App` rather than carrying each brick's contribution, because
 * a runtime array cannot express that in the type system. Chain `.use()` directly when you
 * want `ctx.storage` typed at the call site; that is the whole reason both surfaces exist.
 */
export function appFromConfig(config: OvenConfig): App {
  const { bricks = [], ...options } = config
  let app: App = createApp(options)
  for (const brick of bricks) {
    app = app.use(brick) as unknown as App
  }
  return app
}

export { pathnameOf } from './url'
