import { describe, expect, test } from 'bun:test'
import type { BodyInit } from 'bun'
import { filesOf, parseBody, readRaw } from './body'
import { BadRequest, PayloadTooLarge, UnsupportedMediaType } from './errors'

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request('https://theoven.app/', { method: 'POST', body, headers })
}

function json(value: unknown): Request {
  return post(JSON.stringify(value), { 'content-type': 'application/json' })
}

describe('json', () => {
  test('parses an object', async () => {
    expect(await parseBody(json({ name: 'oven' }))).toEqual({ name: 'oven' })
  })

  test('parses an array', async () => {
    expect(await parseBody(json([1, 2, 3]))).toEqual([1, 2, 3])
  })

  test('parses a bare scalar, which is valid JSON', async () => {
    expect(await parseBody(json(42))).toBe(42)
  })

  test('parses null', async () => {
    expect(await parseBody(json(null))).toBeNull()
  })

  test('parses deeply nested structures', async () => {
    const value = { a: { b: { c: [{ d: 'deep' }] } } }
    expect(await parseBody(json(value))).toEqual(value)
  })

  test('honours a charset parameter on the content type', async () => {
    const request = post('{"a":1}', { 'content-type': 'application/json; charset=utf-8' })
    expect(await parseBody(request)).toEqual({ a: 1 })
  })

  test('accepts +json suffixed types', async () => {
    const request = post('{"a":1}', { 'content-type': 'application/vnd.api+json' })
    expect(await parseBody(request)).toEqual({ a: 1 })
  })

  test('decodes unicode', async () => {
    expect(await parseBody(json({ name: 'हिंदी' }))).toEqual({ name: 'हिंदी' })
  })

  // A stack trace here would be useless to the caller; the parser's own message is not.
  test('malformed JSON is a 400 with a useful message, not a 500', async () => {
    const request = post('{ broken', { 'content-type': 'application/json' })
    const error = (await parseBody(request).catch((thrown) => thrown)) as InstanceType<
      typeof BadRequest
    >
    expect(error).toBeInstanceOf(BadRequest)
    expect(error.status).toBe(400)
    expect(error.message).toContain('JSON')
  })

  test('truncated JSON is a 400', async () => {
    const request = post('{"a": [1, 2', { 'content-type': 'application/json' })
    expect(parseBody(request)).rejects.toBeInstanceOf(BadRequest)
  })
})

describe('empty bodies', () => {
  test('a null body is undefined, not a throw', async () => {
    expect(await parseBody(new Request('https://theoven.app/'))).toBeUndefined()
  })

  test('an empty string body is undefined', async () => {
    expect(await parseBody(post('', { 'content-type': 'application/json' }))).toBeUndefined()
  })

  test('a GET with no body is undefined', async () => {
    expect(await parseBody(new Request('https://theoven.app/x'))).toBeUndefined()
  })
})

describe('urlencoded', () => {
  const type = { 'content-type': 'application/x-www-form-urlencoded' }

  test('parses pairs', async () => {
    expect(await parseBody(post('a=1&b=2', type))).toEqual({ a: '1', b: '2' })
  })

  test('collects repeated keys into an array', async () => {
    expect(await parseBody(post('tag=a&tag=b', type))).toEqual({ tag: ['a', 'b'] })
  })

  test('parses nested keys', async () => {
    expect(await parseBody(post('user[name]=ada', type))).toEqual({ user: { name: 'ada' } })
  })

  test('decodes escapes', async () => {
    expect(await parseBody(post('q=hello+world', type))).toEqual({ q: 'hello world' })
  })

  test('blocks prototype pollution', async () => {
    await parseBody(post('__proto__[bad]=1', type))
    expect(({} as Record<string, unknown>).bad).toBeUndefined()
  })
})

describe('text and unknown types', () => {
  test('text/plain becomes a string', async () => {
    expect(await parseBody(post('hello', { 'content-type': 'text/plain' }))).toBe('hello')
  })

  test('text/html becomes a string', async () => {
    expect(await parseBody(post('<b>x</b>', { 'content-type': 'text/html' }))).toBe('<b>x</b>')
  })

  // Guessing a parse would be worse than handing back exactly what arrived.
  test('an unknown type stays raw bytes', async () => {
    const result = await parseBody(post('binary', { 'content-type': 'application/x-thing' }))
    expect(result).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(result as ArrayBuffer)).toBe('binary')
  })

  test('a missing content type stays raw bytes', async () => {
    expect(await parseBody(post('data'))).toBeInstanceOf(ArrayBuffer)
  })
})

