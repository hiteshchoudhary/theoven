import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { auth } from '@theoven/auth'
import { describeAuthStore } from '@theoven/auth/testing'
import { createApp, silentLogger } from '@theoven/core'
import { db as database } from '@theoven/db'
import { drizzleSqlite } from '@theoven/db-drizzle'
import { sql as sqlRaw } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { basicAuth } from './provider'
import { authSchema } from './schema'
import { drizzleStore } from './store'

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

/** The migration `oven db generate` would produce for this brick's tables. */
const MIGRATION = `
create table auth_users (
  id text primary key,
  email text not null,
  name text not null,
  password_hash text not null,
  email_verified_at integer,
  created_at integer not null
);
create unique index auth_users_email_idx on auth_users (email);

create table auth_refresh_tokens (
  id text primary key,
  user_id text not null references auth_users(id) on delete cascade,
  token_hash text not null,
  expires_at integer not null,
  created_at integer not null
);
create unique index auth_refresh_token_hash_idx on auth_refresh_tokens (token_hash);
create index auth_refresh_user_idx on auth_refresh_tokens (user_id);

create table auth_reset_tokens (
  id text primary key,
  user_id text not null references auth_users(id) on delete cascade,
  token_hash text not null,
  expires_at integer not null,
  used_at integer
);
create unique index auth_reset_token_hash_idx on auth_reset_tokens (token_hash);
`

interface Harness {
  app: { fetch(request: Request): Promise<Response> }
  sent: Array<{ to: string; token: string }>
}

async function harness(options: { withMail?: boolean } = {}): Promise<Harness> {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec(MIGRATION)
  const client = drizzle(sqlite, { schema: authSchema })

  const sent: Array<{ to: string; token: string }> = []

  const provider = basicAuth({
    db: client,
    secret: 'a-test-signing-secret',
    ...(options.withMail === false
      ? {}
      : {
          sendResetEmail: async (to, token) => {
            sent.push({ to, token })
          },
        }),
  })

  const app = createApp({ logger: silentLogger, development: true }).use(auth(provider))
  opened.push(app)

  app.get('/private', { auth: true }, (ctx) => ({ id: ctx.user?.id }))
  app.get('/public', (ctx) => ({ user: ctx.user?.id ?? null }))
  await app.ready()

  return { app, sent }
}

function post(
  app: Harness['app'],
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`https://theoven.app${path}`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json', ...headers },
          }),
      ...(body === undefined ? { headers } : {}),
    }),
  )
}

function get(app: Harness['app'], path: string, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`https://theoven.app${path}`, { headers }))
}

/** The refresh cookie as a `Cookie` header value. */
function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

const CREDENTIALS = { email: 'ada@example.com', password: 'correct-horse', name: 'Ada' }

async function signedIn(app: Harness['app']) {
  const response = await post(app, '/auth/signup', CREDENTIALS)
  const body = (await response.json()) as { accessToken: string; user: { id: string } }
  return { ...body, cookie: cookieFrom(response) }
}

describe('signup', () => {
  test('creates an account and returns an access token', async () => {
    const { app } = await harness()
    const response = await post(app, '/auth/signup', CREDENTIALS)

    expect(response.status).toBe(201)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.accessToken).toBeTruthy()
    expect(body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada' })
  })

  // The refresh token must be unreadable from script; the access token is what clients hold.
  test('puts the refresh token in an httpOnly cookie, not the body', async () => {
    const { app } = await harness()
    const response = await post(app, '/auth/signup', CREDENTIALS)

    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('oven_refresh=')
    expect(cookie).toContain('HttpOnly')
    expect(JSON.stringify(await response.json())).not.toContain('oven_refresh')
  })

  test('never returns the password hash', async () => {
    const { app } = await harness()
    const body = await (await post(app, '/auth/signup', CREDENTIALS)).text()

    expect(body).not.toContain('argon2')
    expect(body).not.toContain('passwordHash')
    expect(body).not.toContain('correct-horse')
  })

  test('rejects a duplicate email', async () => {
    const { app } = await harness()
    await post(app, '/auth/signup', CREDENTIALS)
    expect((await post(app, '/auth/signup', CREDENTIALS)).status).toBe(409)
  })

  test('rejects a short password', async () => {
    const { app } = await harness()
    const response = await post(app, '/auth/signup', { ...CREDENTIALS, password: 'short' })
    expect(response.status).toBe(400)
  })

  test('rejects a missing field', async () => {
    const { app } = await harness()
    expect((await post(app, '/auth/signup', { email: 'a@b.co' })).status).toBe(400)
  })
})

