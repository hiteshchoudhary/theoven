import { afterEach, describe, expect, test } from 'bun:test'
import { type App, createApp, silentLogger } from '@theoven/core'
import { auth } from '../brick'
import { UNUSABLE_PASSWORD, verifyPassword } from '../crypto'
import { passwordAuthProvider } from '../password-provider'
import type { AuthStore, StoredAccount, StoredUser } from '../store'
import { github } from './github'
import { google } from './google'

/**
 * These tests never reach Google or GitHub. The provider endpoints are injected, because what is
 * worth testing is our half — the state check, the linking rule, what gets stored — and a test
 * that needs someone else's OAuth app is a test nobody runs.
 */

const SECRET = 'a-secret-long-enough-to-be-plausible-in-a-test'
const opened: App[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

/** An in-memory store with the account methods. */
function memoryStore(): AuthStore & { users: StoredUser[]; accounts: StoredAccount[] } {
  const users: StoredUser[] = []
  const accounts: StoredAccount[] = []

  return {
    users,
    accounts,
    findUserByEmail: async (email) => users.find((u) => u.email === email.toLowerCase()) ?? null,
    findUserById: async (id) => users.find((u) => u.id === id) ?? null,
    createUser: async (user) => {
      const row: StoredUser = {
        ...user,
        emailVerifiedAt: user.emailVerifiedAt ?? null,
        createdAt: new Date(),
      }
      users.push(row)
      return row
    },
    updateUserPassword: async (userId, passwordHash) => {
      const user = users.find((u) => u.id === userId)
      if (user) Object.assign(user, { passwordHash })
    },
    createRefreshToken: async () => {},
    findRefreshToken: async () => null,
    deleteRefreshTokens: async () => {},
    createResetToken: async () => {},
    findResetToken: async () => null,
    markResetTokenUsed: async () => {},

    findAccount: async (provider, providerAccountId) =>
      accounts.find((a) => a.provider === provider && a.providerAccountId === providerAccountId) ??
      null,
    linkAccount: async (account) => {
      if (
        accounts.some(
          (a) =>
            a.provider === account.provider && a.providerAccountId === account.providerAccountId,
        )
      ) {
        throw new Error('already linked')
      }
      const row: StoredAccount = { ...account, createdAt: new Date() }
      accounts.push(row)
      return row
    },
    findAccountsByUser: async (userId) => accounts.filter((a) => a.userId === userId),
    unlinkAccount: async (userId, provider) => {
      const at = accounts.findIndex((a) => a.userId === userId && a.provider === provider)
      if (at !== -1) accounts.splice(at, 1)
    },
  }
}

/** A fake Google: the token endpoint returns an id_token carrying whatever claims a test wants. */
function fakeGoogle(claims: Record<string, unknown>): typeof fetch {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return (async (url: string | URL) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'at', id_token: `header.${payload}.sig` })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as unknown as typeof fetch
}

function makeApp(store: AuthStore, fetcher: typeof fetch, options: Record<string, unknown> = {}) {
  const app = createApp({ logger: silentLogger, development: true, cookies: { secret: SECRET } })
  opened.push(app)
  app.use(
    auth(
      passwordAuthProvider({
        store,
        name: 'basic',
        secret: SECRET,
        callbackUrl: (name: string) => `https://app.test/auth/oauth/${name}/callback`,
        oauth: { google: { provider: google, clientId: 'id', clientSecret: 'secret' } },
        fetcher,
        ...options,
      } as never),
    ),
  )
  return app
}

const send = (app: App, path: string, init?: RequestInit) =>
  app.fetch(new Request(`https://app.test${path}`, init))

/** Runs the redirect, then the callback with the state the redirect set. */
async function signIn(app: App, extra = '') {
  const started = await send(app, '/auth/oauth/google')
  const location = new URL(started.headers.get('location') ?? '')
  const state = location.searchParams.get('state')
  const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0]

  return send(app, `/auth/oauth/google/callback?code=abc&state=${state}${extra}`, {
    headers: { cookie: cookie ?? '' },
  })
}

