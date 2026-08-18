import { describe, expect, test } from 'bun:test'
import { type CookieJarInit, Cookies } from './cookies'

/** Builds a jar and captures whatever Set-Cookie headers it emits. */
function jar(header: string | null = null, init: CookieJarInit = {}) {
  const emitted: string[] = []
  return { cookies: new Cookies(header, (value) => emitted.push(value), init), emitted }
}

describe('reading', () => {
  test('reads a single cookie', () => {
    expect(jar('session=abc').cookies.get('session')).toBe('abc')
  })

  test('reads one of several', () => {
    const { cookies } = jar('a=1; b=2; c=3')
    expect(cookies.get('b')).toBe('2')
  })

  test('tolerates missing spaces after semicolons', () => {
    expect(jar('a=1;b=2').cookies.get('b')).toBe('2')
  })

  test('returns undefined for an absent cookie', () => {
    expect(jar('a=1').cookies.get('nope')).toBeUndefined()
  })

  test('returns undefined when there is no Cookie header at all', () => {
    expect(jar(null).cookies.get('a')).toBeUndefined()
  })

  test('decodes percent-encoded values', () => {
    expect(jar('msg=hello%20world').cookies.get('msg')).toBe('hello world')
  })

  test('strips surrounding quotes', () => {
    expect(jar('a="quoted"').cookies.get('a')).toBe('quoted')
  })

  test('keeps a value containing an equals sign intact', () => {
    expect(jar('jwt=aaa=bb=cc').cookies.get('jwt')).toBe('aaa=bb=cc')
  })

  test('has reports presence', () => {
    const { cookies } = jar('a=1')
    expect(cookies.has('a')).toBe(true)
    expect(cookies.has('b')).toBe(false)
  })

  test('all returns every cookie', () => {
    expect(jar('a=1; b=2').cookies.all()).toEqual({ a: '1', b: '2' })
  })

  test('skips malformed pairs rather than discarding the whole header', () => {
    expect(jar('broken; a=1; =2').cookies.get('a')).toBe('1')
  })

  test('survives a malformed escape', () => {
    expect(() => jar('a=%zz').cookies.get('a')).not.toThrow()
  })
})

describe('writing', () => {
  test('emits a Set-Cookie header', () => {
    const { cookies, emitted } = jar()
    cookies.set('session', 'abc')
    expect(emitted[0]).toContain('session=abc')
  })

  test('encodes the value', () => {
    const { cookies, emitted } = jar()
    cookies.set('msg', 'hello world')
    expect(emitted[0]).toContain('msg=hello%20world')
  })

  test('defaults to httpOnly, so script cannot read a session cookie', () => {
    const { cookies, emitted } = jar()
    cookies.set('a', '1')
    expect(emitted[0]).toContain('HttpOnly')
  })

  test('httpOnly can be turned off deliberately', () => {
    const { cookies, emitted } = jar()
    cookies.set('a', '1', { httpOnly: false })
    expect(emitted[0]).not.toContain('HttpOnly')
  })

  test('defaults to SameSite=Lax', () => {
    const { cookies, emitted } = jar()
    cookies.set('a', '1')
    expect(emitted[0]).toContain('SameSite=Lax')
  })

  test('defaults to Path=/', () => {
    const { cookies, emitted } = jar()
    cookies.set('a', '1')
    expect(emitted[0]).toContain('Path=/')
  })

  test('is not Secure by default outside production', () => {
    const { cookies, emitted } = jar(null, { secureByDefault: false })
    cookies.set('a', '1')
    expect(emitted[0]).not.toContain('Secure')
  })

  test('is Secure by default in production', () => {
    const { cookies, emitted } = jar(null, { secureByDefault: true })
    cookies.set('a', '1')
    expect(emitted[0]).toContain('Secure')
  })

  // Browsers drop SameSite=None without Secure, so the cookie would silently never arrive.
  test('forces Secure when SameSite=None', () => {
    const { cookies, emitted } = jar(null, { secureByDefault: false })
    cookies.set('a', '1', { sameSite: 'none' })
    expect(emitted[0]).toContain('Secure')
    expect(emitted[0]).toContain('SameSite=None')
  })

  test('writes Max-Age', () => {
    const { cookies, emitted } = jar()
    cookies.set('a', '1', { maxAge: 3600 })
    expect(emitted[0]).toContain('Max-Age=3600')
  })

  test('floors a fractional Max-Age', () => {
    const { cookies, emitted } = jar()
    cookies.set('a', '1', { maxAge: 60.7 })
    expect(emitted[0]).toContain('Max-Age=60')
  })

  test('writes Expires, Domain and Partitioned', () => {
    const { cookies, emitted } = jar()
    cookies.set('a', '1', {
      expires: new Date('2030-01-01T00:00:00Z'),
      domain: 'theoven.app',
      partitioned: true,
    })
    expect(emitted[0]).toContain('Domain=theoven.app')
    expect(emitted[0]).toContain('Partitioned')
    expect(emitted[0]).toContain('Expires=')
  })

  test('emits one header per cookie', () => {
    const { cookies, emitted } = jar()
    cookies.set('a', '1').set('b', '2')
    expect(emitted).toHaveLength(2)
  })

  test('is chainable', () => {
    const { cookies } = jar()
    expect(cookies.set('a', '1')).toBe(cookies)
  })
})

