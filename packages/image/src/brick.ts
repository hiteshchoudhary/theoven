import type { Brick } from '@theoven/core'
import {
  assertFormatSupported,
  type Guards,
  type ImageSource,
  PORTABLE_FORMATS,
  placeholder,
  readMetadata,
  transform,
} from './image'
import type { ImageFormat, ImageMetadata, TransformOptions, TransformResult } from './types'

/** Default ceiling on the encoded upload: 25 MB. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
/** Default ceiling on decoded size: 50 megapixels, comfortably past any real camera. */
const DEFAULT_MAX_PIXELS = 50_000_000
/** Default encoder quality. 82 is the usual "indistinguishable but much smaller" point. */
const DEFAULT_QUALITY = 82

export interface ImageOptions {
  /**
   * Reject an encoded upload larger than this. Default 25 MB.
   *
   * Checked before anything is decoded, from the size the source already knows.
   */
  maxBytes?: number | undefined
  /**
   * Reject an image with more pixels than this. Default 50 megapixels.
   *
   * This is the guard that matters. Bytes on the wire say very little about memory: a 70 KB PNG
   * can carry 4000×4000 pixels, and a few of those arriving together will end a small server.
   * The header is read first, so an oversized image is refused for about 0.02 ms.
   */
  maxPixels?: number | undefined
  /** Default output format. Without one, the source format is kept when it is portable. */
  format?: ImageFormat | undefined
  /** Default encoder quality, 1–100. Default 82. Ignored by PNG, which is lossless. */
  quality?: number | undefined
  /**
   * Pin the `Bun.Image` backend.
   *
   * `system` (the macOS and Windows default) uses the OS codecs and can write AVIF and HEIC.
   * `bun` is what every Linux server runs, and writes JPEG, PNG and WebP byte-identically.
   *
   * Setting `'bun'` on a developer machine makes it behave exactly like production — the same
   * formats and the same bytes — which is the difference between finding a format problem on a
   * laptop and finding it on a deploy.
   */
  backend?: 'system' | 'bun' | undefined
}

export interface VariantOptions extends Omit<TransformOptions, 'width' | 'height'> {
  /** Target widths. Heights follow the source aspect ratio. */
  widths: readonly number[]
}

export interface ImageService {
  /**
   * Width, height and format, read from the header without decoding.
   *
   * Cheap enough to call on every upload — which is the point, because it is what lets a route
   * reject something enormous before spending anything on it.
   */
  metadata(input: ImageSource): Promise<ImageMetadata>

  /** Resize, rotate, re-encode. Guarded, and never upscales unless asked. */
  transform(input: ImageSource, options?: TransformOptions): Promise<TransformResult>

  /**
   * The same image at several widths, for a `srcset`.
   *
   * Each width is a separate decode — `Bun.Image` pipelines do not share one — so the cost is
   * roughly linear in the number of widths. Worth doing in a queue job rather than in the
   * request when the list is long.
   */
  variants(input: ImageSource, options: VariantOptions): Promise<TransformResult[]>

  /** A ThumbHash `data:` URL of the source, ~400–700 bytes, for `<img src>` while the real one loads. */
  placeholder(input: ImageSource): Promise<string>

  /** Which backend is in use, and therefore which formats can be written. */
  readonly backend: 'system' | 'bun'
  /** The configured ceilings, so a route can report them in a validation message. */
  readonly limits: { maxBytes: number; maxPixels: number }
}

/**
 * The image brick.
 *
 * ```ts
 * app.use(image({ format: 'webp', maxPixels: 40_000_000 }))
 * ```
 *
 * ```ts
 * export default async (ctx) => {
 *   const avatar = await ctx.image.transform(ctx.body.file, { width: 256, height: 256 })
 *   await ctx.storage.upload(`avatars/${ctx.user.id}.webp`, avatar.bytes)
 * }
 * ```
 *
 * Everything here is `Bun.Image`, which means no native module to build and nothing to install.
 * What the brick adds is the part that is easy to leave out: refusing an image before decoding
 * it. Image handling is one of the few places where accepting a request at face value is a
 * denial-of-service vector, because the cost is in the *decoded* size and the request only shows
 * you the compressed one.
 */
export function image(options: ImageOptions = {}): Brick<'image', ImageService> {
  const guards: Guards = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
  }
  const quality = options.quality ?? DEFAULT_QUALITY

  const withDefaults = (given: TransformOptions = {}): TransformOptions => ({
    ...given,
    format: given.format ?? options.format,
    quality: given.quality ?? quality,
  })

  return {
    name: 'image',

    async setup() {
      if (options.backend) Bun.Image.backend = options.backend

      // Checked here so a format this platform cannot write is a boot failure naming the
      // problem, rather than a 500 on somebody's upload weeks later (D19).
      if (options.format) await assertFormatSupported(options.format)

      const service: ImageService = {
        backend: Bun.Image.backend,
        limits: {
          maxBytes: guards.maxBytes ?? DEFAULT_MAX_BYTES,
          maxPixels: guards.maxPixels ?? DEFAULT_MAX_PIXELS,
        },

        metadata: (input) => readMetadata(input, guards),
        transform: (input, given) => transform(input, withDefaults(given), guards),
        placeholder: (input) => placeholder(input, guards),

        async variants(input, { widths, ...rest }) {
          const base = withDefaults(rest)
          const results: TransformResult[] = []
          // Sequential on purpose. Each decode holds the full bitmap, so running every width at
          // once multiplies peak memory by the number of widths — which is exactly the spike the
          // pixel guard above exists to prevent.
          for (const width of widths) {
            results.push(await transform(input, { ...base, width }, guards))
          }
          return results
        },
      }

      return service
    },
  }
}

export { PORTABLE_FORMATS }