describe('starting a sign-in', () => {
  test('redirects to the provider with PKCE and state', async () => {
    const response = await send(makeApp(memoryStore(), fakeGoogle({})), '/auth/oauth/google')
    const url = new URL(response.headers.get('location') ?? '')

    expect(response.status).toBe(302)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/auth/oauth/google/callback')
  })

  test('the handshake cookie is httpOnly and not readable as plain state', async () => {
    const response = await send(makeApp(memoryStore(), fakeGoogle({})), '/auth/oauth/google')
    const cookie = response.headers.get('set-cookie') ?? ''

    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('oven_oauth')
  })
})

describe('the state check', () => {
  const claims = { sub: 'g1', email: 'ada@example.com', email_verified: true, name: 'Ada' }

  test('a callback with no cookie is refused', async () => {
    const app = makeApp(memoryStore(), fakeGoogle(claims))
    const response = await send(app, '/auth/oauth/google/callback?code=abc&state=anything')

    expect(response.status).toBe(400)
  })

  test('a mismatched state is refused', async () => {
    const app = makeApp(memoryStore(), fakeGoogle(claims))
    const started = await send(app, '/auth/oauth/google')
    const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0]

    const response = await send(app, '/auth/oauth/google/callback?code=abc&state=forged', {
      headers: { cookie: cookie ?? '' },
    })

    expect(response.status).toBe(400)
  })

  /**
   * The handshake is cleared on the callback, whatever happens next — so a browser that follows
   * the response has nothing left to replay with, and a second callback is refused.
   *
   * Note what this does *not* claim: a client that deliberately keeps the cookie can send it
   * again. What stops that is the provider refusing a reused authorization code, which is real
   * but is Google's guarantee rather than ours. Making it ours would mean storing state
   * server-side — a table that is empty in steady state and a cleanup job nobody runs.
   */
  test('the handshake is cleared on the callback, so a browser cannot replay it', async () => {
    const app = makeApp(memoryStore(), fakeGoogle(claims))
    const started = await send(app, '/auth/oauth/google')
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state')
    const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0]
    const url = `/auth/oauth/google/callback?code=abc&state=${state}`

    const first = await send(app, url, { headers: { cookie: cookie ?? '' } })
    expect(first.status).toBe(200)

    // The callback clears it, which is what a real browser would act on.
    expect(first.headers.get('set-cookie') ?? '').toContain('oven_oauth=;')

    // And without the cookie, the same state is worthless.
    expect((await send(app, url)).status).toBe(400)
  })

  test('a provider error is surfaced rather than swallowed', async () => {
    const app = makeApp(memoryStore(), fakeGoogle(claims))
    const response = await send(app, '/auth/oauth/google/callback?error=access_denied')

    expect(response.status).toBe(401)
    expect(await response.text()).toContain('access_denied')
  })
})

describe('creating a user', () => {
  test('a first sign-in creates the user and links the account', async () => {
    const store = memoryStore()
    const app = makeApp(
      store,
      fakeGoogle({ sub: 'g1', email: 'Ada@Example.com', email_verified: true, name: 'Ada' }),
    )

    const body = (await (await signIn(app)).json()) as { created: boolean; accessToken: string }

    expect(body.created).toBe(true)
    expect(body.accessToken).toBeTruthy()
    expect(store.users).toHaveLength(1)
    expect(store.users[0]?.email).toBe('ada@example.com')
    expect(store.accounts[0]).toMatchObject({ provider: 'google', providerAccountId: 'g1' })
  })

  /** The whole reason `password_hash` did not have to become nullable. */
  test('the created user has an unusable password that nothing can verify', async () => {
    const store = memoryStore()
    const app = makeApp(
      store,
      fakeGoogle({ sub: 'g1', email: 'ada@example.com', email_verified: true, name: 'Ada' }),
    )
    await signIn(app)

    const hash = store.users[0]?.passwordHash ?? ''
    expect(hash).toBe(UNUSABLE_PASSWORD)
    expect(await verifyPassword('', hash)).toBe(false)
    expect(await verifyPassword(UNUSABLE_PASSWORD, hash)).toBe(false)
    expect(await verifyPassword('password', hash)).toBe(false)
  })

  test('a returning user is found by account, not recreated', async () => {
    const store = memoryStore()
    const app = makeApp(
      store,
      fakeGoogle({ sub: 'g1', email: 'ada@example.com', email_verified: true, name: 'Ada' }),
    )

    await signIn(app)
    const second = (await (await signIn(app)).json()) as { created: boolean }

    expect(second.created).toBe(false)
    expect(store.users).toHaveLength(1)
    expect(store.accounts).toHaveLength(1)
  })

  /** Keyed on the provider's subject id, so a renamed account is still the same person. */
  test('a returning user whose email changed is still the same user', async () => {
    const store = memoryStore()
    await signIn(
      makeApp(
        store,
        fakeGoogle({ sub: 'g1', email: 'ada@example.com', email_verified: true, name: 'Ada' }),
      ),
    )
    const again = makeApp(
      store,
      fakeGoogle({ sub: 'g1', email: 'ada@newjob.com', email_verified: true, name: 'Ada' }),
    )

    const body = (await (await signIn(again)).json()) as { created: boolean; user: { id: string } }

    expect(body.created).toBe(false)
    expect(store.users).toHaveLength(1)
    expect(body.user.id).toBe(store.users[0]?.id ?? '')
  })
})

