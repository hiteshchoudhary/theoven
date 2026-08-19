import type { DatabaseProvider } from '@theoven/db'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'

export interface PostgresOptions<Schema extends Record<string, unknown>> {
  /** Connection string. Read it from the environment; do not commit it. */
  url: string
  /** Your Drizzle schema. What makes `ctx.db` typed. */
  schema?: Schema
  logger?: boolean
  /** Maximum pooled connections. Default 10. */
  max?: number
}

type PostgresClient<Schema extends Record<string, unknown>> = ReturnType<typeof drizzle<Schema>>

/**
 * Drizzle over Postgres, using Bun's built-in SQL client.
 *
 * The switch from SQLite is this line. Every query written against `ctx.db` is unchanged —
 * which is the point of defaulting to Drizzle rather than raw SQL (D24).
 *
 * ```ts
 * app.use(db(drizzlePostgres({ url: env.url('DATABASE_URL'), schema })))
 * ```
 */
export function drizzlePostgres<Schema extends Record<string, unknown> = Record<string, never>>(
  options: PostgresOptions<Schema>,
): DatabaseProvider<PostgresClient<Schema>> {
  const { url, schema, logger = false, max = 10 } = options

  return {
    // The URL is deliberately not in the name: provider names reach logs and error messages,
    // and a connection string carries a password.
    name: 'drizzle:postgres',

    connect: () =>
      drizzle({
        connection: { url, max },
        ...(schema ? { schema } : {}),
        logger,
      }) as PostgresClient<Schema>,

    health: async (client) => {
      await client.execute(sql`select 1`)
      return true
    },

    close: async (client) => {
      // Drizzle exposes the underlying client differently by driver; closing is best-effort
      // rather than a hard failure during shutdown, which is already a degraded path.
      const inner = (client as unknown as { $client?: { close?: () => Promise<void> } }).$client
      await inner?.close?.()
    },

    transaction: async (client, work) =>
      client.transaction(async (tx) => work(tx as unknown as PostgresClient<Schema>)),
  }
}
