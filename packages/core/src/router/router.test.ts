import { describe, expect, test } from 'bun:test'
import { normalisePath, RouteConflictError, Router } from './router'

/** Builds a router where each route's payload is its own pattern, so matches are self-describing. */
function build(...patterns: string[]): Router<string> {
  const router = new Router<string>()
  for (const pattern of patterns) router.insert('GET', pattern, pattern)
  return router
}

function hit(router: Router<string>, path: string) {
  const result = router.find('GET', path)
  if (!result.found) throw new Error(`expected a match for ${path}, got 404/405`)
  return result
}

describe('normalisePath', () => {
  test.each([
    ['', '/'],
    ['/', '/'],
    ['users', '/users'],
    ['/users/', '/users'],
    ['/users', '/users'],
    ['/a/b/c/', '/a/b/c'],
  ])('%s -> %s', (input, expected) => {
    expect(normalisePath(input)).toBe(expected)
  })
})

describe('static routes', () => {
  test('matches the root', () => {
    expect(hit(build('/'), '/').payload).toBe('/')
  })

  test('matches a single segment', () => {
    expect(hit(build('/users'), '/users').payload).toBe('/users')
  })

  test('matches nested segments', () => {
    expect(hit(build('/a/b/c'), '/a/b/c').payload).toBe('/a/b/c')
  })

  test('treats a trailing slash as the same route', () => {
    expect(hit(build('/users'), '/users/').payload).toBe('/users')
  })

  test('is case sensitive, as URLs are', () => {
    expect(build('/users').find('GET', '/Users').found).toBe(false)
  })

  test('does not match a prefix', () => {
    expect(build('/users/list').find('GET', '/users').found).toBe(false)
  })

  test('does not match a longer path', () => {
    expect(build('/users').find('GET', '/users/1').found).toBe(false)
  })

  test('yields a frozen shared object when there are no params', () => {
    expect(hit(build('/users'), '/users').params).toEqual({})
  })
})

describe('parameters', () => {
  test('captures a single parameter', () => {
    const match = hit(build('/users/:id'), '/users/42')
    expect(match.payload).toBe('/users/:id')
    expect(match.params).toEqual({ id: '42' })
  })

  test('captures multiple parameters', () => {
    const match = hit(build('/users/:userId/posts/:postId'), '/users/7/posts/9')
    expect(match.params).toEqual({ userId: '7', postId: '9' })
  })

  test('captures a parameter in the middle of a path', () => {
    expect(hit(build('/a/:b/c'), '/a/value/c').params).toEqual({ b: 'value' })
  })

  test('does not match an empty segment', () => {
    expect(build('/users/:id').find('GET', '/users/').found).toBe(false)
  })

  test('does not span a slash', () => {
    expect(build('/users/:id').find('GET', '/users/a/b').found).toBe(false)
  })

  test('percent-decodes captured values', () => {
    expect(hit(build('/search/:q'), '/search/hello%20world').params).toEqual({ q: 'hello world' })
  })

  test('decodes unicode', () => {
    expect(hit(build('/u/:name'), '/u/%E0%A4%B9%E0%A4%BF').params).toEqual({ name: 'हि' })
  })

  test('survives a malformed escape rather than throwing', () => {
    expect(hit(build('/u/:name'), '/u/%zz').params).toEqual({ name: '%zz' })
  })

  test('leaves values without escapes untouched', () => {
    expect(hit(build('/u/:name'), '/u/plain').params).toEqual({ name: 'plain' })
  })
})

describe('wildcards', () => {
  test('captures the remainder of the path', () => {
    const match = hit(build('/files/*path'), '/files/a/b/c.txt')
    expect(match.params).toEqual({ path: 'a/b/c.txt' })
  })

  test('captures a single trailing segment', () => {
    expect(hit(build('/files/*path'), '/files/one').params).toEqual({ path: 'one' })
  })

  test('matches an empty remainder', () => {
    expect(hit(build('/files/*path'), '/files').params).toEqual({ path: '' })
  })

  test('defaults the capture name to "*" when unnamed', () => {
    expect(hit(build('/files/*'), '/files/x/y').params).toEqual({ '*': 'x/y' })
  })

  test('matches at the root', () => {
    expect(hit(build('/*rest'), '/anything/at/all').params).toEqual({ rest: 'anything/at/all' })
  })
})

describe('precedence', () => {
  test('static beats parameter', () => {
    expect(hit(build('/users/:id', '/users/me'), '/users/me').payload).toBe('/users/me')
  })

  test('parameter still matches everything else', () => {
    expect(hit(build('/users/:id', '/users/me'), '/users/42').payload).toBe('/users/:id')
  })

  test('parameter beats wildcard', () => {
    expect(hit(build('/files/*path', '/files/:name'), '/files/one').payload).toBe('/files/:name')
  })

  test('static beats wildcard', () => {
    expect(hit(build('/files/*path', '/files/index'), '/files/index').payload).toBe('/files/index')
  })

  test('falls back to wildcard for multi-segment remainders', () => {
    expect(hit(build('/files/*path', '/files/:name'), '/files/a/b').payload).toBe('/files/*path')
  })
})

