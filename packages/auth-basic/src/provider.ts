import type { AuthProvider, FlowConfig, Identity, MountRegistrar, StoredUser } from '@theoven/auth'
import {
  changePassword,
  login,
  logout,
  refresh,
  requestPasswordReset,
  resetPassword,
  signup,
  toIdentity,
  verifyAccessToken,
} from '@theoven/auth'
import { BadRequest, type Context, Unauthorized } from '@theoven/core'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { drizzleStore } from './store'

export interface BasicAuthOptions {
  /** The Drizzle client. Usually the same one the rest of your app uses. */
  db: BunSQLiteDatabase<Record<string, unknown>>
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
   * Cookie holding the refresh token. Default `oven_refresh`.
   *
   * The refresh token is set as an httpOnly cookie rather than returned in the body, so a
   * cross-site script cannot read it. The short-lived access token goes in the body, where a
   * client can attach it to `Authorization`.
   */
  refreshCookie?: string
}

/** Everything `auth-basic` exposes on `ctx.auth`. */
export interface BasicAuthService {
  readonly name: string
  /** The flow configuration, for calling signup/login/etc. from your own routes. */
  readonly flows: FlowConfig
}

const COOKIE_DEFAULT = 'oven_refresh'

/**
 * Email-and-password auth, stored with Drizzle.
 *
 * Mounts the whole flow at `/auth/*` and identifies requests from a short-lived access JWT.
 * Sessions are revocable: logout deletes the refresh row, and the access token expires within
 * its window (D20).
 */
export function basicAuth(options: BasicAuthOptions): AuthProvider<StoredUser> & BasicAuthService {
  const {
    db,
    secret,
    refreshCookie = COOKIE_DEFAULT,
    accessTtl = 15 * 60,
    refreshTtl = 30 * 24 * 60 * 60,
    resetTtl = 60 * 60,
    minPasswordLength = 8,
    sendResetEmail,
  } = options

  if (!secret) {
    throw new Error(
      'basicAuth needs a secret to sign access tokens. Read one from the environment: ' +
        "basicAuth({ secret: env.string('AUTH_SECRET'), ... })",
    )
  }

  const flows: FlowConfig = {
    store: drizzleStore(db),
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
    name: 'basic',
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
      register('POST', `${prefix}/signup`, async (ctx) => {
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

      register('POST', `${prefix}/forgot-password`, async (ctx) => {
        const body = (await ctx.body) as { email?: string }
        if (!body?.email) throw new BadRequest('email is required.')

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
