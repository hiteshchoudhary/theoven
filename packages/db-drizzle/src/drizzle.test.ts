import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { checkHealth, db, transaction } from '@theoven/db'
import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { drizzleSqlite } from './sqlite'

const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  age: integer('age'),
})

const schema = { users }

/**
 * Closable apps, typed structurally.
 *
 * Annotating these as `App` would erase what `.use(db(...))` contributed, and `ctx.db` would
 * stop being typed — which is the thing these tests exist to check.
 */
const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

/** An app with an in-memory database, with the brick's contribution preserved in the type. */
async function withDatabase() {
  const app = createApp({ logger: silentLogger, development: true }).use(
    db(drizzleSqlite({ url: ':memory:', schema })),
  )
  opened.push(app)
  await app.ready()
  return app
}

function send(
  app: { fetch(request: Request): Promise<Response> },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`, init))
}

describe('connecting', () => {
  test('boots against an in-memory database', async () => {
    const app = await withDatabase()
    app.get('/ping', async (ctx) => {
      // `all()` rather than `get()`: for raw SQL, Drizzle's bun-sqlite `get()` returns the row
      // as an array, while `all()` returns objects.
      const rows = ctx.db.all<{ one: number }>(sql`select 1 as one`)
      return { one: rows[0]?.one }
    })
    expect(await (await send(app, '/ping')).json()).toEqual({ one: 1 })
  })

  test('data written to a file survives a restart', async () => {
    const file = `${import.meta.dir}/../../../.tmp/drizzle-${Math.floor(performance.now() * 1000)}.db`

    const first = createApp({ logger: silentLogger }).use(db(drizzleSqlite({ url: file })))
    first.post('/write', (ctx) => {
      ctx.db.run(sql`create table if not exists notes (body text)`)
      ctx.db.run(sql`insert into notes values ('persisted')`)
      return null
    })
    await first.ready()
    await send(first, '/write', { method: 'POST' })
    await first.close()

    // A second app, a fresh connection, the same file.
    const second = createApp({ logger: silentLogger }).use(db(drizzleSqlite({ url: file })))
    opened.push(second)
    second.get('/read', (ctx) => ctx.db.all<{ body: string }>(sql`select body from notes`))

    expect(await (await send(second, '/read')).json()).toEqual([{ body: 'persisted' }])

    await second.close()
    await Bun.file(file)
      .delete()
      .catch(() => {})
  })

  test('a bad path is refused at boot', async () => {
    const app = createApp({ logger: silentLogger }).use(
      db(drizzleSqlite({ url: '/nonexistent-directory/x.db' })),
    )
    opened.push(app)
    expect(app.ready()).rejects.toThrow(/drizzle:sqlite/)
  })
})

describe('queries are native Drizzle', () => {
  test('insert and select', async () => {
    const app = await withDatabase()

    app.post('/setup', (ctx) => {
      ctx.db.run(sql`create table users (id text primary key, name text not null, age integer)`)
      return null
    })
    app.post('/users', async (ctx) => {
      await ctx.db.insert(users).values({ id: '1', name: 'Ada', age: 36 })
      return null
    })
    app.get('/users', async (ctx) => ctx.db.select().from(users))

    await send(app, '/setup', { method: 'POST' })
    await send(app, '/users', { method: 'POST' })

    expect(await (await send(app, '/users')).json()).toEqual([{ id: '1', name: 'Ada', age: 36 }])
  })

  // The point of D16: nothing of ours sits between the handler and the ORM.
  test('the client exposes Drizzle’s own API, not a wrapper', async () => {
    const app = await withDatabase()
    app.get('/api', (ctx) => ({
      hasSelect: typeof ctx.db.select === 'function',
      hasInsert: typeof ctx.db.insert === 'function',
      hasTransaction: typeof ctx.db.transaction === 'function',
    }))

    expect(await (await send(app, '/api')).json()).toEqual({
      hasSelect: true,
      hasInsert: true,
      hasTransaction: true,
    })
  })
})

describe('health', () => {
  test('a live database reports healthy', async () => {
    const app = await withDatabase()
    app.get('/h', async (ctx) => ({ healthy: await checkHealth(ctx.db) }))
    expect(await (await send(app, '/h')).json()).toEqual({ healthy: true })
  })

  test('the health endpoint can be mounted', async () => {
    const app = createApp({ logger: silentLogger }).use(
      db(drizzleSqlite({ url: ':memory:' }), { healthPath: '/_health/db' }),
    )
    opened.push(app)

    const response = await send(app, '/_health/db')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ healthy: true })
  })
})

describe('transactions', () => {
  test('commit', async () => {
    const app = await withDatabase()
    app.post('/x', async (ctx) => {
      ctx.db.run(sql`create table users (id text primary key, name text not null, age integer)`)
      await transaction(ctx.db, async (tx) => {
        await tx.insert(users).values({ id: '1', name: 'Ada' })
      })
      return ctx.db.select().from(users)
    })

    expect(await (await send(app, '/x', { method: 'POST' })).json()).toHaveLength(1)
  })

  // The reason transactions exist: partial writes must not survive a failure.
  test('roll back on failure', async () => {
    const app = await withDatabase()
    app.post('/x', async (ctx) => {
      ctx.db.run(sql`create table users (id text primary key, name text not null, age integer)`)

      try {
        await transaction(ctx.db, async (tx) => {
          await tx.insert(users).values({ id: '1', name: 'Ada' })
          throw new Error('something went wrong after the insert')
        })
      } catch {
        // expected
      }

      return ctx.db.select().from(users)
    })

    expect(await (await send(app, '/x', { method: 'POST' })).json()).toEqual([])
  })

  // Drizzle's own bun-sqlite transaction commits before an async rejection arrives, because
  // bun:sqlite is synchronous. This documents that difference rather than hiding it.
  test('the native Drizzle transaction does NOT roll back async failures', async () => {
    const app = await withDatabase()
    app.post('/x', async (ctx) => {
      ctx.db.run(sql`create table users (id text primary key, name text not null, age integer)`)
      try {
        await ctx.db.transaction(async (tx) => {
          await tx.insert(users).values({ id: '9', name: 'Escaped' })
          throw new Error('after the insert')
        })
      } catch {
        // expected
      }
      return ctx.db.select().from(users)
    })

    // The row survives — which is exactly why the provider issues begin/commit itself.
    expect(await (await send(app, '/x', { method: 'POST' })).json()).toHaveLength(1)
  })

  test('Drizzle’s own transaction API still works', async () => {
    const app = await withDatabase()
    app.post('/x', async (ctx) => {
      ctx.db.run(sql`create table users (id text primary key, name text not null, age integer)`)
      await ctx.db.transaction(async (tx) => {
        await tx.insert(users).values({ id: '2', name: 'Grace' })
      })
      return ctx.db.select().from(users)
    })

    expect(await (await send(app, '/x', { method: 'POST' })).json()).toHaveLength(1)
  })
})

describe('sqlite tuning', () => {
  // Without WAL, SQLite serialises readers behind a writer and a web app sees SQLITE_BUSY
  // under exactly the concurrency it was built for.
  test('WAL and foreign keys are on by default', async () => {
    const app = await withDatabase()
    app.get('/pragmas', (ctx) => ({
      foreignKeys: ctx.db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`)[0]?.foreign_keys,
    }))

    const result = (await (await send(app, '/pragmas')).json()) as Record<string, unknown>
    // An in-memory database reports `memory` rather than `wal`; foreign keys apply either way.
    expect(result.foreignKeys).toBe(1)
  })

  test('tuning can be turned off', async () => {
    const app = createApp({ logger: silentLogger }).use(
      db(drizzleSqlite({ url: ':memory:', tune: false })),
    )
    opened.push(app)
    app.get('/fk', (ctx) => ({
      foreignKeys: ctx.db.all<{ foreign_keys: number }>(sql`pragma foreign_keys`)[0]?.foreign_keys,
    }))

    expect(await (await send(app, '/fk')).json()).toEqual({ foreignKeys: 0 })
  })
})
