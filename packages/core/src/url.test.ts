import { describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from './index'
import { pathnameOf } from './url'

/**
 * `pathnameOf` is a security-relevant shortcut, so it is tested as one.
 *
 * Routing and middleware prefix-matching both run on its result. If it ever disagreed with the
 * URL parser, a request could be matched by one and not the other — which is how a guard mounted
 * on `/admin` gets skipped on a route that still resolves to `/admin`.
 *
 * The shortcut is only sound because `Request` canonicalises first: dot segments resolved,
 * `%2e%2e` decoded and collapsed, backslashes converted. These tests assert that equivalence
 * rather than assuming it, and fail if a runtime change ever breaks it.
 */
describe('pathnameOf', () => {
  /** Everything nasty enough to be worth a mismatch. */
  const HOSTILE = [
    '/admin',
    '/foo/../admin',
    '/./admin',
    '/admin/./x',
    '/a//b',
    '/a/b/',
    '/%2e%2e/admin',
    '/%2E%2E/admin',
    '/%2f/admin',
    '/admin%00.txt',
    '/admin?x=1',
    '/admin#frag',
    '/admin?a=/../b',
    '/',
    '/files/a%20b.txt',
    '/ünïcode',
    '/a\\b',
    '/%',
    '/admin/../../../../etc/passwd',
    '//evil.com/admin',
    '/;/admin',
    '/admin;/x',
    '/..%2fadmin',
    '/admin/%2e%2e/%2e%2e/etc',
  ]

  test('it agrees with the URL parser on every hostile path', () => {
    for (const path of HOSTILE) {
      const request = new Request(`http://x${path}`)
      expect(pathnameOf(request.url), `disagreed on ${path}`).toBe(new URL(request.url).pathname)
    }
  })

  test('a query string or fragment never leaks into the path', () => {
    expect(pathnameOf('http://x/a?b=/c')).toBe('/a')
    expect(pathnameOf('http://x/a#/c')).toBe('/a')
    expect(pathnameOf('http://x/a?b#c')).toBe('/a')
  })

  test('a URL with no path is the root', () => {
    expect(pathnameOf('http://x')).toBe('/')
    expect(pathnameOf('http://x?a=1')).toBe('/')
  })
})

/**
 * The invariant that matters more than either component: **middleware and routing must agree on
 * what the path is.** They read the same value now, and this proves the consequence rather than
 * the mechanism — a guard on a prefix runs for every spelling of a URL that reaches the route
 * behind it.
 */
describe('middleware and routing agree on the path', () => {
  const SPELLINGS = [
    '/admin/secret',
    '/foo/../admin/secret',
    '/./admin/secret',
    '/admin/./secret',
    '/admin/x/../secret',
    '/%2e/admin/secret',
    '/foo/%2e%2e/admin/secret',
  ]

  test('a prefix guard runs for every spelling that reaches the route', async () => {
    for (const path of SPELLINGS) {
      let guarded = false
      const app = createApp({ logger: silentLogger })
      app.use('/admin', async (ctx, next) => {
        guarded = true
        return next()
      })
      app.get('/admin/secret', () => 'secret')

      const response = await app.fetch(new Request(`http://x${path}`))

      // Either the route is not reached, or the guard ran. Reaching it unguarded is the bug.
      if (response.status === 200) {
        expect(guarded, `${path} reached the route without running the guard`).toBe(true)
      }
      await app.close({ timeout: 0 })
    }
  })

  test('a guard that refuses cannot be walked around', async () => {
    for (const path of SPELLINGS) {
      const app = createApp({ logger: silentLogger })
      app.use('/admin', async () => new Response('nope', { status: 403 }))
      app.get('/admin/secret', () => 'secret')

      const response = await app.fetch(new Request(`http://x${path}`))
      expect(await response.text(), `${path} slipped past the guard`).not.toBe('secret')
      await app.close({ timeout: 0 })
    }
  })
})

/**
 * `ctx.path` is now answered from a scan rather than by building a `URL`. It must still be the
 * same string, including when something else has already built the URL for its own reasons.
 */
describe('ctx.path', () => {
  async function pathSeenBy(url: string, touchUrlFirst = false): Promise<string> {
    const app = createApp({ logger: silentLogger })
    let seen = ''
    app.get('/*', (ctx) => {
      if (touchUrlFirst) void ctx.url
      seen = ctx.path
      return null
    })
    await app.fetch(new Request(url))
    await app.close({ timeout: 0 })
    return seen
  }

  test('it matches the parsed URL', async () => {
    for (const path of ['/a/b', '/a/b?q=1', '/a%20b', '/foo/../a']) {
      const url = `http://x${path}`
      expect(await pathSeenBy(url)).toBe(new URL(new Request(url).url).pathname)
    }
  })

  // The two must not drift apart depending on which one a handler happened to touch first.
  test('it is the same whether or not ctx.url was read first', async () => {
    for (const path of ['/a/b', '/a/b?q=1', '/a%20b']) {
      const url = `http://x${path}`
      expect(await pathSeenBy(url, true)).toBe(await pathSeenBy(url, false))
    }
  })
})
