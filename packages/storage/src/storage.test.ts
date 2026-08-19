import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { storage } from './brick'
import { diskStorage } from './disk'
import { s3Storage } from './s3'
import { createService } from './service'
import { assertSafeKey, type StorageDriver, StorageError } from './types'

const temporary: string[] = []
const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 0 })))
  await Promise.all(
    temporary
      .splice(0)
      .map((dir) =>
        import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true })),
      ),
  )
})

function scratch(): string {
  const dir = `${import.meta.dir}/../../../.tmp/storage-${temporary.length}-${Math.floor(performance.now() * 1000)}`
  temporary.push(dir)
  return dir
}

// ---------------------------------------------------------------------------------------
// The key check, which both drivers share
// ---------------------------------------------------------------------------------------

/**
 * Keys usually come from something a user typed, so these are the ones that matter.
 * S3 would treat `../../etc/passwd` as a literal key name; the disk driver would not.
 */
describe('object keys', () => {
  test('ordinary keys pass', () => {
    for (const key of ['a', 'avatars/1.png', 'a/b/c/d.txt', 'weird name (1).pdf', 'ünïcode.txt']) {
      expect(() => assertSafeKey(key)).not.toThrow()
    }
  })

  test('traversal is refused', () => {
    for (const key of ['../secrets', 'a/../../b', '..', 'a/..']) {
      expect(() => assertSafeKey(key)).toThrow(/traverse|not a usable/)
    }
  })

  // A backslash key reaching a POSIX path join is still a key someone chose, and the intent
  // is identical.
  test('backslash traversal is refused too', () => {
    expect(() => assertSafeKey('a\\..\\..\\b')).toThrow(/traverse/)
  })

  test('absolute keys are refused', () => {
    expect(() => assertSafeKey('/etc/passwd')).toThrow(/relative/)
    expect(() => assertSafeKey('\\windows\\system32')).toThrow(/relative/)
  })

  test('empty keys and null bytes are refused', () => {
    expect(() => assertSafeKey('')).toThrow(/not a usable/)
    expect(() => assertSafeKey('a\0b')).toThrow(/null byte/)
  })
})

// ---------------------------------------------------------------------------------------
// Disk driver — the one that runs everywhere
// ---------------------------------------------------------------------------------------

