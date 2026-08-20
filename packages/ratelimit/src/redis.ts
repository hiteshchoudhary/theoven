import type { RateLimitResult, RateLimitStore } from './types'

export interface RedisStoreOptions {
  url?: string
  /** Namespace, so two apps can share one Redis. */
  prefix?: string
  /** An existing client to adopt rather than connecting. */
  client?: Bun.RedisClient
}

/**
 * The whole check, as one Lua script.
 *
 * Everything here is about atomicity. Reading a counter and then writing it back is a race across
 * instances — which is exactly the failure the in-process limiter has and this package exists to
 * fix, so reproducing it in Redis would be absurd.
 *
 * The algorithm is a **sliding window counter**: the previous window's count is weighted by how
 * much of it still overlaps the last `window` milliseconds, and added to the current one. A plain
 * fixed window lets someone spend their whole allowance in the last second of one window and again
 * in the first second of the next — a 2× burst at every boundary, which is precisely when a
 * scraper is hammering you.
 *
 * KEYS[1] the base key · ARGV: now, window, both in milliseconds.
 */
const SCRIPT = `
local base    = KEYS[1]
local now     = tonumber(ARGV[1])
local window  = tonumber(ARGV[2])

local start   = math.floor(now / window) * window
local current = base .. ':' .. start
local prior   = base .. ':' .. (start - window)

local previous = tonumber(redis.call('GET', prior)) or 0
local counted  = redis.call('INCR', current)

-- Set the expiry only when the key is new. Refreshing it on every hit would keep a busy key
-- alive forever and slowly leak a row per active client.
if counted == 1 then
  redis.call('PEXPIRE', current, window * 2)
end

-- How much of the previous window still falls inside the trailing window.
local elapsed = now - start
local weight  = (window - elapsed) / window
local total   = math.floor(previous * weight + counted)

return { total, window - elapsed }
`

/** Counting in Redis, shared by every instance that points at it. */
export function redisStore(options: RedisStoreOptions = {}): RateLimitStore {
  const prefix = options.prefix ?? 'oven:ratelimit'
  let client: Bun.RedisClient | undefined = options.client
  const adopted = options.client !== undefined

  async function connection(): Promise<Bun.RedisClient> {
    if (!client) {
      client = new Bun.RedisClient(options.url ?? Bun.env.REDIS_URL ?? 'redis://localhost:6379')
      await client.connect()
    }
    return client
  }

  return {
    name: 'redis',

    async hit(key: string, window: number, now: number): Promise<RateLimitResult> {
      const redis = await connection()
      const reply = (await redis.send('EVAL', [
        SCRIPT,
        '1',
        `${prefix}:${key}`,
        String(now),
        String(window),
      ])) as [number, number] | number[]

      return { count: Number(reply[0]), resetMs: Number(reply[1]) }
    },

    async close(): Promise<void> {
      // Only what we opened — closing a client the caller still holds is their outage, not ours.
      if (!adopted) client?.close()
      client = undefined
    },
  }
}
