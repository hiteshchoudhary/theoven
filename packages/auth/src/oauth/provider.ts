/**
 * A profile as a provider reports it, before it becomes a user.
 *
 * `email` and `emailVerified` are separate because the second is the one that matters: linking an
 * incoming sign-in to an existing account on a matching email is only safe when the provider has
 * actually checked the person owns it (D33).
 */
export interface OAuthProfile {
  /** The provider's own stable subject id. Never the email. */
  accountId: string
  email: string
  emailVerified: boolean
  name: string
  image?: string | undefined
}

/** Tokens as returned by a provider's token endpoint. */
export interface OAuthTokens {
  accessToken: string
  refreshToken?: string | undefined
  expiresIn?: number | undefined
  idToken?: string | undefined
}

/**
 * Everything that differs between one OAuth2 provider and the next.
 *
 * Deliberately small. The authorization-code dance is one protocol, so a provider is mostly
 * configuration plus a mapper — which is why social sign-in is one feature with a provider
 * registry rather than a brick per provider.
 */
export interface OAuthProvider {
  /** `google`, `github`, … Appears in URLs and in the accounts table. */
  name: string
  authorizationUrl: string
  tokenUrl: string
  /** Requested unless the application overrides them. */
  defaultScopes: readonly string[]
  /** Extra parameters this provider needs on the authorization request. */
  authorizationParams?: Record<string, string>
  /** Whether to send and verify a `nonce`. OIDC providers only. */
  usesNonce?: boolean
  /** Turns a token response into a profile, fetching whatever else the provider requires. */
  profile(tokens: OAuthTokens, fetcher: typeof fetch): Promise<OAuthProfile>
}

/** What an application configures for one provider. */
export interface OAuthProviderOptions {
  clientId: string
  clientSecret: string
  /** Overrides the provider's defaults. */
  scopes?: readonly string[]
  /**
   * Keep the provider's access and refresh tokens on the linked account.
   *
   * Off by default (D35): most applications want sign-in, not the provider's API, and tokens
   * nobody reads are a liability rather than a feature.
   */
  storeTokens?: boolean
}