describe('login', () => {
  test('succeeds and issues a token', async () => {
    const { app } = await harness()
    await post(app, '/auth/signup', CREDENTIALS)

    const response = await post(app, '/auth/login', {
      email: CREDENTIALS.email,
      password: CREDENTIALS.password,
    })
    expect(response.status).toBe(200)
    expect((await response.json()) as Record<string, unknown>).toHaveProperty('accessToken')
  })

  test('rejects a wrong password with 401', async () => {
    const { app } = await harness()
    await post(app, '/auth/signup', CREDENTIALS)
    const response = await post(app, '/auth/login', {
      email: CREDENTIALS.email,
      password: 'wrong',
    })
    expect(response.status).toBe(401)
  })

  // The endpoint must not reveal which addresses have accounts.
  test('an unknown email answers identically to a wrong password', async () => {
    const { app } = await harness()
    await post(app, '/auth/signup', CREDENTIALS)

    const wrong = await post(app, '/auth/login', { email: CREDENTIALS.email, password: 'nope' })
    const unknown = await post(app, '/auth/login', { email: 'nobody@x.co', password: 'nope' })

    expect(unknown.status).toBe(wrong.status)
    expect(await unknown.text()).toBe(await wrong.text())
  })
})

describe('identifying a request', () => {
  test('a valid access token identifies the user', async () => {
    const { app } = await harness()
    const { accessToken, user } = await signedIn(app)

    const response = await get(app, '/private', { authorization: `Bearer ${accessToken}` })
    expect(await response.json()).toEqual({ id: user.id })
  })

  test('a guarded route rejects an anonymous request', async () => {
    const { app } = await harness()
    expect((await get(app, '/private')).status).toBe(401)
  })

  test('a forged token does not identify anyone', async () => {
    const { app } = await harness()
    await signedIn(app)

    const response = await get(app, '/private', { authorization: 'Bearer not.a.token' })
    expect(response.status).toBe(401)
  })

  // A token signed with a different secret is exactly what an attacker would present.
  test('a token signed with another secret is rejected', async () => {
    const { app } = await harness()
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'u1', exp: 9e9 })).toString('base64url'),
      'forged-signature',
    ].join('.')

    expect((await get(app, '/private', { authorization: `Bearer ${forged}` })).status).toBe(401)
  })

  test('public routes still work while signed out', async () => {
    const { app } = await harness()
    expect(await (await get(app, '/public')).json()).toEqual({ user: null })
  })

  test('/auth/me returns the current user', async () => {
    const { app } = await harness()
    const { accessToken, user } = await signedIn(app)

    const response = await get(app, '/auth/me', { authorization: `Bearer ${accessToken}` })
    expect(await response.json()).toMatchObject({ id: user.id, email: 'ada@example.com' })
  })
})

describe('refresh', () => {
  test('issues a new access token from the cookie', async () => {
    const { app } = await harness()
    const { cookie } = await signedIn(app)

    const response = await post(app, '/auth/refresh', undefined, { cookie })
    expect(response.status).toBe(200)
    expect((await response.json()) as Record<string, unknown>).toHaveProperty('accessToken')
  })

  test('rotates the refresh token', async () => {
    const { app } = await harness()
    const { cookie } = await signedIn(app)

    const response = await post(app, '/auth/refresh', undefined, { cookie })
    expect(cookieFrom(response)).not.toBe(cookie)
  })

  // A refresh token that survives its own use is one a thief keeps using.
  test('the old cookie stops working after rotation', async () => {
    const { app } = await harness()
    const { cookie } = await signedIn(app)

    await post(app, '/auth/refresh', undefined, { cookie })
    expect((await post(app, '/auth/refresh', undefined, { cookie })).status).toBe(401)
  })

  test('rejects a request with no cookie', async () => {
    const { app } = await harness()
    expect((await post(app, '/auth/refresh')).status).toBe(401)
  })
})

