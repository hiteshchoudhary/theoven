import { describe, expect, test } from 'bun:test'
import { bunnyStorage } from './bunny'

/**
 * Bunny's API is HTTP, so the request shapes and the URL signing are fully testable without an
 * account — and those are where the bugs are. What is *not* tested here is that Bunny accepts
 * them; live tests are gated on `BUNNY_ZONE` at the bottom.
 */

/** Records every request and answers with whatever the test queued. */
function fakeBunny(answers: Record<string, Response | (() => Response)> = {}) {
  const calls: Array<{ method: string; url: string; accessKey: string | null; body: string }> = []

  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      method: init?.method ?? 'GET',
      url,
      accessKey: new Headers(init?.headers as Record<string, string>).get('AccessKey'),
      body: typeof init?.body === 'string' ? init.body : '',
    })

    for (const [pattern, answer] of Object.entries(answers)) {
      if (url.includes(pattern)) return typeof answer === 'function' ? answer() : answer.clone()
    }
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch

  return { calls, fetcher }
}

const CONFIG = { zone: 'my-zone', accessKey: 'zone-password' }

describe('construction', () => {
  test('a missing zone or key is refused, and the key error says which one', () => {
    expect(() => bunnyStorage({ zone: '', accessKey: 'k' })).toThrow(/storage zone/)
    expect(() => bunnyStorage({ zone: 'z', accessKey: '' })).toThrow(/not the account API key/)
  })

  test('it reports itself as the zone, so errors name the right bucket', () => {
    const driver = bunnyStorage(CONFIG)
    expect(driver.name).toBe('bunny')
    expect(driver.bucket).toBe('my-zone')
  })
})

describe('requests', () => {
  test('put sends the zone password and the bytes', async () => {
    const { calls, fetcher } = fakeBunny()
    const driver = bunnyStorage({ ...CONFIG, fetcher })

    const stored = await driver.put('a/b.txt', 'hello', {})

    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.url).toBe('https://storage.bunnycdn.com/my-zone/a/b.txt')
    expect(calls[0]?.accessKey).toBe('zone-password')
    expect(stored).toMatchObject({ key: 'a/b.txt', bucket: 'my-zone', size: 5 })
  })

  test('a region prefixes the host', async () => {
    const { calls, fetcher } = fakeBunny()
    await bunnyStorage({ ...CONFIG, region: 'ny.storage.bunnycdn.com', fetcher }).put('k', 'x', {})

    expect(calls[0]?.url).toStartWith('https://ny.storage.bunnycdn.com/my-zone/')
  })

  test('key segments are encoded, separators are not', async () => {
    const { calls, fetcher } = fakeBunny()
    await bunnyStorage({ ...CONFIG, fetcher }).put('a b/c+d.txt', 'x', {})

    expect(calls[0]?.url).toEndWith('/my-zone/a%20b/c%2Bd.txt')
  })

  test('stat reads the headers, and a missing object is null', async () => {
    const found = bunnyStorage({
      ...CONFIG,
      fetcher: fakeBunny({
        '/my-zone/': new Response('', {
          headers: { 'content-length': '42', 'content-type': 'text/plain' },
        }),
      }).fetcher,
    })
    expect(await found.stat('k')).toMatchObject({ size: 42, type: 'text/plain' })

    const missing = bunnyStorage({
      ...CONFIG,
      fetcher: fakeBunny({ '/my-zone/': new Response('', { status: 404 }) }).fetcher,
    })
    expect(await missing.stat('k')).toBeNull()
  })

  // The caller wanted it gone, and it is.
  test('deleting something absent is not an error', async () => {
    const driver = bunnyStorage({
      ...CONFIG,
      fetcher: fakeBunny({ '/my-zone/': new Response('', { status: 404 }) }).fetcher,
    })
    await expect(driver.remove('gone')).resolves.toBeUndefined()
  })

  test('any other failure names the status', async () => {
    const driver = bunnyStorage({
      ...CONFIG,
      fetcher: fakeBunny({ '/my-zone/': new Response('nope', { status: 401 }) }).fetcher,
    })
    expect(driver.put('k', 'x', {})).rejects.toThrow(/401/)
  })

  test('list filters a prefix and reports directories out', async () => {
    const entries = [
      { ObjectName: 'a.txt', Length: 1, LastChanged: '2026-01-01', IsDirectory: false },
      { ObjectName: 'ab.txt', Length: 2, LastChanged: '2026-01-01', IsDirectory: false },
      { ObjectName: 'sub', Length: 0, LastChanged: '2026-01-01', IsDirectory: true },
      { ObjectName: 'z.txt', Length: 3, LastChanged: '2026-01-01', IsDirectory: false },
    ]
    const driver = bunnyStorage({
      ...CONFIG,
      fetcher: fakeBunny({ '/my-zone/': new Response(JSON.stringify(entries)) }).fetcher,
    })

    const { objects } = await driver.list({ prefix: 'a' })
    expect(objects.map((object) => object.key)).toEqual(['a.txt', 'ab.txt'])
  })

  test('list pages with after', async () => {
    const entries = ['a', 'b', 'c', 'd'].map((name) => ({
      ObjectName: `${name}.txt`,
      Length: 1,
      LastChanged: '2026-01-01',
      IsDirectory: false,
    }))
    const driver = bunnyStorage({
      ...CONFIG,
      fetcher: fakeBunny({ '/my-zone/': new Response(JSON.stringify(entries)) }).fetcher,
    })

    const first = await driver.list({ limit: 2 })
    expect(first.objects.map((o) => o.key)).toEqual(['a.txt', 'b.txt'])
    expect(first.next).toBe('b.txt')

    const second = await driver.list({ limit: 2, after: first.next })
    expect(second.objects.map((o) => o.key)).toEqual(['c.txt', 'd.txt'])
  })
})

