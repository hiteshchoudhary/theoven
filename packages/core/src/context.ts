import type { Server } from 'bun'
import type { Logger } from './logger'
import { toResponse } from './response'
import type { RouteParams } from './router/types'

export interface ContextInit {
  /** Base logger; the request-scoped child is derived lazily from it. */
  logger: Logger
  /** Header consulted for an inbound request id, e.g. from a load balancer. */
  requestIdHeader: string
  /** Present when serving over HTTP; absent when a Request is dispatched directly in tests. */
  server?: Server<unknown> | undefined
}

/**
 * The single argument every handler receives.
 *
 * Implemented as a class rather than a plain object for two reasons. Lazy properties need
 * getters, and getters need a prototype; and a shared hidden class keeps construction to one
 * allocation per request no matter how many properties the context eventually grows.
 *
 * **Everything expensive here is lazy.** Reading nothing costs nothing: a handler that returns
 * a constant string never generates a request id, never derives a child logger, and never
 * parses the URL. This is a hard rule, not an optimisation — see `CLAUDE.md` §2b.
 *
 * Request body, query, cookies and token capture land here in §1.3, following the same rule.
 */
export class Context {
  /** The raw web-standard request. Always available, never wrapped. */
  readonly req: Request

  /** Path parameters from the matched route. Frozen and shared when the route has none. */
  readonly params: RouteParams

  /**
   * Status for the response. Left undefined so the returned value can decide — `null` becomes
   * 204, everything else 200 — while an explicit assignment always wins.
   */
  status: number | undefined

  private readonly init: ContextInit
  private responseHeaders: Headers | undefined
  private cachedId: string | undefined
  private cachedLog: Logger | undefined
  private cachedUrl: URL | undefined

  constructor(req: Request, params: RouteParams, init: ContextInit) {
    this.req = req
    this.params = params
    this.init = init
    this.status = undefined
  }

  /**
   * A stable id for this request.
   *
   * Taken from the inbound request-id header when a proxy already assigned one, so a trace
   * survives the hop; generated otherwise. Generated lazily, which means an app that never logs
   * never pays for a UUID.
   */
  get id(): string {
    if (this.cachedId === undefined) {
      this.cachedId = this.req.headers.get(this.init.requestIdHeader) ?? crypto.randomUUID()
    }
    return this.cachedId
  }

  /** True once `id` has been materialised, so the server knows whether to echo the header. */
  get hasId(): boolean {
    return this.cachedId !== undefined
  }

  /** Request-scoped logger with the request id already bound to every line. */
  get log(): Logger {
    if (this.cachedLog === undefined) {
      this.cachedLog = this.init.logger.child({ requestId: this.id })
    }
    return this.cachedLog
  }

  /** The parsed request URL, built once and reused. */
  get url(): URL {
    if (this.cachedUrl === undefined) {
      this.cachedUrl = new URL(this.req.url)
    }
    return this.cachedUrl
  }

  /** Shorthand for the request path, without allocating a URL when it can be avoided. */
  get path(): string {
    return this.url.pathname
  }

  /** The request method, as a plain string. */
  get method(): string {
    return this.req.method
  }

  /**
   * Sets a response header.
   *
   * The header bag is created on first use, so responses that set no headers allocate nothing.
   */
  set(name: string, value: string): this {
    this.responseHeaders ??= new Headers()
    this.responseHeaders.set(name, value)
    return this
  }

  /** Appends a response header, keeping any existing values — needed for `set-cookie`. */
  append(name: string, value: string): this {
    this.responseHeaders ??= new Headers()
    this.responseHeaders.append(name, value)
    return this
  }

  /** Response headers accumulated so far, or undefined if none were set. */
  get headers(): Headers | undefined {
    return this.responseHeaders
  }

  /**
   * Builds a redirect response.
   *
   * Returned rather than thrown, so redirecting reads like any other result:
   * `return ctx.redirect('/login')`. 302 by default; use 301 or 308 for permanent moves.
   */
  redirect(location: string, status = 302): Response {
    this.set('location', location)
    return new Response(
      null,
      this.responseHeaders ? { status, headers: this.responseHeaders } : { status },
    )
  }

  /** The client IP, or undefined when not served over a socket (direct dispatch in tests). */
  get ip(): string | undefined {
    return this.init.server?.requestIP(this.req)?.address
  }

  /**
   * Converts a handler's return value into a `Response`, applying this context's status and
   * headers. Called by the server; exposed because middleware sometimes needs it too.
   */
  respond(value: unknown): Response {
    return toResponse(value, this.status, this.responseHeaders)
  }
}
