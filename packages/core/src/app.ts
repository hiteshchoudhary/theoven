import type { Server } from 'bun'
import { Context } from './context'
import { type OvenError, toOvenError } from './errors'
import { ConsoleLogger, type Logger, type LogLevel } from './logger'
import { Router } from './router/router'
import { type HttpMethod, isHttpMethod } from './router/types'

/**
 * A route handler. Returns anything — the value is coerced into a `Response`.
 *
 * There is no `next`, no `res`, and no callback. A handler either returns a value or throws;
 * async throws are caught identically to synchronous ones.
 */
export type Handler = (ctx: Context) => unknown

/** Replaces the default problem+json rendering for failures. */
export type ErrorHandler = (error: OvenError, ctx: Context) => unknown

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
   * Defaults to `NODE_ENV !== 'production'` — safe by default in the environment that matters.
   */
  development?: boolean
  /** How long `close()` waits for in-flight requests before forcing the socket shut. Default 10s. */
  shutdownTimeout?: number
  onError?: ErrorHandler
}

const PROBLEM_TYPE = 'application/problem+json; charset=utf-8'

/**
 * An Oven application.
 *
 * Two ways in: `listen()` binds a socket, and `fetch()` dispatches a `Request` directly. They
 * run the exact same pipeline, which is why the test suite never needs a real port — and why
 * a passing test means the served behaviour is genuinely covered.
 */
export class App {
  private readonly router = new Router<Handler>()
  /**
   * Resolved configuration.
   *
   * Named `settings` rather than `options` because `options()` is a public verb method — a
   * field of the same name silently shadows it on the instance, and the resulting failure
   * (`app.options is not a function`) points nowhere near the cause.
   */
  private readonly settings: Required<Omit<AppOptions, 'logger' | 'onError' | 'port' | 'hostname'>>
  private readonly baseLogger: Logger
  private readonly errorHandler: ErrorHandler | undefined
  private readonly port: number
  private readonly hostname: string | undefined

  private server: Server<unknown> | undefined
  private shutdownHooks: Array<() => unknown> = []

  /** In-flight request accounting, so shutdown can drain rather than guillotine. */
  private inFlight = 0
  private closing = false
  private drained: (() => void) | undefined
  private signalHandler: (() => void) | undefined

  constructor(options: AppOptions = {}) {
    this.port = options.port ?? Number(Bun.env.PORT ?? 3000)
    this.hostname = options.hostname
    this.errorHandler = options.onError
    this.settings = {
      logLevel: options.logLevel ?? 'info',
      requestIdHeader: options.requestIdHeader ?? 'x-request-id',
      echoRequestId: options.echoRequestId ?? true,
      development: options.development ?? Bun.env.NODE_ENV !== 'production',
      shutdownTimeout: options.shutdownTimeout ?? 10_000,
    }
    this.baseLogger = options.logger ?? new ConsoleLogger({ level: this.settings.logLevel })
  }

  // ---------------------------------------------------------------- registration

  /**
   * Registers a handler.
   *
   * File-based routing (§1.8) is the DX users see, but it compiles down to this, and plugins
   * that contribute their own endpoints — `/auth/*`, the docs UI — call it directly.
   */
  route(method: HttpMethod, path: string, handler: Handler): this {
    this.router.insert(method, path, handler)
    return this
  }

  get(path: string, handler: Handler): this {
    return this.route('GET', path, handler)
  }
  post(path: string, handler: Handler): this {
    return this.route('POST', path, handler)
  }
  put(path: string, handler: Handler): this {
    return this.route('PUT', path, handler)
  }
  patch(path: string, handler: Handler): this {
    return this.route('PATCH', path, handler)
  }
  delete(path: string, handler: Handler): this {
    return this.route('DELETE', path, handler)
  }
  head(path: string, handler: Handler): this {
    return this.route('HEAD', path, handler)
  }
  options(path: string, handler: Handler): this {
    return this.route('OPTIONS', path, handler)
  }

