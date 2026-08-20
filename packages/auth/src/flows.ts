import { BadRequest, Conflict, Unauthorized } from '@theoven/core'
import {
  fakeVerify,
  hashPassword,
  hashToken,
  randomToken,
  signAccessToken,
  verifyPassword,
} from './crypto'
import type { Identity } from './identity'
import type { AuthStore, StoredUser } from './store'

/**
 * The flows every storage brick shares.
 *
 * Written against `AuthStore`, so `auth-basic` (Drizzle) and `auth-mongo` (Mongoose) run the
 * identical logic. Security decisions live here and nowhere else.
 */

export interface FlowConfig {
  store: AuthStore
  /** Signs access tokens. Must be set; there is no safe default. */
  secret: string
  /** Access-token lifetime in seconds. Default 15 minutes. */
  accessTtl?: number
  /** Refresh-token lifetime in seconds. Default 30 days. */
  refreshTtl?: number
  /** Password-reset link lifetime in seconds. Default 1 hour. */
  resetTtl?: number
  /** Minimum password length. Default 8. */
  minPasswordLength?: number
  /** Sends the reset email. Absent means reset links are logged instead of sent. */
  sendResetEmail?: (to: string, token: string) => Promise<void>
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

const DEFAULTS = {
  accessTtl: 15 * 60,
  refreshTtl: 30 * 24 * 60 * 60,
  resetTtl: 60 * 60,
  minPasswordLength: 8,
} as const

/** Emails are stored and compared lowercased; people type them both ways. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function toIdentity(user: StoredUser): Identity<StoredUser> {
  return { id: user.id, email: user.email, name: user.name, raw: user }
}

function config(input: FlowConfig) {
  return { ...DEFAULTS, ...input }
}

/**
 * Issues an access/refresh pair for a user.
 *
 * Exported so social sign-in produces the *same* session a password login does — one session
 * model means logout, sign-out-everywhere and password-change-invalidates-sessions keep working
 * however the person signed in.
 */
export async function issueTokens(user: StoredUser, input: FlowConfig): Promise<TokenPair> {
  const { store, secret, accessTtl, refreshTtl } = config(input)

  const refreshToken = randomToken()
  await store.createRefreshToken({
    id: crypto.randomUUID(),
    userId: user.id,
    // Hashed, so a leaked database does not hand over working sessions.
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + refreshTtl * 1000),
  })

  return {
    accessToken: signAccessToken({ sub: user.id }, secret, accessTtl),
    refreshToken,
    expiresIn: accessTtl,
  }
}

/**
 * Creates an account.
 *
 * @throws {Conflict} when the email is already registered
 */
export async function signup(
  input: FlowConfig,
  details: { email: string; password: string; name: string },
): Promise<{ user: Identity<StoredUser>; tokens: TokenPair }> {
  const settings = config(input)
  const email = normaliseEmail(details.email)

  if (details.password.length < settings.minPasswordLength) {
    throw new BadRequest(`Password must be at least ${settings.minPasswordLength} characters.`)
  }

  // Signup genuinely cannot hide whether an email is taken — the account either gets created or
  // it does not. Password reset is where enumeration is preventable, and that is handled there.
  if (await settings.store.findUserByEmail(email)) {
    throw new Conflict('An account with that email already exists.')
  }

  const user = await settings.store.createUser({
    id: crypto.randomUUID(),
    email,
    name: details.name.trim(),
    passwordHash: await hashPassword(details.password),
  })

  return { user: toIdentity(user), tokens: await issueTokens(user, input) }
}

/**
 * Signs in.
 *
 * @throws {Unauthorized} for a wrong password *and* for an unknown email, with the same message
 * and the same timing — the endpoint must not become a way to find out who has an account.
 */
export async function login(
  input: FlowConfig,
  credentials: { email: string; password: string },
): Promise<{ user: Identity<StoredUser>; tokens: TokenPair }> {
  const settings = config(input)
  const user = await settings.store.findUserByEmail(normaliseEmail(credentials.email))

  if (!user) {
    // Spend the same time a real verification would, so a missing account is not measurably
    // faster than a wrong password.
    await fakeVerify()
    throw new Unauthorized('Invalid email or password.')
  }

  if (!(await verifyPassword(credentials.password, user.passwordHash))) {
    throw new Unauthorized('Invalid email or password.')
  }

  return { user: toIdentity(user), tokens: await issueTokens(user, input) }
}

