import type { Context } from './context'

/**
 * Middleware.
 *
 * The onion model: each middleware receives the context and a `next` it may await. Everything
 * before the `await` runs on the way in, everything after runs on the way out, and the value
 * `next()` resolves to is whatever the handler produced.
 *
 * ```ts
 * app.use(async (ctx, next) => {
 *   const start = Bun.nanoseconds()
 *   const result = await next()
 *   ctx.set('server-timing', `total;dur=${(Bun.nanoseconds() - start) / 1e6}`)
 *   return result
 * })
 * ```
 *
 * There is no `(req, res, next)` and no Connect compatibility — see `CLAUDE.md` D12. A
 * middleware either returns a value or throws, exactly like a handler, which is what lets the
 * two compose without special cases.
 *
 * **Not calling `next()` short-circuits.** Returning a value without awaiting `next` means the
 * handler never runs, which is how auth guards and caches work.
 */
export type Next = () => Promise<unknown>

export type Middleware = (ctx: Context, next: Next) => unknown

/** A middleware plus the path prefix it applies to. `undefined` means every request. */
export interface ScopedMiddleware {
  prefix: string | undefined
  handler: Middleware
}

/**
 * Folds middleware and a handler into one callable.
 *
 * Built once per route at registration time rather than per request: composing a chain on every
 * request would allocate a closure per layer, on the hot path, for a structure that never
 * changes.
 */
export function compose(
  middleware: readonly Middleware[],
  handler: (ctx: Context) => unknown,
): (ctx: Context) => Promise<unknown> {
  if (middleware.length === 0) {
    return async (ctx) => handler(ctx)
  }

  return async (ctx) => {
    // Guards against `next()` being awaited twice in one layer, which would run the rest of the
    // chain a second time — the resulting double-write is very hard to trace back to its cause.
    let lastCalled = -1

    const dispatch = async (index: number): Promise<unknown> => {
      if (index <= lastCalled) {
        throw new Error('next() called multiple times in the same middleware')
      }
      lastCalled = index

      const layer = middleware[index]
      if (layer === undefined) return handler(ctx)

      return layer(ctx, () => dispatch(index + 1))
    }

    return dispatch(0)
  }
}

/** True when a scoped middleware applies to a path. */
export function appliesTo(prefix: string | undefined, path: string): boolean {
  if (prefix === undefined || prefix === '/') return true
  if (!path.startsWith(prefix)) return false
  // `/admin` must not match `/administrators`; the next character has to be a boundary.
  const next = path.charCodeAt(prefix.length)
  return Number.isNaN(next) || next === 47 /* / */
}

// ---------------------------------------------------------------- built-ins
//
// These ship in the box but stay configurable — they are the cases where behaviour genuinely
// varies between apps, unlike body parsing where it does not. Configured, not installed.

export interface CorsOptions {
  /**
   * Allowed origins. A list, a predicate, or `'*'`.
   *
   * `'*'` cannot be combined with credentials: browsers reject a wildcard origin on a
   * credentialed request, so the request fails in a way that looks like a server bug.
   */
  origin?: string | string[] | ((origin: string) => boolean)
  methods?: string[]
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  credentials?: boolean
  /** Seconds a preflight result may be cached. Default 86400. */
  maxAge?: number
}

