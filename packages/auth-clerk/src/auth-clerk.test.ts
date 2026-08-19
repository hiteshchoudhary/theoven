import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { auth } from '@theoven/auth'
import { createApp, silentLogger } from '@theoven/core'
import { createJwks, verifyRs256 } from './jwks'
import { type ClerkClaims, clerkAuth, isValid, toIdentity } from './provider'

/**
 * A real RSA keypair, real signatures, a fake key server.
 *
 * Nothing here mocks the verification itself — that is the part worth testing. What is injected
 * is only where the keys come from, so the suite runs without a network and still fails if the
 * signature check does.
 */

const ISSUER = 'https://tidy-mole-42.clerk.accounts.dev'
const KID = 'ins_test_key'

let keyPair: CryptoKeyPair
let jwksBody: string
/** A second, unrelated key — for the token that is signed by the wrong hands. */
let impostor: CryptoKeyPair

beforeAll(async () => {
  const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }
  keyPair = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair
  impostor = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as CryptoKeyPair

  const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  jwksBody = JSON.stringify({
    keys: [{ ...exported, kid: KID, use: 'sig', alg: 'RS256' }],
  })
})

/** Counts fetches, so caching and rotation behaviour can be asserted rather than assumed. */
function keyServer(body = () => jwksBody) {
  let calls = 0
  const fetcher = (async () => {
    calls++
    return new Response(body(), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetcher, calls: () => calls }
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

async function signToken(
  claims: Partial<ClerkClaims> = {},
  options: { kid?: string; alg?: string; key?: CryptoKey } = {},
): Promise<string> {
  const header = base64url(
    JSON.stringify({ alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' }),
  )
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(
    JSON.stringify({ sub: 'user_2abc', iss: ISSUER, exp: now + 3600, nbf: now - 10, ...claims }),
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    options.key ?? keyPair.privateKey,
    Buffer.from(`${header}.${payload}`, 'utf8'),
  )
  return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`
}

describe('RS256 verification', () => {
  test('a token signed by the right key verifies', async () => {
    const { fetcher } = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    const verified = await verifyRs256(await signToken(), jwks)
    expect(verified?.claims.sub).toBe('user_2abc')
  })

  // The whole point. A token signed by anyone else must not verify.
  test('a token signed by a different key does not', async () => {
    const { fetcher } = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    expect(await verifyRs256(await signToken({}, { key: impostor.privateKey }), jwks)).toBeNull()
  })

  /**
   * The classic JWT break: trusting the `alg` in the token. `none` means "no signature", and an
   * implementation that honours it accepts anything.
   */
  test('alg: none is rejected', async () => {
    const { fetcher } = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    const header = base64url(JSON.stringify({ alg: 'none', kid: KID, typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ sub: 'user_2abc', iss: ISSUER }))

    expect(await verifyRs256(`${header}.${payload}.`, jwks)).toBeNull()
  })

  test('an HS256 header is rejected even with a valid-looking signature', async () => {
    const { fetcher } = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    expect(await verifyRs256(await signToken({}, { alg: 'HS256' }), jwks)).toBeNull()
  })

  test('a token naming an unknown key is rejected', async () => {
    const { fetcher } = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    expect(await verifyRs256(await signToken({}, { kid: 'ins_not_ours' }), jwks)).toBeNull()
  })

  test('a token with no kid is rejected', async () => {
    const { fetcher } = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    expect(await verifyRs256(`${header}.${base64url('{}')}.x`, jwks)).toBeNull()
  })

  test('a malformed token is rejected rather than throwing', async () => {
    const { fetcher } = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    expect(await verifyRs256('not-a-jwt', jwks)).toBeNull()
    expect(await verifyRs256('a.b', jwks)).toBeNull()
    expect(await verifyRs256('%%%.%%%.%%%', jwks)).toBeNull()
  })
})

describe('the key set', () => {
  // Normal traffic must not make a network call per request.
  test('keys are cached across requests', async () => {
    const server = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher: server.fetcher })

    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await verifyRs256(await signToken(), jwks)).not.toBeNull()
    }
    expect(server.calls()).toBe(1)
  })

  /**
   * An unknown kid usually means Clerk rotated its keys. Refetching is what keeps the app up —
   * but only once a minute, or a stream of forged kids becomes a way to make us hammer the key
   * server on an attacker's behalf.
   */
  test('an unknown kid triggers at most one refetch a minute', async () => {
    const server = keyServer()
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher: server.fetcher })

    await verifyRs256(await signToken(), jwks)
    expect(server.calls()).toBe(1)

    for (let attempt = 0; attempt < 10; attempt++) {
      await verifyRs256(await signToken({}, { kid: `forged-${attempt}` }), jwks)
    }

    expect(server.calls()).toBe(2)
  })

  test('a key server that is down surfaces as an error, not a silent pass', async () => {
    const fetcher = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    expect(verifyRs256(await signToken(), jwks)).rejects.toThrow(/Could not fetch the key set/)
  })

  test('a key set with no usable keys is an error', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ keys: [{ kty: 'oct', kid: 'x' }] }))) as unknown as typeof fetch
    const jwks = createJwks({ url: 'https://keys.test/jwks.json', fetcher })

    expect(jwks.load()).rejects.toThrow(/no usable RS256 keys/)
  })
})

describe('claim checks', () => {
  const base = { issuer: ISSUER, clockSkew: 5 }
  const now = Math.floor(Date.now() / 1000)
  const valid: ClerkClaims = { sub: 'user_1', iss: ISSUER, exp: now + 60, nbf: now - 60 }

  test('a good token passes', () => {
    expect(isValid(valid, base)).toBe(true)
  })

  // A valid signature proves Clerk minted it. It does not prove it was minted for you.
  test('a token from another Clerk instance is rejected', () => {
    expect(isValid({ ...valid, iss: 'https://someone-else.clerk.accounts.dev' }, base)).toBe(false)
  })

  test('an expired token is rejected', () => {
    expect(isValid({ ...valid, exp: now - 60 }, base)).toBe(false)
  })

  test('a token not yet valid is rejected', () => {
    expect(isValid({ ...valid, nbf: now + 600 }, base)).toBe(false)
  })

  // Skew tolerance is why a server a few seconds fast does not reject everyone.
  test('clock skew is tolerated at the edges', () => {
    expect(isValid({ ...valid, exp: now - 2 }, base)).toBe(true)
    expect(isValid({ ...valid, nbf: now + 2 }, base)).toBe(true)
  })

  test('a token with no expiry is rejected', () => {
    const { exp: _dropped, ...noExpiry } = valid
    expect(isValid(noExpiry as ClerkClaims, base)).toBe(false)
  })

  test('authorized parties are enforced when configured', () => {
    const withAzp = { ...base, authorizedParties: ['https://app.example.com'] }
    expect(isValid({ ...valid, azp: 'https://app.example.com' }, withAzp)).toBe(true)
    expect(isValid({ ...valid, azp: 'https://evil.example.com' }, withAzp)).toBe(false)
    // Clerk omits azp for some token types, so an absent one fails only once you have opted in.
    expect(isValid(valid, withAzp)).toBe(false)
    expect(isValid(valid, base)).toBe(true)
  })
})

describe('identity mapping', () => {
  test('the Clerk user id becomes the identity id, and raw carries everything', () => {
    const identity = toIdentity({ sub: 'user_2abc', sid: 'sess_1', org_role: 'admin' })
    expect(identity.id).toBe('user_2abc')
    expect(identity.raw.sid).toBe('sess_1')
    expect(identity.raw.org_role).toBe('admin')
  })

  // The default Clerk JWT template carries only `sub`. An identity with no email is normal.
  test('email and name are absent rather than empty when the template omits them', () => {
    const identity = toIdentity({ sub: 'user_2abc' })
    expect(identity.email).toBeUndefined()
    expect(identity.name).toBeUndefined()
  })

  test('a customised template is read where people usually put it', () => {
    const identity = toIdentity({
      sub: 'user_2abc',
      email: 'ada@example.com',
      full_name: 'Ada Lovelace',
      image_url: 'https://img.clerk.com/ada',
    })
    expect(identity.email).toBe('ada@example.com')
    expect(identity.name).toBe('Ada Lovelace')
    expect(identity.image).toBe('https://img.clerk.com/ada')
  })
})

describe('the brick', () => {
  const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 0 })))
  })

  async function withClerk() {
    const { fetcher } = keyServer()
    const app = createApp({ logger: silentLogger, development: true }).use(
      auth(clerkAuth({ issuer: ISSUER, fetcher })),
    )
    opened.push(app)
    app.get('/me', { auth: true }, (ctx) => ({ id: ctx.user.id }))
    app.get('/public', (ctx) => ({ signedIn: ctx.user !== null }))
    await app.ready()
    return app
  }

  test('a bearer token identifies the request', async () => {
    const app = await withClerk()
    const response = await app.fetch(
      new Request('https://theoven.app/me', {
        headers: { authorization: `Bearer ${await signToken()}` },
      }),
    )
    expect(await response.json()).toEqual({ id: 'user_2abc' })
  })

  // Clerk's browser SDK sets this cookie on same-origin requests.
  test('the __session cookie identifies the request too', async () => {
    const app = await withClerk()
    const response = await app.fetch(
      new Request('https://theoven.app/me', {
        headers: { cookie: `__session=${await signToken()}` },
      }),
    )
    expect(await response.json()).toEqual({ id: 'user_2abc' })
  })

  test('a guarded route refuses an anonymous request', async () => {
    const app = await withClerk()
    expect((await app.fetch(new Request('https://theoven.app/me'))).status).toBe(401)
  })

  test('a forged token is refused', async () => {
    const app = await withClerk()
    const forged = await signToken({}, { key: impostor.privateKey })
    const response = await app.fetch(
      new Request('https://theoven.app/me', { headers: { authorization: `Bearer ${forged}` } }),
    )
    expect(response.status).toBe(401)
  })

  /**
   * An invalid credential must not break a public route. Otherwise a stale cookie in someone's
   * browser turns the marketing pages into 401s.
   */
  test('a bad token leaves public routes working, anonymously', async () => {
    const app = await withClerk()
    const response = await app.fetch(
      new Request('https://theoven.app/public', { headers: { authorization: 'Bearer garbage' } }),
    )
    expect(await response.json()).toEqual({ signedIn: false })
  })

  test('it declares that it mounts nothing and cannot sign out', () => {
    const provider = clerkAuth({ issuer: ISSUER })
    expect(provider.capabilities).toEqual({ routes: false, signOut: false, refresh: false })
    expect(provider.mount).toBeUndefined()
    expect(provider.signOut).toBeUndefined()
  })

  test('a missing issuer is refused at construction', () => {
    expect(() => clerkAuth({ issuer: '' })).toThrow(/issuer/)
  })

  test('the jwks url is derived from the issuer, trailing slash or not', async () => {
    let requested = ''
    const fetcher = (async (url: string) => {
      requested = url
      return new Response(jwksBody)
    }) as unknown as typeof fetch

    const provider = clerkAuth({ issuer: `${ISSUER}/`, fetcher })
    await provider.identify({
      token: await signToken(),
      cookies: { get: () => undefined },
    } as never)

    expect(requested).toBe(`${ISSUER}/.well-known/jwks.json`)
  })
})
