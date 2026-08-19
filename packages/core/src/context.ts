import type { Server } from 'bun'
import { type BodyOptions, filesOf, parseBody, readRaw } from './body'
import { type CookieJarInit, Cookies } from './cookies'
import type { Logger } from './logger'
import { type ParsedQuery, parseQuery, type QueryOptions } from './query'
import { toResponse } from './response'
import type { RouteParams } from './router/types'
import { type CapturedToken, captureToken, decodeBasic, type TokenOptions } from './token'
import { pathnameOf } from './url'

export interface ContextInit {
  /** Base logger; the request-scoped child is derived lazily from it. */
  logger: Logger
  /** Header consulted for an inbound request id, e.g. from a load balancer. */
  requestIdHeader: string
  /** Present when serving over HTTP; absent when a Request is dispatched directly in tests. */
  server?: Server<unknown> | undefined
  body?: BodyOptions | undefined
  query?: QueryOptions | undefined
  cookies?: CookieJarInit | undefined
  token?: TokenOptions | undefined
  /**
   * Whether to believe `X-Forwarded-For`. `false` uses the socket address only.
   *
   * This is a security setting, not a convenience one: any client can send the header, so
   * trusting it without a proxy in front means clients choose their own IP — and with it, defeat
   * any rate limit or audit log keyed on `ctx.ip`. A number says how many proxy hops to skip
   * from the right, which is the only form that survives a chain of proxies.
   */
  trustProxy?: boolean | number | undefined
}

/**
 * The single argument every handler receives.
 *
 * A class rather than a plain object for two reasons. Lazy properties need getters, and getters
 * need a prototype; and a shared hidden class keeps construction to one allocation no matter
 * how many properties the context grows.
 *
 * **Everything expensive here is lazy.** A handler returning a constant never generates a
 * request id, derives a logger, parses the URL, splits a cookie header, or reads the body. This
 * is a hard rule with tests to hold it, not an aspiration — see `CLAUDE.md` §2b.
 */
export class Context {
  /** The raw web-standard request. Never wrapped, always available. */
  readonly req: Request

  private mutableParams: RouteParams

  /**
   * Status for the response. Left undefined so the returned value can decide — `null` becomes
   * 204, everything else 200 — while an explicit assignment always wins.
   */
  status: number | undefined

  private readonly init: ContextInit
  private responseHeaderBag: Headers | undefined
  private cachedId: string | undefined
  private cachedLog: Logger | undefined
  private cachedUrl: URL | undefined
  private cachedPath: string | undefined
  private matchedPattern: string | undefined
  private cachedQuery: ParsedQuery | undefined
  private cachedCookies: Cookies | undefined
  private cachedBody: Promise<unknown> | undefined
  private cachedRaw: Promise<ArrayBuffer> | undefined
  private cachedToken: CapturedToken | undefined | null = null

  constructor(req: Request, params: RouteParams, init: ContextInit, path?: string) {
    this.req = req
    this.mutableParams = params
    this.init = init
    this.status = undefined
    this.cachedPath = path
  }

  /** Path parameters from the matched route. Frozen and shared when the route has none. */
  get params(): RouteParams {
    return this.mutableParams
  }

  /**
   * Assigns params once routing has resolved.
   *
   * The context is built *before* the route is matched, because middleware has to run for
   * requests that match nothing — a CORS preflight, a 404 that still needs logging and security
   * headers. Params simply are not known yet at construction.
   *
   * @internal called by the framework; not part of the handler-facing API.
   */
  assignParams(params: RouteParams): void {
    this.mutableParams = params
  }

  /**
   * The matched route's pattern — `/users/:id`, not `/users/8f14e45f`.
   *
   * `undefined` before routing resolves, and on a request that matched nothing. Metrics, logs and
   * tracing all want this rather than `ctx.path`: a backend that sees a million distinct route
   * names cannot aggregate anything, and reconstructing the pattern from the path means inventing
   * a rule about which segments are ids — which is wrong on every slug.
   */
  get routePattern(): string | undefined {
    return this.matchedPattern
  }

  /** @internal called by the framework once a route matches. */
  assignRoutePattern(pattern: string): void {
    this.matchedPattern = pattern
  }

  // ------------------------------------------------------------------ request

