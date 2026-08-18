import { describe, expect, test } from 'bun:test'
import { parseQuery } from './query'

describe('scalars', () => {
  test('parses a single pair', () => {
    expect(parseQuery('a=1')).toEqual({ a: '1' })
  })

  test('parses several pairs', () => {
    expect(parseQuery('a=1&b=2')).toEqual({ a: '1', b: '2' })
  })

  test('tolerates a leading question mark', () => {
    expect(parseQuery('?a=1')).toEqual({ a: '1' })
  })

  test('accepts URLSearchParams directly', () => {
    expect(parseQuery(new URLSearchParams('a=1'))).toEqual({ a: '1' })
  })

  test('returns an empty object for an empty string', () => {
    expect(parseQuery('')).toEqual({})
  })

  test('keeps values as strings, since that is what a URL contains', () => {
    expect(parseQuery('n=42&b=true')).toEqual({ n: '42', b: 'true' })
  })

  test('handles a key with no value', () => {
    expect(parseQuery('a=')).toEqual({ a: '' })
  })

  test('handles a bare key', () => {
    expect(parseQuery('a')).toEqual({ a: '' })
  })

  test('decodes percent escapes', () => {
    expect(parseQuery('q=hello%20world')).toEqual({ q: 'hello world' })
  })

  test('decodes plus as space, as form encoding requires', () => {
    expect(parseQuery('q=hello+world')).toEqual({ q: 'hello world' })
  })

  test('decodes unicode', () => {
    expect(parseQuery('name=%E0%A4%B9%E0%A4%BF')).toEqual({ name: 'हि' })
  })
})

describe('repeated keys', () => {
  test('collects into an array', () => {
    expect(parseQuery('tag=a&tag=b')).toEqual({ tag: ['a', 'b'] })
  })

  test('collects three or more', () => {
    expect(parseQuery('t=a&t=b&t=c')).toEqual({ t: ['a', 'b', 'c'] })
  })

  test('leaves a single occurrence as a scalar', () => {
    expect(parseQuery('tag=a')).toEqual({ tag: 'a' })
  })
})

describe('explicit array syntax', () => {
  test('a[]=1&a[]=2 becomes an array', () => {
    expect(parseQuery('a[]=1&a[]=2')).toEqual({ a: ['1', '2'] })
  })

  test('a single a[] is still an array, unlike a repeated scalar key', () => {
    expect(parseQuery('a[]=1')).toEqual({ a: ['1'] })
  })
})

describe('nested objects', () => {
  test('parses one level', () => {
    expect(parseQuery('filter[status]=open')).toEqual({ filter: { status: 'open' } })
  })

  test('parses several keys under one parent', () => {
    expect(parseQuery('f[status]=open&f[owner]=me')).toEqual({
      f: { status: 'open', owner: 'me' },
    })
  })

  test('parses two levels', () => {
    expect(parseQuery('a[b][c]=1')).toEqual({ a: { b: { c: '1' } } })
  })

  test('mixes nested and flat keys', () => {
    expect(parseQuery('page=2&f[status]=open')).toEqual({ page: '2', f: { status: 'open' } })
  })

  test('prefers the structured form when input contradicts itself', () => {
    expect(parseQuery('a=1&a[b]=2')).toEqual({ a: { b: '2' } })
  })
})

describe('limits', () => {
  test('stops expanding past the depth limit rather than building objects forever', () => {
    const parsed = parseQuery('a[b][c][d][e][f][g][h]=1', { depth: 2 })
    // The remainder stays attached to the last segment, so nothing is silently lost.
    expect(JSON.stringify(parsed)).toContain('1')
    expect(parsed).not.toHaveProperty(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  })

  test('honours a custom depth', () => {
    expect(parseQuery('a[b]=1', { depth: 1 })).toEqual({ a: { b: '1' } })
  })

  test('caps the number of keys', () => {
    const many = Array.from({ length: 500 }, (_, i) => `k${i}=v`).join('&')
    expect(Object.keys(parseQuery(many, { maxKeys: 10 }))).toHaveLength(10)
  })

  test('handles a large query without hanging', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `k${i}=v`).join('&')
    const start = Bun.nanoseconds()
    parseQuery(many)
    expect((Bun.nanoseconds() - start) / 1e6).toBeLessThan(500)
  })
})

// This is the `qs` CVE class. The only safe amount of prototype pollution is none.
describe('prototype pollution', () => {
  test('drops a __proto__ key', () => {
    const parsed = parseQuery('__proto__[polluted]=yes')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(parsed).not.toHaveProperty('polluted')
  })

  test('drops a nested __proto__ key', () => {
    parseQuery('a[__proto__][polluted]=yes')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('drops constructor', () => {
    parseQuery('constructor[prototype][polluted]=yes')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('drops prototype', () => {
    const parsed = parseQuery('prototype[x]=1')
    expect(parsed).not.toHaveProperty('prototype')
  })

  test('does not leave Object.prototype modified after a full run', () => {
    parseQuery('__proto__[a]=1&x[__proto__][b]=2&constructor[c]=3')
    const probe = {} as Record<string, unknown>
    expect(probe.a).toBeUndefined()
    expect(probe.b).toBeUndefined()
    expect(probe.c).toBeUndefined()
  })

  test('uses a null-prototype result so inherited names cannot be shadowed', () => {
    expect(Object.getPrototypeOf(parseQuery('a=1'))).toBeNull()
  })

  test('a key named toString is stored as data, not an inherited method', () => {
    // The null prototype is what makes this safe: there is nothing inherited to shadow.
    const parsed = parseQuery('toString=hi')
    expect(Object.getOwnPropertyDescriptor(parsed, 'toString')?.value).toBe('hi')
  })
})

describe('malformed input', () => {
  test('ignores an empty key', () => {
    expect(parseQuery('=value&a=1')).toEqual({ a: '1' })
  })

  test('survives an unclosed bracket', () => {
    expect(() => parseQuery('a[b=1')).not.toThrow()
  })

  test('survives stray brackets', () => {
    expect(() => parseQuery('a]]][[[=1')).not.toThrow()
  })

  test('survives a malformed escape', () => {
    expect(() => parseQuery('a=%zz')).not.toThrow()
  })
})
