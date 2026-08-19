import type { Brick } from '@theoven/core'
import { memoryCache } from './memory'
import { type CacheDriver, CacheError, type SetOptions } from './types'

export interface CacheOptions {
  /** Default time to live in milliseconds, when a call does not say. */
  ttl?: number
  /**
   * Allow the in-process driver outside development.
   *
   * Refused by default. Per-process caches disagree with each other, so behind several instances
   * a user sees one value, refreshes, and sees another — a bug that reproduces only under load
   * and never on a laptop.
   */
  allowMemoryInProduction?: boolean
}

export interface CacheService {
  readonly driver: string

  get<Value>(key: string): Promise<Value | undefined>
  set<Value>(key: string, value: Value, options?: SetOptions): Promise<void>
  delete(key: string): Promise<void>

  /**
   * Returns the cached value, or computes and stores it.
   *
   * ```ts
   * const user = await ctx.cache.cached(
   *   `user:${id}`,
   *   () => ctx.db.select().from(users).where(eq(users.id, id)),
   *   { ttl: 60_000, tags: [`user:${id}`] },
   * )
   * ```
   *
   * Concurrent misses for the same key share **one** call to `produce`. Without that, a popular
   * key expiring means every in-flight request recomputes it at once — the cache stampede, and
   * the reason a cache can make an outage worse rather than better.
   */
  cached<Value>(
    key: string,
    produce: () => Value | Promise<Value>,
    options?: SetOptions,
  ): Promise<Value>

  /** Removes every entry carrying the tag. Returns how many were removed. */
  invalidate(tag: string): Promise<number>
  clear(): Promise<void>

  readonly raw: unknown
}

/**
 * The cache brick.
 *
 * ```ts
 * app.use(cache(redisCache({ url: env.string('REDIS_URL') }), { ttl: 60_000 }))
 * ```
 *
 * Defaults to an in-process cache so an app works with nothing to install.
 */
export function cache(
  driver: CacheDriver = memoryCache(),
  options: CacheOptions = {},
): Brick<'cache', CacheService> {
  return {
    name: 'cache',

    setup: async (context) => {
      if (!context.development && driver.name === 'memory' && !options.allowMemoryInProduction) {
        throw new CacheError(
          'The in-process cache driver is refused in production: each instance would keep its ' +
            'own copy, so a user sees one value, refreshes, and sees another — a bug that only ' +
            'reproduces under load. Configure Redis, or pass allowMemoryInProduction if a ' +
            'per-instance cache is genuinely what you want.',
          { driver: 'memory' },
        )
      }

      await driver.start?.()

      /**
       * In-flight computations, so concurrent misses share one call.
       *
       * Per process — two instances can still both compute once each. Collapsing that would mean
       * a distributed lock, which costs a round trip on every miss to save a duplicate call, and
       * is rarely the right trade. What this removes is the thundering herd *within* an instance,
       * which is where the multiplier actually is.
       */
      const inFlight = new Map<string, Promise<unknown>>()

      const service: CacheService = {
        driver: driver.name,
        raw: driver.raw,

        get: async <Value>(key: string) => {
          const entry = await driver.get(key)
          return entry?.value as Value | undefined
        },

        set: async (key, value, set = {}) => {
          const ttl = set.ttl ?? options.ttl
          await driver.set(
            key,
            { value, ...(ttl !== undefined ? { expiresAt: Date.now() + ttl } : {}) },
            { ...set, ...(ttl !== undefined ? { ttl } : {}) },
          )
        },

        delete: (key) => driver.delete(key),
        invalidate: (tag) => driver.invalidate(tag),
        clear: () => driver.clear(),

        cached: async <Value>(
          key: string,
          produce: () => Value | Promise<Value>,
          set: SetOptions = {},
        ): Promise<Value> => {
          const hit = await driver.get(key)
          if (hit) return hit.value as Value

          const running = inFlight.get(key)
          if (running) return running as Promise<Value>

          const work = (async () => {
            const value = await produce()
            await service.set(key, value, set)
            return value
          })()

          inFlight.set(key, work)

          /**
           * Cleaned up *after* the map has the entry, and never from inside the work itself.
           *
           * An async function body runs synchronously up to its first `await`, so a producer that
           * throws immediately would reach a `finally` before `inFlight.set` had run — deleting
           * nothing, then storing the rejected promise, which every later caller would then be
           * handed forever. The identity check keeps a slow cleanup from evicting a newer entry.
           *
           * `then(forget, forget)` rather than `finally`: it settles the rejection here so Bun
           * does not report an unhandled one, while `work` itself still rejects for the caller.
           */
          const forget = () => {
            if (inFlight.get(key) === work) inFlight.delete(key)
          }
          void work.then(forget, forget)

          return work
        },
      }

      return service
    },

    onShutdown: async () => {
      await driver.close?.()
    },
  }
}
