import type { CacheDriver, CacheEntry, SetOptions } from './types'
import { CacheError } from './types'

export interface RedisCacheOptions {
  /** Connection string. Defaults to `REDIS_URL`, then localhost. */
  url?: string
  /** Key prefix, so two apps can share one Redis. Default `oven:cache`. */
  prefix?: string
  /** An existing client, when the app already has one. */
  client?: Bun.RedisClient
}

/**
 * A cache in Redis, on Bun's built-in client.
 *
 * Entries are plain keys with Redis's own TTL, so expiry is the server's job rather than
 * something we sweep for. Tags are sets of key names — invalidating one reads the set and deletes
 * its members.
 */
export function redisCache(options: RedisCacheOptions = {}): CacheDriver {
  const prefix = options.prefix ?? 'oven:cache'
  const client =
    options.client ??
    new Bun.RedisClient(options.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379')

  const entryKey = (key: string) => `${prefix}:k:${key}`
  const tagKey = (tag: string) => `${prefix}:t:${tag}`

  const send = (command: string, args: string[]) => client.send(command, args)

  return {
    name: 'redis',
    raw: client,

    start: async () => {
      try {
        await client.connect()
      } catch (cause) {
        throw new CacheError('Could not connect to Redis. Check REDIS_URL.', {
          driver: 'redis',
          cause,
        })
      }
    },

    get: async (key) => {
      const raw = (await send('GET', [entryKey(key)])) as string | null
      if (raw === null) return undefined

      try {
        return JSON.parse(raw) as CacheEntry
      } catch {
        // A value we cannot parse is a value from an older format or another writer. Dropping it
        // is better than throwing on a read path.
        await send('DEL', [entryKey(key)])
        return undefined
      }
    },

    set: async (key, entry, options: SetOptions) => {
      const payload = JSON.stringify(entry)

      if (options.ttl !== undefined && options.ttl > 0) {
        // Redis owns expiry, so nothing here has to sweep.
        await send('SET', [entryKey(key), payload, 'PX', String(Math.ceil(options.ttl))])
      } else {
        await send('SET', [entryKey(key), payload])
      }

      for (const tag of options.tags ?? []) {
        await send('SADD', [tagKey(tag), key])
        // The tag set outlives its members otherwise: entries expire on their own and the set
        // would keep their names forever.
        if (options.ttl !== undefined && options.ttl > 0) {
          await send('PEXPIRE', [tagKey(tag), String(Math.ceil(options.ttl)), 'GT'])
        }
      }
    },

    delete: async (key) => {
      await send('DEL', [entryKey(key)])
    },

    invalidate: async (tag) => {
      const members = ((await send('SMEMBERS', [tagKey(tag)])) as string[] | null) ?? []
      if (members.length === 0) return 0

      await send('DEL', members.map(entryKey))
      await send('DEL', [tagKey(tag)])
      return members.length
    },

    clear: async () => {
      // `SCAN` rather than `KEYS`: `KEYS` blocks the server for the length of the keyspace, which
      // on a shared Redis is somebody else's outage.
      let cursor = '0'
      do {
        const [next, batch] = (await send('SCAN', [
          cursor,
          'MATCH',
          `${prefix}:*`,
          'COUNT',
          '500',
        ])) as [string, string[]]

        if (batch.length > 0) await send('DEL', batch)
        cursor = next
      } while (cursor !== '0')
    },

    close: async () => {
      if (!options.client) client.close()
    },
  }
}
