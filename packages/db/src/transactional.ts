import type { Context, Middleware } from '@theoven/core'
import { providerFor, transaction } from './provider'

/**
 * Wraps every matching request in a database transaction.
 *
 * `ctx.db` becomes the transaction-scoped client for the duration, so handlers need no change:
 * a request that throws rolls back everything it wrote.
 *
 * ```ts
 * app.use('/admin', transactional())
 * ```
 *
 * Middleware rather than a brick option, because a transaction has to *wrap* the handler and a
 * brick's `request()` hook returns before the handler runs. Being middleware also makes the
 * scope explicit — which matters, because this is not something to switch on globally without
 * thinking.
 */
export function transactional(): Middleware {
  return async (ctx, next) => {
    const client = (ctx as Context & { db?: unknown }).db

    // No database brick registered, or a client from outside Oven: carry on rather than fail.
    // A missing transaction is a reason to say nothing here; the alternative is breaking every
    // route in an app that added this line optimistically.
    if (!client || !providerFor(client)) return next()

    return transaction(client, async (tx) => {
      // An own property shadows the prototype value for this request only.
      Object.defineProperty(ctx, 'db', { value: tx, configurable: true, writable: true })
      return next()
    })
  }
}