/**
 * Exchanges a refresh token for a new pair.
 *
 * The old token is deleted as part of the exchange — rotation. A refresh token that stays valid
 * after use is one a thief can keep using alongside the real client.
 *
 * @throws {Unauthorized} when the token is unknown, expired, or already used
 */
export async function refresh(input: FlowConfig, refreshToken: string): Promise<TokenPair> {
  const settings = config(input)
  const stored = await settings.store.findRefreshToken(hashToken(refreshToken))

  if (!stored || stored.expiresAt.getTime() <= Date.now()) {
    throw new Unauthorized('Invalid or expired refresh token.')
  }

  const user = await settings.store.findUserById(stored.userId)
  if (!user) throw new Unauthorized('Invalid or expired refresh token.')

  await settings.store.deleteRefreshTokens({ id: stored.id })
  return issueTokens(user, input)
}

/**
 * Signs out.
 *
 * Deletes the refresh token, which is what makes logout real: the access token expires within
 * its short window and cannot be renewed. Unknown tokens are ignored — logging out twice is not
 * an error worth reporting.
 */
export async function logout(input: FlowConfig, refreshToken: string): Promise<void> {
  const stored = await input.store.findRefreshToken(hashToken(refreshToken))
  if (stored) await input.store.deleteRefreshTokens({ id: stored.id })
}

/**
 * Changes a password for a signed-in user, then ends every other session.
 *
 * The second half is the point. Someone changing their password usually believes an account is
 * compromised, and a change that leaves existing sessions alive has not locked anyone out.
 *
 * @throws {Unauthorized} when the current password is wrong
 */
export async function changePassword(
  input: FlowConfig,
  userId: string,
  passwords: { current: string; next: string },
): Promise<void> {
  const settings = config(input)
  const user = await settings.store.findUserById(userId)
  if (!user) throw new Unauthorized('Not signed in.')

  if (!(await verifyPassword(passwords.current, user.passwordHash))) {
    throw new Unauthorized('Current password is incorrect.')
  }
  if (passwords.next.length < settings.minPasswordLength) {
    throw new BadRequest(`Password must be at least ${settings.minPasswordLength} characters.`)
  }

  await settings.store.updateUserPassword(userId, await hashPassword(passwords.next))
  await settings.store.deleteRefreshTokens({ userId })
}

/**
 * Starts a password reset.
 *
 * Always succeeds, whether or not the email exists. Reporting "no such account" would turn this
 * into an account-enumeration endpoint, and unlike login there is nothing lost by staying quiet:
 * the person who owns the address finds out by email.
 */
export async function requestPasswordReset(input: FlowConfig, email: string): Promise<void> {
  const settings = config(input)
  const user = await settings.store.findUserByEmail(normaliseEmail(email))
  if (!user) return

  const token = randomToken()
  await settings.store.createResetToken({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + settings.resetTtl * 1000),
  })

  await settings.sendResetEmail?.(user.email, token)
}

/**
 * Completes a password reset, then ends every session.
 *
 * The token is single-use and checked for expiry. Resetting a password is the strongest signal
 * that existing sessions should not survive.
 *
 * @throws {Unauthorized} when the token is unknown, expired, or already used
 */
export async function resetPassword(
  input: FlowConfig,
  token: string,
  newPassword: string,
): Promise<void> {
  const settings = config(input)
  const stored = await settings.store.findResetToken(hashToken(token))

  if (!stored || stored.usedAt || stored.expiresAt.getTime() <= Date.now()) {
    throw new Unauthorized('This reset link is invalid or has expired.')
  }
  if (newPassword.length < settings.minPasswordLength) {
    throw new BadRequest(`Password must be at least ${settings.minPasswordLength} characters.`)
  }

  await settings.store.updateUserPassword(stored.userId, await hashPassword(newPassword))
  await settings.store.markResetTokenUsed(stored.id)
  await settings.store.deleteRefreshTokens({ userId: stored.userId })
}
