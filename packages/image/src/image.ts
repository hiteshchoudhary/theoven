import {
  type ImageFormat,
  type ImageMetadata,
  ImageTooLargeError,
  type TransformOptions,
  type TransformResult,
  UnsupportedImageError,
} from './types'

/** Anything `Bun.Image` will take: a path, a Blob or File, or raw bytes. */
export type ImageSource = string | ArrayBuffer | NodeJS.TypedArray | Blob

/**
 * Formats every platform can write.
 *
 * `Bun.Image` runs on one of two backends: `system` (macOS and Windows, using the OS codecs) and
 * `bun` (everywhere else, including every Linux server). These three are byte-identical on both —
 * verified in the tests, not assumed. AVIF and HEIC exist only on `system`, which is why choosing
 * one is checked at boot rather than discovered on a user's upload.
 */
export const PORTABLE_FORMATS: readonly ImageFormat[] = ['jpeg', 'png', 'webp']

/** Bun's code for "this backend cannot write that format". */
const UNSUPPORTED = 'ERR_IMAGE_FORMAT_UNSUPPORTED'

export interface Guards {
  /** Reject an input larger than this many bytes, before decoding anything. */
  maxBytes?: number | undefined
  /** Reject an image with more pixels than this. Checked from the header. */
  maxPixels?: number | undefined
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

/**
 * The encoded size of a source, without reading it.
 *
 * `Blob.size` and `byteLength` are already known, and `Bun.file()` reads the size from the
 * filesystem. Nothing here pulls the image into memory — which is the point, since the whole
 * job of the byte guard is to reject something before paying to hold it.
 */
export async function sourceBytes(input: ImageSource): Promise<number> {
  if (typeof input === 'string') return Bun.file(input).size
  if (input instanceof Blob) return input.size
  return input.byteLength
}

/**
 * Reads width, height and format without decoding the image.
 *
 * This is the guard that makes everything else safe. A 70 KB PNG can carry 4000×4000 pixels —
 * 16 megapixels of memory from a request body that looks trivial. Reading the header first costs
 * about 0.02 ms against 44 ms for the decode, so refusing an oversized image is roughly free,
 * while discovering it during the decode is not.
 */
export async function readMetadata(
  input: ImageSource,
  guards: Guards = {},
): Promise<ImageMetadata> {
  const bytes = await sourceBytes(input)
  if (guards.maxBytes !== undefined && bytes > guards.maxBytes) {
    throw new ImageTooLargeError(
      `Image is ${bytes} bytes, over the ${guards.maxBytes} byte limit.`,
      { bytes, maxBytes: guards.maxBytes },
    )
  }

  let meta: { width: number; height: number; format: string }
  try {
    meta = await new Bun.Image(input).metadata()
  } catch (error) {
    throw new UnsupportedImageError(
      'The upload is not an image, or is in a format this platform cannot read.',
      { cause: String(error) },
    )
  }

  const pixels = meta.width * meta.height
  if (guards.maxPixels !== undefined && pixels > guards.maxPixels) {
    throw new ImageTooLargeError(
      `Image is ${meta.width}x${meta.height} (${pixels} pixels), over the ${guards.maxPixels} pixel limit.`,
      { width: meta.width, height: meta.height, pixels, maxPixels: guards.maxPixels },
    )
  }

  return { width: meta.width, height: meta.height, format: meta.format, pixels, bytes }
}

/** Applies the requested output format and quality to a pipeline. */
function encode(pipeline: Bun.Image, format: ImageFormat, quality: number | undefined): Bun.Image {
  switch (format) {
    case 'png':
      // Lossless, so `quality` has no meaning here and is deliberately not mapped onto
      // `compressionLevel` — they are different scales, and silently reinterpreting one as the
      // other would make `quality: 10` mean "barely compress" instead of "small file".
      return pipeline.png()
    case 'jpeg':
      return quality === undefined ? pipeline.jpeg() : pipeline.jpeg({ quality })
    case 'webp':
      return quality === undefined ? pipeline.webp() : pipeline.webp({ quality })
    case 'avif':
      return quality === undefined ? pipeline.avif() : pipeline.avif({ quality })
    case 'heic':
      return quality === undefined ? pipeline.heic() : pipeline.heic({ quality })
  }
}

/**
 * Decides the target size.
 *
 * `Bun.Image` upscales without complaint, so a request for 8000px against a 200px upload would
 * spend real time and memory inventing detail that is not in the source. Unless upscaling is
 * asked for, the source's own dimensions are the ceiling.
 */
function targetSize(
  source: ImageMetadata,
  options: TransformOptions,
): { width: number | undefined; height: number | undefined } {
  let { width, height } = options
  if (width === undefined && height === undefined) return { width: undefined, height: undefined }

  if (!options.allowUpscale) {
    if (width !== undefined) width = Math.min(width, source.width)
    if (height !== undefined) height = Math.min(height, source.height)
  }
  return { width, height }
}

/**
 * Guards, transforms and re-encodes one image.
 *
 * The order matters: every check that can be made from the header happens before the decode, so
 * a hostile upload is refused while it is still cheap.
 */
export async function transform(
  input: ImageSource,
  options: TransformOptions = {},
  guards: Guards = {},
): Promise<TransformResult> {
  const source = await readMetadata(input, guards)
  const format =
    options.format ??
    (PORTABLE_FORMATS.includes(source.format as ImageFormat)
      ? (source.format as ImageFormat)
      : 'webp')

  let pipeline = new Bun.Image(input)

  const { width, height } = targetSize(source, options)
  if (width !== undefined || height !== undefined) {
    // `Bun.Image.resize` requires a width. Asking for a height alone means "fit that height",
    // which is the source width scaled by the same ratio.
    const fit = options.fit ?? 'inside'
    if (width === undefined && height !== undefined) {
      const scaled = Math.max(1, Math.round((source.width * height) / source.height))
      pipeline = pipeline.resize(scaled, height, { fit })
    } else if (width !== undefined && height === undefined) {
      pipeline = pipeline.resize(width, undefined, { fit })
    } else if (width !== undefined && height !== undefined) {
      pipeline = pipeline.resize(width, height, { fit })
    }
  }

  if (options.rotate) pipeline = pipeline.rotate(options.rotate)
  if (options.flip) pipeline = pipeline.flip()
  if (options.flop) pipeline = pipeline.flop()

  let bytes: Uint8Array
  try {
    bytes = await encode(pipeline, format, options.quality).bytes()
  } catch (error) {
    if (codeOf(error) === UNSUPPORTED) {
      throw new UnsupportedImageError(
        `This platform cannot write ${format}. The "${Bun.Image.backend}" backend supports ${PORTABLE_FORMATS.join(', ')}; AVIF and HEIC need the "system" backend, which exists only on macOS and Windows.`,
        { format, backend: Bun.Image.backend },
      )
    }
    throw error
  }

  return { bytes, format, width: pipeline.width, height: pipeline.height, source }
}

/**
 * A ThumbHash placeholder for the source, as a `data:` URL.
 *
 * Roughly 400–700 bytes of blurred colour and structure at 32px, which is small enough to inline
 * into the HTML that references the real image — so the layout settles and something is on screen
 * before the full picture has been requested.
 */
export async function placeholder(input: ImageSource, guards: Guards = {}): Promise<string> {
  await readMetadata(input, guards)
  return new Bun.Image(input).placeholder()
}

/**
 * Checks that this platform can actually write `format`, by encoding one pixel.
 *
 * Called at boot rather than on the first upload. A developer on macOS who configures AVIF gets
 * a working machine and a Linux deployment that rejects every image, and the gap between those
 * two facts is where the 3am page comes from. One 1×1 encode at startup closes it.
 */
export async function assertFormatSupported(format: ImageFormat): Promise<void> {
  if (PORTABLE_FORMATS.includes(format)) return
  // A 1×1 white PNG, small enough to inline and enough to exercise the encoder.
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  try {
    await encode(new Bun.Image(pixel), format, undefined).bytes()
  } catch (error) {
    if (codeOf(error) === UNSUPPORTED) {
      throw new UnsupportedImageError(
        `image(): "${format}" cannot be written on this platform. Bun.Image is using the "${Bun.Image.backend}" backend, which supports ${PORTABLE_FORMATS.join(', ')}. AVIF and HEIC need the "system" backend (macOS and Windows only), so a Linux server cannot produce them. Choose one of ${PORTABLE_FORMATS.join(', ')}.`,
        { format, backend: Bun.Image.backend },
      )
    }
    throw error
  }
}
