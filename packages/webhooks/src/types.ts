/** The parts of a request a verifier is allowed to see. */
export interface SignedRequest {
  /** The exact bytes as they arrived. Never a re-serialised parse — that is the whole point. */
  body: string
  headers: Headers
  /** Overridable so replay-window tests are not a race against the clock. */
  now?: number
}

/** Why a webhook was refused. Returned rather than thrown, so the route decides the status. */
export type VerificationFailure =
  | { reason: 'missing-header'; header: string }
  | { reason: 'malformed-header'; header: string }
  | { reason: 'signature-mismatch' }
  | { reason: 'timestamp-outside-tolerance'; ageSeconds: number }

export type VerificationResult =
  | { ok: true; id?: string | undefined; timestamp?: number | undefined }
  | ({ ok: false } & VerificationFailure)

/**
 * One provider's signature scheme.
 *
 * `replayProtected` is declared rather than assumed (D19): GitHub, Shopify and Razorpay sign only
 * the body, so a captured request stays valid forever and no verifier can pretend otherwise.
 */
export interface WebhookVerifier {
  name: string
  /** Whether this provider's signature covers a timestamp, making replay detectable. */
  replayProtected: boolean
  verify(request: SignedRequest): VerificationResult
}
