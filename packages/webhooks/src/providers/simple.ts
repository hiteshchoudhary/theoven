import type { SignedRequest, VerificationResult, WebhookVerifier } from '../types'
import { hmacBase64, hmacHex, timingSafeEqual } from '../verify'

/**
 * The providers that sign the body and nothing else.
 *
 * Simpler to verify and **impossible to replay-protect**: with no timestamp inside the signature,
 * a captured delivery is valid forever. `replayProtected: false` says so, and the brick page says
 * what to do about it — record the delivery id and refuse one you have already handled.
 */
function bodyOnly(
  name: string,
  header: string,
  secret: string,
  encode: (secret: string, payload: string) => string,
  idHeader?: string,
): WebhookVerifier {
  return {
    name,
    replayProtected: false,

    verify(request: SignedRequest): VerificationResult {
      const signature = request.headers.get(header.toLowerCase())
      if (!signature) return { ok: false, reason: 'missing-header', header }

      const expected = encode(secret, request.body)
      if (!timingSafeEqual(expected, signature)) return { ok: false, reason: 'signature-mismatch' }

      const id = idHeader ? request.headers.get(idHeader) : null
      return id ? { ok: true, id } : { ok: true }
    },
  }
}

export interface SecretOptions {
  secret: string
}

/** Razorpay — `X-Razorpay-Signature`, hex HMAC of the raw body. */
export function razorpay(options: SecretOptions): WebhookVerifier {
  return bodyOnly(
    'razorpay',
    'X-Razorpay-Signature',
    options.secret,
    hmacHex,
    'x-razorpay-event-id',
  )
}

/** Shopify — `X-Shopify-Hmac-Sha256`, **base64** rather than hex. */
export function shopify(options: SecretOptions): WebhookVerifier {
  return bodyOnly(
    'shopify',
    'X-Shopify-Hmac-Sha256',
    options.secret,
    hmacBase64,
    'x-shopify-webhook-id',
  )
}