describe('logout', () => {
  test('revokes the session', async () => {
    const { app } = await harness()
    const { cookie } = await signedIn(app)

    expect((await post(app, '/auth/logout', undefined, { cookie })).status).toBe(204)
    expect((await post(app, '/auth/refresh', undefined, { cookie })).status).toBe(401)
  })

  test('clears the cookie', async () => {
    const { app } = await harness()
    const { cookie } = await signedIn(app)

    const response = await post(app, '/auth/logout', undefined, { cookie })
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  test('logging out twice is not an error', async () => {
    const { app } = await harness()
    const { cookie } = await signedIn(app)

    await post(app, '/auth/logout', undefined, { cookie })
    expect((await post(app, '/auth/logout', undefined, { cookie })).status).toBe(204)
  })
})

describe('change password', () => {
  test('changes it and signs other sessions out', async () => {
    const { app } = await harness()
    const { accessToken, cookie } = await signedIn(app)

    const response = await post(
      app,
      '/auth/change-password',
      { current: CREDENTIALS.password, next: 'a-brand-new-password' },
      { authorization: `Bearer ${accessToken}` },
    )
    expect(response.status).toBe(200)

    // The old session is gone.
    expect((await post(app, '/auth/refresh', undefined, { cookie })).status).toBe(401)
    // The new password works.
    const login = await post(app, '/auth/login', {
      email: CREDENTIALS.email,
      password: 'a-brand-new-password',
    })
    expect(login.status).toBe(200)
  })

  test('rejects a wrong current password', async () => {
    const { app } = await harness()
    const { accessToken } = await signedIn(app)

    const response = await post(
      app,
      '/auth/change-password',
      { current: 'wrong', next: 'a-brand-new-password' },
      { authorization: `Bearer ${accessToken}` },
    )
    expect(response.status).toBe(401)
  })

  test('requires authentication', async () => {
    const { app } = await harness()
    const response = await post(app, '/auth/change-password', {
      current: 'x',
      next: 'a-brand-new-password',
    })
    expect(response.status).toBe(401)
  })
})

describe('password reset', () => {
  test('sends a token and completes the reset', async () => {
    const { app, sent } = await harness()
    await post(app, '/auth/signup', CREDENTIALS)

    await post(app, '/auth/forgot-password', { email: CREDENTIALS.email })
    expect(sent).toHaveLength(1)

    const response = await post(app, '/auth/reset-password', {
      token: sent[0]?.token,
      password: 'a-brand-new-password',
    })
    expect(response.status).toBe(200)

    const login = await post(app, '/auth/login', {
      email: CREDENTIALS.email,
      password: 'a-brand-new-password',
    })
    expect(login.status).toBe(200)
  })

  // Reporting "no such account" would make this an enumeration endpoint.
  test('an unknown email gets the same answer as a known one', async () => {
    const { app, sent } = await harness()
    await post(app, '/auth/signup', CREDENTIALS)

    const known = await post(app, '/auth/forgot-password', { email: CREDENTIALS.email })
    const unknown = await post(app, '/auth/forgot-password', { email: 'nobody@example.com' })

    expect(unknown.status).toBe(known.status)
    expect(await unknown.text()).toBe(await known.text())
    expect(sent).toHaveLength(1)
  })

  test('a reset token cannot be used twice', async () => {
    const { app, sent } = await harness()
    await post(app, '/auth/signup', CREDENTIALS)
    await post(app, '/auth/forgot-password', { email: CREDENTIALS.email })

    const token = sent[0]?.token
    await post(app, '/auth/reset-password', { token, password: 'first-new-password' })

    const second = await post(app, '/auth/reset-password', {
      token,
      password: 'second-new-password',
    })
    expect(second.status).toBe(401)
  })

  test('a forged reset token is rejected', async () => {
    const { app } = await harness()
    await post(app, '/auth/signup', CREDENTIALS)

    const response = await post(app, '/auth/reset-password', {
      token: 'made-up-token',
      password: 'a-brand-new-password',
    })
    expect(response.status).toBe(401)
  })

  test('resetting signs every session out', async () => {
    const { app, sent } = await harness()
    const { cookie } = await signedIn(app)

    await post(app, '/auth/forgot-password', { email: CREDENTIALS.email })
    await post(app, '/auth/reset-password', {
      token: sent[0]?.token,
      password: 'a-brand-new-password',
    })

    expect((await post(app, '/auth/refresh', undefined, { cookie })).status).toBe(401)
  })
})

/**
 * These are the endpoints that actually get attacked, so the limits are on by default. Keyed by
 * both IP and email: by IP alone a distributed attempt on one account walks through, and by
 * email alone one host can spray the whole user table.
 */
describe('rate limiting', () => {
  async function limited(overrides = {}) {
    const sqlite = new Database(':memory:')
    sqlite.exec(MIGRATION)
    const client = drizzle(sqlite, { schema: authSchema })

    const app = createApp({ logger: silentLogger, development: true }).use(
      auth(
        basicAuth({
          db: client,
          secret: 'rate-limit-secret',
          rateLimit: { login: 3, signup: 2, forgotPassword: 2, window: 60_000, ...overrides },
        }),
      ),
    )
    opened.push(app)
    await app.ready()
    return app
  }

  test('login is throttled after repeated failures', async () => {
    const app = await limited()
    await post(app, '/auth/signup', CREDENTIALS)

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await post(app, '/auth/login', {
        email: CREDENTIALS.email,
        password: 'wrong',
      })
      expect(response.status).toBe(401)
    }

    const blocked = await post(app, '/auth/login', {
      email: CREDENTIALS.email,
      password: 'wrong',
    })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBeTruthy()
  })

  // Otherwise one host walks through the user table one account at a time.
  test('the limit follows the email, not only the caller', async () => {
    const app = await limited()
    await post(app, '/auth/signup', CREDENTIALS)

    for (let attempt = 0; attempt < 4; attempt++) {
      await post(app, '/auth/login', { email: CREDENTIALS.email, password: 'wrong' })
    }

    // Even the correct password is refused while the window is open.
    const correct = await post(app, '/auth/login', {
      email: CREDENTIALS.email,
      password: CREDENTIALS.password,
    })
    expect(correct.status).toBe(429)
  })

  test('signup is throttled', async () => {
    const app = await limited()
    await post(app, '/auth/signup', { ...CREDENTIALS, email: 'one@example.com' })
    await post(app, '/auth/signup', { ...CREDENTIALS, email: 'two@example.com' })

    const third = await post(app, '/auth/signup', { ...CREDENTIALS, email: 'three@example.com' })
    expect(third.status).toBe(429)
  })

  test('password-reset requests are throttled', async () => {
    const app = await limited()
    await post(app, '/auth/signup', CREDENTIALS)

    await post(app, '/auth/forgot-password', { email: CREDENTIALS.email })
    await post(app, '/auth/forgot-password', { email: CREDENTIALS.email })

    const third = await post(app, '/auth/forgot-password', { email: CREDENTIALS.email })
    expect(third.status).toBe(429)
  })

  test('a generous limit does not interfere with normal use', async () => {
    const app = await limited({ login: 50 })
    await post(app, '/auth/signup', CREDENTIALS)

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await post(app, '/auth/login', {
        email: CREDENTIALS.email,
        password: CREDENTIALS.password,
      })
      expect(response.status).toBe(200)
    }
  })

  test('it can be turned off', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(MIGRATION)
    const client = drizzle(sqlite, { schema: authSchema })

    const app = createApp({ logger: silentLogger, development: true }).use(
      auth(basicAuth({ db: client, secret: 'no-limit', rateLimit: false })),
    )
    opened.push(app)
    await app.ready()
    await post(app, '/auth/signup', CREDENTIALS)

    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await post(app, '/auth/login', {
        email: CREDENTIALS.email,
        password: 'wrong',
      })
      expect(response.status).toBe(401)
    }
  })
})