describe('backtracking', () => {
  // The case greedy routers get wrong: the static branch matches, then dead-ends.
  test('retreats from a dead-ended static branch to the parameter branch', () => {
    const router = build('/files/public/list', '/files/:id/download')
    const match = hit(router, '/files/public/download')
    expect(match.payload).toBe('/files/:id/download')
    expect(match.params).toEqual({ id: 'public' })
  })

  test('retreats through two levels of static segments', () => {
    const router = build('/a/b/c/d', '/a/:x/:y/z')
    const match = hit(router, '/a/b/c/z')
    expect(match.payload).toBe('/a/:x/:y/z')
    expect(match.params).toEqual({ x: 'b', y: 'c' })
  })

  test('retreats from a dead-ended parameter branch to the wildcard', () => {
    const router = build('/x/:id/edit', '/x/*rest')
    expect(hit(router, '/x/1/view').payload).toBe('/x/*rest')
  })

  test('leaves no stale parameters behind after backtracking', () => {
    const router = build('/a/b/c', '/a/*rest')
    expect(hit(router, '/a/b/z').params).toEqual({ rest: 'b/z' })
  })
})

describe('methods', () => {
  test('routes each method independently', () => {
    const router = new Router<string>()
    router.insert('GET', '/users', 'list')
    router.insert('POST', '/users', 'create')
    expect(router.find('GET', '/users')).toMatchObject({ payload: 'list' })
    expect(router.find('POST', '/users')).toMatchObject({ payload: 'create' })
  })

  test('reports the allowed methods when only the method is wrong', () => {
    const router = new Router<string>()
    router.insert('GET', '/users', 'list')
    router.insert('POST', '/users', 'create')
    const result = router.find('DELETE', '/users')
    expect(result.found).toBe(false)
    if (!result.found) expect(result.allowed.sort()).toEqual(['GET', 'POST'])
  })

  test('reports no allowed methods when the path itself is unknown', () => {
    const router = new Router<string>()
    router.insert('GET', '/users', 'list')
    const result = router.find('GET', '/nope')
    expect(result.found).toBe(false)
    if (!result.found) expect(result.allowed).toEqual([])
  })

  test('collects allowed methods across a parameter branch', () => {
    const router = new Router<string>()
    router.insert('PUT', '/users/:id', 'update')
    const result = router.find('GET', '/users/1')
    expect(result.found).toBe(false)
    if (!result.found) expect(result.allowed).toEqual(['PUT'])
  })

  test('collects allowed methods from a wildcard branch', () => {
    const router = new Router<string>()
    router.insert('POST', '/files/*path', 'upload')
    const result = router.find('GET', '/files/a/b')
    expect(result.found).toBe(false)
    if (!result.found) expect(result.allowed).toEqual(['POST'])
  })
})

describe('registration conflicts', () => {
  test('rejects a duplicate method and path', () => {
    const router = build('/users')
    expect(() => router.insert('GET', '/users', 'again')).toThrow(RouteConflictError)
  })

  test('treats a trailing-slash duplicate as a duplicate', () => {
    const router = build('/users')
    expect(() => router.insert('GET', '/users/', 'again')).toThrow(/Duplicate route/)
  })

  test('rejects a wildcard that is not the final segment', () => {
    expect(() => build('/files/*path/edit')).toThrow(/final segment/)
  })

  test('rejects two names for the same parameter position', () => {
    const router = build('/users/:id')
    expect(() => router.insert('GET', '/users/:userId/posts', 'x')).toThrow(/already registered/)
  })

  test('rejects an unnamed parameter', () => {
    expect(() => build('/users/:')).toThrow(/Unnamed parameter/)
  })

  test('allows the same parameter name to be reused consistently', () => {
    expect(() => build('/users/:id', '/users/:id/posts', '/users/:id/posts/:postId')).not.toThrow()
  })
})

describe('introspection', () => {
  test('lists registered routes in registration order', () => {
    const router = new Router<string>()
    router.insert('GET', '/b', 'b')
    router.insert('POST', '/a/', 'a')
    expect(router.routes()).toEqual([
      { method: 'GET', pattern: '/b' },
      { method: 'POST', pattern: '/a' },
    ])
  })
})

describe('scale', () => {
  test('handles a large route table correctly', () => {
    const router = new Router<string>()
    for (let i = 0; i < 1000; i++) {
      router.insert('GET', `/resource${i}/:id/detail`, `r${i}`)
    }
    const match = router.find('GET', '/resource999/abc/detail')
    expect(match).toMatchObject({ payload: 'r999', params: { id: 'abc' } })
    expect(router.find('GET', '/resource1000/abc/detail').found).toBe(false)
  })
})
