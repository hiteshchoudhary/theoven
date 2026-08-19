/**
 * Transformation URLs — the reason to choose ImageKit over plain object storage.
 *
 * Deliberately separate from the storage driver: resizing an image is not something the storage
 * contract has an opinion about, and inventing one would mean every other driver pretending it
 * could crop.
 */

export interface Transformation {
  width?: number
  height?: number
  /** `maintain_ratio`, `force`, `at_least`, `at_max`. */
  crop?: string
  quality?: number
  /** `auto` lets ImageKit pick webp/avif per browser, which is most of the win. */
  format?: 'auto' | 'webp' | 'avif' | 'jpg' | 'png'
  blur?: number
  /** Anything not covered above, passed through as `key-value`. */
  raw?: Record<string, string | number>
}

const NAMES: Record<string, string> = {
  width: 'w',
  height: 'h',
  crop: 'c',
  quality: 'q',
  format: 'f',
  blur: 'bl',
}

/** Serialises transformations into ImageKit's `tr=` syntax. */
export function transformationOf(transformation: Transformation): string {
  const parts: string[] = []

  for (const [key, short] of Object.entries(NAMES)) {
    const value = transformation[key as keyof Transformation]
    if (value !== undefined && value !== null) parts.push(`${short}-${value}`)
  }
  for (const [key, value] of Object.entries(transformation.raw ?? {})) {
    parts.push(`${key}-${value}`)
  }

  return parts.join(',')
}

export interface UrlOptions {
  transform?: Transformation
  /** Seconds the signed URL stays valid. Signing is skipped when omitted. */
  expiresIn?: number
}

/**
 * Builds a delivery URL, optionally signed.
 *
 * ImageKit's signature covers the path *and* the transformation, so a client cannot edit `tr=`
 * to request a 10 000px render off a signed URL — which is the reason to sign at all on a
 * pay-per-transformation product.
 */
export function buildUrl(
  endpoint: string,
  privateKey: string | undefined,
  key: string,
  options: UrlOptions = {},
): string {
  const base = endpoint.replace(/\/$/, '')
  const path = key.replace(/^\//, '')
  const query = options.transform ? `?tr=${transformationOf(options.transform)}` : ''
  const url = `${base}/${path}${query}`

  if (options.expiresIn === undefined) return url
  if (!privateKey) {
    throw new Error('Signing an ImageKit URL needs the private key.')
  }

  const expires = Math.floor(Date.now() / 1000) + options.expiresIn

  // ImageKit signs the URL with its endpoint removed, plus the expiry.
  const signable = `${url.replace(`${base}/`, '')}${expires}`
  const signature = new Bun.CryptoHasher('sha1', privateKey).update(signable).digest('hex')

  return `${url}${query ? '&' : '?'}ik-t=${expires}&ik-s=${signature}`
}
