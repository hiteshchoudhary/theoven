import { afterEach, describe, expect, test } from 'bun:test'
import { type App, createApp, silentLogger } from '@theoven/core'
import { db } from './brick'
import {
  checkHealth,
  DatabaseError,
  type DatabaseProvider,
  providerFor,
  transaction,
} from './provider'

const opened: App[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

function make(): App {
  const app = createApp({ logger: silentLogger, development: true })
  opened.push(app)
  return app
}

function send(app: App, path: string): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`))
}

/** A provider standing in for a real one, so the contract can be tested without a database. */
interface FakeClient {
  rows: string[]
  closed: boolean
  inTransaction: boolean
}

function fakeProvider(
  overrides: Partial<DatabaseProvider<FakeClient>> = {},
): DatabaseProvider<FakeClient> {
  const client: FakeClient = { rows: [], closed: false, inTransaction: false }
  return {
    name: 'fake',
    connect: () => client,
    health: () => !client.closed,
    close: () => {
      client.closed = true
    },
    transaction: async (target, work) => {
      const scoped = { ...target, inTransaction: true }
      return work(scoped)
    },
    ...overrides,
  }
}

describe('the brick', () => {
  test('exposes the native client on ctx.db', async () => {
    const app = make().use(db(fakeProvider()))
    app.get('/x', (ctx) => ({ rows: ctx.db.rows, inTransaction: ctx.db.inTransaction }))

    expect(await (await send(app, '/x')).json()).toEqual({ rows: [], inTransaction: false })
  })

  // ctx.db must be exactly what the ORM handed us — no wrapper, no proxy.
  test('does not wrap the client', async () => {
    const provider = fakeProvider()
    const original = await provider.connect()

    const app = make().use(db(provider))
    app.get('/x', (ctx) => ({ same: ctx.db === original }))

    expect(await (await send(app, '/x')).json()).toEqual({ same: true })
  })

  test('connects once, not per request', async () => {
    let connections = 0
    const client: FakeClient = { rows: [], closed: false, inTransaction: false }
    const app = make().use(
      db({
        name: 'counting',
        connect: () => {
          connections++
          return client
        },
        health: () => true,
        close: () => {},
      }),
    )
    app.get('/x', () => 'ok')

    await send(app, '/x')
    await send(app, '/x')
    expect(connections).toBe(1)
  })

  test('closes on shutdown', async () => {
    const provider = fakeProvider()
    const client = await provider.connect()

    const app = createApp({ logger: silentLogger }).use(db(provider))
    await app.ready()
    await app.close()

    expect(client.closed).toBe(true)
  })

  // One restart beats a deploy that looked green and fails on the first request.
  test('a failing connection is refused at boot, naming the provider', async () => {
    const app = make().use(
      db({
        name: 'broken',
        connect: () => {
          throw new Error('ECONNREFUSED')
        },
        health: () => true,
        close: () => {},
      }),
    )
    expect(app.ready()).rejects.toThrow(/broken/)
  })

  test('a connection that opens but fails its health check is refused at boot', async () => {
    const app = make().use(db(fakeProvider({ health: () => false })))
    expect(app.ready()).rejects.toThrow(/health check failed/)
  })

  test('the boot check can be turned off', async () => {
    const app = make().use(db(fakeProvider({ health: () => false }), { checkOnBoot: false }))
    app.get('/x', () => 'ok')
    expect((await send(app, '/x')).status).toBe(200)
  })
})

describe('health endpoint', () => {
  // A brick that silently adds routes shows up unexplained in `oven routes`.
  test('is not mounted unless asked for', async () => {
    const app = make().use(db(fakeProvider()))
    app.get('/x', () => 'ok')
    expect((await send(app, '/_health/db')).status).toBe(404)
  })

  test('reports healthy', async () => {
    const app = make().use(db(fakeProvider(), { healthPath: '/_health/db' }))
    const response = await send(app, '/_health/db')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ database: 'fake', healthy: true })
  })

  // A load balancer reads the status line, not the body.
  test('answers 503 when unhealthy', async () => {
    let healthy = true
    const app = make().use(
      db(fakeProvider({ health: () => healthy }), { healthPath: '/_health/db' }),
    )
    await app.ready()

    healthy = false
    const response = await send(app, '/_health/db')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ healthy: false })
  })

  test('mounts at the path given', async () => {
    const app = make().use(db(fakeProvider(), { healthPath: '/status/database' }))
    expect((await send(app, '/status/database')).status).toBe(200)
  })
})

describe('provider lookup', () => {
  test('maps a client back to its provider', async () => {
    const provider = fakeProvider()
    const client = await provider.connect()

    const app = make().use(db(provider))
    await app.ready()

    expect(providerFor(client)?.name).toBe('fake')
  })

  test('returns undefined for a client Oven did not make', () => {
    expect(providerFor({ some: 'object' })).toBeUndefined()
    expect(providerFor(null)).toBeUndefined()
    expect(providerFor('a string')).toBeUndefined()
  })
})

describe('transactions', () => {
  test('runs work with a scoped client', async () => {
    const provider = fakeProvider()
    const client = await provider.connect()
    const app = make().use(db(provider))
    await app.ready()

    const result = await transaction(client, async (tx) => tx.inTransaction)
    expect(result).toBe(true)
  })

  test('returns the work’s value', async () => {
    const provider = fakeProvider()
    const client = await provider.connect()
    const app = make().use(db(provider))
    await app.ready()

    expect(await transaction(client, async () => 'done')).toBe('done')
  })

  // Work that silently escapes its transaction is the failure nobody notices until the data
  // is already wrong.
  test('refuses when the provider has no transaction support', async () => {
    // Built without the optional method rather than with it set to undefined, which is what a
    // provider for a store lacking transactions actually looks like.
    const { transaction: _omitted, ...provider } = fakeProvider()
    const client = await provider.connect()
    const app = make().use(db(provider))
    await app.ready()

    expect(transaction(client, async () => 'x')).rejects.toThrow(/does not support transactions/)
  })

  test('refuses a client Oven did not make', () => {
    expect(transaction({ foreign: true }, async () => 'x')).rejects.toThrow(/did not come from/)
  })

  test('propagates a failure so the provider can roll back', async () => {
    const provider = fakeProvider()
    const client = await provider.connect()
    const app = make().use(db(provider))
    await app.ready()

    expect(
      transaction(client, async () => {
        throw new Error('constraint violated')
      }),
    ).rejects.toThrow(/constraint violated/)
  })
})

describe('checkHealth', () => {
  test('reports a healthy client', async () => {
    const provider = fakeProvider()
    const client = await provider.connect()
    const app = make().use(db(provider))
    await app.ready()

    expect(await checkHealth(client)).toBe(true)
  })

  // A health endpoint that 500s tells a load balancer less than one reporting "not healthy".
  test('reports false when the check itself throws', async () => {
    const provider = fakeProvider({
      health: () => {
        throw new Error('connection lost')
      },
    })
    const client = await provider.connect()
    // The boot check is off here so the app can start; this test is about checkHealth itself.
    const app = make().use(db(provider, { checkOnBoot: false }))
    await app.ready()

    expect(await checkHealth(client)).toBe(false)
  })

  test('reports false for an unknown client', async () => {
    expect(await checkHealth({ foreign: true })).toBe(false)
  })
})

describe('DatabaseError', () => {
  test('is a real Error carrying the provider name', () => {
    const error = new DatabaseError('failed', { provider: 'drizzle:sqlite' })
    expect(error).toBeInstanceOf(Error)
    expect(error.provider).toBe('drizzle:sqlite')
  })
})