export function cors(options: CorsOptions = {}): Middleware {
  const {
    origin = '*',
    methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders,
    credentials = false,
    maxAge = 86_400,
  } = options

  if (origin === '*' && credentials) {
    throw new Error(
      'CORS: credentials cannot be used with origin "*". Browsers reject a wildcard origin on ' +
        'credentialed requests. List the origins you actually allow.',
    )
  }

  const allows = (candidate: string): boolean => {
    if (origin === '*') return true
    if (typeof origin === 'function') return origin(candidate)
    if (Array.isArray(origin)) return origin.includes(candidate)
    return origin === candidate
  }

  return async (ctx, next) => {
    const requestOrigin = ctx.header('origin')

    if (requestOrigin && allows(requestOrigin)) {
      ctx.set('access-control-allow-origin', origin === '*' ? '*' : requestOrigin)
      // Any response that varies by Origin must say so, or a shared cache will serve one
      // origin's response to another.
      if (origin !== '*') ctx.append('vary', 'Origin')
      if (credentials) ctx.set('access-control-allow-credentials', 'true')
      if (exposedHeaders?.length) {
        ctx.set('access-control-expose-headers', exposedHeaders.join(', '))
      }
    }

    if (ctx.method === 'OPTIONS' && ctx.header('access-control-request-method')) {
      ctx.set('access-control-allow-methods', methods.join(', '))
      ctx.set(
        'access-control-allow-headers',
        allowedHeaders?.join(', ') ??
          ctx.header('access-control-request-headers') ??
          'content-type',
      )
      ctx.set('access-control-max-age', String(maxAge))
      ctx.status = 204
      return null
    }

    return next()
  }
}

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string | false
  /** `Strict-Transport-Security` max-age in seconds. Default 1 year. `false` to omit. */
  hsts?: number | false
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  referrerPolicy?: string | false
  /** Value for `Permissions-Policy`. Defaults to denying the high-risk features. */
  permissionsPolicy?: string | false
}

/** Sets the headers every app should send and most forget to. */
export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  const {
    contentSecurityPolicy = false,
    hsts = 31_536_000,
    frameOptions = 'DENY',
    referrerPolicy = 'strict-origin-when-cross-origin',
    permissionsPolicy = 'geolocation=(), microphone=(), camera=()',
  } = options

  return async (ctx, next) => {
    ctx.set('x-content-type-options', 'nosniff')
    if (frameOptions) ctx.set('x-frame-options', frameOptions)
    if (referrerPolicy) ctx.set('referrer-policy', referrerPolicy)
    if (permissionsPolicy) ctx.set('permissions-policy', permissionsPolicy)
    if (contentSecurityPolicy) ctx.set('content-security-policy', contentSecurityPolicy)
    // Only meaningful over HTTPS, and actively harmful to send on plain HTTP in development
    // where it would pin localhost to https in the browser for a year.
    if (hsts && ctx.url.protocol === 'https:') {
      ctx.set('strict-transport-security', `max-age=${hsts}; includeSubDomains`)
    }
    return next()
  }
}

export interface RequestLoggerOptions {
  /** Paths to skip — health checks otherwise dominate the log. */
  ignore?: string[]
  /** Log at `warn` above this duration in milliseconds. Default 1000. */
  slowThreshold?: number
}

/** Logs one line per request, with method, path, status and duration. */
export function requestLogger(options: RequestLoggerOptions = {}): Middleware {
  const ignore = new Set(options.ignore ?? [])
  const slow = options.slowThreshold ?? 1000

  return async (ctx, next) => {
    if (ignore.has(ctx.path)) return next()

    const start = Bun.nanoseconds()
    try {
      const result = await next()
      log(ctx, start, slow, ctx.status ?? 200)
      return result
    } catch (thrown) {
      const status =
        typeof thrown === 'object' && thrown !== null && 'status' in thrown
          ? Number((thrown as { status: unknown }).status)
          : 500
      log(ctx, start, slow, status)
      throw thrown
    }
  }
}

function log(ctx: Context, start: number, slow: number, status: number): void {
  const ms = (Bun.nanoseconds() - start) / 1e6
  const fields = { method: ctx.method, path: ctx.path, status, ms: Number(ms.toFixed(2)) }

  if (status >= 500) ctx.log.error('request failed', fields)
  else if (ms > slow) ctx.log.warn('slow request', fields)
  else ctx.log.info('request', fields)
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number
  /** Window length in milliseconds. Default 60000. */
  window?: number
  /** Groups requests. Defaults to client IP; use it to key on a user or API key instead. */
  key?: (ctx: Context) => string | undefined
  /** Skip limiting entirely for some requests, e.g. internal traffic. */
  skip?: (ctx: Context) => boolean
}