describe('multipart', () => {
  function multipart(build: (form: FormData) => void): Request {
    const form = new FormData()
    build(form)
    return new Request('https://theoven.app/', { method: 'POST', body: form })
  }

  test('parses text fields', async () => {
    const body = await parseBody(multipart((f) => f.append('name', 'ada')))
    expect(body).toMatchObject({ name: 'ada' })
  })

  test('files arrive as File objects', async () => {
    const body = (await parseBody(
      multipart((f) => f.append('avatar', new File(['bytes'], 'a.png', { type: 'image/png' }))),
    )) as Record<string, File>

    expect(body.avatar).toBeInstanceOf(File)
    expect(body.avatar?.name).toBe('a.png')
    expect(await body.avatar?.text()).toBe('bytes')
  })

  test('mixes fields and files', async () => {
    const body = (await parseBody(
      multipart((f) => {
        f.append('title', 'holiday')
        f.append('photo', new File(['x'], 'p.jpg', { type: 'image/jpeg' }))
      }),
    )) as Record<string, unknown>

    expect(body.title).toBe('holiday')
    expect(body.photo).toBeInstanceOf(File)
  })

  test('repeated field names collapse into an array', async () => {
    const body = (await parseBody(
      multipart((f) => {
        f.append('files', new File(['1'], 'a.txt'))
        f.append('files', new File(['2'], 'b.txt'))
      }),
    )) as Record<string, File[]>

    expect(body.files).toHaveLength(2)
  })

  test('rejects a file over the per-file limit', async () => {
    const big = new File(['x'.repeat(2000)], 'big.bin')
    const request = multipart((f) => f.append('upload', big))
    expect(parseBody(request, { fileLimit: 1000 })).rejects.toBeInstanceOf(PayloadTooLarge)
  })

  test('rejects more files than allowed', async () => {
    const request = multipart((f) => {
      for (let i = 0; i < 5; i++) f.append('f', new File(['x'], `${i}.txt`))
    })
    expect(parseBody(request, { maxFiles: 2 })).rejects.toBeInstanceOf(PayloadTooLarge)
  })

  test('rejects a disallowed MIME type', async () => {
    const request = multipart((f) =>
      f.append('upload', new File(['x'], 'evil.sh', { type: 'application/x-sh' })),
    )
    const error = await parseBody(request, { allowedFileTypes: ['image/*'] }).catch((e) => e)
    expect(error).toBeInstanceOf(UnsupportedMediaType)
  })

  test('accepts a MIME type matching a wildcard', async () => {
    const request = multipart((f) =>
      f.append('upload', new File(['x'], 'a.png', { type: 'image/png' })),
    )
    expect(parseBody(request, { allowedFileTypes: ['image/*'] })).resolves.toBeDefined()
  })

  test('accepts an exact MIME match', async () => {
    const request = multipart((f) =>
      f.append('upload', new File(['x'], 'a.pdf', { type: 'application/pdf' })),
    )
    expect(parseBody(request, { allowedFileTypes: ['application/pdf'] })).resolves.toBeDefined()
  })

  // A filename is attacker-controlled, so it must never be treated as a path.
  test('a traversal filename is preserved verbatim, never resolved', async () => {
    const body = (await parseBody(
      multipart((f) => f.append('upload', new File(['x'], '../../etc/passwd'))),
    )) as Record<string, File>
    expect(body.upload?.name).toBe('../../etc/passwd')
  })

  test('malformed multipart is a 400', async () => {
    const request = post('--nope\r\ngarbage', {
      'content-type': 'multipart/form-data; boundary=nope',
    })
    expect(parseBody(request)).rejects.toBeInstanceOf(BadRequest)
  })
})

