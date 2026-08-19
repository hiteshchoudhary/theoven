import { routesFor } from '@theoven/core'
import type { app } from './app'

/**
 * `defineRoute`, bound to this app's bricks.
 *
 * Without it a route file cannot see what `app.ts` registered — `ctx.db` and `ctx.storage` would
 * be `unknown`, which gives up the typing in the one place most routes are written.
 *
 * The import is **type-only**, so this does not create a cycle with the module that loads the
 * route files.
 */
export const route = routesFor<typeof app>()
