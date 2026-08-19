import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { auth } from '@theoven/auth'
import { createApp, silentLogger } from '@theoven/core'
import { betterAuth, getAuthTables } from 'better-auth'
import { type BetterAuthInstance, betterAuthProvider } from './provider'

/**
 * Against a real better-auth instance on a real database.
 *
 * A double would only prove the double works, and the interesting behaviour here is the
 * forwarding — that better-auth's own endpoints, whatever they are, reach it intact through
 * Oven's router.
 */

const SECRET = 'a-secret-long-enough-to-be-plausible-in-a-test'

/**
 * The schema, generated from better-auth's own table metadata rather than hand-copied.
 *
 * A hand-written copy drifts the moment better-auth adds a column, and the failure is a 500 on
 * signup that looks like our bug. This asks it what it needs.
 */
function migrate(db: Database, options: Parameters<typeof getAuthTables>[0]): void {
  for (const table of Object.values(getAuthTables(options))) {
    const columns = ['id text primary key']
    for (const [name, field] of Object.entries(table.fields)) {
      const column = field.fieldName ?? name
      // SQLite is dynamically typed, so affinity is all that is being expressed here.
      const affinity = field.type === 'boolean' || field.type === 'number' ? 'integer' : 'text'
      columns.push(`"${column}" ${affinity}${field.required ? ' not null' : ''}`)
    }
    db.exec(`create table "${table.modelName}" (${columns.join(', ')})`)
  }
}

function makeInstance(basePath = '/auth') {
  const options = {
    baseURL: 'https://theoven.app',
    basePath,
    secret: SECRET,
    emailAndPassword: { enabled: true },
  }
  const db = new Database(':memory:')
  migrate(db, options)
  return betterAuth({ ...options, database: db }) as unknown as BetterAuthInstance
}

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 0 })))
})

async function withBetterAuth(basePath = '/auth') {
  const app = createApp({ logger: silentLogger, development: true }).use(
    auth(betterAuthProvider({ instance: makeInstance(basePath) })),
  )
  opened.push(app)
  app.get('/me', { auth: true }, (ctx) => ({ id: ctx.user.id, email: ctx.user.email }))
  app.get('/public', (ctx) => ({ signedIn: ctx.user !== null }))
  await app.ready()
  return app
}

function signUp(app: { fetch(request: Request): Promise<Response> }) {
  return app.fetch(
    new Request('https://theoven.app/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', password: 'correct-horse', name: 'Ada' }),
    }),
  )
}

/** The session cookie, in the form a browser would send it back. */
function sessionCookie(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

describe('mounted routes', () => {
  test("better-auth's own endpoints work through Oven", async () => {
    const app = await withBetterAuth()
    const response = await signUp(app)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { user: { email: string } }
    expect(body.user.email).toBe('ada@example.com')
    expect(response.headers.get('set-cookie')).toBeTruthy()
  })

  test('sign-in works and a wrong password does not', async () => {
    const app = await withBetterAuth()
    await signUp(app)

    const signIn = (password: string) =>
      app.fetch(
        new Request('https://theoven.app/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'ada@example.com', password }),
        }),
      )

    expect((await signIn('correct-horse')).status).toBe(200)
    expect((await signIn('wrong')).status).toBeGreaterThanOrEqual(400)
  })

  /**
   * A wildcard rather than an enumerated list, because better-auth's endpoint set depends on
   * which plugins are enabled. This checks a path we never named reaches it.
   */
  test('an endpoint the brick never enumerated still reaches better-auth', async () => {
    const app = await withBetterAuth()
    const response = await app.fetch(new Request('https://theoven.app/auth/get-session'))

    // Whatever it answers, it is better-auth answering rather than Oven's 404.
    expect(response.status).toBe(200)
  })

  /**
   * A wildcard child does not match the prefix itself, so it is registered separately.
   * Asserted on the route table rather than on a response: better-auth answers `404` for its
   * bare base path too, which is indistinguishable from Oven never routing it.
   */
  test('the prefix itself is registered, not only paths beneath it', async () => {
    const app = await withBetterAuth()
    const patterns = new Set(app.routes().map((route) => route.pattern))

    expect(patterns.has('/auth')).toBe(true)
    expect(patterns.has('/auth/*')).toBe(true)
  })

  test('routes outside the prefix are unaffected', async () => {
    const app = await withBetterAuth()
    expect((await app.fetch(new Request('https://theoven.app/public'))).status).toBe(200)
  })
})

describe('identifying a request', () => {
  test('a session cookie identifies the request', async () => {
    const app = await withBetterAuth()
    const cookie = sessionCookie(await signUp(app))

    const response = await app.fetch(new Request('https://theoven.app/me', { headers: { cookie } }))
    expect(await response.json()).toEqual({
      id: expect.any(String),
      email: 'ada@example.com',
    })
  })

  test('a guarded route refuses an anonymous request', async () => {
    const app = await withBetterAuth()
    expect((await app.fetch(new Request('https://theoven.app/me'))).status).toBe(401)
  })

  // A stale cookie must not turn public pages into 401s.
  test('a bad cookie leaves public routes working, anonymously', async () => {
    const app = await withBetterAuth()
    const response = await app.fetch(
      new Request('https://theoven.app/public', {
        headers: { cookie: 'better-auth.session_token=garbage' },
      }),
    )
    expect(await response.json()).toEqual({ signedIn: false })
  })
})

describe('the contract', () => {
  test('it declares that it mounts routes', () => {
    const provider = betterAuthProvider({ instance: makeInstance() })
    expect(provider.capabilities?.routes).toBe(true)
    expect(provider.mount).toBeDefined()
  })

  /**
   * The check that saves an afternoon. better-auth defaults to `/api/auth` and Oven mounts at
   * `/auth`; a mismatch is a 404 from *inside* better-auth on every request, which looks exactly
   * like a routing bug in Oven and is not one.
   */
  test('a basePath mismatch fails at boot, naming both paths', async () => {
    const app = createApp({ logger: silentLogger }).use(
      auth(betterAuthProvider({ instance: makeInstance('/api/auth') })),
    )
    opened.push(app)

    expect(app.ready()).rejects.toThrow(/basePath "\/api\/auth".*mounts it at "\/auth"/s)
  })

  test('matching paths boot fine, trailing slashes included', async () => {
    const app = createApp({ logger: silentLogger }).use(
      auth(betterAuthProvider({ instance: makeInstance('/auth/') })),
    )
    opened.push(app)
    await app.ready()
    expect(app.routes().some((route) => route.pattern.startsWith('/auth'))).toBe(true)
  })

  test('the check can be waived deliberately', async () => {
    const app = createApp({ logger: silentLogger }).use(
      auth(betterAuthProvider({ instance: makeInstance('/api/auth'), skipBasePathCheck: true })),
    )
    opened.push(app)
    await app.ready()
  })

  test('a non-instance is refused at construction', () => {
    expect(() => betterAuthProvider({ instance: {} as BetterAuthInstance })).toThrow(
      /better-auth instance/,
    )
  })

  // The capability is declared from what the instance actually has, not assumed.
  test('signOut is declared only when the instance offers it', () => {
    const instance = makeInstance()
    expect(betterAuthProvider({ instance }).capabilities?.signOut).toBe(true)

    const withoutSignOut = {
      ...instance,
      api: { getSession: instance.api.getSession },
    } as BetterAuthInstance
    expect(betterAuthProvider({ instance: withoutSignOut }).capabilities?.signOut).toBe(false)
  })
})
