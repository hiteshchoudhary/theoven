import { timingSafeEqual as nativeTimingSafeEqual } from 'node:crypto'

/**
 * The primitives every webhook signature scheme is built from.
 *
 * Providers differ only in what string they sign and where they put the result. The comparison
 * and the HMAC are the same everywhere, so they live here once — a second copy is a second place
 * for a `===` to creep back in.
 */

/** HMAC-SHA256 of `payload`, hex-encoded. */
export function hmacHex(secret: string | Uint8Array, payload: string): string {
  return new Bun.CryptoHasher('sha256', secret).update(payload).digest('hex')
}

/** HMAC-SHA256 of `payload`, base64-encoded. Shopify and Svix both want it this way. */
export function hmacBase64(secret: string | Uint8Array, payload: string): string {
  return new Bun.CryptoHasher('sha256', secret).update(payload).digest('base64')
}

/**
 * Compares two signatures without leaking where they diverge.
 *
 * `a === b` short-circuits at the first differing byte, and that difference is measurable over
 * enough requests. It turns forging a signature from guessing 2^256 values into guessing 32
 * bytes one at a time, which is the difference between impossible and an afternoon.
 *
 * **Node's native implementation, not a hand-rolled loop.** A JavaScript loop accumulating XOR
 * *looks* constant-time and is not guaranteed to be one: the JIT is free to reorder or
 * short-circuit it, and `charCodeAt` on a rope or a latin1-backed string is not obviously
 * uniform. `crypto.timingSafeEqual` is native and exists precisely so this is not our problem.
 *
 * Note what a test can and cannot show here. Every test in this package still passes if this
 * function is replaced by `===`, because the *results* are identical — only the timing differs,
 * and timing is statistical and machine-dependent. This one is carried by review, not coverage.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')

  // Native comparison throws on a length mismatch rather than returning false, and a length is
  // not a secret — a signature's length is fixed by its algorithm, so leaking it reveals nothing.
  if (left.length !== right.length) return false

  return nativeTimingSafeEqual(left, right)
}

/** True when any candidate matches, compared safely. Providers rotate secrets, so lists happen. */
export function matchesAny(expected: string, candidates: readonly string[]): boolean {
  // Not `.some()` with a short-circuit: every candidate is compared, so the number of signatures
  // a request carries does not change how long the check takes.
  let matched = false
  for (const candidate of candidates) {
    if (timingSafeEqual(expected, candidate)) matched = true
  }
  return matched
}

/**
 * Rejects a signature that is correct but old.
 *
 * A captured request stays valid forever without this — the signature does not expire on its own.
 * Providers that include a timestamp in the signed payload (Stripe, Slack, Svix) make replay
 * detectable; ones that do not (GitHub, Shopify, Razorpay) cannot, and their pages say so.
 */
export function withinTolerance(
  timestamp: number,
  toleranceSeconds: number,
  now = Date.now(),
): boolean {
  const age = Math.abs(now / 1000 - timestamp)
  return age <= toleranceSeconds
}
