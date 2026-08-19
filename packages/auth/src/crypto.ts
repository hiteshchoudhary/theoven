/**
 * The security-critical half of auth, written once.
 *
 * Every storage brick — `auth-basic` on Drizzle, `auth-mongo` on Mongoose — shares this file.
 * That is the entire reason it exists: password hashing and token handling duplicated per brick
 * means a fix landing in one and not the other, which is the bug nobody finds (D26).
 */

/** Raised when a credential or token is malformed. Never carries the value. */
export class AuthCryptoError extends Error {
  override name = 'AuthCryptoError'
}

// ---------------------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------------------

/**
 * Hashes a password with argon2id.
 *
 * Bun's default, and the right one: argon2id is memory-hard, so an attacker with a GPU gains
 * far less than they would against bcrypt or PBKDF2. The cost parameters are Bun's defaults
 * rather than ours — this is not a place to invent numbers.
 */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed hash. A corrupt row should fail the login,
 * not take down the endpoint — and a thrown error here would distinguish "bad hash" from "wrong
 * password" to anyone watching response times.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}

/**
 * Spends roughly the same time as a real verification, without one.
 *
 * Called when the email does not exist. Without it, a missing account returns in microseconds
 * while a real one takes the full argon2 cost, and the difference is measurable from the
 * outside — which turns the login endpoint into a way to enumerate who has an account.
 */
export async function fakeVerify(): Promise<void> {
  await Bun.password.verify('decoy-password', DECOY_HASH).catch(() => false)
}

/** Generated once at module load so the cost is paid at boot rather than per request. */
const DECOY_HASH = await Bun.password.hash('decoy-password', { algorithm: 'argon2id' })

// ---------------------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------------------

/**
 * A cryptographically random token, URL-safe.
 *
 * 32 bytes. Long enough that guessing is not a strategy, short enough to fit in a URL for a
 * password-reset link.
 */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Buffer.from(buffer).toString('base64url')
}

/**
 * Hashes a token for storage with SHA-256.
 *
 * Reset and refresh tokens are stored hashed for the same reason passwords are: a leaked
 * database should not hand over working credentials. SHA-256 rather than argon2 because these
 * tokens are already high-entropy random values — there is nothing to brute-force, and a slow
 * hash on every refresh would cost real latency for no gain.
 */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('base64url')
}

/**
 * Constant-time string comparison.
 *
 * Returning early on the first differing byte leaks, through timing, how much of a forged value
 * was correct — which is enough to reconstruct it one byte at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index++) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return mismatch === 0
}

// ---------------------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------------------

export interface AccessTokenClaims {
  /** Subject: the user id. */
  sub: string
  /** Issued at, in seconds. */
  iat: number
  /** Expires at, in seconds. */
  exp: number
  /** Session this token belongs to, so revoking the session invalidates it. */
  sid?: string
  [claim: string]: unknown
}

function base64url(input: string | Uint8Array): string {
  return Buffer.from(input as never).toString('base64url')
}

function sign(payload: string, secret: string): string {
  return new Bun.CryptoHasher('sha256', secret).update(payload).digest('base64url')
}

/**
 * Issues a signed access token (JWT, HS256).
 *
 * Deliberately short-lived. Verification is a signature check with no database read, which is
 * what keeps the hot path fast — and the cost of that is that it cannot be revoked, so it must
 * expire quickly. Revocation lives with the refresh token (D20).
 */
export function signAccessToken(
  claims: { sub: string; sid?: string },
  secret: string,
  ttlSeconds: number,
): string {
  if (!secret) throw new AuthCryptoError('An access-token secret is required.')

  const issuedAt = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload: AccessTokenClaims = { ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds }
  const body = base64url(JSON.stringify(payload))

  return `${header}.${body}.${sign(`${header}.${body}`, secret)}`
}

/**
 * Verifies an access token and returns its claims.
 *
 * Returns `null` for anything that does not verify — bad signature, wrong shape, expired. A
 * caller should treat all of those identically, and distinguishing them in the return value
 * invites a caller to treat one as recoverable.
 */
export function verifyAccessToken(token: string, secret: string): AccessTokenClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts as [string, string, string]
  if (!timingSafeEqual(signature, sign(`${header}.${body}`, secret))) return null

  let claims: AccessTokenClaims
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessTokenClaims
  } catch {
    return null
  }

  // The signature proves we issued it; the expiry proves it is still meant to work.
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null
  if (typeof claims.sub !== 'string' || claims.sub === '') return null

  return claims
}
