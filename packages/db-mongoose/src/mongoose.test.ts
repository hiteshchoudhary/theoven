import { describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { db, providerFor, rememberProvider, transaction } from '@theoven/db'
import type { Connection } from 'mongoose'
import { mongooseDb } from './mongoose'

/**
 * Most of these run without a MongoDB server, because most of what is worth testing about an
 * adapter is its shape and its refusals. The integration block at the bottom runs against a real
 * server when `MONGO_URL` is set, and says so when it is not.
 */

describe('mongooseDb provider', () => {
  test('it names itself, so an error in an app with two databases says which', () => {
    expect(mongooseDb({ url: 'mongodb://localhost:27017/x' }).name).toBe('mongoose:mongodb')
  })

  // A missing url should fail at construction with a sentence, not at first connect with a
  // Mongoose parse error.
  test('a missing url is refused at construction', () => {
    expect(() => mongooseDb({ url: '' })).toThrow(/connection url/)
  })

  /**
   * The interesting one. This adapter exists to test whether the contract fits something
   * structurally unlike Drizzle, and this is where it did not: Mongoose scopes a transaction to
   * a session attached per query, not to a client that can be handed to `work`.
   *
   * So the provider declares no transaction support, and the contract refuses rather than
   * running the work unwrapped.
   */
  test('it declares no portable transaction support', () => {
    expect(mongooseDb({ url: 'mongodb://localhost:27017/x' }).transaction).toBeUndefined()
  })

  test('transaction() refuses for it, naming the provider', async () => {
    const provider = mongooseDb({ url: 'mongodb://localhost:27017/x' })
    const client = {} as Connection
    rememberProvider(client, provider)

    expect(providerFor(client)?.name).toBe('mongoose:mongodb')
    await expect(transaction(client, async () => 'never runs')).rejects.toThrow(
      /mongoose:mongodb.*does not support/s,
    )
  })

  // The failure mode worth guarding: a transaction that reports success without one.
  test('the refused work never runs', async () => {
    const provider = mongooseDb({ url: 'mongodb://localhost:27017/x' })
    const client = {} as Connection
    rememberProvider(client, provider)

    let ran = false
    await transaction(client, async () => {
      ran = true
    }).catch(() => {})

    expect(ran).toBe(false)
  })

  test('connection options are passed through rather than restated', () => {
    // Nothing to assert beyond the type accepting them; the value is that Mongoose's own
    // options are not re-declared here and left to fall behind.
    const provider = mongooseDb({
      url: 'mongodb://localhost:27017/x',
      connection: { maxPoolSize: 5, serverSelectionTimeoutMS: 1000 },
    })
    expect(provider.name).toBe('mongoose:mongodb')
  })
})

describe('health check', () => {
  // readyState would report healthy for a connection whose server has gone away.
  test('it returns false when there is no database handle', async () => {
    const provider = mongooseDb({ url: 'mongodb://localhost:27017/x' })
    expect(await provider.health({ db: undefined } as unknown as Connection)).toBe(false)
  })

  test('it reports the result of a real ping', async () => {
    const provider = mongooseDb({ url: 'mongodb://localhost:27017/x' })
    const pinged = { db: { admin: () => ({ command: async () => ({ ok: 1 }) }) } }
    expect(await provider.health(pinged as unknown as Connection)).toBe(true)

    const unwell = { db: { admin: () => ({ command: async () => ({ ok: 0 }) }) } }
    expect(await provider.health(unwell as unknown as Connection)).toBe(false)
  })
})

/**
 * Set `MONGO_URL` to run these. Skipped rather than failed when it is absent: a contributor
 * without a Mongo server should still get a green suite, and CI sets the variable.
 */
const MONGO_URL = process.env.MONGO_URL
const integration = MONGO_URL ? describe : describe.skip

integration('against a real server', () => {
  test('it connects, reports healthy, and closes', async () => {
    const provider = mongooseDb({ url: MONGO_URL as string })
    const connection = await provider.connect()

    expect(await provider.health(connection)).toBe(true)
    await provider.close(connection)
  })

  test('ctx.db is a Mongoose Connection, and models come off it', async () => {
    const app = createApp({ logger: silentLogger }).use(
      db(mongooseDb({ url: MONGO_URL as string })),
    )
    app.get('/ping', (ctx) => ({ ready: ctx.db.readyState }))
    await app.ready()

    const response = await app.fetch(new Request('https://theoven.app/ping'))
    expect(await response.json()).toEqual({ ready: 1 })

    await app.close({ timeout: 0 })
  })
})

if (!MONGO_URL) {
  // Silence is how a skipped integration suite gets mistaken for a passing one.
  console.info('[db-mongoose] MONGO_URL not set — integration tests skipped.')
}
