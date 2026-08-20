import type { SignedRequest, VerificationResult, WebhookVerifier } from '../types'
import { hmacHex, timingSafeEqual } from '../verify'

export interface GitHubOptions {
  /** The secret set on the webhook, not a personal access token. */
  secret: string
}

/**
 * GitHub — `X-Hub-Signature-256`, HMAC-SHA256 of the raw body, hex, prefixed `sha256=`.
 *
 * The implementation is checked against GitHub's own published example rather than a value this
 * code produced, which would only prove it agrees with itself.
 */
export function github(options: GitHubOptions): WebhookVerifier {
  return {
    name: 'github',
    // GitHub signs the body and nothing else, so a captured delivery never expires.
    replayProtected: false,

    verify(request: SignedRequest): VerificationResult {
      const header = request.headers.get('x-hub-signature-256')
      if (!header) return { ok: false, reason: 'missing-header', header: 'X-Hub-Signature-256' }

      const [scheme, signature] = header.split('=')
      if (scheme !== 'sha256' || !signature) {
        return { ok: false, reason: 'malformed-header', header: 'X-Hub-Signature-256' }
      }

      const expected = hmacHex(options.secret, request.body)
      if (!timingSafeEqual(expected, signature)) return { ok: false, reason: 'signature-mismatch' }

      const id = request.headers.get('x-github-delivery')
      return id ? { ok: true, id } : { ok: true }
    },
  }
}
