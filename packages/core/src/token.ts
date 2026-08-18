/**
 * Credential capture.
 *
 * `ctx.token` is populated on every request, whether or not an auth module is installed.
 * Capture and verification are deliberately different jobs: pulling a bearer token out of a
 * header is trivial and universal, so core does it; deciding whether that token means anything
 * needs a key, a session store or a provider, so `@theoven/auth` does that.
 *
 * The split matters for anyone who does not use our auth module. Verifying a third-party JWT or
 * checking an API key against your own table should not require installing an auth framework —
 * it should require `ctx.token` and four lines of your own code.
 *
 * Precedence is header, then cookie, then query string. A caller that sends an `Authorization`
 * header meant it; a token in a URL is the weakest and most leak-prone form, so it never wins.
 */

export type TokenSource = 'header' | 'cookie' | 'query'

export interface TokenOptions {
  /** Cookie consulted when there is no `Authorization` header. Default `token`. */
  cookie?: string
  /**
   * Query parameter consulted last. Default `access_token`.
   *
   * Disabled by setting to `null`. Worth considering: query strings end up in access logs,
   * browser history and `Referer` headers. It is supported because EventSource and some
   * download flows cannot set headers, not because it is a good idea.
   */
  query?: string | null
}

export interface CapturedToken {
  /** The credential itself. For `Basic`, the still-encoded base64 payload. */
  value: string
  /** Where it came from, for auditing and for deciding how much to trust it. */
  source: TokenSource
  /** Auth scheme when it came from a header — `Bearer`, `Basic`, and so on. */
  scheme: string | undefined
}

export interface BasicCredentials {
  username: string
  password: string
}

const DEFAULT_COOKIE = 'token'
const DEFAULT_QUERY = 'access_token'

/**
 * Scheme names that carry no credential on their own.
 *
 * `Authorization: Bearer` with nothing after it arrives here as the single word `Bearer`,
 * because `Headers` trims trailing whitespace. Without this list the scheme-less branch below
 * would happily hand back `"Bearer"` as though it were the token — which then fails
 * verification somewhere far away, with a value that looks absurd in the logs.
 */
const BARE_SCHEMES = new Set(['bearer', 'basic', 'digest', 'negotiate', 'apikey', 'token'])

/**
 * Extracts a credential from a request.
 *
 * Returns `undefined` rather than throwing when nothing is present. An absent token is the
 * normal state of a public endpoint, not an error.
 */
export function captureToken(
  headers: Headers,
  cookie: (name: string) => string | undefined,
  query: (name: string) => string | undefined,
  options: TokenOptions = {},
): CapturedToken | undefined {
  const authorization = headers.get('authorization')

  if (authorization) {
    const space = authorization.indexOf(' ')

    // A scheme-less Authorization header is off-spec but common in hand-rolled clients.
    // Treating it as an opaque token is more useful than ignoring it — unless the whole header
    // is just a scheme name, which means the credential is missing rather than unlabelled.
    if (space === -1) {
      if (!BARE_SCHEMES.has(authorization.toLowerCase())) {
        return { value: authorization, source: 'header', scheme: undefined }
      }
    } else {
      const scheme = authorization.slice(0, space)
      const value = authorization.slice(space + 1).trim()
      if (value !== '') {
        return { value, source: 'header', scheme }
      }
    }
  }

  const fromCookie = cookie(options.cookie ?? DEFAULT_COOKIE)
  if (fromCookie) {
    return { value: fromCookie, source: 'cookie', scheme: undefined }
  }

  const queryKey = options.query === undefined ? DEFAULT_QUERY : options.query
  if (queryKey !== null) {
    const fromQuery = query(queryKey)
    if (fromQuery) {
      return { value: fromQuery, source: 'query', scheme: undefined }
    }
  }

  return undefined
}

/**
 * Decodes `Basic` credentials.
 *
 * Returns `undefined` for anything that is not a well-formed `Basic` token, including a
 * password-less username — an empty password is valid, a missing colon is not.
 */
export function decodeBasic(token: CapturedToken | undefined): BasicCredentials | undefined {
  if (token?.scheme?.toLowerCase() !== 'basic') return undefined

  let decoded: string
  try {
    decoded = atob(token.value)
  } catch {
    return undefined
  }

  const colon = decoded.indexOf(':')
  if (colon === -1) return undefined

  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

/**
 * Redacts a token for logging.
 *
 * Enough to correlate two log lines, never enough to replay. Short tokens are hidden entirely
 * rather than partially revealed, since a prefix of a short secret is a large fraction of it.
 */
export function redactToken(value: string): string {
  if (value.length <= 12) return '[redacted]'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}