/** D33 — the security-critical rule. */
describe('linking to an existing account', () => {
  async function withPasswordUser() {
    const store = memoryStore()
    await store.createUser({
      id: 'u1',
      email: 'ada@example.com',
      name: 'Ada',
      passwordHash: 'not-a-real-hash',
    })
    return store
  }

  test('a verified email links to the existing user rather than making a second one', async () => {
    const store = await withPasswordUser()
    const app = makeApp(
      store,
      fakeGoogle({ sub: 'g1', email: 'ada@example.com', email_verified: true, name: 'Ada' }),
    )

    const body = (await (await signIn(app)).json()) as { created: boolean; user: { id: string } }

    expect(body.created).toBe(false)
    expect(body.user.id).toBe('u1')
    expect(store.users).toHaveLength(1)
    expect(store.accounts[0]?.userId).toBe('u1')
  })

  /**
   * The attack this rule exists for: a provider that lets someone claim an address they do not
   * own would otherwise hand them an existing account.
   */
  test('an unverified email is refused, not linked', async () => {
    const store = await withPasswordUser()
    const app = makeApp(
      store,
      fakeGoogle({ sub: 'g1', email: 'ada@example.com', email_verified: false, name: 'Ada' }),
    )

    const response = await signIn(app)

    expect(response.status).toBe(409)
    expect(store.accounts).toHaveLength(0)
    expect(store.users).toHaveLength(1)
  })

  test('the refusal says what to do instead', async () => {
    const store = await withPasswordUser()
    const app = makeApp(
      store,
      fakeGoogle({ sub: 'g1', email: 'ada@example.com', email_verified: false, name: 'Ada' }),
    )

    expect(await (await signIn(app)).text()).toContain('link the account')
  })
})

/** D34 — an account with no email can never be linked or recovered. */
describe('a provider that returns no email', () => {
  test('Google without an email claim fails the sign-in', async () => {
    const app = makeApp(memoryStore(), fakeGoogle({ sub: 'g1', email_verified: true, name: 'Ada' }))

    expect((await signIn(app)).status).toBe(500)
  })

  test('GitHub asks for the primary address when the profile has none', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string | URL) => {
      calls.push(String(url))
      if (String(url).includes('login/oauth/access_token'))
        return Response.json({ access_token: 'at' })
      if (String(url).endsWith('/user')) return Response.json({ id: 7, login: 'ada', email: null })
      if (String(url).endsWith('/user/emails')) {
        return Response.json([{ email: 'ada@example.com', primary: true, verified: true }])
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const profile = await github.profile({ accessToken: 'at' }, fetcher)

    expect(profile).toMatchObject({ accountId: '7', email: 'ada@example.com', emailVerified: true })
    expect(calls.some((url) => url.endsWith('/user/emails'))).toBe(true)
  })

  test('GitHub without the user:email scope fails with a message naming it', async () => {
    const fetcher = (async (url: string | URL) => {
      if (String(url).endsWith('/user')) return Response.json({ id: 7, login: 'ada', email: null })
      return new Response('', { status: 403 })
    }) as unknown as typeof fetch

    expect(github.profile({ accessToken: 'at' }, fetcher)).rejects.toThrow(/user:email/)
  })

  test('GitHub with no verified address at all is refused', async () => {
    const fetcher = (async (url: string | URL) => {
      if (String(url).endsWith('/user')) return Response.json({ id: 7, login: 'ada', email: null })
      return Response.json([{ email: 'ada@example.com', primary: true, verified: false }])
    }) as unknown as typeof fetch

    expect(github.profile({ accessToken: 'at' }, fetcher)).rejects.toThrow(/verified/)
  })
})

