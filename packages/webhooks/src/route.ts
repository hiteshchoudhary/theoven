import {
  BadRequest,
  type Context,
  defineRoute,
  type RouteDefinition,
  Unauthorized,
} from '@theoven/core'
import type { VerificationResult, WebhookVerifier } from './types'

/** What a verified delivery looks like to a handler. */
export interface VerifiedWebhook<Payload = unknown> {
  /** The parsed body — parsed only *after* the signature covered the bytes it came from. */
  payload: Payload
  /** The provider's delivery id, where it sends one. The key to deduplicate on. */
  id: string | undefined
  timestamp: number | undefined
  provider: string
  /** The exact bytes, for anything that needs them again. */
  raw: string
}

export interface WebhookOptions {
  /**
   * Called when verification fails, before the request is refused.
   *
   * A webhook that starts failing is usually a rotated secret or a clock, and it is silent — the
   * provider retries and gives up, and nobody finds out until something downstream is missing.
   */
  onRejected?: (failure: Extract<VerificationResult, { ok: false }>, ctx: Context) => void
}

/**
 * A route that runs its handler **only** for a delivery whose signature checked out.
 *
 * The ordering is the point, and it is the same argument as `auth: true` running before a
 * handler: an unverified webhook must be *unreachable*, not merely inconvenient to act on. A
 * handler that verifies on its first line is one early `return` away from not verifying.
 *
 * ```ts title="src/routes/webhooks/stripe.post.ts"
 * import { stripe, webhook } from '@theoven/webhooks'
 *
 * export default webhook(stripe({ secret: env.string('STRIPE_WEBHOOK_SECRET') }), async (ctx) => {
 *   const event = ctx.webhook.payload as Stripe.Event
 *   await ctx.queue.dispatch(handleStripe, { event }, { key: ctx.webhook.id })
 *   return { received: true }
 * })
 * ```
 */
export function webhook<Payload = unknown>(
  verifier: WebhookVerifier,
  handler: (ctx: Context & { webhook: VerifiedWebhook<Payload> }) => unknown,
  options: WebhookOptions = {},
): (ctx: Context) => Promise<unknown> {
  /**
   * A plain handler, not a `defineRoute` definition.
   *
   * A definition only works where file routing reads it. A handler works there *and* in
   * `app.post('/hook', …)`, because a route file's default export may be a bare function — so one
   * shape covers both registration styles instead of one covering half of them.
   */
  return async (ctx: Context) => {
    /**
     * The raw bytes, not `ctx.body`.
     *
     * A signature covers the exact payload. Re-serialising a parse produces different bytes —
     * a reordered key, a changed number format — and a signature that fails for reasons no
     * amount of staring at the JSON explains. Core keeps `rawBody` for precisely this.
     */
    const raw = new TextDecoder().decode(await ctx.rawBody)
    const result = verifier.verify({ body: raw, headers: ctx.req.headers })

    if (!result.ok) {
      options.onRejected?.(result, ctx)

      // 400 for a malformed or missing header — the caller sent something wrong.
      // 401 for a signature that did not match — the caller failed to authenticate.
      if (result.reason === 'signature-mismatch') {
        throw new Unauthorized(`This ${verifier.name} webhook signature did not verify.`)
      }
      if (result.reason === 'timestamp-outside-tolerance') {
        throw new BadRequest(
          `This ${verifier.name} webhook is ${result.ageSeconds}s old, outside the replay window.`,
        )
      }
      throw new BadRequest(`Missing or malformed ${result.header}.`)
    }

    // Parsed from the bytes the signature covered, so the handler cannot see a different body
    // from the one that was verified.
    let payload: unknown
    try {
      payload = raw.length > 0 ? JSON.parse(raw) : undefined
    } catch {
      throw new BadRequest('Signature verified, but the body is not JSON.')
    }

    const verified: VerifiedWebhook<Payload> = {
      payload: payload as Payload,
      id: result.id,
      timestamp: result.timestamp,
      provider: verifier.name,
      raw,
    }

    Object.defineProperty(ctx, 'webhook', { value: verified, enumerable: true, configurable: true })
    return handler(ctx as Context & { webhook: VerifiedWebhook<Payload> })
  }
}
