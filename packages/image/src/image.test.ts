import { afterEach, describe, expect, test } from 'bun:test'
import { createApp } from '@theoven/core'
import { image } from './brick'
import { PORTABLE_FORMATS, readMetadata, transform } from './image'
import { ImageTooLargeError, UnsupportedImageError } from './types'

/**
 * A minimal uncompressed 24-bit BMP.
 *
 * Fixtures on disk would have to be committed as binaries nobody can review, and a generator
 * lets a test ask for the exact dimensions it needs — including sizes far too large to commit.
 */
function bmp(width: number, height: number): Uint8Array {
  const rowRaw = width * 3
  const rowSize = rowRaw + ((4 - (rowRaw % 4)) % 4)
  const pixels = rowSize * height
  const out = new Uint8Array(54 + pixels)
  const view = new DataView(out.buffer)
  out[0] = 0x42
  out[1] = 0x4d
  view.setUint32(2, out.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, -height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, pixels, true)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3
      out[offset] = ((x * 255) / width) | 0
      out[offset + 1] = ((y * 255) / height) | 0
      out[offset + 2] = 200
    }
  }
  return out
}

const png = async (width: number, height: number) =>
  await new Bun.Image(bmp(width, height)).png().bytes()

// `Bun.Image.backend` is process-global, so a test that pins it must put it back or every later
// test in this process inherits the choice.
const originalBackend = Bun.Image.backend
afterEach(() => {
  Bun.Image.backend = originalBackend
})

