import type { SignedRequest, VerificationResult, WebhookVerifier } from '../types'
import { hmacBase64, matchesAny, withinTolerance } from '../verify'

export interface SvixOptions {
  /** `whsec_<base64>`. The prefix is stripped and the rest is **base64-decoded** — see below. */
  secret: string
  tolerance?: number
}

/**
 * Svix, and therefore Clerk, Resend, Brex and everything else built on it.
 *
 * Signs `${id}.${timestamp}.${body}` and returns base64. Two details that are the usual reason a
 * hand-rolled check fails:
 *
 * 1. **The secret is base64 after the `whsec_` prefix**, and the *decoded bytes* are the HMAC key.
 *    Using the string as-is produces a signature that is wrong every time and looks right.
 * 2. **The header holds a space-separated list** of `v1,<sig>` pairs, because Svix supports
 *    rotation. Comparing only the first one fails during a rotation, which is exactly when
 *    nobody is watching.
 */
export function svix(options: SvixOptions): WebhookVerifier {
  const tolerance = options.tolerance ?? 300
  const key = Buffer.from(options.secret.replace(/^whsec_/, ''), 'base64')

  return {
    name: 'svix',
    replayProtected: true,

    verify(request: SignedRequest): VerificationResult {
      const id = request.headers.get('svix-id')
      const raw = request.headers.get('svix-timestamp')
      const header = request.headers.get('svix-signature')

      if (!id) return { ok: false, reason: 'missing-header', header: 'svix-id' }
      if (!raw) return { ok: false, reason: 'missing-header', header: 'svix-timestamp' }
      if (!header) return { ok: false, reason: 'missing-header', header: 'svix-signature' }

      const timestamp = Number(raw)
      if (Number.isNaN(timestamp)) {
        return { ok: false, reason: 'malformed-header', header: 'svix-timestamp' }
      }

      const signatures = header
        .split(' ')
        .map((part) => part.split(','))
        .filter(([version]) => version === 'v1')
        .map(([, signature]) => signature ?? '')
        .filter(Boolean)

      if (signatures.length === 0) {
        return { ok: false, reason: 'malformed-header', header: 'svix-signature' }
      }

      const expected = hmacBase64(key, `${id}.${timestamp}.${request.body}`)
      if (!matchesAny(expected, signatures)) return { ok: false, reason: 'signature-mismatch' }

      if (!withinTolerance(timestamp, tolerance, request.now)) {
        return {
          ok: false,
          reason: 'timestamp-outside-tolerance',
          ageSeconds: Math.round(Math.abs((request.now ?? Date.now()) / 1000 - timestamp)),
        }
      }

      return { ok: true, id, timestamp }
    },
  }
}