describe('size limits', () => {
  test('rejects a body over the limit', async () => {
    const request = post('x'.repeat(5000), { 'content-type': 'text/plain' })
    expect(parseBody(request, { limit: 1000 })).rejects.toBeInstanceOf(PayloadTooLarge)
  })

  test('accepts a body under the limit', async () => {
    const request = post('x'.repeat(100), { 'content-type': 'text/plain' })
    expect(await parseBody(request, { limit: 1000 })).toHaveLength(100)
  })

  // Bun does not set Content-Length for a string body, so it is set here deliberately: this
  // test is specifically about the cheap pre-read rejection when a client is honest about size.
  test('rejects before reading when Content-Length declares too much', async () => {
    const request = post('x'.repeat(5000), {
      'content-type': 'text/plain',
      'content-length': '5000',
    })
    expect(request.headers.get('content-length')).toBe('5000')
    expect(parseBody(request, { limit: 10 })).rejects.toBeInstanceOf(PayloadTooLarge)
  })

  test('a lying Content-Length does not get past the byte counter', async () => {
    // Claims to be tiny, actually is not. Only counting as we read catches this.
    const request = post('x'.repeat(5000), {
      'content-type': 'text/plain',
      'content-length': '5',
    })
    expect(parseBody(request, { limit: 100 })).rejects.toBeInstanceOf(PayloadTooLarge)
  })

  // The important case: Content-Length is client-supplied, so the limit cannot depend on it.
  test('still rejects when Content-Length is absent, by counting bytes as they arrive', async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 50; i++) controller.enqueue(new Uint8Array(1000))
        controller.close()
      },
    })
    const request = new Request('https://theoven.app/', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'text/plain' },
      // Required by the spec whenever the body is a stream.
      duplex: 'half',
    })
    expect(request.headers.get('content-length')).toBeNull()
    expect(parseBody(request, { limit: 5000 })).rejects.toBeInstanceOf(PayloadTooLarge)
  })

  test('the error names the limit so the caller can act on it', async () => {
    const request = post('x'.repeat(50), { 'content-type': 'text/plain' })
    const error = (await parseBody(request, { limit: 10 }).catch((e) => e)) as InstanceType<
      typeof PayloadTooLarge
    >
    expect(error.message).toContain('10')
    expect(error.status).toBe(413)
  })
})

describe('rawBody', () => {
  test('returns the exact bytes', async () => {
    const raw = await readRaw(post('{"a":1}', { 'content-type': 'application/json' }))
    expect(new TextDecoder().decode(raw)).toBe('{"a":1}')
  })

  // Webhook signatures cover the exact bytes; re-serialising parsed JSON changes them.
  test('preserves byte-exact formatting that JSON.stringify would not reproduce', async () => {
    const original = '{ "a" :  1 }'
    const raw = await readRaw(post(original, { 'content-type': 'application/json' }))
    const decoded = new TextDecoder().decode(raw)
    expect(decoded).toBe(original)
    expect(JSON.stringify(JSON.parse(decoded))).not.toBe(decoded)
  })

  test('enforces the size limit', async () => {
    const request = post('x'.repeat(5000))
    expect(readRaw(request, { limit: 100 })).rejects.toBeInstanceOf(PayloadTooLarge)
  })

  test('parseBody can reuse already-read bytes', async () => {
    const request = post('{"a":1}', { 'content-type': 'application/json' })
    const raw = await readRaw(request)
    expect(await parseBody(request, {}, raw)).toEqual({ a: 1 })
  })
})

describe('filesOf', () => {
  test('extracts a single file as an array', () => {
    const file = new File(['x'], 'a.txt')
    expect(filesOf({ doc: file })).toEqual({ doc: [file] })
  })

  test('extracts multiple files under one field', () => {
    const a = new File(['1'], 'a.txt')
    const b = new File(['2'], 'b.txt')
    expect(filesOf({ docs: [a, b] })).toEqual({ docs: [a, b] })
  })

  test('ignores non-file fields', () => {
    expect(filesOf({ name: 'ada', doc: new File(['x'], 'a.txt') })).toHaveProperty('doc')
    expect(filesOf({ name: 'ada' })).toEqual({})
  })

  test('filters files out of a mixed array', () => {
    const file = new File(['x'], 'a.txt')
    expect(filesOf({ mixed: ['text', file] })).toEqual({ mixed: [file] })
  })

  test('returns empty for a non-object body', () => {
    expect(filesOf('a string')).toEqual({})
    expect(filesOf(null)).toEqual({})
    expect(filesOf(undefined)).toEqual({})
  })
})