describe('metadata', () => {
  test('reads dimensions and format from the header', async () => {
    const meta = await readMetadata(bmp(200, 120))
    expect(meta).toMatchObject({ width: 200, height: 120, format: 'bmp', pixels: 24_000 })
    expect(meta.bytes).toBeGreaterThan(0)
  })

  test('is cheap enough to guard with', async () => {
    const bomb = await png(4000, 4000)

    const beforeMeta = performance.now()
    await readMetadata(bomb)
    const metaMs = performance.now() - beforeMeta

    const beforeDecode = performance.now()
    await transform(bomb, { width: 200 })
    const decodeMs = performance.now() - beforeDecode

    // The whole guard rests on this gap. Measured at ~2500x when written; asserting a far weaker
    // bound so the test reports a real regression rather than machine noise.
    expect(metaMs * 20).toBeLessThan(decodeMs)
  })

  test('rejects bytes that are not an image', async () => {
    expect(readMetadata(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(UnsupportedImageError)
  })
})

describe('guards', () => {
  test('refuses a decompression bomb before decoding it', async () => {
    // 4000x4000 is 16 megapixels of memory, and this arrives as a ~70 KB request body. Byte
    // limits alone do not see it coming.
    const bomb = await png(4000, 4000)
    expect(bomb.length).toBeLessThan(200_000)

    const failure = readMetadata(bomb, { maxPixels: 1_000_000 })
    expect(failure).rejects.toThrow(ImageTooLargeError)
    await failure.catch((error: ImageTooLargeError) => {
      expect(error.status).toBe(413)
      expect(error.detail).toMatchObject({ pixels: 16_000_000, maxPixels: 1_000_000 })
    })
  })

  test('refuses an oversized upload from its byte count alone', async () => {
    const source = await png(400, 400)
    expect(readMetadata(source, { maxBytes: 10 })).rejects.toThrow(ImageTooLargeError)
  })

  test('a permitted image passes both guards', async () => {
    const meta = await readMetadata(await png(100, 100), {
      maxBytes: 10_000_000,
      maxPixels: 1_000_000,
    })
    expect(meta.pixels).toBe(10_000)
  })
})

describe('transform', () => {
  test('keeps the aspect ratio when given one dimension', async () => {
    const result = await transform(bmp(200, 120), { width: 50 })
    expect([result.width, result.height]).toEqual([50, 30])
  })

  test('fits inside a box without stretching', async () => {
    const result = await transform(bmp(200, 120), { width: 100, height: 100 })
    expect([result.width, result.height]).toEqual([100, 60])
  })

  test('fill stretches to exactly the box when that is what was asked for', async () => {
    const result = await transform(bmp(200, 120), { width: 100, height: 100, fit: 'fill' })
    expect([result.width, result.height]).toEqual([100, 100])
  })

  test('does not upscale by default', async () => {
    // Bun.Image upscales happily; a request for 4000px against a 200px source would spend real
    // time and memory inventing detail that is not there.
    const result = await transform(bmp(200, 120), { width: 4000 })
    expect(result.width).toBe(200)
  })

  test('upscales when explicitly allowed', async () => {
    const result = await transform(bmp(200, 120), { width: 400, allowUpscale: true })
    expect(result.width).toBe(400)
  })

  test('converts format and honours quality', async () => {
    const source = bmp(200, 120)
    const low = await transform(source, { format: 'jpeg', quality: 10 })
    const high = await transform(source, { format: 'jpeg', quality: 90 })
    expect(low.format).toBe('jpeg')
    expect(low.bytes.length).toBeLessThan(high.bytes.length)
  })

  test('rotating by 90 degrees swaps the dimensions', async () => {
    const result = await transform(bmp(200, 120), { rotate: 90 })
    expect([result.width, result.height]).toEqual([120, 200])
  })

  test('reports what the source was', async () => {
    const result = await transform(bmp(200, 120), { width: 50, format: 'webp' })
    expect(result.source).toMatchObject({ width: 200, height: 120, format: 'bmp' })
  })
})

describe('portability', () => {
  test('the portable formats are byte-identical on both backends', async () => {
    const source = bmp(120, 80)
    for (const format of PORTABLE_FORMATS) {
      Bun.Image.backend = 'system'
      const onSystem = await transform(source, { format, quality: 80 })
      Bun.Image.backend = 'bun'
      const onBun = await transform(source, { format, quality: 80 })
      // This is what lets a developer pin `backend: 'bun'` and get their Linux server's exact
      // output on a laptop, rather than something merely similar.
      expect(Buffer.from(onSystem.bytes).equals(Buffer.from(onBun.bytes))).toBe(true)
    }
  })

  test('AVIF on the Linux backend fails with a message naming the fix', async () => {
    // Pinning the backend is how a macOS machine reproduces what a Linux server does.
    Bun.Image.backend = 'bun'
    const failure = transform(bmp(80, 80), { format: 'avif' })
    expect(failure).rejects.toThrow(UnsupportedImageError)
    await failure.catch((error: UnsupportedImageError) => {
      expect(error.status).toBe(415)
      expect(error.message).toMatch(/jpeg, png, webp/)
      expect(error.message).toMatch(/macOS and Windows/)
    })
  })

  test('a format this platform cannot write fails at boot, not on an upload', async () => {
    Bun.Image.backend = 'bun'
    const app = createApp().use(image({ format: 'avif' }))
    // The alternative is a server that starts cleanly and rejects every image a user sends.
    expect(app.ready()).rejects.toThrow(/cannot be written on this platform/)
  })

  test('a portable format boots anywhere', async () => {
    Bun.Image.backend = 'bun'
    const app = createApp().use(image({ format: 'webp' }))
    await app.ready()
    expect(app.service('image').backend).toBe('bun')
  })
})

describe('the brick', () => {
  test('resizes an upload inside a route', async () => {
    const app = createApp().use(image({ format: 'webp' }))
    app.post('/avatar', async (ctx) => {
      const [file] = (await ctx.files()).avatar as File[]
      const avatar = await ctx.image.transform(file as File, { width: 64, height: 64 })
      return { width: avatar.width, height: avatar.height, format: avatar.format }
    })

    const form = new FormData()
    form.set('avatar', new Blob([bmp(512, 512)], { type: 'image/bmp' }), 'avatar.bmp')
    const response = await app.fetch(
      new Request('http://localhost/avatar', { method: 'POST', body: form }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ width: 64, height: 64, format: 'webp' })
  })

  test('an oversized upload becomes a 413 problem document', async () => {
    const app = createApp().use(image({ maxPixels: 10_000 }))
    app.post('/avatar', async (ctx) => {
      const [file] = (await ctx.files()).avatar as File[]
      return await ctx.image.transform(file as File, { width: 64 })
    })

    const form = new FormData()
    form.set('avatar', new Blob([bmp(500, 500)], { type: 'image/bmp' }), 'big.bmp')
    const response = await app.fetch(
      new Request('http://localhost/avatar', { method: 'POST', body: form }),
    )

    expect(response.status).toBe(413)
    expect(response.headers.get('content-type')).toContain('problem+json')
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      title: 'Image too large',
      pixels: 250_000,
      maxPixels: 10_000,
    })
  })

  test('variants produce a srcset ladder at the requested widths', async () => {
    const app = createApp().use(image({ format: 'webp' }))
    await app.ready()

    const results = await app.service('image').variants(bmp(1200, 600), { widths: [200, 400, 800] })

    expect(results.map((result) => [result.width, result.height])).toEqual([
      [200, 100],
      [400, 200],
      [800, 400],
    ])
    expect(results.every((result) => result.format === 'webp')).toBe(true)
  })

  test('placeholder is a small data URL ready for an img tag', async () => {
    const app = createApp().use(image())
    await app.ready()

    const lqip = await app.service('image').placeholder(bmp(800, 600))
    expect(lqip.startsWith('data:image/png;base64,')).toBe(true)
    // Small enough to inline into the HTML that references the real image.
    expect(lqip.length).toBeLessThan(2000)
  })

  test('the configured defaults apply without being restated per call', async () => {
    const app = createApp().use(image({ format: 'jpeg', quality: 20 }))
    await app.ready()
    const service = app.service('image')

    const defaulted = await service.transform(bmp(200, 200))
    const explicit = await service.transform(bmp(200, 200), { quality: 95 })

    expect(defaulted.format).toBe('jpeg')
    expect(defaulted.bytes.length).toBeLessThan(explicit.bytes.length)
  })

  test('exposes its limits so a route can explain a rejection', async () => {
    const app = createApp().use(image({ maxBytes: 1234, maxPixels: 5678 }))
    await app.ready()
    expect(app.service('image').limits).toEqual({ maxBytes: 1234, maxPixels: 5678 })
  })
})
