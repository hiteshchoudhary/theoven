import type { AuthProvider, Identity } from '@theoven/auth'
import type { Context } from '@theoven/core'
import { createJwks, verifyRs256 } from './jwks'

/** The Clerk session claims this brick reads. Clerk may send more; `raw` carries all of them. */
export interface ClerkClaims {
  /** The Clerk user id, e.g. `user_2abc…`. */
  sub: string
  iss?: string
  exp?: number
  nbf?: number
  /** Authorized party — the frontend origin the token was minted for. */
  azp?: string
  /** Session id. Present on session tokens. */
  sid?: string
  [claim: string]: unknown
}

export interface ClerkAuthOptions {
  /**
   * Your Clerk instance issuer, e.g. `https://tidy-mole-42.clerk.accounts.dev`.
   *
   * Read it from the environment. Every token must claim this exact issuer — a token from
   * someone else's Clerk instance is signed by a real Clerk key and is not yours.
   */
  issuer: string
  /**
   * Where to fetch the signing keys. Defaults to `${issuer}/.well-known/jwks.json`.
   */
  jwksUrl?: string
  /**
   * Origins allowed to mint tokens for this backend, e.g. `['https://app.example.com']`.
   *
   * Checked against the `azp` claim. Optional, and worth setting: without it a token minted for
   * a different frontend of the same Clerk instance is accepted here.
   */
  authorizedParties?: readonly string[]
  /** Tolerance for clock differences, in seconds. Default 5. */
  clockSkew?: number
  /** How long a fetched key set is trusted, in milliseconds. Default 10 minutes. */
  jwksTtl?: number
  /**
   * Cookie carrying the session token, for same-origin browser requests. Default `__session`.
   *
   * `Authorization: Bearer` is checked first, because that is what an API client sends.
   */
  cookie?: string
  /** Injected in tests. Defaults to global `fetch`. */
  fetcher?: typeof fetch
}

/**
 * Clerk as an Oven auth provider.
 *
 * The opposite end of the contract from [`auth-basic`](/docs/bricks/auth-basic/): Clerk hosts
 * sign-in, so this brick mounts **no routes**, cannot sign a user out from the server, and
 * cannot refresh. It declares those capabilities as absent, and a route asking for something it
 * cannot do fails at boot with a message rather than at 3am (D19).
 *
 * All it does is verify the session token on each request:
 *
 * ```ts
 * const app = createApp().use(auth(clerkAuth({ issuer: env.url('CLERK_ISSUER') })))
 *
 * app.get('/me', { auth: true }, (ctx) => ctx.user)
 * ```
 */
export function clerkAuth(options: ClerkAuthOptions): AuthProvider<ClerkClaims> {
  const {
    issuer,
    jwksUrl = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`,
    authorizedParties,
    clockSkew = 5,
    jwksTtl,
    cookie = '__session',
    fetcher,
  } = options

  if (!issuer) {
    throw new Error(
      'clerkAuth needs your Clerk issuer. Read one from the environment: ' +
        "clerkAuth({ issuer: env.url('CLERK_ISSUER') })",
    )
  }

  const jwks = createJwks({
    url: jwksUrl,
    ...(jwksTtl !== undefined ? { ttl: jwksTtl } : {}),
    ...(fetcher ? { fetcher } : {}),
  })

  return {
    name: 'clerk',

    /**
     * Nothing is declared.
     *
     * Clerk cannot sign a user in or out from a server — sessions belong to Clerk, and the
     * browser talks to it directly. Pretending otherwise would produce a `signOut` that quietly
     * did nothing, which is worse than a boot-time error saying the provider cannot do it.
     */
    capabilities: { routes: false, signOut: false, refresh: false },

    securitySchemes: {
      clerkSession: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },

    identify: async (ctx: Context): Promise<Identity<ClerkClaims> | null> => {
      const token = ctx.token ?? ctx.cookies.get(cookie)
      if (!token) return null

      const verified = await verifyRs256(token, jwks).catch(() => null)
      if (!verified) return null

      const claims = verified.claims as ClerkClaims
      if (!isValid(claims, { issuer, authorizedParties, clockSkew })) return null

      return toIdentity(claims)
    },
  }
}

/**
 * The claim checks, separately so they can be tested without a signature.
 *
 * A valid signature proves Clerk minted the token. It does not prove the token was minted for
 * *this* application, or that it is still meant to work — which is what these check.
 */
export function isValid(
  claims: ClerkClaims,
  options: {
    issuer: string
    authorizedParties?: readonly string[] | undefined
    clockSkew: number
  },
): boolean {
  const { issuer, authorizedParties, clockSkew } = options

  if (typeof claims.sub !== 'string' || claims.sub === '') return false

  // Clerk signs every instance's tokens with keys from that instance, but an application that
  // skipped this would accept a token from any instance whose JWKS it happened to fetch.
  if (claims.iss !== issuer.replace(/\/$/, '')) return false

  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp + clockSkew <= now) return false
  if (typeof claims.nbf === 'number' && claims.nbf - clockSkew > now) return false

  // Only when configured. Clerk omits `azp` for some token types, and rejecting those by
  // default would break backends that never see a browser.
  if (authorizedParties && authorizedParties.length > 0) {
    if (typeof claims.azp !== 'string' || !authorizedParties.includes(claims.azp)) return false
  }

  return true
}

/**
 * Maps Clerk's claims onto Oven's `Identity`.
 *
 * Clerk's session token carries whatever your instance's JWT template puts in it. The default
 * template has only `sub`, so email and name are read where a customised template usually puts
 * them, and are simply absent otherwise — an `Identity` with no email is a normal thing.
 */
export function toIdentity(claims: ClerkClaims): Identity<ClerkClaims> {
  const email = pickString(claims, ['email', 'email_address', 'primary_email_address'])
  const name = pickString(claims, ['name', 'full_name', 'first_name'])
  const image = pickString(claims, ['image_url', 'picture'])

  return {
    id: claims.sub,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(image ? { image } : {}),
    raw: claims,
  }
}

function pickString(claims: ClerkClaims, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = claims[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}