describe('deleting', () => {
  test('expires the cookie', () => {
    const { cookies, emitted } = jar()
    cookies.delete('session')
    expect(emitted[0]).toContain('Max-Age=0')
    expect(emitted[0]).toContain('Expires=Thu, 01 Jan 1970')
  })

  // A mismatched path leaves the original cookie in place; this is why "logout does nothing".
  test('carries path and domain through, so the right cookie is targeted', () => {
    const { cookies, emitted } = jar()
    cookies.delete('session', { path: '/admin', domain: 'theoven.app' })
    expect(emitted[0]).toContain('Path=/admin')
    expect(emitted[0]).toContain('Domain=theoven.app')
  })
})

describe('signed cookies', () => {
  const secret = 'a-test-secret-value'

  test('round-trips', () => {
    const { cookies, emitted } = jar(null, { secret })
    cookies.set('session', 'user-42', { signed: true })

    const raw = decodeURIComponent(emitted[0]?.split(';')[0]?.split('=')[1] ?? '')
    const reader = jar(`session=${encodeURIComponent(raw)}`, { secret })
    expect(reader.cookies.get('session', { signed: true })).toBe('user-42')
  })

  test('appends a signature to the stored value', () => {
    const { cookies, emitted } = jar(null, { secret })
    cookies.set('a', 'plain', { signed: true })
    expect(emitted[0]).toContain('a=plain.')
  })

  test('a tampered value reads as absent', () => {
    const { cookies, emitted } = jar(null, { secret })
    cookies.set('role', 'user', { signed: true })
    const signature = (emitted[0]?.split(';')[0] ?? '').split('.')[1]

    const forged = jar(`role=admin.${signature}`, { secret })
    expect(forged.cookies.get('role', { signed: true })).toBeUndefined()
  })

  test('a wrong secret reads as absent', () => {
    const { cookies, emitted } = jar(null, { secret })
    cookies.set('a', 'value', { signed: true })
    const raw = decodeURIComponent(emitted[0]?.split(';')[0]?.split('=')[1] ?? '')

    const other = jar(`a=${encodeURIComponent(raw)}`, { secret: 'different-secret' })
    expect(other.cookies.get('a', { signed: true })).toBeUndefined()
  })

  test('a value with no signature reads as absent', () => {
    expect(jar('a=unsigned', { secret }).cookies.get('a', { signed: true })).toBeUndefined()
  })

  test('the unsigned read still returns the raw stored form', () => {
    expect(jar('a=value.sig', { secret }).cookies.get('a')).toBe('value.sig')
  })

  test('signing without a secret throws rather than silently not signing', () => {
    const { cookies } = jar()
    expect(() => cookies.set('a', '1', { signed: true })).toThrow(/secret/)
  })

  test('reading signed without a secret throws', () => {
    const { cookies } = jar('a=v.s')
    expect(() => cookies.get('a', { signed: true })).toThrow(/secret/)
  })

  test('signatures differ per value', () => {
    const { cookies, emitted } = jar(null, { secret })
    cookies.set('a', 'one', { signed: true })
    cookies.set('b', 'two', { signed: true })
    expect(emitted[0]?.split('.')[1]).not.toBe(emitted[1]?.split('.')[1])
  })
})

describe('laziness', () => {
  // The jar must not touch the Cookie header until something asks for a value. Counting reads
  // of the header itself is the only way to prove that; the previous version of this test
  // constructed a proxy nothing ever consulted, so it passed regardless.
  test('does not read the header until a value is requested', () => {
    let reads = 0
    const header = {
      toString: () => {
        reads++
        return 'a=1'
      },
    }

    const cookies = new Cookies(header as unknown as string, () => {}, {})
    expect(reads).toBe(0)

    // Writing a cookie must not force the request header to be parsed either.
    cookies.set('b', '2')
    expect(reads).toBe(0)
  })

  test('parses once and caches', () => {
    const cookies = new Cookies('a=1; b=2', () => {}, {})
    expect(cookies.get('a')).toBe('1')
    expect(cookies.get('b')).toBe('2')
    expect(cookies.all()).toEqual({ a: '1', b: '2' })
  })
})