describe('storage', () => {
  test('tokens are stored hashed, never in the clear', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(MIGRATION)
    const client = drizzle(sqlite, { schema: authSchema })

    const app = createApp({ logger: silentLogger }).use(
      auth(basicAuth({ db: client, secret: 'test-secret' })),
    )
    opened.push(app)
    await app.ready()

    const response = await post(app, '/auth/signup', CREDENTIALS)
    const cookie = cookieFrom(response)
    const token = cookie.split('=')[1] ?? ''

    const rows = sqlite.query('select token_hash from auth_refresh_tokens').all() as Array<{
      token_hash: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.token_hash).not.toBe(decodeURIComponent(token))
  })

  test('the password is stored as an argon2id hash', async () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(MIGRATION)
    const client = drizzle(sqlite, { schema: authSchema })

    const app = createApp({ logger: silentLogger }).use(
      auth(basicAuth({ db: client, secret: 'test-secret' })),
    )
    opened.push(app)
    await app.ready()
    await post(app, '/auth/signup', CREDENTIALS)

    const [row] = sqlite.query('select password_hash from auth_users').all() as Array<{
      password_hash: string
    }>
    expect(row?.password_hash).toContain('$argon2id$')
    expect(row?.password_hash).not.toContain('correct-horse')
  })
})

