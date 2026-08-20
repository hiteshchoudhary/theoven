/**
 * The storage-agnostic half of email-and-password auth.
 *
 * Every flow, every endpoint, every cookie and every rate limit lives here — once. A storage
 * brick supplies an `AuthStore` and its own schema, and gets the whole provider back.
 *
 * This file exists because the alternative is real: `auth-basic` and `auth-mongo` each carrying
 * their own copy of the mount table, the throttling and the cookie handling, and a fix landing in
 * one and not the other. That is the bug nobody finds (D26). `auth-mongo` is about a hundred
 * lines because of this file.
 */
import { BadRequest, type Context, TooManyRequests, Unauthorized } from '@theoven/core'
import type { AuthProvider, MountRegistrar } from './brick'
import { verifyAccessToken } from './crypto'
import {
  changePassword,
  type FlowConfig,
  login,
  logout,
  refresh,
  requestPasswordReset,
  resetPassword,
  signup,
  toIdentity,
} from './flows'
import type { Identity } from './identity'
import { completeOAuth, type OAuthConfig, startOAuth } from './oauth/flow'
import type { OAuthProvider, OAuthProviderOptions } from './oauth/provider'
import type { AuthStore, StoredUser } from './store'
import { supportsAccounts } from './store'

export interface PasswordAuthOptions {
  /** Where users, refresh tokens and reset tokens live. */
  store: AuthStore
  /**
   * Names the provider in `ctx.auth.name` and in errors, e.g. `basic` or `mongo`.
   *
   * Storage bricks pass their own, because "authentication failed" is a useless message in an
   * app that registered two of them.
   */
  name: string
  /**
   * Signs access tokens. **Required** — there is no safe default.
   *
   * Read it from the environment. A framework that invents a signing secret has invented a
   * secret every deployment shares.
   */
  secret: string
  /** Access-token lifetime in seconds. Default 15 minutes. */
  accessTtl?: number
  /** Refresh-token lifetime in seconds. Default 30 days. */
  refreshTtl?: number
  /** Reset-link lifetime in seconds. Default 1 hour. */
  resetTtl?: number
  /** Minimum password length. Default 8. */
  minPasswordLength?: number
  /**
   * Sends the password-reset email.
   *
   * Optional so that reset works before mail is configured: without it the link is logged, and
   * a developer can copy it out of the terminal. Not something to ship to production, which is
   * why the brick warns at boot when it is missing.
   */
  sendResetEmail?: (to: string, token: string) => Promise<void>
  /**
   * Throttle the endpoints attackers actually hit.
   *
   * On by default, and per email address as well as per IP: limiting by IP alone does nothing
   * against a distributed attempt at one account, and limiting by email alone lets one host
   * spray the whole user table. Set `false` to handle it yourself.
   */
  rateLimit?: AuthRateLimit | false

  /**
   * Email-and-password sign-in. On by default.
   *
   * Set `false` for an application that authenticates only through providers. The session
   * endpoints — refresh, logout, me — stay mounted either way, because a session is a session
   * however it was established.
   */
  password?: boolean

  /**
   * Social sign-in providers, keyed by name.
   *
   * Each configured provider mounts two endpoints and nothing else. Omit this and no OAuth code
   * runs, no accounts table is touched, and the brick behaves exactly as it did before.
   */
  oauth?: Record<string, { provider: OAuthProvider } & OAuthProviderOptions>

  /**
   * Where a provider sends the browser back, given a provider name.
   *
   * Required when `oauth` is configured, because only the application knows its own public URL —
   * guessing it from the request's Host header would let a caller choose where the code is sent.
   */
  callbackUrl?: (provider: string) => string

  /** Where to send the browser after a successful sign-in. Defaults to returning JSON. */
  afterOAuth?: string

  /**
   * Replaces `fetch` for provider calls. Tests inject one; nothing else should.
   *
   * Without it these flows can only be exercised against a real Google or GitHub application,
   * which is a test nobody runs.
   */
  fetcher?: typeof fetch

