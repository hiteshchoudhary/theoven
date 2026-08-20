import type { Context, Middleware } from '@theoven/core'
import { TooManyRequests } from '@theoven/core'
import type { RateLimitStore } from './types'

export interface SharedRateLimitOptions {
  /** Requests allowed per window. */
  limit: number
  /** Window length in milliseconds. Default 60000. */
  window?: number
  /** Where the counting happens. */
  store: RateLimitStore
  /** Groups requests. Defaults to the client IP; key on a user or an API key instead. */
  key?: (ctx: Context) => string | undefined
  /** Skip entirely for some requests — internal traffic, health checks. */
  skip?: (ctx: Context) => boolean
  /**
   * What to do when the store is unreachable.
   *
   * `'allow'` by default. A Redis outage should not take the application down with it — but it is
   * a real choice, because for an endpoint that exists to stop abuse, failing open means the
   * abuse succeeds during the outage. `'deny'` for those.
   */
  onStoreError?: 'allow' | 'deny'
}

/**
 * Rate limiting that counts across every instance.
 *
 * The same options as [core's `rateLimit`](/docs/reference/middleware/#rate-limiting) plus a
 * `store`, so moving from one to the other is one line.
 *
 * ```ts
 * app.use(rateLimit({ limit: 100, store: redisStore({ url: env.string('REDIS_URL') }) }))
 * ```
 */
export function rateLimit(options: SharedRateLimitOptions): Middleware {
  const window = options.window ?? 60_000
  const keyOf = options.key ?? ((ctx: Context) => ctx.ip)
  const onError = options.onStoreError ?? 'allow'

  return async (ctx, next) => {
    if (options.skip?.(ctx)) return next()

    const key = keyOf(ctx)
    // No key means no way to attribute the request. Counting everyone under one bucket would
    // rate-limit the whole world together, which is worse than not limiting.
    if (key === undefined) return next()

    let result: Awaited<ReturnType<RateLimitStore['hit']>>
    try {
      result = await options.store.hit(key, window, Date.now())
    } catch (cause) {
      ctx.log.error('rate limit store unreachable', {
        store: options.store.name,
        decision: onError,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
      if (onError === 'deny') {
        throw new TooManyRequests('Rate limiting is unavailable.', {
          headers: { 'retry-after': '5' },
        })
      }
      return next()
    }

    const remaining = Math.max(0, options.limit - result.count)
    const resetSeconds = Math.ceil(result.resetMs / 1000)

    const headers = {
      'ratelimit-limit': String(options.limit),
      'ratelimit-remaining': String(remaining),
      'ratelimit-reset': String(resetSeconds),
    }

    for (const [name, value] of Object.entries(headers)) ctx.set(name, value)

    if (result.count > options.limit) {
      /**
       * The headers go on the **error**, not only on the context.
       *
       * A thrown error builds its own response, so anything set with `ctx.set` is gone by the
       * time the 429 is written — which drops the RateLimit headers at the exact moment a client
       * needs them most, since a refusal is when it has to decide how long to wait. Found by a
       * test asserting `ratelimit-remaining` on a refusal, which is worth having precisely
       * because the success path looked fine.
       */
      throw new TooManyRequests('Rate limit exceeded.', {
        headers: { ...headers, 'retry-after': String(resetSeconds) },
      })
    }

    return next()
  }
}
