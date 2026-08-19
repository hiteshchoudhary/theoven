/**
 * Who a request is from.
 *
 * Only what every provider genuinely has. Clerk, better-auth, Auth0 and a hand-rolled JWT all
 * know an id, and usually an email; none of them agree on roles, organisations or metadata.
 * Normalising those would mean fields that are permanently empty on half the providers, and a
 * field that is always `[]` misleads worse than one that is absent (D17).
 *
 * Anything provider-specific lives on `raw`, typed per brick:
 *
 * ```ts
 * ctx.user?.id                    // portable
 * ctx.user?.raw.publicMetadata    // Clerk, typed
 * ```
 */
export interface Identity<Raw = unknown> {
  /** Stable identifier for this user, unique within the provider. */
  id: string
  email?: string
  name?: string
  image?: string
  /** Everything the provider returned, untouched. */
  raw: Raw
}

/**
 * A session, when the provider has a concept of one.
 *
 * Separate from `Identity` because they answer different questions — who this is, versus how
 * long they stay signed in — and providers with hosted sign-in often expose one without the
 * other.
 */
export interface Session {
  id: string
  userId: string
  /** When this session stops being valid. Absent when the provider does not say. */
  expiresAt?: Date
}
