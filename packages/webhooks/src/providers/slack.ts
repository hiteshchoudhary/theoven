import type { SignedRequest, VerificationResult, WebhookVerifier } from '../types'
import { hmacHex, timingSafeEqual, withinTolerance } from '../verify'

export interface SlackOptions {
  /** The app's signing secret, from Basic Information — not a bot token. */
  secret: string
  tolerance?: number
}

/**
 * Slack — `X-Slack-Signature: v0=<hex>` over the literal string `v0:${timestamp}:${body}`.
 *
 * The timestamp is in a *separate* header and also inside the signed string, so tampering with it
 * breaks the signature. Slack recommends 300 seconds, and says plainly that a longer window is a
 * replay window.
 */
export function slack(options: SlackOptions): WebhookVerifier {
  const tolerance = options.tolerance ?? 300

  return {
    name: 'slack',
    replayProtected: true,

    verify(request: SignedRequest): VerificationResult {
      const signature = request.headers.get('x-slack-signature')
      if (!signature) return { ok: false, reason: 'missing-header', header: 'X-Slack-Signature' }

      const raw = request.headers.get('x-slack-request-timestamp')
      if (!raw) {
        return { ok: false, reason: 'missing-header', header: 'X-Slack-Request-Timestamp' }
      }

      const timestamp = Number(raw)
      if (Number.isNaN(timestamp)) {
        return { ok: false, reason: 'malformed-header', header: 'X-Slack-Request-Timestamp' }
      }

      const expected = `v0=${hmacHex(options.secret, `v0:${timestamp}:${request.body}`)}`
      if (!timingSafeEqual(expected, signature)) return { ok: false, reason: 'signature-mismatch' }

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
