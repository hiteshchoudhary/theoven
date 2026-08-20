import type { RateLimitResult, RateLimitStore } from './types'

export interface SqlStoreOptions {
  url?: string
  /** Table name. Created at boot if absent. */
  table?: string
  client?: Bun.SQL
}

/**
 * Counting in Postgres, for applications that already run one and would rather not add Redis.
 *
 * Atomicity comes from `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which is one statement and
 * therefore one transaction: two instances hitting the same key at the same moment serialise on
 * the row, and both get a distinct count back. A `SELECT` followed by an `UPDATE` would not.
 */
export function sqlStore(options: SqlStoreOptions = {}): RateLimitStore {
  const table = options.table ?? 'oven_ratelimit'
  let sql: Bun.SQL | undefined = options.client
  const adopted = options.client !== undefined
  let ready: Promise<void> | undefined

  async function connection(): Promise<Bun.SQL> {
    sql ??= new Bun.SQL(options.url ?? Bun.env.DATABASE_URL ?? '')
    ready ??= (async () => {
      await sql?.unsafe(`
        create table if not exists ${table} (
          key text not null,
          window_start bigint not null,
          count integer not null,
          primary key (key, window_start)
        )
      `)
    })()
    await ready
    return sql
  }

  return {
    name: 'sql',

    async hit(key: string, window: number, now: number): Promise<RateLimitResult> {
      const client = await connection()
      const start = Math.floor(now / window) * window

      const [row] = (await client.unsafe(
        `insert into ${table} (key, window_start, count) values ($1, $2, 1)
         on conflict (key, window_start) do update set count = ${table}.count + 1
         returning count`,
        [key, start],
      )) as Array<{ count: number }>

      const [previous] = (await client.unsafe(
        `select count from ${table} where key = $1 and window_start = $2`,
        [key, start - window],
      )) as Array<{ count: number }>

      // The same sliding weight as the Redis store. Read after the increment because the previous
      // window is settled history — nothing can change it, so it needs no atomicity with the write.
      const elapsed = now - start
      const weight = (window - elapsed) / window
      const total = Math.floor((previous?.count ?? 0) * weight + Number(row?.count ?? 1))

      return { count: total, resetMs: window - elapsed }
    },

    async close(): Promise<void> {
      if (!adopted) await sql?.close()
      sql = undefined
      ready = undefined
    },
  }
}

/**
 * Deletes windows that can no longer affect a decision.
 *
 * Nothing calls this. Rows expire in the sense that they stop being counted, but unlike Redis
 * nothing removes them — so a table on a busy endpoint grows a row per key per window until
 * somebody runs this from a cron job.
 */
export async function pruneRateLimits(client: Bun.SQL, olderThanMs = 3_600_000): Promise<void> {
  await client.unsafe('delete from oven_ratelimit where window_start < $1', [
    Date.now() - olderThanMs,
  ])
}
