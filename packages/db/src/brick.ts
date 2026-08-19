import type { Brick, Context } from '@theoven/core'
import { checkHealth, DatabaseError, type DatabaseProvider, rememberProvider } from './provider'

export interface DatabaseOptions {
  /**
   * Mount a health endpoint at this path. `false` by default.
   *
   * Off unless asked for: a brick that silently adds a route to your application is a brick
   * that shows up unexplained in `oven routes`, and health endpoints in particular are
   * something people want to place and protect themselves.
   */
  healthPath?: string | false

  /**
   * Verify the connection during boot rather than on the first query.
   *
   * On by default. A misconfigured database that fails at boot costs one restart; the same
   * misconfiguration discovered on the first request costs a deploy that looked green.
   */
  checkOnBoot?: boolean
}

/**
 * The database brick.
 *
 * ```ts
 * const app = createApp().use(db(drizzleSqlite({ url: './data.db' })))
 *
 * app.get('/users', (ctx) => ctx.db.select().from(users))
 * //                        ^ the Drizzle instance itself, typed from your schema
 * ```
 *
 * `ctx.db` is exactly what the provider connected — no wrapper, no proxy, nothing of ours
 * added to it. The brick's job is the part every application repeats and gets subtly wrong:
 * connecting once, verifying it at boot, and closing cleanly on shutdown.
 */
export function db<Client>(
  provider: DatabaseProvider<Client>,
  options: DatabaseOptions = {},
): Brick<'db', Client> {
  const { healthPath = false, checkOnBoot = true } = options

  return {
    name: 'db',

    setup: async (context) => {
      let client: Client
      try {
        client = await provider.connect()
      } catch (cause) {
        throw new DatabaseError(`Could not connect using the "${provider.name}" provider.`, {
          provider: provider.name,
          cause,
        })
      }

      rememberProvider(client, provider)

      if (checkOnBoot) {
        const healthy = await checkHealth(client)
        if (!healthy) {
          throw new DatabaseError(
            `Connected using "${provider.name}", but its health check failed. The connection ` +
              'opened and the database did not answer a query.',
            { provider: provider.name },
          )
        }
      }

      if (healthPath) {
        context.route('GET', healthPath, async (ctx: Context) => {
          const healthy = await checkHealth(client)
          // 503 rather than a 200 carrying `{ healthy: false }`: a load balancer reads the
          // status line, not the body.
          if (!healthy) ctx.status = 503
          return { database: provider.name, healthy }
        })
      }

      return client
    },

    onShutdown: async (client) => {
      await provider.close(client)
    },
  }
}