describe('configuration', () => {
  // A framework that invents a signing secret has invented one every deployment shares.
  test('refuses to start without a secret', () => {
    const sqlite = new Database(':memory:')
    const client = drizzle(sqlite)
    expect(() => basicAuth({ db: client, secret: '' })).toThrow(/needs a secret/)
  })

  test('declares its capabilities', () => {
    const sqlite = new Database(':memory:')
    const provider = basicAuth({ db: drizzle(sqlite), secret: 'x' })

    expect(provider.capabilities).toEqual({ routes: true, signOut: true, refresh: true })
  })

  test('contributes a bearer security scheme', () => {
    const sqlite = new Database(':memory:')
    const provider = basicAuth({ db: drizzle(sqlite), secret: 'x' })
    expect(provider.securitySchemes).toHaveProperty('bearerAuth')
  })
})

/**
 * The wiring a real application uses: the db brick connects, the auth brick identifies, and
 * `ctx.db` is the same client `auth-basic` writes through. The tests above build a Drizzle
 * client directly to keep each case small; this one proves the bricks compose.
 */
describe('with the db brick', () => {
  test('signup, login and a guarded route work end to end', async () => {
    const provider = drizzleSqlite({ url: ':memory:', schema: authSchema })
    const client = await provider.connect()

    // The migration a real project would have generated and committed.
    const app = createApp({ logger: silentLogger, development: true }).use(database(provider))
    opened.push(app)
    await app.ready()

    for (const statement of MIGRATION.split(';')) {
      // `sql.raw` because these are literal DDL statements, not a parameterised template.
      if (statement.trim()) client.run(sqlRaw.raw(statement))
    }

    const authed = createApp({ logger: silentLogger, development: true })
      .use(database(provider))
      .use(auth(basicAuth({ db: client, secret: 'integration-secret' })))
    opened.push(authed)

    authed.get('/whoami', { auth: true }, (ctx) => ({
      id: ctx.user?.id,
      // Both bricks are on the same context, each typed.
      hasDb: typeof ctx.db.select === 'function',
    }))
    await authed.ready()

    const signup = await post(authed, '/auth/signup', CREDENTIALS)
    expect(signup.status).toBe(201)

    const { accessToken } = (await signup.json()) as { accessToken: string }
    const me = await get(authed, '/whoami', { authorization: `Bearer ${accessToken}` })

    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ hasDb: true })
  })
})

/**
 * The shared `AuthStore` conformance suite, from `@theoven/auth/testing`.
 *
 * The same suite runs in `auth-mongo`. That is the point: the contract is checked once and both
 * implementations answer to it, rather than each brick testing itself against its own idea of
 * what the contract says.
 */
describeAuthStore('drizzle over bun:sqlite', () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(MIGRATION)
  return drizzleStore(drizzle(sqlite, { schema: authSchema }))
})
