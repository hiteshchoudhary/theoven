import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { AuthConfigurationError, auth, requireUser } from './brick'
import {
  hashPassword,
  hashToken,
  randomToken,
  signAccessToken,
  timingSafeEqual,
  verifyAccessToken,
  verifyPassword,
} from './crypto'
import {
  changePassword,
  type FlowConfig,
  login,
  logout,
  refresh,
  requestPasswordReset,
  resetPassword,
  signup,
} from './flows'
import type { Identity } from './identity'
import { policyNames, requirementOf } from './policy'
import type { AuthStore, StoredRefreshToken, StoredResetToken, StoredUser } from './store'

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

/** An in-memory `AuthStore`. Also a worked example of how small the contract is. */
function memoryStore(): AuthStore & { users: Map<string, StoredUser> } {
  const users = new Map<string, StoredUser>()
  const refreshTokens = new Map<string, StoredRefreshToken>()
  const resetTokens = new Map<string, StoredResetToken>()

  return {
    users,
    findUserByEmail: async (email) =>
      [...users.values()].find((user) => user.email === email.toLowerCase()) ?? null,
    findUserById: async (id) => users.get(id) ?? null,
    createUser: async (user) => {
      const stored: StoredUser = { ...user, createdAt: new Date() }
      users.set(stored.id, stored)
      return stored
    },
    updateUserPassword: async (userId, passwordHash) => {
      const user = users.get(userId)
      if (user) users.set(userId, { ...user, passwordHash })
    },
    createRefreshToken: async (token) => {
      refreshTokens.set(token.tokenHash, { ...token, createdAt: new Date() })
    },
    findRefreshToken: async (tokenHash) => refreshTokens.get(tokenHash) ?? null,
    deleteRefreshTokens: async (where) => {
      for (const [hash, token] of refreshTokens) {
        if (where.id && token.id === where.id) refreshTokens.delete(hash)
        if (where.userId && token.userId === where.userId) refreshTokens.delete(hash)
      }
    },
    createResetToken: async (token) => {
      resetTokens.set(token.tokenHash, { ...token, usedAt: null })
    },
    findResetToken: async (tokenHash) => resetTokens.get(tokenHash) ?? null,
    markResetTokenUsed: async (id) => {
      for (const [hash, token] of resetTokens) {
        if (token.id === id) resetTokens.set(hash, { ...token, usedAt: new Date() })
      }
    },
  }
}

function flows(overrides: Partial<FlowConfig> = {}): FlowConfig {
  return { store: memoryStore(), secret: 'test-secret-value', ...overrides }
}

async function withUser(config: FlowConfig) {
  return signup(config, { email: 'ada@example.com', password: 'correct-horse', name: 'Ada' })
}

// ---------------------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------------------

describe('passwords', () => {
  test('hash and verify round-trip', async () => {
    const hash = await hashPassword('correct-horse')
    expect(await verifyPassword('correct-horse', hash)).toBe(true)
  })

  test('a wrong password does not verify', async () => {
    const hash = await hashPassword('correct-horse')
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  test('the hash is argon2id, not the password', async () => {
    const hash = await hashPassword('correct-horse')
    expect(hash).toContain('$argon2id$')
    expect(hash).not.toContain('correct-horse')
  })

  test('the same password hashes differently each time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  // A corrupt row should fail the login, not take down the endpoint.
  test('a malformed hash returns false rather than throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false)
  })
})

describe('tokens', () => {
  test('random tokens are unique and URL-safe', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()))
    expect(tokens.size).toBe(100)
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  // A leaked database must not hand over working credentials.
  test('hashing a token is stable and not reversible to the token', () => {
    const token = randomToken()
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).not.toContain(token)
  })

  test('timingSafeEqual compares correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('access tokens', () => {
  const secret = 'a-signing-secret'

  test('sign and verify round-trip', () => {
    const token = signAccessToken({ sub: 'user-1' }, secret, 60)
    expect(verifyAccessToken(token, secret)?.sub).toBe('user-1')
  })

  test('a token signed with another secret does not verify', () => {
    const token = signAccessToken({ sub: 'user-1' }, secret, 60)
    expect(verifyAccessToken(token, 'different-secret')).toBeNull()
  })

  // The signature is the whole security property.
  test('a tampered payload does not verify', () => {
    const token = signAccessToken({ sub: 'user-1' }, secret, 60)
    const [header, , signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e9 })).toString('base64url')

    expect(verifyAccessToken(`${header}.${forged}.${signature}`, secret)).toBeNull()
  })

  test('an expired token does not verify', () => {
    expect(verifyAccessToken(signAccessToken({ sub: 'u' }, secret, -1), secret)).toBeNull()
  })

  test('malformed tokens do not verify', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', 'not.a.token']) {
      expect(verifyAccessToken(bad, secret)).toBeNull()
    }
  })

  test('signing without a secret throws rather than signing with nothing', () => {
    expect(() => signAccessToken({ sub: 'u' }, '', 60)).toThrow(/secret is required/)
  })
})