/** D35 — tokens nobody reads are a liability. */
describe('provider tokens', () => {
  const claims = { sub: 'g1', email: 'ada@example.com', email_verified: true, name: 'Ada' }

  test('are not stored by default', async () => {
    const store = memoryStore()
    await signIn(makeApp(store, fakeGoogle(claims)))

    expect(store.accounts[0]?.accessToken).toBeNull()
    expect(store.accounts[0]?.refreshToken).toBeNull()
  })

  test('are stored when the application opts in', async () => {
    const store = memoryStore()
    const app = makeApp(store, fakeGoogle(claims), {
      oauth: {
        google: { provider: google, clientId: 'id', clientSecret: 'secret', storeTokens: true },
      },
    })
    await signIn(app)

    expect(store.accounts[0]?.accessToken).toBe('at')
  })
})

describe('configuration is checked at boot', () => {
  test('a store without account methods is refused, naming the fix', () => {
    const store = memoryStore()
    const { findAccount, linkAccount, findAccountsByUser, unlinkAccount, ...withoutAccounts } =
      store

    expect(() =>
      passwordAuthProvider({
        store: withoutAccounts as AuthStore,
        name: 'basic',
        secret: SECRET,
        callbackUrl: (n: string) => `https://app.test/${n}`,
        oauth: { google: { provider: google, clientId: 'i', clientSecret: 's' } },
      } as never),
    ).toThrow(/cannot hold linked accounts/)
  })

  test('a missing callbackUrl is refused', () => {
    expect(() =>
      passwordAuthProvider({
        store: memoryStore(),
        name: 'basic',
        secret: SECRET,
        oauth: { google: { provider: google, clientId: 'i', clientSecret: 's' } },
      } as never),
    ).toThrow(/callbackUrl/)
  })

  test('no oauth means no checks and no endpoints', async () => {
    const app = createApp({ logger: silentLogger, development: true })
    opened.push(app)
    app.use(auth(passwordAuthProvider({ store: memoryStore(), name: 'basic', secret: SECRET })))
    await app.ready()

    expect(app.routeTable().some((r) => r.pattern.includes('/oauth/'))).toBe(false)
  })
})

describe('flows are independently optional', () => {
  test('password: false mounts no signup or login, but keeps the session endpoints', async () => {
    const app = createApp({ logger: silentLogger, development: true })
    opened.push(app)
    app.use(
      auth(
        passwordAuthProvider({
          store: memoryStore(),
          name: 'basic',
          secret: SECRET,
          password: false,
        }),
      ),
    )
    await app.ready()

    const paths = app.routeTable().map((route) => route.pattern)

    expect(paths).not.toContain('/auth/signup')
    expect(paths).not.toContain('/auth/login')
    expect(paths).not.toContain('/auth/change-password')
    expect(paths).toContain('/auth/refresh')
    expect(paths).toContain('/auth/logout')
    expect(paths).toContain('/auth/me')
  })

  test('by default every password endpoint is still mounted', async () => {
    const app = createApp({ logger: silentLogger, development: true })
    opened.push(app)
    app.use(auth(passwordAuthProvider({ store: memoryStore(), name: 'basic', secret: SECRET })))
    await app.ready()

    const paths = app.routeTable().map((route) => route.pattern)
    for (const path of [
      '/auth/signup',
      '/auth/login',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/auth/change-password',
    ]) {
      expect(paths).toContain(path)
    }
  })
})