describe('reads go through the pull zone', () => {
  test('with one configured, the edge is used rather than the storage origin', async () => {
    const { calls, fetcher } = fakeBunny({ 'cdn.example.com': new Response('bytes') })
    const driver = bunnyStorage({ ...CONFIG, pullZone: 'cdn.example.com', fetcher })

    expect(await driver.read('a/b.txt').text()).toBe('bytes')
    expect(calls[0]?.url).toBe('https://cdn.example.com/a/b.txt')
    // The zone password must never be sent to the public edge.
    expect(calls[0]?.accessKey).toBeNull()
  })

  test('without one it falls back to the storage API, authenticated', async () => {
    const { calls, fetcher } = fakeBunny({ 'storage.bunnycdn.com': new Response('bytes') })
    expect(
      await bunnyStorage({ ...CONFIG, fetcher })
        .read('k')
        .text(),
    ).toBe('bytes')

    expect(calls[0]?.url).toStartWith('https://storage.bunnycdn.com/')
    expect(calls[0]?.accessKey).toBe('zone-password')
  })

  // The contract promises a lazy handle: nothing should be fetched until it is read.
  test('nothing is fetched until the blob is read', async () => {
    const { calls, fetcher } = fakeBunny()
    const handle = bunnyStorage({ ...CONFIG, fetcher }).read('k')

    expect(calls).toHaveLength(0)
    await handle.text()
    expect(calls).toHaveLength(1)
  })
})

describe('signed pull-zone URLs', () => {
  const signed = bunnyStorage({ ...CONFIG, pullZone: 'cdn.example.com', tokenKey: 'secret' })

  test('presigning is unavailable until a pull zone and token key exist', () => {
    expect(bunnyStorage(CONFIG).presign).toBeUndefined()
    expect(bunnyStorage({ ...CONFIG, pullZone: 'cdn.example.com' }).presign).toBeUndefined()
    expect(signed.presign).toBeDefined()
  })

  test('a signed URL carries a token and an expiry, and never the key', () => {
    const url = signed.presign?.('a/b.txt', { expiresIn: 300 }) ?? ''

    expect(url).toStartWith('https://cdn.example.com/a/b.txt?')
    expect(url).toContain('token=')
    expect(url).toContain('expires=')
    expect(url).not.toContain('secret')
  })

  // Base64 has characters that do not survive a query string.
  test('the token is URL-safe', () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const url = signed.presign?.(`file-${attempt}.txt`, {}) ?? ''
      const token = new URL(url).searchParams.get('token') ?? ''
      expect(token, url).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  test('different keys and expiries produce different tokens', () => {
    const a = signed.presign?.('a.txt', { expiresIn: 300 })
    const b = signed.presign?.('b.txt', { expiresIn: 300 })
    expect(a).not.toBe(b)
  })

  /**
   * Bunny's token authentication protects delivery. There is no signed-upload equivalent, so
   * saying "not supported" is better than handing back a URL that fails at the edge.
   */
  test('a PUT is refused rather than signed into something that will not work', () => {
    expect(() => signed.presign?.('k', { method: 'PUT' })).toThrow(/downloads only/)
  })

  test('traversal is refused before anything is signed', () => {
    expect(() => signed.presign?.('../other-zone/key', {})).toThrow(/traverse/)
  })
})

const BUNNY_ZONE = process.env.BUNNY_ZONE
const integration = BUNNY_ZONE ? describe : describe.skip

integration('against a real Bunny zone', () => {
  const driver = () =>
    bunnyStorage({
      zone: BUNNY_ZONE as string,
      accessKey: process.env.BUNNY_ACCESS_KEY as string,
      ...(process.env.BUNNY_REGION ? { region: process.env.BUNNY_REGION } : {}),
    })

  test('round trip: put, read, stat, list, delete', async () => {
    const bunny = driver()
    const key = `oven-test/${crypto.randomUUID()}.txt`

    await bunny.put(key, 'hello from the integration suite', { type: 'text/plain' })
    expect(await bunny.read(key).text()).toBe('hello from the integration suite')
    expect(await bunny.exists(key)).toBe(true)
    expect((await bunny.stat(key))?.size).toBe(32)

    const { objects } = await bunny.list({ prefix: 'oven-test/' })
    expect(objects.some((object) => object.key === key)).toBe(true)

    await bunny.remove(key)
    expect(await bunny.exists(key)).toBe(false)
  })
})

if (!BUNNY_ZONE) {
  console.info('[storage-bunny] BUNNY_ZONE not set — live integration tests skipped.')
}
