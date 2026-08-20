import type { SignedRequest, VerificationResult, WebhookVerifier } from '../types'
import { hmacHex, matchesAny, withinTolerance } from '../verify'

export interface StripeOptions {
  /** The endpoint's signing secret — `whsec_…`, not your API key. */
  secret: string
  /** How old a delivery may be, in seconds. Stripe's own default is 300. */
  tolerance?: number
}

/**
 * Stripe — `Stripe-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over `${t}.${body}`.
 *
 * The timestamp being *inside* the signed payload is what makes replay detectable: an attacker
 * cannot move the clock forward without invalidating the signature.
 *
 * The header may carry several `v1` values during a secret rotation, so every one is compared.
 */
export function stripe(options: StripeOptions): WebhookVerifier {
  const tolerance = options.tolerance ?? 300

  return {
    name: 'stripe',
    replayProtected: true,

    verify(request: SignedRequest): VerificationResult {
      const header = request.headers.get('stripe-signature')
      if (!header) return { ok: false, reason: 'missing-header', header: 'Stripe-Signature' }

      let timestamp: number | undefined
      const signatures: string[] = []

      for (const part of header.split(',')) {
        const [key, value] = part.trim().split('=')
        if (!value) continue
        if (key === 't') timestamp = Number(value)
        if (key === 'v1') signatures.push(value)
      }

      if (timestamp === undefined || Number.isNaN(timestamp) || signatures.length === 0) {
        return { ok: false, reason: 'malformed-header', header: 'Stripe-Signature' }
      }

      const expected = hmacHex(options.secret, `${timestamp}.${request.body}`)
      // Signature before timestamp: telling an unauthenticated caller their timestamp is stale
      // confirms the endpoint exists and the header shape was right.
      if (!matchesAny(expected, signatures)) return { ok: false, reason: 'signature-mismatch' }

      if (!withinTolerance(timestamp, tolerance, request.now)) {
        return {
          ok: false,
          reason: 'timestamp-outside-tolerance',
          ageSeconds: Math.round(Math.abs((request.now ?? Date.now()) / 1000 - timestamp)),
        }
      }

      return { ok: true, timestamp }
    },
  }
}
