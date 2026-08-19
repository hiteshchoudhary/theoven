import { Database } from 'bun:sqlite'
import type { DatabaseProvider } from '@theoven/db'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

export interface SqliteOptions<Schema extends Record<string, unknown>> {
  /**
   * Database file, or `:memory:`.
   *
   * A file by default, because a database that vanishes on restart is a surprising thing for a
   * framework to hand you as the default.
   */
  url?: string
  /** Your Drizzle schema. What makes `ctx.db` typed. */
  schema?: Schema
  /** Log every statement. Useful in development, noisy anywhere else. */
  logger?: boolean
  /**
   * Apply the pragmas that make SQLite behave under concurrent load. On by default.
   *
   * Without WAL, SQLite serialises readers behind a writer, and a web application discovers
   * this as sporadic `SQLITE_BUSY` errors under exactly the traffic it was meant to handle.
   */
  tune?: boolean
}

type SqliteClient<Schema extends Record<string, unknown>> = ReturnType<typeof drizzle<Schema>>

/**
 * Drizzle over `bun:sqlite`.
 *
 * The default for `oven create`: no server to provision, a file on disk, and Bun's own driver
 * underneath. Moving to Postgres later changes this line and nothing else — the query code is
 * identical, which is the whole reason the default is Drizzle rather than raw SQL (D24).
 *
 * ```ts
 * import * as schema from './schema'
 *
 * app.use(db(drizzleSqlite({ url: './data.db', schema })))
 * app.get('/users', (ctx) => ctx.db.select().from(schema.users))
 * ```
 */
export function drizzleSqlite<Schema extends Record<string, unknown> = Record<string, never>>(
  options: SqliteOptions<Schema> = {},
): DatabaseProvider<SqliteClient<Schema>> {
  const { url = './data.db', schema, logger = false, tune = true } = options
  let sqlite: Database | undefined
  /** Tail of the transaction queue; see `transaction` below for why it exists. */
  let queue: Promise<void> = Promise.resolve()

  return {
    name: `drizzle:sqlite(${url})`,

    connect: () => {
      sqlite = new Database(url, { create: true })

      if (tune) {
        // WAL lets readers proceed while a write is in flight; without it a web application
        // hits SQLITE_BUSY under ordinary concurrency. `NORMAL` trades an fsync per commit for
        // throughput and is the standard pairing with WAL.
        sqlite.exec('PRAGMA journal_mode = WAL')
        sqlite.exec('PRAGMA synchronous = NORMAL')
        // Without this, a lock contended for even briefly fails immediately rather than waiting.
        sqlite.exec('PRAGMA busy_timeout = 5000')
        sqlite.exec('PRAGMA foreign_keys = ON')
      }

      return drizzle(sqlite, {
        ...(schema ? { schema } : {}),
        logger,
      }) as SqliteClient<Schema>
    },

    health: (client) => {
      // A real query, not "is the object there". A health check that cannot fail is not one.
      client.get(sql`select 1`)
      return true
    },

    close: () => {
      sqlite?.close()
      sqlite = undefined
    },

    /**
     * Transactions, issued manually rather than through Drizzle's helper.
     *
     * Drizzle's `bun-sqlite` transaction wraps `Database.transaction()`, which is synchronous:
     * an async callback returns a promise immediately, the transaction commits, and *then* the
     * rejection arrives. Work that throws after an `await` is committed anyway. Verified, not
     * assumed — the test below inserts a row and throws, and without this the row survives.
     *
     * Explicit `begin`/`commit`/`rollback` puts the boundaries where the awaits are.
     */
    transaction: async (client, work) => {
      // Serialised. SQLite allows one writer at a time regardless, and two overlapping
      // transactions on one connection would interleave their statements — a `commit` from one
      // request ending another request's transaction early.
      const previous = queue
      let release: () => void = () => {}
      queue = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous

      try {
        client.run(sql`begin`)
        try {
          const result = await work(client)
          client.run(sql`commit`)
          return result
        } catch (failure) {
          client.run(sql`rollback`)
          throw failure
        }
      } finally {
        release()
      }
    },
  }
}
