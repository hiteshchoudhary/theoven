import { describe, expect, test } from 'bun:test'
import { captureToken, decodeBasic, redactToken, type TokenOptions } from './token'

/** Captures from a plain description of where things live. */
function capture(
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
  query: Record<string, string> = {},
  options: TokenOptions = {},
) {
  return captureToken(
    new Headers(headers),
    (name) => cookies[name],
    (name) => query[name],
    options,
  )
}

describe('header', () => {
  test('extracts a bearer token', () => {
    const token = capture({ authorization: 'Bearer abc123' })
    expect(token).toEqual({ value: 'abc123', source: 'header', scheme: 'Bearer' })
  })

  test('preserves the scheme casing as sent', () => {
    expect(capture({ authorization: 'bearer abc' })?.scheme).toBe('bearer')
  })

  test('handles an arbitrary scheme', () => {
    const token = capture({ authorization: 'ApiKey k-1' })
    expect(token).toMatchObject({ value: 'k-1', scheme: 'ApiKey' })
  })

  test('trims surrounding whitespace from the value', () => {
    expect(capture({ authorization: 'Bearer   abc  ' })?.value).toBe('abc')
  })

  // Off-spec but common in hand-rolled clients; more useful to accept than to ignore.
  test('treats a scheme-less header as an opaque token', () => {
    const token = capture({ authorization: 'justatoken' })
    expect(token).toEqual({ value: 'justatoken', source: 'header', scheme: undefined })
  })

  test('keeps a JWT intact, dots and all', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123'
    expect(capture({ authorization: `Bearer ${jwt}` })?.value).toBe(jwt)
  })

  // Headers trims trailing whitespace, so 'Bearer ' arrives as the bare word 'Bearer'. Without
  // a guard the scheme-less branch returns "Bearer" as the token itself.
  test('a scheme with no credential falls through to the cookie', () => {
    expect(capture({ authorization: 'Bearer ' }, { token: 'from-cookie' })?.source).toBe('cookie')
  })

  test('a bare scheme name is not a token', () => {
    expect(capture({ authorization: 'Bearer' })).toBeUndefined()
    expect(capture({ authorization: 'Basic' })).toBeUndefined()
    expect(capture({ authorization: 'basic' })).toBeUndefined()
  })

  test('a scheme-less credential that is not a scheme name still works', () => {
    expect(capture({ authorization: 'sk_live_abc123' })?.value).toBe('sk_live_abc123')
  })
})

describe('cookie', () => {
  test('reads the default cookie name', () => {
    const token = capture({}, { token: 'cookie-value' })
    expect(token).toEqual({ value: 'cookie-value', source: 'cookie', scheme: undefined })
  })

  test('reads a configured cookie name', () => {
    const token = capture({}, { session: 'sid' }, {}, { cookie: 'session' })
    expect(token?.value).toBe('sid')
  })

  test('ignores the default name when a custom one is configured', () => {
    expect(capture({}, { token: 'wrong' }, {}, { cookie: 'session' })).toBeUndefined()
  })
})

describe('query', () => {
  test('reads the default parameter', () => {
    const token = capture({}, {}, { access_token: 'q-value' })
    expect(token).toEqual({ value: 'q-value', source: 'query', scheme: undefined })
  })

  test('reads a configured parameter', () => {
    expect(capture({}, {}, { t: 'v' }, { query: 't' })?.value).toBe('v')
  })

  // Query strings land in access logs, browser history and Referer headers.
  test('can be disabled entirely', () => {
    expect(capture({}, {}, { access_token: 'v' }, { query: null })).toBeUndefined()
  })
})

describe('precedence', () => {
  test('header beats cookie and query', () => {
    const token = capture(
      { authorization: 'Bearer from-header' },
      { token: 'from-cookie' },
      { access_token: 'from-query' },
    )
    expect(token?.value).toBe('from-header')
    expect(token?.source).toBe('header')
  })

  test('cookie beats query', () => {
    const token = capture({}, { token: 'from-cookie' }, { access_token: 'from-query' })
    expect(token?.source).toBe('cookie')
  })

  test('query is the last resort', () => {
    expect(capture({}, {}, { access_token: 'from-query' })?.source).toBe('query')
  })

  test('reports the source so callers can decide how much to trust it', () => {
    expect(capture({ authorization: 'Bearer a' })?.source).toBe('header')
    expect(capture({}, { token: 'a' })?.source).toBe('cookie')
    expect(capture({}, {}, { access_token: 'a' })?.source).toBe('query')
  })
})

describe('absence', () => {
  test('returns undefined when nothing is present', () => {
    expect(capture()).toBeUndefined()
  })

  test('an empty Authorization header is not a token', () => {
    expect(capture({ authorization: '' })).toBeUndefined()
  })

  test('an empty cookie value is not a token', () => {
    expect(capture({}, { token: '' })).toBeUndefined()
  })
})

describe('basic auth', () => {
  test('decodes username and password', () => {
    const encoded = btoa('ada:lovelace')
    expect(decodeBasic(capture({ authorization: `Basic ${encoded}` }))).toEqual({
      username: 'ada',
      password: 'lovelace',
    })
  })

  test('is case-insensitive about the scheme', () => {
    const encoded = btoa('a:b')
    expect(decodeBasic(capture({ authorization: `basic ${encoded}` }))?.username).toBe('a')
  })

  test('keeps colons in the password', () => {
    const encoded = btoa('user:pa:ss:word')
    expect(decodeBasic(capture({ authorization: `Basic ${encoded}` }))?.password).toBe('pa:ss:word')
  })

  test('an empty password is valid', () => {
    const encoded = btoa('user:')
    expect(decodeBasic(capture({ authorization: `Basic ${encoded}` }))).toEqual({
      username: 'user',
      password: '',
    })
  })

  test('a missing colon is not valid', () => {
    expect(decodeBasic(capture({ authorization: `Basic ${btoa('nocolon')}` }))).toBeUndefined()
  })

  test('undefined for a bearer token', () => {
    expect(decodeBasic(capture({ authorization: 'Bearer abc' }))).toBeUndefined()
  })

  test('undefined for malformed base64', () => {
    expect(decodeBasic(capture({ authorization: 'Basic !!!not-base64!!!' }))).toBeUndefined()
  })

  test('undefined when there is no token at all', () => {
    expect(decodeBasic(undefined)).toBeUndefined()
  })
})

// Enough to correlate two log lines, never enough to replay.
describe('redaction', () => {
  test('keeps only the ends of a long token', () => {
    expect(redactToken('abcdefghijklmnopqrstuvwxyz')).toBe('abcd...wxyz')
  })

  test('hides a short token entirely, since a prefix would be most of it', () => {
    expect(redactToken('short')).toBe('[redacted]')
  })

  test('hides a 12-character token entirely', () => {
    expect(redactToken('123456789012')).toBe('[redacted]')
  })

  test('never contains the middle of the secret', () => {
    const secret = 'AAAAsecretmiddlepartZZZZ'
    expect(redactToken(secret)).not.toContain('secretmiddlepart')
  })

  test('is stable, so two log lines can be correlated', () => {
    expect(redactToken('abcdefghijklmnop')).toBe(redactToken('abcdefghijklmnop'))
  })
})
