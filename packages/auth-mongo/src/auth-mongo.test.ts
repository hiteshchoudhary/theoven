import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { auth } from '@theoven/auth'
import { describeAuthStore } from '@theoven/auth/testing'
import { createApp, silentLogger } from '@theoven/core'
import { type Connection, createConnection } from 'mongoose'
import { mongoAuth } from './provider'
import { authModels } from './schema'
import { mongooseStore } from './store'

/**
 * `auth-mongo` against a real MongoDB.
 *
 * There is no in-memory Mongo worth testing against — a fake would prove the fake works. So this
 * suite is gated on `MONGO_URL` and runs in CI against a `mongo:8` service container, and says so
 * rather than passing silently when it is not set.
 *
 * Most of it is the shared conformance suite. That is deliberate: the security-critical half of
 * this brick is `@theoven/auth`, already tested there, and what remains to prove is that the
 * Mongoose store answers the same contract as the Drizzle one.
 */

const MONGO_URL = process.env.MONGO_URL
const integration = MONGO_URL ? describe : describe.skip

let connection: Connection | undefined

async function connect(): Promise<Connection> {
  connection ??= await createConnection(MONGO_URL as string).asPromise()
  return connection
}

/** A clean database for each test, so nothing depends on the order things ran in. */
async function freshStore() {
  const active = await connect()
  const models = authModels(active)
  await Promise.all([
    models.users.deleteMany({}),
    models.refreshTokens.deleteMany({}),
    models.resetTokens.deleteMany({}),
  ])
  return mongooseStore(active)
}

if (MONGO_URL) {
  afterAll(async () => {
    await connection?.close()
  })

  // The same suite `auth-basic` runs against Drizzle. One contract, two implementations.
  describeAuthStore('mongoose over mongodb', freshStore)
}

integration('the brick end to end', () => {
  const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
  })

  const CREDENTIALS = { name: 'Ada', email: 'ada@example.com', password: 'correct-horse' }

  async function withAuth() {
    const active = await connect()
    const models = authModels(active)
    await Promise.all([
      models.users.deleteMany({}),
      models.refreshTokens.deleteMany({}),
      models.resetTokens.deleteMany({}),
    ])

    const app = createApp({ logger: silentLogger, development: true }).use(
      auth(mongoAuth({ connection: active, secret: 'mongo-test-secret' })),
    )
    opened.push(app)
    await app.ready()
    return app
  }

  function post(app: { fetch(request: Request): Promise<Response> }, path: string, body: unknown) {
    return app.fetch(
      new Request(`https://theoven.app${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  test('signup issues an access token and a refresh cookie', async () => {
    const app = await withAuth()
    const response = await post(app, '/auth/signup', CREDENTIALS)

    expect(response.status).toBe(201)
    const body = (await response.json()) as { accessToken: string; user: { email: string } }
    expect(body.accessToken).toBeTruthy()
    expect(body.user.email).toBe(CREDENTIALS.email)
    expect(response.headers.get('set-cookie')).toContain('oven_refresh=')
  })

  test('the password hash never leaves the storage layer', async () => {
    const app = await withAuth()
    const response = await post(app, '/auth/signup', CREDENTIALS)
    expect(await response.text()).not.toContain('passwordHash')
  })

  test('login works and a wrong password does not', async () => {
    const app = await withAuth()
    await post(app, '/auth/signup', CREDENTIALS)

    expect((await post(app, '/auth/login', CREDENTIALS)).status).toBe(200)
    expect(
      (await post(app, '/auth/login', { email: CREDENTIALS.email, password: 'wrong' })).status,
    ).toBe(401)
  })

  // The enumeration case: an unknown address must be indistinguishable from a wrong password.
  test('an unknown email is refused identically to a wrong password', async () => {
    const app = await withAuth()
    await post(app, '/auth/signup', CREDENTIALS)

    const wrong = await post(app, '/auth/login', { email: CREDENTIALS.email, password: 'nope' })
    const unknown = await post(app, '/auth/login', {
      email: 'nobody@example.com',
      password: 'nope',
    })

    expect(unknown.status).toBe(wrong.status)
    expect(await unknown.text()).toBe(await wrong.text())
  })

  test('/auth/me answers with the access token and refuses without it', async () => {
    const app = await withAuth()
    const signup = await post(app, '/auth/signup', CREDENTIALS)
    const { accessToken } = (await signup.json()) as { accessToken: string }

    const authorised = await app.fetch(
      new Request('https://theoven.app/auth/me', {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    )
    expect(((await authorised.json()) as { email: string }).email).toBe(CREDENTIALS.email)

    const anonymous = await app.fetch(new Request('https://theoven.app/auth/me'))
    expect(anonymous.status).toBe(401)
  })

  // The claim `auth-mongo` makes is that it is `auth-basic` with different storage.
  test('it mounts the same eight endpoints as auth-basic', async () => {
    const app = await withAuth()
    const mounted = app
      .routes()
      .filter((route) => route.pattern.startsWith('/auth'))
      .map((route) => `${route.method} ${route.pattern}`)
      .sort()

    expect(mounted).toEqual([
      'GET /auth/me',
      'POST /auth/change-password',
      'POST /auth/forgot-password',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /auth/refresh',
      'POST /auth/reset-password',
      'POST /auth/signup',
    ])
  })

  test('a duplicate signup is refused by the unique index', async () => {
    const app = await withAuth()
    await post(app, '/auth/signup', CREDENTIALS)

    const second = await post(app, '/auth/signup', CREDENTIALS)
    expect(second.status).toBeGreaterThanOrEqual(400)
  })
})

describe('provider shape', () => {
  // Worth checking without a server: these are wiring mistakes, not storage behaviour.
  test('it names itself so ctx.auth.name distinguishes it', () => {
    const provider = mongoAuth({ connection: {} as Connection, secret: 'x' })
    expect(provider.name).toBe('mongo')
  })

  test('a missing secret is refused at construction', () => {
    expect(() => mongoAuth({ connection: {} as Connection, secret: '' })).toThrow(/secret/)
  })

  test('it declares the same capabilities as auth-basic', () => {
    const provider = mongoAuth({ connection: {} as Connection, secret: 'x' })
    expect(provider.capabilities).toEqual({ routes: true, signOut: true, refresh: true })
  })
})

if (!MONGO_URL) {
  console.info('[auth-mongo] MONGO_URL not set — integration tests skipped.')
}
