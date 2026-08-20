import { BadRequest, Conflict, type Context, Unauthorized } from '@theoven/core'
import { randomToken, UNUSABLE_PASSWORD } from '../crypto'
import { type FlowConfig, issueTokens, type TokenPair, toIdentity } from '../flows'
import type { Identity } from '../identity'
import type { AccountCapableStore, StoredUser } from '../store'
import type { OAuthProfile, OAuthProvider, OAuthProviderOptions, OAuthTokens } from './provider'

/** How long a half-finished sign-in stays valid. Long enough to type a password, short enough. */
const HANDSHAKE_TTL = 10 * 60

/** The cookie carrying `state`, the PKCE verifier and the nonce between the two requests. */
const HANDSHAKE_COOKIE = 'oven_oauth'

export interface OAuthConfig extends FlowConfig {
  store: AccountCapableStore
  /** Where a provider sends the browser back. Must match what is registered with the provider. */
  callbackUrl: (provider: string) => string
  fetcher?: typeof fetch
}

/** What a completed sign-in produced. */
export interface OAuthResult {
  user: Identity<StoredUser>
  tokens: TokenPair
  /** True when this sign-in created the user rather than finding one. */
  created: boolean
  /** True when this sign-in attached a new provider to an existing user. */
  linked: boolean
}

/** Base64url, no padding — what PKCE and `state` both want. */
function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function challengeOf(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
}

/**
 * Begins a sign-in: builds the provider's authorization URL and remembers the handshake.
 *
 * `state`, the PKCE verifier and the nonce live in a **signed, httpOnly cookie** rather than a
 * table. They are single-use and short-lived, so a row would be a table that is empty in steady
 * state and a cleanup job that nobody runs.
 */
export async function startOAuth(
  config: OAuthConfig,
  provider: OAuthProvider,
  options: OAuthProviderOptions,
  ctx: Context,
  redirectTo?: string,
): Promise<string> {
  const state = randomToken(16)
  const verifier = randomToken(32)
  const nonce = provider.usesNonce ? randomToken(16) : undefined

  ctx.cookies.set(
    HANDSHAKE_COOKIE,
    JSON.stringify({ state, verifier, nonce, provider: provider.name, redirectTo }),
    { httpOnly: true, sameSite: 'lax', maxAge: HANDSHAKE_TTL, signed: true, path: '/' },
  )

  const url = new URL(provider.authorizationUrl)
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', config.callbackUrl(provider.name))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', (options.scopes ?? provider.defaultScopes).join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', await challengeOf(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  if (nonce) url.searchParams.set('nonce', nonce)

  for (const [key, value] of Object.entries(provider.authorizationParams ?? {})) {
    url.searchParams.set(key, value)
  }

  return url.href
}

interface Handshake {
  state: string
  verifier: string
  nonce?: string
  provider: string
  redirectTo?: string
}

/** Reads and immediately clears the handshake. Single use, whatever happens next. */
function takeHandshake(ctx: Context, provider: string): Handshake {
  const raw = ctx.cookies.get(HANDSHAKE_COOKIE, { signed: true })
  ctx.cookies.delete(HANDSHAKE_COOKIE, { path: '/' })

  if (!raw) {
    throw new BadRequest('This sign-in has expired or was never started. Try again.')
  }

  let handshake: Handshake
  try {
    handshake = JSON.parse(raw) as Handshake
  } catch {
    throw new BadRequest('This sign-in could not be read. Try again.')
  }

  // A handshake begun for Google must not complete against GitHub.
  if (handshake.provider !== provider) {
    throw new BadRequest('This sign-in was started for a different provider.')
  }
  return handshake
}

/**
 * Finishes a sign-in: verifies the handshake, exchanges the code, and produces a session.
 *
 * @throws {BadRequest} when `state` is missing, stale or does not match — the CSRF check.
 */
export async function completeOAuth(
  config: OAuthConfig,
  provider: OAuthProvider,
  options: OAuthProviderOptions,
  ctx: Context,
): Promise<OAuthResult & { redirectTo?: string }> {
  const query = ctx.query as Record<string, string | undefined>

  // A provider that refused says so here; surfacing its reason beats a generic failure.
  if (query.error) {
    throw new Unauthorized(`${provider.name} refused the sign-in: ${query.error}.`)
  }

  const handshake = takeHandshake(ctx, provider.name)
  const code = query.code

  if (!code) throw new BadRequest('The provider returned no authorization code.')
  // Compared after the cookie is cleared, so a mismatched attempt cannot be retried.
  if (!query.state || query.state !== handshake.state) {
    throw new BadRequest('The sign-in state did not match. Start again.')
  }

  const tokens = await exchange(config, provider, options, code, handshake.verifier)
  const profile = await provider.profile(tokens, config.fetcher ?? fetch)

  const result = await resolveUser(config, provider, options, profile, tokens)
  return handshake.redirectTo ? { ...result, redirectTo: handshake.redirectTo } : result
}