describe('disk driver', () => {
  function driver(): StorageDriver {
    return diskStorage({ dir: scratch() })
  }

  test('an uploaded object comes back', async () => {
    const disk = driver()
    const written = await disk.put('notes/hello.txt', 'hello there', {})

    expect(written.key).toBe('notes/hello.txt')
    expect(written.size).toBe(11)
    expect(await disk.read('notes/hello.txt').text()).toBe('hello there')
  })

  test('nested keys create their directories', async () => {
    const disk = driver()
    await disk.put('a/b/c/deep.txt', 'deep', {})
    expect(await disk.exists('a/b/c/deep.txt')).toBe(true)
  })

  test('a File uploads with its own content type and name ignored', async () => {
    const disk = driver()
    const file = new File(['png bytes'], 'user-supplied.png', { type: 'image/png' })
    const written = await disk.put('avatars/1.png', file, {})

    expect(written.type).toBe('image/png')
    // The key is what was asked for, never the name the browser sent.
    expect(written.key).toBe('avatars/1.png')
  })

  test('exists is false for something never written', async () => {
    expect(await driver().exists('nope.txt')).toBe(false)
  })

  test('stat returns null rather than throwing for a missing object', async () => {
    expect(await driver().stat('nope.txt')).toBeNull()
  })

  test('stat reports size and an inferred type', async () => {
    const disk = driver()
    await disk.put('report.pdf', new Uint8Array([1, 2, 3, 4]), {})

    const info = await disk.stat('report.pdf')
    expect(info?.size).toBe(4)
    expect(info?.type).toContain('pdf')
  })

  // The caller wanted it gone, and it is.
  test('deleting something absent succeeds', async () => {
    await expect(driver().remove('never-existed.txt')).resolves.toBeUndefined()
  })

  test('delete removes it', async () => {
    const disk = driver()
    await disk.put('temp.txt', 'x', {})
    await disk.remove('temp.txt')
    expect(await disk.exists('temp.txt')).toBe(false)
  })

  test('list is empty before anything is written, not an error', async () => {
    expect(await driver().list({})).toEqual({ objects: [] })
  })

  test('list finds objects, recursively, with forward slashes', async () => {
    const disk = driver()
    await disk.put('a.txt', '1', {})
    await disk.put('nested/b.txt', '2', {})
    await disk.put('nested/deeper/c.txt', '3', {})

    const { objects } = await disk.list({})
    expect(objects.map((object) => object.key).sort()).toEqual([
      'a.txt',
      'nested/b.txt',
      'nested/deeper/c.txt',
    ])
  })

  test('list filters by prefix', async () => {
    const disk = driver()
    await disk.put('avatars/1.png', '1', {})
    await disk.put('avatars/2.png', '2', {})
    await disk.put('documents/3.pdf', '3', {})

    const { objects } = await disk.list({ prefix: 'avatars/' })
    expect(objects).toHaveLength(2)
  })

  test('list pages with limit and after', async () => {
    const disk = driver()
    for (const index of ['1', '2', '3', '4', '5']) await disk.put(`k${index}.txt`, index, {})

    const first = await disk.list({ limit: 2 })
    expect(first.objects.map((object) => object.key)).toEqual(['k1.txt', 'k2.txt'])
    expect(first.next).toBe('k2.txt')

    const second = await disk.list({ limit: 2, after: first.next })
    expect(second.objects.map((object) => object.key)).toEqual(['k3.txt', 'k4.txt'])

    const last = await disk.list({ limit: 2, after: second.next })
    expect(last.objects.map((object) => object.key)).toEqual(['k5.txt'])
    // No more pages, so nothing to continue from.
    expect(last.next).toBeUndefined()
  })

  /**
   * The second traversal check. `assertSafeKey` catches the obvious forms; this is the one that
   * holds when something gets past it, because the consequence here is a write outside the
   * directory the operator chose.
   */
  test('a key escaping the root is refused even at the path level', async () => {
    const disk = diskStorage({ dir: scratch() })
    await expect(disk.put('../escaped.txt', 'x', {})).rejects.toThrow(StorageError)
  })

  test('it declares that it cannot presign', () => {
    expect(driver().presign).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------
// S3 driver — signing is offline, so it is tested without a server
// ---------------------------------------------------------------------------------------

describe('s3 driver', () => {
  function driver() {
    return s3Storage({
      bucket: 'test-bucket',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
    })
  }

  test('a missing bucket is refused at construction', () => {
    expect(() => s3Storage({ bucket: '' })).toThrow(/needs a bucket/)
  })

  test('it declares that it can presign', () => {
    expect(driver().presign).toBeDefined()
  })

  // Signing is pure computation, so this needs no bucket to exist.
  test('a presigned download URL is signed and expires', () => {
    const url = driver().presign?.('avatars/1.png', { expiresIn: 300, method: 'GET' }) ?? ''

    expect(url).toContain('/test-bucket/avatars/1.png')
    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('X-Amz-Expires=300')
    // The secret must never appear in a URL that gets handed to a browser.
    expect(url).not.toContain('test-secret')
  })

  test('a presigned upload URL signs PUT, not GET', () => {
    const upload = driver().presign?.('uploads/new.bin', { method: 'PUT' }) ?? ''
    const download = driver().presign?.('uploads/new.bin', { method: 'GET' }) ?? ''

    // Different methods are part of what is signed, so the signatures must differ.
    expect(upload).not.toBe(download)
    expect(upload).toContain('X-Amz-Signature=')
  })

  describe('direct upload tickets', () => {
    function ticket() {
      const built = createApp({ logger: silentLogger, development: true }).use(storage(driver()))
      opened.push(built)
      return built
    }

    test('a ticket carries everything a browser needs', async () => {
      const built = ticket()
      built.post('/uploads', (ctx) =>
        ctx.storage.directUpload('users/1/photo.png', { type: 'image/png', expiresIn: 600 }),
      )
      await built.ready()

      const body = (await (
        await built.fetch(new Request('https://theoven.app/uploads', { method: 'POST' }))
      ).json()) as Record<string, unknown>

      expect(body.method).toBe('PUT')
      expect(body.key).toBe('users/1/photo.png')
      expect(body.bucket).toBe('test-bucket')
      expect(String(body.url)).toContain('X-Amz-Signature=')
      // Signed, so the browser must send it back or S3 rejects with a signature mismatch.
      expect(body.headers).toEqual({ 'content-type': 'image/png' })
      expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(Date.now())
    })

    test('the credentials never appear in the ticket', async () => {
      const built = ticket()
      built.post('/uploads', (ctx) => ctx.storage.directUpload('k'))
      await built.ready()

      const text = await (
        await built.fetch(new Request('https://theoven.app/uploads', { method: 'POST' }))
      ).text()
      expect(text).not.toContain('test-secret')
    })

    test('a driver that cannot presign refuses to issue one', async () => {
      const built = createApp({ logger: silentLogger, development: true }).use(
        storage(diskStorage({ dir: scratch() })),
      )
      opened.push(built)
      built.post('/uploads', (ctx) => ctx.storage.directUpload('k'))
      await built.ready()

      const response = await built.fetch(
        new Request('https://theoven.app/uploads', { method: 'POST' }),
      )
      expect(response.status).toBe(500)
    })
  })

  test('presign refuses a traversing key', () => {
    expect(() => driver().presign?.('../other-bucket/key', {})).toThrow(/traverse/)
  })
})

// ---------------------------------------------------------------------------------------
// The brick
// ---------------------------------------------------------------------------------------

describe('the storage brick', () => {
  function app(driver: StorageDriver, options = {}, development = true) {
    const built = createApp({ logger: silentLogger, development }).use(storage(driver, options))
    opened.push(built)
    return built
  }

  test('ctx.storage uploads and reads back', async () => {
    const built = app(diskStorage({ dir: scratch() }))
    built.post('/upload', async (ctx) => ctx.storage.upload('note.txt', 'from a route'))
    built.get('/note', (ctx) => ctx.storage.download('note.txt'))
    await built.ready()

    const written = await (
      await built.fetch(new Request('https://theoven.app/upload', { method: 'POST' }))
    ).json()
    expect(written).toMatchObject({ key: 'note.txt', size: 12 })

    // Returned straight from the handler: core streams the Blob without buffering it.
    const read = await built.fetch(new Request('https://theoven.app/note'))
    expect(await read.text()).toBe('from a route')
  })

  /**
   * The handoff §1.3 was blocked on: a multipart upload arrives as a `File` that Bun already
   * spilled to a temporary file, and it goes from there to storage without the body being read
   * into memory.
   */
  test('a multipart upload is handed to storage directly', async () => {
    const built = app(diskStorage({ dir: scratch() }))
    built.post('/avatar', async (ctx) => {
      const body = (await ctx.body) as { file: File }
      return ctx.storage.upload(`avatars/${body.file.name}`, body.file)
    })
    await built.ready()

    const form = new FormData()
    form.set('file', new File(['image bytes here'], 'me.png', { type: 'image/png' }))

    const response = await built.fetch(
      new Request('https://theoven.app/avatar', { method: 'POST', body: form }),
    )
    expect(await response.json()).toMatchObject({
      key: 'avatars/me.png',
      type: 'image/png',
      size: 16,
    })
  })

  test('a named bucket is reachable', async () => {
    const built = app(diskStorage({ dir: scratch(), bucket: 'uploads' }), {
      buckets: { avatars: diskStorage({ dir: scratch(), bucket: 'avatars' }) },
    })
    built.post('/x', async (ctx) => {
      await ctx.storage.upload('a.txt', 'main')
      await ctx.storage.bucket('avatars').upload('a.txt', 'other')
      return {
        main: await ctx.storage.download('a.txt').text(),
        avatars: await ctx.storage.bucket('avatars').download('a.txt').text(),
      }
    })
    await built.ready()

    const response = await built.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    expect(await response.json()).toEqual({ main: 'main', avatars: 'other' })
  })

  test('an unknown bucket names the ones that exist', async () => {
    const built = app(diskStorage({ dir: scratch(), bucket: 'uploads' }))
    built.get('/x', (ctx) => ctx.storage.bucket('nope').bucketName)
    await built.ready()

    const response = await built.fetch(new Request('https://theoven.app/x'))
    expect(response.status).toBe(500)
  })

  /**
   * Uploads on a container's filesystem are lost on the next deploy, and the service looks
   * healthy while it happens — so this fails at boot rather than weeks later as missing avatars.
   */
  test('the disk driver is refused in production', async () => {
    const built = createApp({ logger: silentLogger, development: false }).use(
      storage(diskStorage({ dir: scratch() })),
    )
    opened.push(built)
    expect(built.ready()).rejects.toThrow(/refused in production/)
  })

  test('a named bucket on disk is refused in production too', async () => {
    const built = createApp({ logger: silentLogger, development: false }).use(
      storage(s3Storage({ bucket: 'real', accessKeyId: 'a', secretAccessKey: 'b' }), {
        buckets: { cache: diskStorage({ dir: scratch() }) },
      }),
    )
    opened.push(built)
    expect(built.ready()).rejects.toThrow(/configured as "cache".*refused in production/s)
  })

  test('it can be allowed deliberately', async () => {
    const built = createApp({ logger: silentLogger, development: false }).use(
      storage(diskStorage({ dir: scratch() }), { allowDiskInProduction: true }),
    )
    opened.push(built)
    await built.ready()
  })

  // Declared, not discovered on the day someone switches drivers.
  test('canPresign reflects the driver, and presigning refuses when it cannot', async () => {
    const built = app(diskStorage({ dir: scratch() }))
    built.get('/can', (ctx) => ({ can: ctx.storage.canPresign }))
    built.get('/sign', (ctx) => ctx.storage.presignUpload('x'))
    await built.ready()

    expect(await (await built.fetch(new Request('https://theoven.app/can'))).json()).toEqual({
      can: false,
    })
    expect((await built.fetch(new Request('https://theoven.app/sign'))).status).toBe(500)
  })

  test('an app without the brick has no ctx.storage at the type level', async () => {
    const built = createApp({ logger: silentLogger })
    opened.push(built)
    // @ts-expect-error — the whole point of bricks: leaving one out is a compile error.
    built.get('/x', (ctx) => ctx.storage.bucketName)
    await built.ready()
  })
})

// ---------------------------------------------------------------------------------------
// Against a real S3, when one is available
// ---------------------------------------------------------------------------------------

const S3_ENDPOINT = process.env.S3_ENDPOINT
const integration = S3_ENDPOINT ? describe : describe.skip

integration('against a real S3-compatible server', () => {
  function driver() {
    return s3Storage({
      bucket: process.env.S3_BUCKET ?? 'oven-test',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
      endpoint: S3_ENDPOINT as string,
      region: 'us-east-1',
      virtualHostedStyle: false,
    })
  }

  test('round trip: put, read, stat, list, delete', async () => {
    const s3 = driver()
    const key = 'integration/round-trip.txt'

    await s3.put(key, 'hello from the integration suite', { type: 'text/plain' })

    expect(await s3.read(key).text()).toBe('hello from the integration suite')
    expect(await s3.exists(key)).toBe(true)
    expect((await s3.stat(key))?.size).toBe(32)

    const { objects } = await s3.list({ prefix: 'integration/' })
    expect(objects.map((object) => object.key)).toContain(key)

    await s3.remove(key)
    expect(await s3.exists(key)).toBe(false)
  })

  test('a File streams through without being buffered', async () => {
    const s3 = driver()
    const key = 'integration/upload.bin'
    // 5MB, comfortably larger than anything worth holding in memory per request.
    const file = new File([new Uint8Array(5 * 1024 * 1024)], 'big.bin', {
      type: 'application/octet-stream',
    })

    const written = await s3.put(key, file, {})
    expect(written.size).toBe(5 * 1024 * 1024)
    expect((await s3.stat(key))?.size).toBe(5 * 1024 * 1024)

    await s3.remove(key)
  })

  test('a presigned upload URL actually accepts a PUT', async () => {
    const s3 = driver()
    const key = 'integration/presigned.txt'
    const url = s3.presign?.(key, { method: 'PUT', expiresIn: 120 }) ?? ''

    const response = await fetch(url, { method: 'PUT', body: 'uploaded by URL' })
    expect(response.ok).toBe(true)
    expect(await s3.read(key).text()).toBe('uploaded by URL')

    await s3.remove(key)
  })

  test('stat is null for a missing object rather than throwing', async () => {
    expect(await driver().stat('integration/definitely-not-here')).toBeNull()
  })

  // The whole claim of a direct upload: a browser can use the ticket verbatim.
  test('a direct-upload ticket works as issued', async () => {
    const s3 = driver()
    const service = createService(s3, new Map([[s3.bucket, s3]]), new Map())
    const key = 'integration/direct.txt'

    const ticket = service.directUpload(key, { type: 'text/plain', expiresIn: 120 })
    const response = await fetch(ticket.url, {
      method: ticket.method,
      headers: ticket.headers,
      body: 'uploaded straight from the client',
    })

    expect(response.ok).toBe(true)
    expect(await s3.read(key).text()).toBe('uploaded straight from the client')

    await s3.remove(key)
  })

  test('multipart kicks in for a large object without a separate API', async () => {
    // 12MB against a 5MiB part size: three parts, no code change, no separate call.
    const s3 = s3Storage({
      bucket: process.env.S3_BUCKET ?? 'oven-test',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
      endpoint: S3_ENDPOINT as string,
      region: 'us-east-1',
      partSize: 5 * 1024 * 1024,
      queueSize: 2,
    })
    const key = 'integration/multipart.bin'

    await s3.put(key, new File([new Uint8Array(12 * 1024 * 1024)], 'big.bin'), {})
    expect((await s3.stat(key))?.size).toBe(12 * 1024 * 1024)

    await s3.remove(key)
  })
})

if (!S3_ENDPOINT) {
  console.info('[storage] S3_ENDPOINT not set — S3 integration tests skipped.')
}