/**
 * A fixed-window rate limiter held in memory.
 *
 * In memory means per process: behind a load balancer each instance counts separately, so the
 * effective limit is `limit × instances`. That is fine for shedding obvious abuse and wrong for
 * anything you must enforce exactly. `@theoven/ratelimit` counts in Redis or Postgres instead,
 * with the same options plus a store.
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const window = options.window ?? 60_000
  const keyOf = options.key ?? ((ctx: Context) => ctx.ip)
  const buckets = new Map<string, { count: number; resetAt: number }>()

  return async (ctx, next) => {
    if (options.skip?.(ctx)) return next()

    const key = keyOf(ctx)
    // No key means no way to attribute the request; limiting everyone together would be worse
    // than not limiting at all.
    if (key === undefined) return next()

    const now = Date.now()
    let bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + window }
      buckets.set(key, bucket)
    }

    bucket.count++

    const remaining = Math.max(0, options.limit - bucket.count)
    ctx.set('ratelimit-limit', String(options.limit))
    ctx.set('ratelimit-remaining', String(remaining))
    ctx.set('ratelimit-reset', String(Math.ceil((bucket.resetAt - now) / 1000)))

    if (bucket.count > options.limit) {
      // Sweeping here rather than on a timer keeps the map bounded without a background task
      // that would hold the process open at shutdown.
      if (buckets.size > 10_000) {
        for (const [candidate, entry] of buckets) {
          if (entry.resetAt <= now) buckets.delete(candidate)
        }
      }
      const { TooManyRequests } = await import('./errors')
      throw new TooManyRequests('Rate limit exceeded.', {
        headers: { 'retry-after': String(Math.ceil((bucket.resetAt - now) / 1000)) },
      })
    }

    return next()
  }
}

export interface CompressionOptions {
  /** Smallest response worth compressing, in bytes. Default 1024. */
  threshold?: number
  /** Content types to compress. Prefix matches are allowed. */
  types?: string[]
}

const COMPRESSIBLE = [
  'text/',
  'application/json',
  'application/javascript',
  'application/xml',
  'image/svg+xml',
]

/**
 * Compresses responses the client said it could decode.
 *
 * Two deliberate limits:
 *
 * **Only in-memory values.** A returned `Response`, `ReadableStream` or `Blob` is passed
 * through untouched. Compressing those would mean buffering them first, which breaks streaming
 * — server-sent events would stop arriving, and a large file download would be read entirely
 * into memory before the first byte reached the client. Bun has no `CompressionStream`, so
 * there is no way to compress a stream incrementally; passing it through is the honest choice.
 *
 * **Only text-shaped payloads above a threshold.** Compressing an already-compressed image
 * burns CPU to make the response marginally larger, and compressing 40 bytes costs more in
 * header overhead than it saves.
 *
 * Most Bun deployments sit behind a CDN or proxy that already compresses, in which case this
 * is redundant — measure before reaching for it.
 */
export function compression(options: CompressionOptions = {}): Middleware {
  const threshold = options.threshold ?? 1024
  const types = options.types ?? COMPRESSIBLE

  return async (ctx, next) => {
    const result = await next()

    // Anything already in a streaming form is left alone; see above.
    if (
      result instanceof Response ||
      result instanceof ReadableStream ||
      result instanceof Blob ||
      result === null ||
      result === undefined
    ) {
      return result
    }

    const accept = ctx.header('accept-encoding') ?? ''
    const encoding = accept.includes('gzip')
      ? 'gzip'
      : accept.includes('deflate')
        ? 'deflate'
        : null
    if (!encoding) return result

    const response = ctx.respond(result)
    const type = response.headers.get('content-type') ?? ''
    if (!types.some((candidate) => type.startsWith(candidate))) return response

    const raw = new Uint8Array(await response.arrayBuffer())
    if (raw.byteLength < threshold) {
      // Rebuilt because the body was consumed reading it.
      return new Response(raw, { status: response.status, headers: response.headers })
    }

    const compressed = encoding === 'gzip' ? Bun.gzipSync(raw) : Bun.deflateSync(raw)

    const headers = new Headers(response.headers)
    headers.set('content-encoding', encoding)
    headers.set('content-length', String(compressed.byteLength))
    headers.append('vary', 'Accept-Encoding')

    return new Response(compressed, { status: response.status, headers })
  }
}
