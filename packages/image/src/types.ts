import { OvenError } from '@theoven/core'

/** Formats `Bun.Image` can write. Decoding also accepts GIF and TIFF. */
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'heic'

/** What a source image is, before anything has been decoded. */
export interface ImageMetadata {
  width: number
  height: number
  /** The format as detected from the file's header, not from its name or its content-type. */
  format: string
  /** `width * height`. The number that decides whether decoding is affordable. */
  pixels: number
  /** Size of the encoded input in bytes. */
  bytes: number
}

export interface ResizeOptions {
  width?: number | undefined
  height?: number | undefined
  /**
   * `inside` fits within the box and keeps the aspect ratio. `fill` stretches to exactly the
   * box. Defaults to `inside`, because a stretched avatar is a bug report.
   */
  fit?: 'inside' | 'fill' | undefined
  /**
   * Permit an output larger than the source. Off by default.
   *
   * `Bun.Image` upscales happily, so a request for 10000px on a 200px upload would spend real
   * CPU and memory inventing detail that is not there. Off means the source's own size is the
   * ceiling.
   */
  allowUpscale?: boolean | undefined
}

export interface TransformOptions extends ResizeOptions {
  format?: ImageFormat | undefined
  /** 1–100. Ignored by `png`, which is lossless. */
  quality?: number | undefined
  /** Degrees clockwise. 90 and 270 swap width and height. */
  rotate?: number | undefined
  /** Mirror vertically. */
  flip?: boolean | undefined
  /** Mirror horizontally. */
  flop?: boolean | undefined
}

export interface TransformResult {
  /** The encoded image. */
  bytes: Uint8Array
  format: ImageFormat
  width: number
  height: number
  /** What the source looked like before this ran. */
  source: ImageMetadata
}

/**
 * The image is larger than this application is willing to decode.
 *
 * 413 rather than 422: the upload is well-formed, there is simply too much of it.
 */
export class ImageTooLargeError extends OvenError {
  override name = 'ImageTooLargeError'
  constructor(message: string, detail: Record<string, unknown>) {
    super(413, 'Image too large', message, {
      type: 'https://theoven.app/errors/image-too-large',
      detail,
    })
  }
}

/** The bytes are not an image, or not one this platform can read. */
export class UnsupportedImageError extends OvenError {
  override name = 'UnsupportedImageError'
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(415, 'Unsupported image', message, {
      type: 'https://theoven.app/errors/unsupported-image',
      detail,
    })
  }
}
