import {
  type Brick,
  type Context,
  Forbidden,
  type HttpMethod,
  router,
  Unauthorized,
} from '@theoven/core'
import type { Identity } from './identity'
import { type AuthRequirement, type Policies, policyNames, requirementOf } from './policy'

/**
 * What an auth brick must provide.
 *
 * `identify()` is the only required method. Everything else is a declared capability, because
 * providers genuinely differ: Clerk cannot sign a user in from a server, and better-auth cannot
 * not-mount routes. Requiring both to pretend produces adapters that throw at 3am; declaring
 * capabilities makes the gap visible at boot instead (D19).
 */
export interface AuthProvider<Raw = unknown> {
  /** Identifies the provider in errors, e.g. `clerk` or `basic`. */
  readonly name: string

  /**
   * Works out who this request is from.
   *
   * Returns `null` for an anonymous request. Should **not** throw for a merely absent or invalid
   * credential — a public route on the same app still has to work.
   */
  identify(ctx: Context): Promise<Identity<Raw> | null> | Identity<Raw> | null

  capabilities?: {
    /** Mounts its own routes, e.g. `/auth/*`. */
    routes?: boolean
    signOut?: boolean
    refresh?: boolean
  }

  /** Registers the provider's own routes. Required when `capabilities.routes` is set. */
  mount?(register: MountRegistrar, prefix: string): void

  signOut?(ctx: Context): Promise<void> | void

  /** OpenAPI security schemes this provider uses, merged into the document. */
  securitySchemes?: Record<string, unknown>

  /** Closes anything the provider opened. */
  close?(): Promise<void> | void
}

/** The narrow slice of route registration a provider needs. */
export type MountRegistrar = (
  method: string,
  path: string,
  handler: (ctx: Context) => unknown,
) => void

export interface AuthOptions<Raw = unknown> {
  /** Named authorization rules, referenced by routes as `auth: 'admin'`. */
  policies?: Policies<Raw>
  /** Where the provider's routes are mounted, when it has any. Default `/auth`. */
  prefix?: string
}

/** Raised when a route asks for something the configured provider cannot do. */
export class AuthConfigurationError extends Error {
  override name = 'AuthConfigurationError'
}

/**
 * The auth brick.
 *
 * ```ts
 * const app = createApp().use(auth(basicAuth({ ... }), { policies }))
 *
 * app.get('/me', { auth: true }, (ctx) => ctx.user)      // 401 when anonymous
 * app.get('/admin', { auth: 'admin' }, (ctx) => ...)     // 403 unless the policy passes
 * ```
 *
 * `ctx.user` is `Identity | null` on every route, and the guard is what narrows it: a route
 * declaring `auth: true` cannot be reached anonymously, so inside it the user is present.
 */
export function auth<Raw>(
  provider: AuthProvider<Raw>,
  options: AuthOptions<Raw> = {},
): Brick<'auth', AuthProvider<Raw>, { user: Identity<Raw> | null }> {
  const { policies = {}, prefix = '/auth' } = options

  return {
    name: 'auth',

    setup: (context) => {
      if (provider.capabilities?.routes) {
        if (!provider.mount) {
          throw new AuthConfigurationError(
            `The "${provider.name}" provider declares the "routes" capability but has no ` +
              'mount() method.',
          )
        }
        /**
         * The provider still registers one path at a time — `MountRegistrar` is a public
         * contract that third-party adapters implement, and changing it to gain a tag would
         * break every one of them for no benefit they asked for.
         *
         * What changed is where those registrations land: a router rather than the app. The
         * endpoints come out grouped and tagged, so they read as one feature in the generated
         * document and in `oven routes`, and the adapter is untouched.
         */
        const mounted = router({ tags: ['auth'] })
        provider.mount((method, path, handler) => {
          mounted.route(method as HttpMethod, path, handler as never)
        }, prefix)
        context.mount(mounted)
      }

      if (provider.securitySchemes) {
        context.app.contributeOpenApi({ securitySchemes: provider.securitySchemes })
      }

      return provider
    },

    request: async (ctx, route) => {
      const user = (await provider.identify(ctx)) ?? null
      const requirement = requirementOf(route.schema)

      // Enforced here rather than in a handler: a guarded route must be unreachable, not
      // merely inconvenient to reach.
      if (requirement !== undefined && requirement !== false) {
        await enforce(requirement, user, ctx, policies, provider.name)
      }

      return { user }
    },

    onShutdown: async () => {
      await provider.close?.()
    },
  }
}

async function enforce<Raw>(
  requirement: AuthRequirement,
  user: Identity<Raw> | null,
  ctx: Context,
  policies: Policies<Raw>,
  providerName: string,
): Promise<void> {
  if (!user) {
    throw new Unauthorized('Authentication required.', {
      // Tells a client *how* to authenticate, which is what the header is for.
      headers: { 'www-authenticate': 'Bearer' },
    })
  }

  for (const name of policyNames(requirement)) {
    const policy = policies[name]

    // A typo'd policy name must never mean "allowed". Failing closed and loudly is the only
    // safe reading of a rule that does not exist.
    if (!policy) {
      throw new AuthConfigurationError(
        `A route requires the "${name}" policy, which is not registered. ` +
          `Add it to auth(${providerName}, { policies }). Known policies: ` +
          `${Object.keys(policies).join(', ') || '(none)'}.`,
      )
    }

    if (!(await policy(user, ctx))) {
      throw new Forbidden(`This action requires "${name}".`)
    }
  }
}

/**
 * Narrows `ctx.user` to a present identity.
 *
 * For code reached from a route that did not declare `auth: true` — a helper shared between a
 * guarded and an unguarded route, for instance.
 *
 * @throws {Unauthorized} when nobody is signed in
 */
export function requireUser<Raw>(user: Identity<Raw> | null): Identity<Raw> {
  if (!user) throw new Unauthorized('Authentication required.')
  return user
}