// ---------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------

describe('signup', () => {
  test('creates a user and issues tokens', async () => {
    const config = flows()
    const { user, tokens } = await withUser(config)

    expect(user.email).toBe('ada@example.com')
    expect(tokens.accessToken).toBeTruthy()
    expect(tokens.refreshToken).toBeTruthy()
  })

  test('lowercases the email, because people type both ways', async () => {
    const config = flows()
    const { user } = await signup(config, {
      email: '  Ada@Example.COM ',
      password: 'correct-horse',
      name: 'Ada',
    })
    expect(user.email).toBe('ada@example.com')
  })

  test('rejects a duplicate email', async () => {
    const config = flows()
    await withUser(config)
    expect(withUser(config)).rejects.toThrow(/already exists/)
  })

  test('rejects a short password', async () => {
    expect(signup(flows(), { email: 'a@b.co', password: 'short', name: 'A' })).rejects.toThrow(
      /at least 8/,
    )
  })

  test('never stores the password itself', async () => {
    const config = flows()
    const { user } = await withUser(config)
    expect(user.raw.passwordHash).not.toContain('correct-horse')
  })
})

describe('login', () => {
  test('succeeds with the right password', async () => {
    const config = flows()
    await withUser(config)

    const { tokens } = await login(config, {
      email: 'ada@example.com',
      password: 'correct-horse',
    })
    expect(tokens.accessToken).toBeTruthy()
  })

  test('is case-insensitive about the email', async () => {
    const config = flows()
    await withUser(config)
    expect(
      login(config, { email: 'ADA@EXAMPLE.COM', password: 'correct-horse' }),
    ).resolves.toBeDefined()
  })

  test('rejects a wrong password', async () => {
    const config = flows()
    await withUser(config)
    expect(login(config, { email: 'ada@example.com', password: 'wrong' })).rejects.toThrow(
      /Invalid email or password/,
    )
  })

  // The endpoint must not become a way to find out who has an account.
  test('an unknown email fails with the identical message', async () => {
    const config = flows()
    await withUser(config)

    const wrongPassword = await login(config, {
      email: 'ada@example.com',
      password: 'wrong',
    }).catch((error) => error.message)
    const unknownEmail = await login(config, {
      email: 'nobody@example.com',
      password: 'wrong',
    }).catch((error) => error.message)

    expect(unknownEmail).toBe(wrongPassword)
  })

  test('an unknown email takes comparable time to a real one', async () => {
    const config = flows()
    await withUser(config)

    const time = async (email: string) => {
      const start = Bun.nanoseconds()
      await login(config, { email, password: 'wrong' }).catch(() => {})
      return Bun.nanoseconds() - start
    }

    const known = await time('ada@example.com')
    const unknown = await time('nobody@example.com')

    // Both pay an argon2 verification. Without the decoy the unknown path would return orders
    // of magnitude faster; a 5x band catches that without being flaky.
    expect(unknown).toBeGreaterThan(known / 5)
  })
})

