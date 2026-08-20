import type { OAuthProfile, OAuthProvider, OAuthTokens } from './provider'

/** Claims we read off Google's id_token. Everything else is ignored. */
interface GoogleClaims {
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
}

/**
 * Reads a JWT payload without verifying its signature.
 *
 * Safe **only** here: this token arrived over TLS directly from Google's token endpoint, in
 * exchange for our client secret, rather than from the browser. A token that reached us any other
 * way would have to be verified against Google's JWKS, and this function must not be used for one.
 */
function claimsOf(idToken: string): GoogleClaims {
  const payload = idToken.split('.')[1]
  if (!payload) return {}
  try {
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as GoogleClaims
  } catch {
    return {}
  }
}

/**
 * Sign in with Google.
 *
 * OIDC, so the id_token carries the profile and no second call is needed. Its `email_verified`
 * claim is what makes Google safe to auto-link on (D33).
 */
export const google: OAuthProvider = {
  name: 'google',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  defaultScopes: ['openid', 'email', 'profile'],
  usesNonce: true,

  async profile(tokens: OAuthTokens): Promise<OAuthProfile> {
    const claims = tokens.idToken ? claimsOf(tokens.idToken) : {}

    if (!claims.sub) throw new Error('Google returned no subject claim.')
    if (!claims.email) throw new Error('Google returned no email address.')

    return {
      accountId: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true,
      name: claims.name ?? claims.email.split('@')[0] ?? claims.email,
      image: claims.picture,
    }
  },
}
