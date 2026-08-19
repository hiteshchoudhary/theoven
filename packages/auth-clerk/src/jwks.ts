/**
 * RS256 verification against a remote JWKS.
 *
 * Written on WebCrypto rather than pulling in a JWT library. Clerk's own SDK is a reasonable
 * dependency for an application; it is a poor one for a framework brick, which would then own
 * its release cadence and its transitive tree. This is the part of it we actually need, and it
 * is small enough to read.
 */

export class JwksError extends Error {
  override name = 'JwksError'
}

interface RemoteKey {
  kid?: string
  kty?: string
  alg?: string
  use?: string
  n?: string
  e?: string
}

export interface JwksOptions {
  /** Where to fetch the key set. */
  url: string
  /** How long a fetched key set is trusted, in milliseconds. Default 10 minutes. */
  ttl?: number
  /** Injected in tests. Defaults to global `fetch`. */
  fetcher?: typeof fetch
}

/**
 * Fetches and caches a JWKS, refetching when an unknown `kid` appears.
 *
 * Two behaviours matter here. The cache means normal traffic does not make a network call per
 * request. The refetch-on-unknown-kid means a key rotation does not take the application down
 * until the TTL expires — but it is rate-limited, or an attacker could force a fetch per request
 * by sending garbage `kid`s.
 */
export function createJwks(options: JwksOptions) {
  const { url, ttl = 10 * 60 * 1000, fetcher = fetch } = options

  let keys = new Map<string, CryptoKey>()
  let fetchedAt = 0
  let inFlight: Promise<void> | undefined
  /** Earliest time an unknown `kid` may trigger a refetch. */
  let nextForcedFetch = 0

  async function load(): Promise<void> {
    inFlight ??= (async () => {
      try {
        const response = await fetcher(url)
        if (!response.ok) {
          throw new JwksError(`Could not fetch the key set from ${url} (${response.status}).`)
        }

        const body = (await response.json()) as { keys?: RemoteKey[] }
        const imported = new Map<string, CryptoKey>()

        for (const key of body.keys ?? []) {
          // Only RSA signing keys are usable here. Anything else is skipped rather than thrown
          // on: a key set may legitimately carry keys for purposes we do not serve.
          if (!key.kid || key.kty !== 'RSA' || (key.alg && key.alg !== 'RS256')) continue
          if (!key.n || !key.e) continue

          imported.set(
            key.kid,
            await crypto.subtle.importKey(
              'jwk',
              { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true },
              { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
              false,
              ['verify'],
            ),
          )
        }

        if (imported.size === 0) {
          throw new JwksError(`The key set at ${url} contained no usable RS256 keys.`)
        }

        keys = imported
        fetchedAt = Date.now()
      } finally {
        inFlight = undefined
      }
    })()

    return inFlight
  }

  return {
    async keyFor(kid: string): Promise<CryptoKey | null> {
      const now = Date.now()
      if (now - fetchedAt > ttl) await load()

      const known = keys.get(kid)
      if (known) return known

      // An unknown kid usually means a rotation. Refetch — but not more than once a minute, or
      // a stream of forged kids becomes a way to make us hammer the key server.
      if (now >= nextForcedFetch) {
        nextForcedFetch = now + 60_000
        await load()
        return keys.get(kid) ?? null
      }

      return null
    },

    /** Exposed for tests and for a warm-up at boot. */
    load,
  }
}

export interface VerifiedToken {
  claims: Record<string, unknown>
  kid: string
}

/**
 * Verifies an RS256 JWT against a key set.
 *
 * Returns `null` for anything that does not verify — bad signature, unknown key, wrong
 * algorithm, malformed. A caller must treat all of those identically, and distinguishing them
 * in the return value invites treating one as recoverable.
 */
export async function verifyRs256(
  token: string,
  jwks: { keyFor(kid: string): Promise<CryptoKey | null> },
): Promise<VerifiedToken | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  let header: { alg?: string; kid?: string }
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  /**
   * The algorithm comes from the token, so it must be checked rather than trusted. Accepting
   * whatever `alg` says is the classic JWT break — `alg: "none"`, or an RSA public key used as
   * an HMAC secret.
   */
  if (header.alg !== 'RS256' || !header.kid) return null

  const key = await jwks.keyFor(header.kid)
  if (!key) return null

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Buffer.from(signaturePart, 'base64url'),
    Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
  )
  if (!verified) return null

  try {
    return {
      claims: JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')),
      kid: header.kid,
    }
  } catch {
    return null
  }
}
