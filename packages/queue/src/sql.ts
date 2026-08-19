import type { JobRecord, QueueDriver, QueueStats } from './types'
import { QueueError } from './types'

export interface SqlQueueOptions {
  /** Postgres connection string. Defaults to `DATABASE_URL`. */
  url?: string
  /** Table name. Default `oven_jobs`. Created at boot if it does not exist. */
  table?: string
  /** An existing `Bun.SQL`, when the app already has one. */
  sql?: Bun.SQL
}

/**
 * A queue in Postgres, on Bun's built-in SQL client.
 *
 * Worth having because most applications already run Postgres, and one fewer service to operate
 * is worth more than the throughput a dedicated broker would add. If you are enqueueing tens of
 * thousands of jobs a second, use Redis.
 *
 * Reserving uses `FOR UPDATE SKIP LOCKED`, which is the reason this is safe with several workers:
 * each transaction takes rows nobody else has locked instead of queueing behind them.
 */
export function sqlQueue(options: SqlQueueOptions = {}): QueueDriver {
  const table = options.table ?? 'oven_jobs'

  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    // The table name is interpolated — parameters cannot name a relation — so it is validated
    // rather than trusted.
    throw new QueueError(`"${table}" is not a usable table name.`, { driver: 'postgres' })
  }

  const url = options.url ?? process.env.DATABASE_URL
  if (!options.sql && !url) {
    throw new QueueError(
      'The Postgres queue needs a connection. Pass `url`, pass an existing `sql` client, or ' +
        'set DATABASE_URL.',
      { driver: 'postgres' },
    )
  }

  const sql = options.sql ?? new Bun.SQL(url as string)

  function toRecord(row: Record<string, unknown>): JobRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      payload: row.payload,
      attempts: Number(row.attempts),
      runAt: Number(row.run_at),
      createdAt: Number(row.created_at),
      lastError: row.last_error === null ? undefined : String(row.last_error),
    }
  }

  return {
    name: 'postgres',

    start: async () => {
      try {
        // Created here rather than in a migration: the queue's schema is the brick's business,
        // and an application should not have to hand-write a table to use a feature.
        await sql.unsafe(`
          create table if not exists ${table} (
            id text primary key,
            name text not null,
            payload jsonb,
            attempts integer not null default 0,
            run_at bigint not null,
            created_at bigint not null,
            visible_at bigint,
            dedupe_key text,
            last_error text,
            state text not null default 'pending'
          );
          create index if not exists ${table}_ready_idx on ${table} (state, run_at);
          create unique index if not exists ${table}_dedupe_idx
            on ${table} (dedupe_key) where dedupe_key is not null and state <> 'dead';
        `)
      } catch (cause) {
        throw new QueueError('Could not prepare the queue table.', { driver: 'postgres', cause })
      }
    },

    push: async (record, key) => {
      // `on conflict do nothing` against the partial unique index is the dedupe: no read, no
      // race between checking and inserting.
      const rows = (await sql.unsafe(
        `insert into ${table} (id, name, payload, attempts, run_at, created_at, dedupe_key, state)
         values ($1, $2, $3, $4, $5, $6, $7, 'pending')
         on conflict do nothing
         returning *`,
        [
          record.id,
          record.name,
          JSON.stringify(record.payload ?? null),
          record.attempts,
          record.runAt,
          record.createdAt,
          key ?? null,
        ],
      )) as Array<Record<string, unknown>>

      return rows.length > 0 ? record : null
    },

    reserve: async (count, visibility) => {
      const now = Date.now()

      /**
       * One statement, so reserving is atomic.
       *
       * `skip locked` is what makes several workers safe: a worker takes rows nobody else has
       * locked rather than blocking behind them. The `visible_at` check reclaims jobs from a
       * worker that died holding them.
       */
      const rows = (await sql.unsafe(
        `update ${table} set
           state = 'active',
           attempts = attempts + 1,
           visible_at = $1
         where id in (
           select id from ${table}
           where state <> 'dead'
             and run_at <= $2
             and (state = 'pending' or visible_at <= $2)
           order by run_at
           limit $3
           for update skip locked
         )
         returning *`,
        [now + visibility, now, count],
      )) as Array<Record<string, unknown>>

      return rows.map(toRecord)
    },

    complete: async (id) => {
      await sql.unsafe(`delete from ${table} where id = $1`, [id])
    },

    retry: async (record) => {
      await sql.unsafe(
        `update ${table}
         set state = 'pending', run_at = $2, last_error = $3, visible_at = null
         where id = $1`,
        [record.id, record.runAt, record.lastError ?? null],
      )
    },

    kill: async (record) => {
      // Kept in the same table with a different state rather than moved: a dead job is still a
      // job, and one table means one place to look.
      await sql.unsafe(
        `update ${table} set state = 'dead', last_error = $2, visible_at = null where id = $1`,
        [record.id, record.lastError ?? null],
      )
    },

    heartbeat: async (id, visibility) => {
      await sql.unsafe(`update ${table} set visible_at = $2 where id = $1 and state = 'active'`, [
        id,
        Date.now() + visibility,
      ])
    },

    stats: async (): Promise<QueueStats> => {
      const now = Date.now()
      const rows = (await sql.unsafe(
        `select
           count(*) filter (where state = 'pending' and run_at <= $1) as ready,
           count(*) filter (where state = 'pending' and run_at > $1) as scheduled,
           count(*) filter (where state = 'active') as active,
           count(*) filter (where state = 'dead') as dead
         from ${table}`,
        [now],
      )) as Array<Record<string, unknown>>

      const row = rows[0] ?? {}
      return {
        ready: Number(row.ready ?? 0),
        scheduled: Number(row.scheduled ?? 0),
        active: Number(row.active ?? 0),
        dead: Number(row.dead ?? 0),
      }
    },

    dead: async (limit) => {
      const rows = (await sql.unsafe(
        `select * from ${table} where state = 'dead' order by created_at desc limit $1`,
        [limit],
      )) as Array<Record<string, unknown>>
      return rows.map(toRecord)
    },

    revive: async (id) => {
      const rows = (await sql.unsafe(
        `update ${table}
         set state = 'pending', attempts = 0, run_at = $2, last_error = null, visible_at = null
         where id = $1 and state = 'dead'
         returning *`,
        [id, Date.now()],
      )) as Array<Record<string, unknown>>

      return rows.length > 0 ? toRecord(rows[0] as Record<string, unknown>) : null
    },

    close: async () => {
      if (!options.sql) await sql.close()
    },
  }
}