  /** The parsed request URL, built once and reused. */
  get url(): URL {
    if (this.cachedUrl === undefined) this.cachedUrl = new URL(this.req.url)
    return this.cachedUrl
  }

  /**
   * The request path.
   *
   * Deliberately **not** `this.url.pathname`: reading it used to force `new URL()` on every
   * request, because routing reads `ctx.path`. That was ~580 ns of parsing per request to answer
   * a question a substring already answers — and it was the framework's own dispatch paying it,
   * not the application.
   *
   * The router computes this once with a scan and hands it to the constructor, so this is
   * usually just a field read. When it is not — a Context built directly in a test — the same
   * scan runs lazily. `ctx.url` stays available and lazy for anything that genuinely needs a
   * parsed URL.
   */
  get path(): string {
    // A URL built for some other reason is authoritative; using it keeps the two in step.
    if (this.cachedUrl !== undefined) return this.cachedUrl.pathname
    this.cachedPath ??= pathnameOf(this.req.url)
    return this.cachedPath
  }

  /** The request method. */
  get method(): string {
    return this.req.method
  }

  /**
   * A request header, or `undefined` when absent.
   *
   * `Headers.get` returns `null`, which reads badly next to every other optional on the
   * context. Names are case-insensitive, as HTTP defines them.
   */
  header(name: string): string | undefined {
    return this.req.headers.get(name) ?? undefined
  }

  /**
   * The parsed query string.
   *
   * Handles what `URLSearchParams` will not: repeated keys become arrays, and `filter[status]`
   * becomes a nested object. Depth- and count-limited, with prototype pollution blocked.
   */
  get query(): ParsedQuery {
    if (this.cachedQuery === undefined) {
      this.cachedQuery = parseQuery(this.url.searchParams, this.init.query)
    }
    return this.cachedQuery
  }

  /** Cookie jar for this request. Parsing is deferred until a value is read. */
  get cookies(): Cookies {
    if (this.cachedCookies === undefined) {
      this.cachedCookies = new Cookies(
        this.req.headers.get('cookie'),
        (value) => this.append('set-cookie', value),
        this.init.cookies ?? {},
      )
    }
    return this.cachedCookies
  }

  /**
   * The parsed request body.
   *
   * Awaited, and parsed according to `Content-Type`. Memoised, so awaiting twice costs nothing
   * and — more importantly — does not fail on an already-consumed stream.
   */
  get body(): Promise<unknown> {
    if (this.cachedBody === undefined) {
      this.cachedBody = this.cachedRaw
        ? this.cachedRaw.then((raw) => parseBody(this.req, this.init.body, raw))
        : parseBody(this.req, this.init.body)
    }
    return this.cachedBody
  }

  /**
   * The unparsed body bytes.
   *
   * Needed wherever a signature covers the exact payload — Stripe, GitHub and every other
   * webhook that signs the raw bytes. Re-serialising parsed JSON gives different bytes and a
   * failing signature, which is a genuinely miserable thing to debug.
   *
   * Reading this first is safe: `ctx.body` will parse from these bytes rather than trying to
   * read a stream that is already gone.
   */
  get rawBody(): Promise<ArrayBuffer> {
    if (this.cachedRaw === undefined) this.cachedRaw = readRaw(this.req, this.init.body)
    return this.cachedRaw
  }

  /** Uploaded files from a multipart body, keyed by field name. */
  async files(): Promise<Record<string, File[]>> {
    return filesOf(await this.body)
  }

  /**
   * The credential on this request, from the `Authorization` header, a cookie, or the query
   * string — in that order.
   *
   * Present with or without an auth module installed: capture is core, verification is not.
   */
  get token(): string | undefined {
    return this.captured?.value
  }

  /** Where `token` came from. Useful for auditing, and for trusting a header over a URL. */
  get tokenSource(): CapturedToken['source'] | undefined {
    return this.captured?.source
  }

  /** The `Authorization` scheme, when the credential came from a header. */
  get tokenScheme(): string | undefined {
    return this.captured?.scheme
  }

  /** Decoded `Basic` credentials, when that is what arrived. */
  get basicAuth(): { username: string; password: string } | undefined {
    return decodeBasic(this.captured)
  }