async function exchange(
  config: OAuthConfig,
  provider: OAuthProvider,
  options: OAuthProviderOptions,
  code: string,
  verifier: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: config.callbackUrl(provider.name),
    code_verifier: verifier,
  })

  const response = await (config.fetcher ?? fetch)(provider.tokenUrl, {
    method: 'POST',
    // GitHub returns form-encoded unless asked otherwise, so both providers are told to send JSON.
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  })

  if (!response.ok) {
    throw new Unauthorized(`${provider.name} refused the token exchange (${response.status}).`)
  }

  const payload = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
    error?: string
  }

  if (payload.error || !payload.access_token) {
    throw new Unauthorized(`${provider.name} returned no access token.`)
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresIn: payload.expires_in,
    idToken: payload.id_token,
  }
}

/**
 * Finds, links or creates the user behind a profile.
 *
 * The order matters and is the security-critical part of this file (D33):
 *
 * 1. **A linked account wins.** Sign in as whoever it points at, whatever the email now says.
 * 2. **A matching email links** — but only when the provider says it verified the address.
 *    Without that check, an account at a provider that lets anyone claim an address is an
 *    account-takeover path into an existing user.
 * 3. **Otherwise create**, with an unusable password.
 */
async function resolveUser(
  config: OAuthConfig,
  provider: OAuthProvider,
  options: OAuthProviderOptions,
  profile: OAuthProfile,
  tokens: OAuthTokens,
): Promise<OAuthResult> {
  const { store } = config
  const email = profile.email.trim().toLowerCase()

  const existingAccount = await store.findAccount(provider.name, profile.accountId)
  if (existingAccount) {
    const user = await store.findUserById(existingAccount.userId)
    if (!user) {
      throw new Conflict('That account is linked to a user that no longer exists.')
    }
    return {
      user: toIdentity(user),
      tokens: await issueTokens(user, config),
      created: false,
      linked: false,
    }
  }

  const byEmail = await store.findUserByEmail(email)

  if (byEmail) {
    if (!profile.emailVerified) {
      throw new Conflict(
        `An account already exists for ${email}, and ${provider.name} did not verify that ` +
          'address. Sign in with your password and link the account from your settings.',
      )
    }
    await link(store, provider, options, byEmail.id, profile, tokens)
    return {
      user: toIdentity(byEmail),
      tokens: await issueTokens(byEmail, config),
      created: false,
      linked: true,
    }
  }

  const created = await store.createUser({
    id: crypto.randomUUID(),
    email,
    name: profile.name.trim() || email,
    // No password, ever, unless they set one through the reset flow.
    passwordHash: UNUSABLE_PASSWORD,
    // The provider verified it; recording that is what lets a later provider link to this user.
    emailVerifiedAt: profile.emailVerified ? new Date() : null,
  })

  await link(store, provider, options, created.id, profile, tokens)
  return {
    user: toIdentity(created),
    tokens: await issueTokens(created, config),
    created: true,
    linked: true,
  }
}

function link(
  store: AccountCapableStore,
  provider: OAuthProvider,
  options: OAuthProviderOptions,
  userId: string,
  profile: OAuthProfile,
  tokens: OAuthTokens,
): Promise<unknown> {
  const keep = options.storeTokens === true
  return store.linkAccount({
    id: crypto.randomUUID(),
    userId,
    provider: provider.name,
    providerAccountId: profile.accountId,
    // Absent unless asked for (D35).
    accessToken: keep ? tokens.accessToken : null,
    refreshToken: keep ? (tokens.refreshToken ?? null) : null,
    expiresAt: keep && tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
  })
}

/**
 * Detaches a provider from a user.
 *
 * @throws {Conflict} when it is the last way they have of signing in. Removing it would lock
 * someone out of their own account, and no confirmation dialog makes that recoverable.
 */
export async function unlinkAccount(
  store: AccountCapableStore,
  user: StoredUser,
  provider: string,
): Promise<void> {
  const accounts = await store.findAccountsByUser(user.id)
  const remaining = accounts.filter((account) => account.provider !== provider)
  const hasPassword = !user.passwordHash.startsWith('!')

  if (remaining.length === 0 && !hasPassword) {
    throw new Conflict(`Unlinking ${provider} would leave no way to sign in. Set a password first.`)
  }

  await store.unlinkAccount(user.id, provider)
}