describe('refresh', () => {
  test('exchanges a refresh token for a new pair', async () => {
    const config = flows()
    const { tokens } = await withUser(config)

    const next = await refresh(config, tokens.refreshToken)
    expect(next.accessToken).toBeTruthy()
    expect(next.refreshToken).not.toBe(tokens.refreshToken)
  })

  // A refresh token that stays valid after use is one a thief keeps using alongside the client.
  test('the old token stops working after rotation', async () => {
    const config = flows()
    const { tokens } = await withUser(config)

    await refresh(config, tokens.refreshToken)
    expect(refresh(config, tokens.refreshToken)).rejects.toThrow(/Invalid or expired/)
  })

  test('an unknown token is rejected', async () => {
    expect(refresh(flows(), randomToken())).rejects.toThrow(/Invalid or expired/)
  })

  test('an expired token is rejected', async () => {
    const config = flows({ refreshTtl: -1 })
    const { tokens } = await withUser(config)
    expect(refresh(config, tokens.refreshToken)).rejects.toThrow(/Invalid or expired/)
  })
})

describe('logout', () => {
  test('revokes the refresh token, so logout is real', async () => {
    const config = flows()
    const { tokens } = await withUser(config)

    await logout(config, tokens.refreshToken)
    expect(refresh(config, tokens.refreshToken)).rejects.toThrow(/Invalid or expired/)
  })

  test('logging out twice is not an error', async () => {
    const config = flows()
    const { tokens } = await withUser(config)

    await logout(config, tokens.refreshToken)
    expect(logout(config, tokens.refreshToken)).resolves.toBeUndefined()
  })
})

describe('change password', () => {
  test('changes it', async () => {
    const config = flows()
    const { user } = await withUser(config)

    await changePassword(config, user.id, { current: 'correct-horse', next: 'new-password' })
    expect(
      login(config, { email: 'ada@example.com', password: 'new-password' }),
    ).resolves.toBeDefined()
  })

  test('rejects a wrong current password', async () => {
    const config = flows()
    const { user } = await withUser(config)
    expect(
      changePassword(config, user.id, { current: 'wrong', next: 'new-password' }),
    ).rejects.toThrow(/incorrect/)
  })

  // Someone changing a password usually believes an account is compromised.
  test('ends every other session', async () => {
    const config = flows()
    const { user, tokens } = await withUser(config)

    await changePassword(config, user.id, { current: 'correct-horse', next: 'new-password' })
    expect(refresh(config, tokens.refreshToken)).rejects.toThrow(/Invalid or expired/)
  })

  test('rejects a short new password', async () => {
    const config = flows()
    const { user } = await withUser(config)
    expect(
      changePassword(config, user.id, { current: 'correct-horse', next: 'short' }),
    ).rejects.toThrow(/at least 8/)
  })
})