  private get captured(): CapturedToken | undefined {
    if (this.cachedToken === null) {
      this.cachedToken = captureToken(
        this.req.headers,
        (name) => this.cookies.get(name),
        (name) => {
          const value = this.query[name]
          return typeof value === 'string' ? value : undefined
        },
        this.init.token ?? {},
      )
    }
    return this.cachedToken
  }

  /**
   * The client address.
   *
   * Uses the socket address unless `trustProxy` is set. See `ContextInit.trustProxy` for why
   * that default is not merely conservative.
   */
  get ip(): string | undefined {
    const trust = this.init.trustProxy
    if (trust) {
      const forwarded = this.req.headers.get('x-forwarded-for')
      if (forwarded) {
        const hops = forwarded
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
        // Count from the right: entries further left are supplied by earlier, less trusted
        // parties, and a client can prepend as many as it likes.
        const skip = typeof trust === 'number' ? trust : 1
        const chosen = hops[Math.max(0, hops.length - skip)]
        if (chosen) return chosen
      }
    }
    return this.init.server?.requestIP(this.req)?.address
  }

  /**
   * Picks the best response type for this client from the ones offered.
   *
   * Returns the first offered type the client accepts, honouring `q` weights, or `undefined`
   * when it accepts none of them.
   */
  accepts(...offered: string[]): string | undefined {
    const header = this.req.headers.get('accept')
    if (!header || header.trim() === '') return offered[0]

    const ranked = header
      .split(',')
      .map((entry) => {
        const [type = '', ...params] = entry.trim().split(';')
        const q = params.find((param) => param.trimStart().startsWith('q='))
        return { type: type.trim().toLowerCase(), q: q ? Number(q.split('=')[1]) || 0 : 1 }
      })
      .filter((entry) => entry.q > 0)
      .sort((a, b) => b.q - a.q)

    for (const { type } of ranked) {
      for (const candidate of offered) {
        const lower = candidate.toLowerCase()
        if (type === '*/*' || type === lower) return candidate
        if (type.endsWith('/*') && lower.startsWith(type.slice(0, -1))) return candidate
      }
    }

    return undefined
  }

  // ------------------------------------------------------------ observability

  /**
   * A stable id for this request.
   *
   * Taken from the inbound request-id header when a proxy already assigned one, so a trace
   * survives the hop; generated otherwise, and only when something asks.
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

  /** Request-scoped logger with the request id bound to every line. */
  get log(): Logger {
    if (this.cachedLog === undefined) {
      this.cachedLog = this.init.logger.child({ requestId: this.id })
    }
    return this.cachedLog
  }

  // ----------------------------------------------------------------- response

  /** Sets a response header. The bag is allocated on first use. */
  set(name: string, value: string): this {
    this.responseHeaderBag ??= new Headers()
    this.responseHeaderBag.set(name, value)
    return this
  }

  /** Appends a response header, keeping existing values — needed for `set-cookie`. */
  append(name: string, value: string): this {
    this.responseHeaderBag ??= new Headers()
    this.responseHeaderBag.append(name, value)
    return this
  }

  /**
   * Response headers accumulated so far, or `undefined` if none were set.
   *
   * Named `responseHeaders`, not `headers`: request and response headers are different things,
   * and a single `ctx.headers` is a coin flip every time you read it.
   */
  get responseHeaders(): Headers | undefined {
    return this.responseHeaderBag
  }

  /**
   * Builds a redirect response.
   *
   * Returned rather than thrown, so redirecting reads like any other result:
   * `return ctx.redirect('/login')`.
   */
  redirect(location: string, status = 302): Response {
    this.set('location', location)
    return new Response(
      null,
      this.responseHeaderBag ? { status, headers: this.responseHeaderBag } : { status },
    )
  }

  /** Converts a handler's return value into a `Response` using this context's status/headers. */
  respond(value: unknown): Response {
    return toResponse(value, this.status, this.responseHeaderBag)
  }

  /**
   * Keeps credentials out of anything that serialises the context.
   *
   * A context reaching a log line or an error report is a mistake, but it is a mistake that
   * happens — and it must not be the mistake that leaks a session token.
   */
  toJSON(): Record<string, unknown> {
    return {
      method: this.method,
      path: this.path,
      params: this.params,
      requestId: this.cachedId,
    }
  }
}