  /**
   * Cookie holding the refresh token. Default `oven_refresh`.
   *
   * The refresh token is set as an httpOnly cookie rather than returned in the body, so a
   * cross-site script cannot read it. The short-lived access token goes in the body, where a
   * client can attach it to `Authorization`.
   */
  refreshCookie?: string
}

/** What a password-auth provider exposes on `ctx.auth`. */
export interface PasswordAuthService {
  readonly name: string
  /** The flow configuration, for calling signup/login/etc. from your own routes. */
  readonly flows: FlowConfig
}

const COOKIE_DEFAULT = 'oven_refresh'

export interface AuthRateLimit {
  /** Attempts allowed per window on login. Default 10. */
  login?: number
  /** Signups allowed per window. Default 5. */
  signup?: number
  /** Reset requests allowed per window. Default 3. */
  forgotPassword?: number
  /** Window length in milliseconds. Default 15 minutes. */
  window?: number
}

const RATE_DEFAULTS = { login: 10, signup: 5, forgotPassword: 3, window: 15 * 60 * 1000 } as const

/**
 * A fixed-window counter, in memory.
 *
 * Per process, so behind a load balancer the effective limit is `limit x instances`. That is
 * enough to blunt credential stuffing and password-reset spam, which is what these endpoints
 * face; it is not a precise quota, and the brick's page says so.
 */
function throttle(limit: number, window: number) {
  const hits = new Map<string, { count: number; resetAt: number }>()

  return (key: string): void => {
    const now = Date.now()
    let bucket = hits.get(key)

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + window }
      hits.set(key, bucket)
    }

    bucket.count++

    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      throw new TooManyRequests('Too many attempts. Try again shortly.', {
        headers: { 'retry-after': String(retryAfter) },
      })
    }

    // Swept on write rather than on a timer, so nothing keeps the process alive at shutdown.
    if (hits.size > 10_000) {
      for (const [candidate, entry] of hits) {
        if (entry.resetAt <= now) hits.delete(candidate)
      }
    }
  }
}

/**
 * Builds an email-and-password `AuthProvider` on top of any `AuthStore`.
 *
 * Mounts the whole flow at `/auth/*` and identifies requests from a short-lived access JWT.
 * Sessions are revocable: logout deletes the refresh row, and the access token expires within
 * its window (D20).
 *
 * Storage bricks call this; applications call the storage brick.
 */