describe('password reset', () => {
  async function resetFlow() {
    const sent: Array<{ to: string; token: string }> = []
    const config = flows({
      sendResetEmail: async (to, token) => {
        sent.push({ to, token })
      },
    })
    await withUser(config)
    return { config, sent }
  }

  test('sends a reset token', async () => {
    const { config, sent } = await resetFlow()
    await requestPasswordReset(config, 'ada@example.com')

    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('ada@example.com')
  })

  // Unlike login, nothing is lost by staying quiet: the owner finds out by email.
  test('an unknown email succeeds silently rather than confirming absence', async () => {
    const { config, sent } = await resetFlow()
    await expect(requestPasswordReset(config, 'nobody@example.com')).resolves.toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  test('completes the reset', async () => {
    const { config, sent } = await resetFlow()
    await requestPasswordReset(config, 'ada@example.com')

    await resetPassword(config, sent[0]?.token ?? '', 'brand-new-password')
    expect(
      login(config, { email: 'ada@example.com', password: 'brand-new-password' }),
    ).resolves.toBeDefined()
  })

  test('the token is single use', async () => {
    const { config, sent } = await resetFlow()
    await requestPasswordReset(config, 'ada@example.com')
    const token = sent[0]?.token ?? ''

    await resetPassword(config, token, 'first-new-password')
    expect(resetPassword(config, token, 'second-new-password')).rejects.toThrow(
      /invalid or has expired/,
    )
  })

  test('an expired token is rejected', async () => {
    const sent: Array<{ to: string; token: string }> = []
    const config = flows({
      resetTtl: -1,
      sendResetEmail: async (to, token) => {
        sent.push({ to, token })
      },
    })
    await withUser(config)
    await requestPasswordReset(config, 'ada@example.com')

    expect(resetPassword(config, sent[0]?.token ?? '', 'new-password')).rejects.toThrow(
      /invalid or has expired/,
    )
  })

  test('a forged token is rejected', async () => {
    const { config } = await resetFlow()
    expect(resetPassword(config, randomToken(), 'new-password')).rejects.toThrow(
      /invalid or has expired/,
    )
  })

  // Resetting a password is the strongest signal that old sessions should not survive.
  test('ends every session', async () => {
    const { config, sent } = await resetFlow()
    const { tokens } = await login(config, {
      email: 'ada@example.com',
      password: 'correct-horse',
    })

    await requestPasswordReset(config, 'ada@example.com')
    await resetPassword(config, sent[0]?.token ?? '', 'brand-new-password')

    expect(refresh(config, tokens.refreshToken)).rejects.toThrow(/Invalid or expired/)
  })
})

// ---------------------------------------------------------------------------------------
// The brick
// ---------------------------------------------------------------------------------------

interface FakeUser {
  role?: string
}

function fakeProvider(user: Identity<FakeUser> | null) {
  return {
    name: 'fake',
    identify: () => user,
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  }
}

function makeApp(user: Identity<FakeUser> | null, policies = {}) {
  const app = createApp({ logger: silentLogger, development: true }).use(
    auth(fakeProvider(user), { policies }),
  )
  opened.push(app)
  return app
}

function send(
  app: { fetch(request: Request): Promise<Response> },
  path: string,
): Promise<Response> {
  return app.fetch(new Request(`https://theoven.app${path}`))
}

const ada: Identity<FakeUser> = { id: 'u1', email: 'ada@example.com', raw: { role: 'admin' } }

describe('the brick', () => {
  test('puts the identity on the context', async () => {
    const app = makeApp(ada)
    app.get('/me', (ctx) => ({ id: ctx.user?.id }))
    expect(await (await send(app, '/me')).json()).toEqual({ id: 'u1' })
  })

  test('an anonymous request gets null, not an error', async () => {
    const app = makeApp(null)
    app.get('/me', (ctx) => ({ user: ctx.user }))
    expect(await (await send(app, '/me')).json()).toEqual({ user: null })
  })

  test('auth: true allows a signed-in request', async () => {
    const app = makeApp(ada)
    app.get('/private', { auth: true }, (ctx) => ({ id: ctx.user?.id }))
    expect((await send(app, '/private')).status).toBe(200)
  })

  // A guarded route must be unreachable, not merely inconvenient to reach.
  test('auth: true rejects an anonymous request before the handler runs', async () => {
    let reached = false
    const app = makeApp(null)
    app.get('/private', { auth: true }, () => {
      reached = true
      return 'secret'
    })

    const response = await send(app, '/private')
    expect(response.status).toBe(401)
    expect(reached).toBe(false)
  })

  test('a 401 says how to authenticate', async () => {
    const app = makeApp(null)
    app.get('/private', { auth: true }, () => 'x')
    expect((await send(app, '/private')).headers.get('www-authenticate')).toBe('Bearer')
  })

  test('auth: false is explicitly public', async () => {
    const app = makeApp(null)
    app.get('/public', { auth: false }, () => 'open')
    expect((await send(app, '/public')).status).toBe(200)
  })

  test('routes with no auth key are public', async () => {
    const app = makeApp(null)
    app.get('/public', () => 'open')
    expect((await send(app, '/public')).status).toBe(200)
  })

  test('contributes security schemes to the OpenAPI document', async () => {
    const app = makeApp(ada)
    await app.ready()
    expect(app.openApiFragments().securitySchemes).toHaveProperty('bearerAuth')
  })
})

describe('policies', () => {
  const policies = {
    admin: (user: Identity<FakeUser>) => user.raw.role === 'admin',
    owner: (user: Identity<FakeUser>, ctx: { params: Record<string, string> }) =>
      user.id === ctx.params.id,
  }

  test('a passing policy allows the request', async () => {
    const app = makeApp(ada, policies)
    app.get('/admin', { auth: 'admin' }, () => 'ok')
    expect((await send(app, '/admin')).status).toBe(200)
  })

  test('a failing policy is 403, not 401', async () => {
    const app = makeApp({ id: 'u2', raw: { role: 'member' } }, policies)
    app.get('/admin', { auth: 'admin' }, () => 'ok')

    // 403 because the request *is* authenticated; it is simply not allowed.
    expect((await send(app, '/admin')).status).toBe(403)
  })

  test('an anonymous request to a policy route is 401', async () => {
    const app = makeApp(null, policies)
    app.get('/admin', { auth: 'admin' }, () => 'ok')
    expect((await send(app, '/admin')).status).toBe(401)
  })

  test('a policy can read route params', async () => {
    const app = makeApp(ada, policies)
    app.get('/users/:id', { auth: 'owner' }, () => 'ok')

    expect((await send(app, '/users/u1')).status).toBe(200)
    expect((await send(app, '/users/u2')).status).toBe(403)
  })

  test('several policies must all pass', async () => {
    const app = makeApp({ id: 'u1', raw: { role: 'member' } }, policies)
    app.get('/both', { auth: ['admin', 'owner'] }, () => 'ok')
    expect((await send(app, '/both')).status).toBe(403)
  })

  // A typo'd policy name must never mean "allowed".
  test('an unknown policy fails closed and names what is registered', async () => {
    const app = makeApp(ada, policies)
    app.get('/typo', { auth: 'adminn' }, () => 'ok')

    const response = await send(app, '/typo')
    expect(response.status).toBe(500)
    expect(await response.text()).not.toBe('ok')
  })

  test('an async policy is awaited', async () => {
    const app = makeApp(ada, { slow: async () => false })
    app.get('/slow', { auth: 'slow' }, () => 'ok')
    expect((await send(app, '/slow')).status).toBe(403)
  })
})

describe('capabilities', () => {
  test('a provider declaring routes must implement mount()', async () => {
    const app = createApp({ logger: silentLogger }).use(
      auth({ name: 'broken', identify: () => null, capabilities: { routes: true } }),
    )
    opened.push(app)
    expect(app.ready()).rejects.toThrow(/declares the "routes" capability/)
  })

  test('a provider that mounts routes gets them registered', async () => {
    const app = createApp({ logger: silentLogger }).use(
      auth({
        name: 'mounting',
        identify: () => null,
        capabilities: { routes: true },
        mount: (register, prefix) => {
          register('POST', `${prefix}/login`, () => ({ mounted: true }))
        },
      }),
    )
    opened.push(app)

    const response = await app.fetch(
      new Request('https://theoven.app/auth/login', { method: 'POST' }),
    )
    expect(await response.json()).toEqual({ mounted: true })
  })

  test('the mount prefix is configurable', async () => {
    const app = createApp({ logger: silentLogger }).use(
      auth(
        {
          name: 'mounting',
          identify: () => null,
          capabilities: { routes: true },
          mount: (register, prefix) => {
            register('GET', `${prefix}/status`, () => 'ok')
          },
        },
        { prefix: '/identity' },
      ),
    )
    opened.push(app)
    expect((await send(app, '/identity/status')).status).toBe(200)
  })
})

describe('helpers', () => {
  test('requireUser narrows a present identity', () => {
    expect(requireUser(ada).id).toBe('u1')
  })

  test('requireUser throws for null', () => {
    expect(() => requireUser(null)).toThrow(/Authentication required/)
  })

  test('requirementOf reads what core carried', () => {
    expect(requirementOf({ auth: true })).toBe(true)
    expect(requirementOf({ auth: 'admin' })).toBe('admin')
    expect(requirementOf({ auth: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(requirementOf({})).toBeUndefined()
    expect(requirementOf(undefined)).toBeUndefined()
  })

  test('requirementOf ignores a shape it does not understand', () => {
    expect(requirementOf({ auth: { role: 'admin' } })).toBeUndefined()
    expect(requirementOf({ auth: 42 })).toBeUndefined()
  })

  test('policyNames extracts the names', () => {
    expect(policyNames(true)).toEqual([])
    expect(policyNames('admin')).toEqual(['admin'])
    expect(policyNames(['a', 'b'])).toEqual(['a', 'b'])
  })

  test('AuthConfigurationError is a real Error', () => {
    expect(new AuthConfigurationError('x')).toBeInstanceOf(Error)
  })
})
