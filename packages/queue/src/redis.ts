import type { JobRecord, QueueDriver, QueueStats } from './types'
import { QueueError } from './types'

export interface RedisQueueOptions {
  /** Connection string. Defaults to `REDIS_URL`, then localhost. */
  url?: string
  /** Key prefix, so two apps can share one Redis. Default `oven:queue`. */
  prefix?: string
  /** An existing client, when the app already has one. */
  client?: Bun.RedisClient
}

/**
 * A queue in Redis, on Bun's built-in client.
 *
 * The layout is four keys:
 *
 * - `{prefix}:jobs` — a hash of id → JSON, the jobs themselves
 * - `{prefix}:pending` — a sorted set scored by `runAt`, which makes "what can run now" and
 *   "what is scheduled" the same structure rather than two
 * - `{prefix}:active` — a sorted set scored by the visibility deadline, so a worker that dies
 *   mid-job has its work reclaimed rather than lost
 * - `{prefix}:dead` — a list of jobs given up on
 *
 * Reserving is a Lua script, because "find runnable, mark in flight, return" has to be one
 * step: two workers polling at the same millisecond must not receive the same job, and three
 * round trips cannot promise that.
 */
export function redisQueue(options: RedisQueueOptions = {}): QueueDriver {
  const prefix = options.prefix ?? 'oven:queue'
  const client =
    options.client ??
    new Bun.RedisClient(options.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379')

  const keys = {
    jobs: `${prefix}:jobs`,
    pending: `${prefix}:pending`,
    active: `${prefix}:active`,
    dead: `${prefix}:dead`,
    dedupe: `${prefix}:dedupe`,
  }

  /** Bun's client exposes the typed commands it knows; everything else goes through `send`. */
  function send(command: string, args: string[]): Promise<unknown> {
    return client.send(command, args)
  }

  /**
   * Reserve: pick runnable jobs, move them to active, bump attempts, return them.
   *
   * One script so it is atomic. `ZRANGEBYSCORE ... LIMIT` finds what is due; the same call
   * removes each from pending and adds it to active with a visibility deadline.
   */
  const RESERVE = `
    local now = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local deadline = tonumber(ARGV[3])

    -- Anything whose visibility has lapsed goes back to pending first: the worker holding it died.
    local lapsed = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)
    for _, id in ipairs(lapsed) do
      redis.call('ZREM', KEYS[3], id)
      redis.call('ZADD', KEYS[2], now, id)
    end

    local due = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, limit)
    local out = {}
    for _, id in ipairs(due) do
      local raw = redis.call('HGET', KEYS[1], id)
      if raw then
        local job = cjson.decode(raw)
        job.attempts = (job.attempts or 0) + 1
        local encoded = cjson.encode(job)
        redis.call('HSET', KEYS[1], id, encoded)
        redis.call('ZREM', KEYS[2], id)
        redis.call('ZADD', KEYS[3], deadline, id)
        table.insert(out, encoded)
      else
        -- The hash entry is gone, so the index entry is stale. Drop it.
        redis.call('ZREM', KEYS[2], id)
      end
    end
    return out
  `

  return {
    name: 'redis',

    start: async () => {
      try {
        await client.connect()
      } catch (cause) {
        throw new QueueError(
          `Could not connect to Redis. Check REDIS_URL is reachable from this host.`,
          { driver: 'redis', cause },
        )
      }
    },

    push: async (record, key) => {
      if (key) {
        // NX so the first caller wins. The marker is cleared when the job leaves the queue,
        // which is what makes "while the first is still pending" the actual window.
        const claimed = await send('HSETNX', [keys.dedupe, key, record.id])
        if (Number(claimed) === 0) return null
      }

      const stored: JobRecord = key ? ({ ...record, dedupeKey: key } as JobRecord) : record
      await send('HSET', [keys.jobs, record.id, JSON.stringify(stored)])
      await send('ZADD', [keys.pending, String(record.runAt), record.id])
      return record
    },

    reserve: async (count, visibility) => {
      const now = Date.now()
      const result = (await send('EVAL', [
        RESERVE,
        '3',
        keys.jobs,
        keys.pending,
        keys.active,
        String(now),
        String(count),
        String(now + visibility),
      ])) as string[] | null

      return (result ?? []).map((entry) => JSON.parse(entry) as JobRecord)
    },

    complete: async (id) => {
      await forget(id)
    },

    retry: async (record) => {
      await send('HSET', [keys.jobs, record.id, JSON.stringify(record)])
      await send('ZREM', [keys.active, record.id])
      await send('ZADD', [keys.pending, String(record.runAt), record.id])
    },

    kill: async (record) => {
      await send('LPUSH', [keys.dead, JSON.stringify(record)])
      // Bounded, or a job failing in a loop fills the instance.
      await send('LTRIM', [keys.dead, '0', '999'])
      await forget(record.id)
    },

    heartbeat: async (id, visibility) => {
      await send('ZADD', [keys.active, 'XX', String(Date.now() + visibility), id])
    },

    stats: async (): Promise<QueueStats> => {
      const now = Date.now()
      const [ready, total, active, dead] = (await Promise.all([
        send('ZCOUNT', [keys.pending, '-inf', String(now)]),
        send('ZCARD', [keys.pending]),
        send('ZCARD', [keys.active]),
        send('LLEN', [keys.dead]),
      ])) as [number, number, number, number]

      return {
        ready: Number(ready),
        scheduled: Number(total) - Number(ready),
        active: Number(active),
        dead: Number(dead),
      }
    },

    dead: async (limit) => {
      const entries = (await send('LRANGE', [keys.dead, '0', String(limit - 1)])) as string[]
      return (entries ?? []).map((entry) => JSON.parse(entry) as JobRecord)
    },

    revive: async (id) => {
      const entries = (await send('LRANGE', [keys.dead, '0', '-1'])) as string[]
      const found = (entries ?? []).find((entry) => (JSON.parse(entry) as JobRecord).id === id)
      if (!found) return null

      await send('LREM', [keys.dead, '1', found])
      const record: JobRecord = {
        ...(JSON.parse(found) as JobRecord),
        attempts: 0,
        runAt: Date.now(),
        lastError: undefined,
      }

      await send('HSET', [keys.jobs, record.id, JSON.stringify(record)])
      await send('ZADD', [keys.pending, String(record.runAt), record.id])
      return record
    },

    close: async () => {
      // Only when we made it. Closing a client the app handed us would take down its own use.
      if (!options.client) client.close()
    },
  }

  /** Removes a job and any dedupe marker pointing at it. */
  async function forget(id: string): Promise<void> {
    const raw = (await send('HGET', [keys.jobs, id])) as string | null
    const key = raw ? (JSON.parse(raw) as { dedupeKey?: string }).dedupeKey : undefined

    await send('HDEL', [keys.jobs, id])
    await send('ZREM', [keys.pending, id])
    await send('ZREM', [keys.active, id])
    if (key) await send('HDEL', [keys.dedupe, key])
  }
}
