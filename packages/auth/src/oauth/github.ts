import type { OAuthProfile, OAuthProvider, OAuthTokens } from './provider'

interface GitHubUser {
  id?: number
  login?: string
  name?: string | null
  email?: string | null
  avatar_url?: string
}

interface GitHubEmail {
  email: string
  primary: boolean
  verified: boolean
}

/**
 * Sign in with GitHub.
 *
 * Plain OAuth2, not OIDC: there is no id_token, so the profile is a call to `/user`. And GitHub
 * omits the email from that response whenever the user has kept it private, which is the default —
 * so a second call to `/user/emails` is not an optimisation, it is the only way to get one.
 *
 * That call needs the `user:email` scope. Without it GitHub returns 403 and sign-in fails with a
 * message naming the scope, rather than silently creating an account with no email (D34).
 */
export const github: OAuthProvider = {
  name: 'github',
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  defaultScopes: ['read:user', 'user:email'],

  async profile(tokens: OAuthTokens, fetcher: typeof fetch): Promise<OAuthProfile> {
    const headers = {
      authorization: `Bearer ${tokens.accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'oven-auth',
    }

    const response = await fetcher('https://api.github.com/user', { headers })
    if (!response.ok) {
      throw new Error(`GitHub refused the profile request (${response.status}).`)
    }
    const user = (await response.json()) as GitHubUser

    if (!user.id) throw new Error('GitHub returned no account id.')

    const email = user.email
      ? { address: user.email, verified: true }
      : await primaryEmail(fetcher, headers)

    return {
      accountId: String(user.id),
      email: email.address,
      emailVerified: email.verified,
      // `name` is optional on GitHub; `login` always exists.
      name: user.name ?? user.login ?? email.address,
      image: user.avatar_url,
    }
  },
}

/** The verified primary address, when the profile did not carry one. */
async function primaryEmail(
  fetcher: typeof fetch,
  headers: Record<string, string>,
): Promise<{ address: string; verified: boolean }> {
  const response = await fetcher('https://api.github.com/user/emails', { headers })

  if (response.status === 403 || response.status === 404) {
    throw new Error(
      'GitHub did not return an email address, and the "user:email" scope was not granted. ' +
        'Add it to the provider scopes.',
    )
  }
  if (!response.ok) {
    throw new Error(`GitHub refused the email request (${response.status}).`)
  }

  const emails = (await response.json()) as GitHubEmail[]
  // Primary first; otherwise any verified address is better than none.
  const chosen =
    emails.find((entry) => entry.primary && entry.verified) ?? emails.find((e) => e.verified)

  if (!chosen) throw new Error('GitHub has no verified email address for this account.')
  return { address: chosen.email, verified: true }
}
