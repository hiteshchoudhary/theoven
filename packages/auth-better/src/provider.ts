import type { AuthProvider, Identity, MountRegistrar } from '@theoven/auth'
import type { Context } from '@theoven/core'

/**
 * The slice of a better-auth instance this brick uses.
 *
 * Structural rather than imported, so the brick does not pin a better-auth version through its
 * types. Anything with a `handler` and a `getSession` fits — including a test double, which is
 * how this is tested without a database.
 */
export interface BetterAuthInstance {
  handler(request: Request): Promise<Response>
  api: {
    getSession(input: { headers: Headers }): Promise<BetterAuthSession | null>
    signOut?(input: { headers: Headers }): Promise<unknown>
  }
  options?: { basePath?: string | undefined }
}

export interface BetterAuthSession {
  user: {
    id: string
    email?: string | null
    name?: string | null
    image?: string | null
    [field: string]: unknown
  }
  session?: { id?: string; [field: string]: unknown }
}

export interface BetterAuthOptions {
  /**
   * The better-auth instance, built by you.
   *
   * Not wrapped: better-auth's configuration — database, providers, plugins — is its own, large,
   * and moving. A wrapper around it would be permanently behind, and would hide the option you
   * needed. You call `betterAuth({ ... })`; this brick mounts it.
   */
  instance: BetterAuthInstance
  /**
   * Skips the boot-time check that better-auth's `basePath` matches where Oven mounts it.
   *
   * Only set this if you are deliberately routing to it some other way.
   */
  skipBasePathCheck?: boolean
}

/**
 * better-auth as an Oven auth provider.
 *
 * The provider that exercises the `routes` capability: better-auth owns sign-in, sign-up, OAuth
 * callbacks, verification and sessions, and needs its own endpoints mounted. Oven hands it every
 * request under the prefix and stays out of the way.
 *
 * ```ts
 * const instance = betterAuth({ database, basePath: '/auth', emailAndPassword: { enabled: true } })
 *
 * const app = createApp().use(auth(betterAuthProvider({ instance })))
 * ```
 *
 * The opposite of [`auth-clerk`](/docs/bricks/auth-clerk/), which mounts nothing at all. The same
 * `AuthProvider` interface fits both.
 */
export function betterAuthProvider(
  options: BetterAuthOptions,
): AuthProvider<BetterAuthSession['user']> {
  const { instance, skipBasePathCheck = false } = options

  if (!instance?.handler || !instance.api?.getSession) {
    throw new Error(
      'betterAuthProvider needs a better-auth instance: ' +
        'betterAuthProvider({ instance: betterAuth({ ... }) })',
    )
  }

  return {
    name: 'better-auth',

    /**
     * Refresh is better-auth's own business — it rotates sessions internally on its endpoints,
     * with no server-side call for an application to make. Declaring it would offer a method
     * that had nothing to do.
     */
    capabilities: { routes: true, signOut: Boolean(instance.api.signOut), refresh: false },

    securitySchemes: {
      betterAuthSession: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
    },

    identify: async (ctx: Context): Promise<Identity<BetterAuthSession['user']> | null> => {
      // better-auth reads its own cookie or bearer token off the headers. Passing the headers
      // rather than a token means whatever scheme it is configured for keeps working.
      const session = await instance.api.getSession({ headers: ctx.req.headers }).catch(() => null)
      if (!session?.user?.id) return null

      const { id, email, name, image } = session.user
      return {
        id,
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
        ...(image ? { image } : {}),
        raw: session.user,
      }
    },

    signOut: async (ctx: Context) => {
      await instance.api.signOut?.({ headers: ctx.req.headers })
    },

    /**
     * Mounts better-auth under the prefix, on every method.
     *
     * A wildcard rather than an enumerated route list, because better-auth's endpoints depend on
     * which plugins are enabled — an enumerated list would be wrong the moment someone added
     * one. The cost is that `oven routes` shows a wildcard instead of thirty paths, which the
     * brick page says.
     */
    mount: (register: MountRegistrar, prefix: string) => {
      if (!skipBasePathCheck) {
        const configured = instance.options?.basePath
        // The failure this prevents is a 404 from inside better-auth on every request, which
        // looks like a routing bug in Oven and is not one.
        if (configured !== undefined && normalize(configured) !== normalize(prefix)) {
          throw new Error(
            `better-auth is configured with basePath "${configured}" but Oven mounts it at ` +
              `"${prefix}". Make them match — betterAuth({ basePath: '${prefix}' }) — or mount ` +
              `the brick with auth(provider, { prefix: '${configured}' }).`,
          )
        }
      }

      const forward = (ctx: Context): Promise<Response> => instance.handler(ctx.req)

      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        register(method, `${prefix}/*`, forward)
        // The prefix itself, which a wildcard child does not cover.
        register(method, prefix, forward)
      }
    },
  }
}

function normalize(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`
}