  /** Runs during `close()`, before the socket is released. Plugins use this to free resources. */
  onShutdown(hook: () => unknown): this {
    this.shutdownHooks.push(hook)
    return this
  }

  /** Every registered route. Backs `oven routes` and the boot banner. */
  routes(): ReadonlyArray<{ method: HttpMethod; pattern: string }> {
    return this.router.routes()
  }

  get logger(): Logger {
    return this.baseLogger
  }

  // ---------------------------------------------------------------- dispatch

  /**
   * Handles one request.
   *
   * Bound rather than declared as a method so it can be handed straight to `Bun.serve` and to
   * tests without losing `this`.
   */
  readonly fetch = async (request: Request, server?: Server<unknown>): Promise<Response> => {
    // Refuse new work once draining has started, so a rolling deploy sheds load in a way
    // clients can act on rather than by dropping connections.
    if (this.closing) {
      return this.refuse(503, 'Service Unavailable', 'The server is shutting down.', {
        'retry-after': '5',
      })
    }

    this.inFlight++
    try {
      return await this.dispatch(request, server)
    } finally {
      this.inFlight--
      if (this.closing && this.inFlight === 0) this.drained?.()
    }
  }

  private async dispatch(request: Request, server: Server<unknown> | undefined): Promise<Response> {
    const method = request.method
    const path = pathnameOf(request.url)

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
        const allow = match.allowed.join(', ')
        return this.refuse(405, 'Method Not Allowed', `${method} is not allowed on ${path}.`, {
          allow,
        })
      }
      return this.refuse(404, 'Not Found', `No route matches ${path}.`)
    }

    const ctx = new Context(request, match.params, {
      logger: this.baseLogger,
      requestIdHeader: this.settings.requestIdHeader,
      server,
    })

    try {
      const result = await match.payload(ctx)
      const response = ctx.respond(result)
      this.stampRequestId(response, ctx)
      // A HEAD response must carry the GET headers but no body.
      return headOfGet
        ? new Response(null, { status: response.status, headers: response.headers })
        : response
    } catch (thrown) {
      return this.handleError(thrown, ctx)
    }
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
   * 404s and 405s are not exceptional — a crawler or a scanner can produce thousands a second —
   * and building an `Error` for each one captures a stack trace, which is one of the most
   * expensive things a runtime does. These refusals never surface a stack to anyone, so paying
   * for one is pure waste. Genuine thrown errors still go through `problem()` and keep theirs.
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
   * Generating an id for a request nobody traced would violate the lazy rule for no benefit,
   * so the header appears exactly when the id was materialised.
   */
  private stampRequestId(response: Response, ctx: Context): void {
    if (!this.settings.echoRequestId || !ctx.hasId) return
    if (!response.headers.has(this.settings.requestIdHeader)) {
      response.headers.set(this.settings.requestIdHeader, ctx.id)
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts the server. Signal handlers are installed so SIGTERM drains rather than kills. */
  listen(port = this.port): Server<unknown> {
    if (this.server) throw new Error('This app is already listening.')

    this.server = Bun.serve({
      port,
      ...(this.hostname !== undefined ? { hostname: this.hostname } : {}),
      fetch: this.fetch,
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
   * rather than a dropped connection, which is the difference between a clean rolling deploy
   * and a burst of client-side errors.
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

/**
 * Extracts the pathname without constructing a `URL`.
 *
 * `new URL()` is one of the most expensive things a router can do per request, and the path is
 * needed on every single one. Scanning for the third slash and stopping at `?` or `#` is
 * roughly an order of magnitude cheaper; `ctx.url` still gives handlers the full parse when
 * they ask for it.
 */
export function pathnameOf(url: string): string {
  const start = url.indexOf('/', url.indexOf('//') + 2)
  if (start === -1) return '/'

  let end = url.length
  const query = url.indexOf('?', start)
  if (query !== -1) end = query
  const hash = url.indexOf('#', start)
  if (hash !== -1 && hash < end) end = hash

  return start === end ? '/' : url.slice(start, end)
}

/** Creates an Oven application. */
export function createApp(options: AppOptions = {}): App {
  return new App(options)
}
