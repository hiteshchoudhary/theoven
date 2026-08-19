import { describe, expect, test } from 'bun:test'
import { imagekitStorage } from './imagekit'
import { buildUrl, transformationOf } from './url'

const CONFIG = { privateKey: 'private_abc', urlEndpoint: 'https://ik.imagekit.io/demo' }

function fake(answers: Record<string, Response> = {}) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = []
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      method: init?.method ?? 'GET',
      url,
      auth: new Headers(init?.headers as Record<string, string>).get('authorization'),
    })
    for (const [pattern, answer] of Object.entries(answers)) {
      if (url.includes(pattern)) return answer.clone()
    }
    return new Response('[]', { status: 200 })
  }) as unknown as typeof fetch
  return { calls, fetcher }
}

describe('transformations', () => {
  test('they serialise to ImageKit’s short syntax', () => {
    expect(transformationOf({ width: 300, height: 200 })).toBe('w-300,h-200')
    expect(transformationOf({ format: 'auto', quality: 80 })).toBe('q-80,f-auto')
    expect(transformationOf({ width: 100, raw: { e: 'grayscale' } })).toBe('w-100,e-grayscale')
  })

  test('an empty transformation produces nothing', () => {
    expect(transformationOf({})).toBe('')
  })
})

describe('delivery URLs', () => {
  test('a plain URL is the endpoint and the path', () => {
    expect(buildUrl(CONFIG.urlEndpoint, undefined, 'avatars/1.png')).toBe(
      'https://ik.imagekit.io/demo/avatars/1.png',
    )
  })

  test('transformations are appended as tr=', () => {
    expect(buildUrl(CONFIG.urlEndpoint, undefined, 'a.png', { transform: { width: 200 } })).toBe(
      'https://ik.imagekit.io/demo/a.png?tr=w-200',
    )
  })

  test('a trailing slash on the endpoint does not double up', () => {
    expect(buildUrl('https://ik.imagekit.io/demo/', undefined, 'a.png')).toBe(
      'https://ik.imagekit.io/demo/a.png',
    )
  })

  describe('signing', () => {
    test('a signed URL carries an expiry and a signature, never the key', () => {
      const url = buildUrl(CONFIG.urlEndpoint, CONFIG.privateKey, 'a.png', { expiresIn: 300 })

      expect(url).toContain('ik-t=')
      expect(url).toContain('ik-s=')
      expect(url).not.toContain('private_abc')
    })

    /**
     * The signature covers the transformation too, so a client cannot edit `tr=` on a signed URL
     * to request a 10 000px render — which is the reason to sign at all on a product billed per
     * transformation.
     */
    test('changing the transformation changes the signature', () => {
      const small = buildUrl(CONFIG.urlEndpoint, CONFIG.privateKey, 'a.png', {
        transform: { width: 100 },
        expiresIn: 300,
      })
      const large = buildUrl(CONFIG.urlEndpoint, CONFIG.privateKey, 'a.png', {
        transform: { width: 9999 },
        expiresIn: 300,
      })

      const signatureOf = (url: string) => new URL(url).searchParams.get('ik-s')
      expect(signatureOf(small)).not.toBe(signatureOf(large))
    })

    test('a transformed signed URL keeps both parameters', () => {
      const url = buildUrl(CONFIG.urlEndpoint, CONFIG.privateKey, 'a.png', {
        transform: { width: 200 },
        expiresIn: 60,
      })
      const params = new URL(url).searchParams
      expect(params.get('tr')).toBe('w-200')
      expect(params.get('ik-s')).toBeTruthy()
    })

    test('signing without a private key is refused rather than emitted unsigned', () => {
      expect(() => buildUrl(CONFIG.urlEndpoint, undefined, 'a.png', { expiresIn: 60 })).toThrow(
        /private key/,
      )
    })
  })
})

describe('the driver', () => {
  test('missing configuration is refused at construction', () => {
    expect(() => imagekitStorage({ privateKey: '', urlEndpoint: 'x' })).toThrow(/private API key/)
    expect(() => imagekitStorage({ privateKey: 'k', urlEndpoint: '' })).toThrow(/URL endpoint/)
  })

  test('uploads go to the upload host with Basic auth', async () => {
    const { calls, fetcher } = fake({
      'upload.imagekit.io': new Response(
        JSON.stringify({ fileId: 'f1', name: 'b.txt', filePath: '/a/b.txt', size: 5 }),
      ),
    })

    const stored = await imagekitStorage({ ...CONFIG, fetcher }).put('a/b.txt', 'hello', {})

    expect(calls[0]?.url).toContain('upload.imagekit.io/api/v1/files/upload')
    expect(calls[0]?.auth).toStartWith('Basic ')
    expect(stored).toMatchObject({ key: 'a/b.txt', size: 5 })
  })

  /**
   * The contract is path-keyed and ImageKit deletes by `fileId`, so anything but an upload costs
   * a lookup first. Worth a test so the extra round trip is visible rather than surprising.
   */
  test('delete looks the file up by path first', async () => {
    const { calls, fetcher } = fake({
      '/files?': new Response(
        JSON.stringify([{ fileId: 'f1', name: 'b.txt', filePath: '/a/b.txt', size: 5 }]),
      ),
    })

    await imagekitStorage({ ...CONFIG, fetcher }).remove('a/b.txt')

    expect(calls[0]?.url).toContain('/v1/files?')
    expect(calls[1]?.method).toBe('DELETE')
    expect(calls[1]?.url).toContain('/v1/files/f1')
  })

  test('deleting something absent makes no delete call', async () => {
    const { calls, fetcher } = fake({ '/files?': new Response('[]') })
    await imagekitStorage({ ...CONFIG, fetcher }).remove('gone.txt')

    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  test('stat returns null for a missing file', async () => {
    const { fetcher } = fake({ '/files?': new Response('[]') })
    expect(await imagekitStorage({ ...CONFIG, fetcher }).stat('gone.txt')).toBeNull()
  })

  // Browser uploads use a token/signature triple, not a PUT-able URL.
  test('it declares that it cannot presign uploads', () => {
    expect(imagekitStorage(CONFIG).presign).toBeUndefined()
  })

  test('traversing keys are refused', async () => {
    const driver = imagekitStorage(CONFIG)
    expect(driver.put('../escape', 'x', {})).rejects.toThrow(/traverse/)
  })

  test('reads stay lazy', async () => {
    const { calls, fetcher } = fake({ 'ik.imagekit.io': new Response('bytes') })
    const handle = imagekitStorage({ ...CONFIG, fetcher }).read('a.png')

    expect(calls).toHaveLength(0)
    expect(await handle.text()).toBe('bytes')
    expect(calls).toHaveLength(1)
  })
})
