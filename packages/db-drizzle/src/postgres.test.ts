import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { checkHealth, db, transaction, transactional } from '@theoven/db'
import { sql } from 'drizzle-orm'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { drizzlePostgres } from './postgres'

/**
 * Postgres, against a real server.
 *
 * The SQLite suite proves the adapter's logic; this one proves the things only a real server
 * can — that pooling, `select 1`, real `BEGIN`/`ROLLBACK` and connection close behave as the
 * provider claims. CI runs it against a service container. Set `POSTGRES_URL` to run it locally.
 */

const POSTGRES_URL = process.env.POSTGRES_URL
const integration = POSTGRES_URL ? describe : describe.skip

const people = pgTable('oven_people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  age: integer('age'),
})

const schema = { people }

/** The client type the provider produces — kept real, so these tests still check the typing. */
type PostgresClient = Awaited<
  ReturnType<ReturnType<typeof drizzlePostgres<typeof schema>>['connect']>
>

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

/**
 * An app plus its database client.
 *
 * The client is captured through a route rather than read off the app, because a brick's
 * contribution lives on the request context — which is the design, and the reason these tests
 * reach it the way an application would.
 */
async function withPostgres() {
  const app = createApp({ logger: silentLogger, development: true }).use(
    db(drizzlePostgres({ url: POSTGRES_URL as string, schema })),
  )
  opened.push(app)

  let client!: PostgresClient

  app.get('/__client', (ctx) => {
    client = ctx.db
    return null
  })

  await app.ready()
  await app.fetch(new Request('https://theoven.app/__client'))

  // Each test starts from an empty table rather than depending on the order they ran in.
  await client.execute(
    sql`create table if not exists oven_people (id text primary key, name text not null, age integer)`,
  )
  await client.execute(sql`truncate oven_people`)
  return { app, client }
}

integration('drizzle over postgres', () => {
  test('it connects and reports healthy through a real query', async () => {
    const { client } = await withPostgres()
    expect(await checkHealth(client)).toBe(true)
  })

  test('ctx.db is the Drizzle client, typed from the schema', async () => {
    const { app } = await withPostgres()
    app.get('/people', (ctx) => ctx.db.select().from(people))
    app.post('/people', async (ctx) => {
      await ctx.db.insert(people).values({ id: '1', name: 'Ada', age: 36 })
      return null
    })

    await app.fetch(new Request('https://theoven.app/people', { method: 'POST' }))
    const listed = await (await app.fetch(new Request('https://theoven.app/people'))).json()
    expect(listed).toEqual([{ id: '1', name: 'Ada', age: 36 }])
  })

  /**
   * The case that caught a real bug in the SQLite adapter: Drizzle's callback returning while an
   * async failure is still in flight, and the transaction committing anyway. Postgres has to
   * roll back here too.
   */
  test('a failed transaction rolls back an async write', async () => {
    const { client } = await withPostgres()

    await transaction(client, async (tx) => {
      await tx.insert(people).values({ id: 'rollback', name: 'Grace' })
      throw new Error('failed after the write')
    }).catch(() => {})

    expect(await client.select().from(people)).toEqual([])
  })

  test('a successful transaction commits', async () => {
    const { client } = await withPostgres()

    await transaction(client, async (tx) => {
      await tx.insert(people).values({ id: 'commit', name: 'Grace' })
    })

    expect(await client.select().from(people)).toHaveLength(1)
  })

  test('transactional() wraps a whole request', async () => {
    const { app, client } = await withPostgres()
    app.use(transactional())
    app.post('/fail', async (ctx) => {
      await ctx.db.insert(people).values({ id: 'req', name: 'Ada' })
      throw new Error('handler failed')
    })

    await app.fetch(new Request('https://theoven.app/fail', { method: 'POST' }))
    expect(await client.select().from(people)).toEqual([])
  })

  // Shutdown should release pooled connections, or a test suite exhausts the server's limit.
  test('close releases the pool', async () => {
    const { app, client } = await withPostgres()
    await app.close({ timeout: 100 })
    opened.length = 0

    // Health goes through the closed client; it must report unhealthy rather than hang.
    expect(await checkHealth(client)).toBe(false)
  })
})

if (!POSTGRES_URL) {
  console.info('[db-drizzle] POSTGRES_URL not set — Postgres integration tests skipped.')
}