export function passwordAuthProvider(
  options: PasswordAuthOptions,
): AuthProvider<StoredUser> & PasswordAuthService {
  const {
    store,
    name,
    secret,
    refreshCookie = COOKIE_DEFAULT,
    password = true,
    oauth,
    callbackUrl,
    afterOAuth,
    fetcher,
    accessTtl = 15 * 60,
    refreshTtl = 30 * 24 * 60 * 60,
    resetTtl = 60 * 60,
    minPasswordLength = 8,
    sendResetEmail,
    rateLimit: rateLimitOptions,
  } = options

  /**
   * Everything about a misconfigured social sign-in is checked here, at construction, rather than
   * at the first callback (D19).
   *
   * A store without account methods, or a missing callback URL, produces a redirect that works
   * right up until someone comes back from Google — which is the worst possible moment to find
   * out, because it happens in production, to a real person, and looks like the provider's fault.
   */
  if (oauth && Object.keys(oauth).length > 0) {
    if (!supportsAccounts(store)) {
      throw new Error(
        `The "${name}" auth store cannot hold linked accounts, so social sign-in cannot work. ` +
          'For auth-basic, pass `drizzleStore(db, { accounts: true })` and add ' +
          "`export * from '@theoven/auth-basic/schema/accounts'` to your schema.",
      )
    }
    if (typeof callbackUrl !== 'function') {
      throw new Error(
        'Social sign-in needs `callbackUrl`, because only your application knows its own public ' +
          'URL. Deriving it from the request Host header would let a caller choose where the ' +
          'authorization code is sent.',
      )
    }
  }

  const limits =
    rateLimitOptions === false ? null : { ...RATE_DEFAULTS, ...(rateLimitOptions ?? {}) }

  const throttleLogin = limits ? throttle(limits.login, limits.window) : null
  const throttleSignup = limits ? throttle(limits.signup, limits.window) : null
  const throttleForgot = limits ? throttle(limits.forgotPassword, limits.window) : null

  if (!secret) {
    throw new Error(
      `${name} auth needs a secret to sign access tokens. Read one from the environment: ` +
        "{ secret: env.string('AUTH_SECRET'), ... }",
    )
  }

  const flows: FlowConfig = {
    store,
    secret,
    accessTtl,
    refreshTtl,
    resetTtl,
    minPasswordLength,
    ...(sendResetEmail ? { sendResetEmail } : {}),
  }

  /** Sets the refresh cookie with the same lifetime as the token it carries. */
  function setRefreshCookie(ctx: Context, token: string): void {
    ctx.cookies.set(refreshCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: refreshTtl,
      // Scoped to the refresh endpoint so it is not sent with every request to the app.
      path: '/',
    })
  }

  function readRefreshToken(ctx: Context): string {
    const token = ctx.cookies.get(refreshCookie)
    if (!token) throw new Unauthorized('No refresh token.')
    return token
  }

  return {
    name,
    flows,

    capabilities: { routes: true, signOut: true, refresh: true },

    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },

    /**
     * Identifies a request from its access token.
     *
     * A signature check and an expiry check — no database read. That is the trade the design
     * makes: fast identification, and revocation handled by the refresh token instead.
     */
    identify: async (ctx): Promise<Identity<StoredUser> | null> => {
      const token = ctx.token
      if (!token) return null

      const claims = verifyAccessToken(token, secret)
      if (!claims) return null

      const user = await flows.store.findUserById(claims.sub)
      return user ? toIdentity(user) : null
    },

    signOut: async (ctx) => {
      const token = ctx.cookies.get(refreshCookie)
      if (token) await logout(flows, token)
      ctx.cookies.delete(refreshCookie)
    },

    mount: (register: MountRegistrar, prefix: string) => {
      /**
       * The password endpoints, mounted only when the password flow is on.
       *
       * An application that signs people in with Google alone does not want a live `/auth/signup`
       * quietly accepting passwords behind it. That is not clutter, it is a way in nobody
       * intended (D33).
       */
      if (password) {
        register('POST', `${prefix}/signup`, async (ctx) => {
          throttleSignup?.(ctx.ip ?? 'unknown')
          const body = (await ctx.body) as { email?: string; password?: string; name?: string }
          if (!body?.email || !body.password || !body.name) {
            throw new BadRequest('email, password and name are required.')
          }

          const { user, tokens } = await signup(flows, {
            email: body.email,
            password: body.password,
            name: body.name,
          })

          setRefreshCookie(ctx, tokens.refreshToken)
          ctx.status = 201
          return {
            user: publicUser(user),
            accessToken: tokens.accessToken,
            expiresIn: tokens.expiresIn,
          }
        })

        register('POST', `${prefix}/login`, async (ctx) => {
          const body = (await ctx.body) as { email?: string; password?: string }
          if (!body?.email || !body.password) {
            throw new BadRequest('email and password are required.')
          }

          // Both keys: by IP alone a distributed attempt on one account walks through, and by
          // email alone one host can spray the whole user table.
          throttleLogin?.(`ip:${ctx.ip ?? 'unknown'}`)
          throttleLogin?.(`email:${body.email.trim().toLowerCase()}`)

          const { user, tokens } = await login(flows, {
            email: body.email,
            password: body.password,
          })

          setRefreshCookie(ctx, tokens.refreshToken)
          return {
            user: publicUser(user),
            accessToken: tokens.accessToken,
            expiresIn: tokens.expiresIn,
          }
        })
      }

      register('POST', `${prefix}/refresh`, async (ctx) => {
        const tokens = await refresh(flows, readRefreshToken(ctx))
        setRefreshCookie(ctx, tokens.refreshToken)
        return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn }
      })

      register('POST', `${prefix}/logout`, async (ctx) => {
        const token = ctx.cookies.get(refreshCookie)
        if (token) await logout(flows, token)
        ctx.cookies.delete(refreshCookie)
        ctx.status = 204
        return null
      })

      if (password) {
        register('POST', `${prefix}/forgot-password`, async (ctx) => {
          const body = (await ctx.body) as { email?: string }
          if (!body?.email) throw new BadRequest('email is required.')

          throttleForgot?.(`ip:${ctx.ip ?? 'unknown'}`)
          throttleForgot?.(`email:${body.email.trim().toLowerCase()}`)

          await requestPasswordReset(flows, body.email)
          // Always the same answer, whether or not the address exists — see the flow for why.
          return { message: 'If that email has an account, a reset link is on its way.' }
        })

        register('POST', `${prefix}/reset-password`, async (ctx) => {
          const body = (await ctx.body) as { token?: string; password?: string }
          if (!body?.token || !body.password) {
            throw new BadRequest('token and password are required.')
          }

          await resetPassword(flows, body.token, body.password)
          ctx.cookies.delete(refreshCookie)
          return { message: 'Password updated. Please sign in again.' }
        })

        register('POST', `${prefix}/change-password`, async (ctx) => {
          const user = (ctx as Context & { user?: Identity<StoredUser> | null }).user
          if (!user) throw new Unauthorized('Authentication required.')

          const body = (await ctx.body) as { current?: string; next?: string }
          if (!body?.current || !body.next) {
            throw new BadRequest('current and next are required.')
          }

          await changePassword(flows, user.id, { current: body.current, next: body.next })
          ctx.cookies.delete(refreshCookie)
          return { message: 'Password changed. Other sessions have been signed out.' }
        })
      }

      for (const [key, configured] of Object.entries(oauth ?? {})) {
        const { provider, ...providerOptions } = configured
        const oauthConfig: OAuthConfig = {
          ...flows,
          store: flows.store as OAuthConfig['store'],
          callbackUrl: callbackUrl as (name: string) => string,
          ...(fetcher ? { fetcher } : {}),
        }

        register('GET', `${prefix}/oauth/${key}`, async (ctx) => {
          const target = await startOAuth(
            oauthConfig,
            provider,
            providerOptions,
            ctx,
            (ctx.query as { redirect?: string }).redirect,
          )
          return ctx.redirect(target, 302)
        })

        register('GET', `${prefix}/oauth/${key}/callback`, async (ctx) => {
          const result = await completeOAuth(oauthConfig, provider, providerOptions, ctx)

          setRefreshCookie(ctx, result.tokens.refreshToken)

          // A browser that started this needs somewhere to land; an API client wants the tokens.
          const destination = result.redirectTo ?? afterOAuth
          if (destination) return ctx.redirect(destination, 302)

          return {
            user: publicUser(result.user),
            accessToken: result.tokens.accessToken,
            expiresIn: result.tokens.expiresIn,
            created: result.created,
          }
        })
      }

      register('GET', `${prefix}/me`, async (ctx) => {
        const user = (ctx as Context & { user?: Identity<StoredUser> | null }).user
        if (!user) throw new Unauthorized('Authentication required.')
        return publicUser(user)
      })
    },
  }
}

/** The user fields safe to return over HTTP. Never the password hash. */
function publicUser(user: Identity<StoredUser>): {
  id: string
  email: string | undefined
  name: string | undefined
} {
  return { id: user.id, email: user.email, name: user.name }
}
