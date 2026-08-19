import type {
  DirectUpload,
  DirectUploadOptions,
  ListOptions,
  ListResult,
  PresignOptions,
  PutOptions,
  StorageDriver,
  StoredObject,
  Uploadable,
} from './types'
import { StorageError } from './types'

/**
 * What `ctx.storage` exposes.
 *
 * One bucket's worth of operations, plus `bucket(name)` to reach another. The names are the
 * ones people already say out loud — upload, download, delete — rather than the S3 verbs.
 */
export interface StorageService {
  /** The driver behind this bucket, e.g. `s3` or `disk`. */
  readonly driver: string
  /** The bucket this service writes to. */
  readonly bucketName: string

  /**
   * Stores an object.
   *
   * A `File` from a multipart upload is streamed straight through — Bun spilled it to a
   * temporary file while parsing, and it goes from there to the destination without the body
   * being held in memory.
   */
  upload(key: string, body: Uploadable, options?: PutOptions): Promise<StoredObject>

  /**
   * A lazy handle to an object.
   *
   * A `Blob`, so a route can return it directly and core streams it to the client:
   *
   * ```ts
   * app.get('/files/[...key]', (ctx) => ctx.storage.download(ctx.params.key))
   * ```
   *
   * Nothing is fetched until something reads it.
   */
  download(key: string): Blob

  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  /** Metadata, or `null` when the object is not there. */
  stat(key: string): Promise<StoredObject | null>
  list(options?: ListOptions): Promise<ListResult>

  /** Whether this driver can sign URLs. `false` for local disk. */
  readonly canPresign: boolean

  /** A URL a browser can `PUT` straight to, skipping your server entirely. */
  presignUpload(key: string, options?: Omit<PresignOptions, 'method'>): string
  /** A time-limited URL for a private object. */
  presignDownload(key: string, options?: Omit<PresignOptions, 'method'>): string

  /**
   * Everything a browser needs to upload straight to the bucket, skipping your server.
   *
   * ```ts
   * app.post('/uploads', { auth: true }, (ctx) =>
   *   ctx.storage.directUpload(`users/${ctx.user.id}/${crypto.randomUUID()}`, {
   *     type: 'image/png',
   *   }),
   * )
   * ```
   *
   * ```ts
   * // in the browser
   * const ticket = await (await fetch('/uploads', { method: 'POST' })).json()
   * await fetch(ticket.url, { method: ticket.method, headers: ticket.headers, body: file })
   * ```
   *
   * The point is that a 2GB file never touches your server: no request timeout to raise, no
   * memory to budget, no bandwidth to pay for twice.
   */
  directUpload(key: string, options?: DirectUploadOptions): DirectUpload

  /**
   * Another configured bucket, by name.
   *
   * ```ts
   * await ctx.storage.bucket('avatars').upload(key, file)
   * ```
   */
  bucket(name: string): StorageService

  /** The underlying client, for whatever the contract does not cover. */
  readonly raw: unknown
}

/** Builds the service over one driver. `buckets` resolves `bucket(name)`. */
export function createService(
  driver: StorageDriver,
  buckets: Map<string, StorageDriver>,
  services: Map<string, StorageService>,
): StorageService {
  function requirePresign(): NonNullable<StorageDriver['presign']> {
    if (!driver.presign) {
      throw new StorageError(
        `The "${driver.name}" driver cannot sign URLs, so presigned uploads and downloads are ` +
          'not available. Serve the object through a route instead, or switch to an ' +
          'S3-compatible driver.',
        { driver: driver.name },
      )
    }
    return driver.presign
  }

  const service: StorageService = {
    driver: driver.name,
    bucketName: driver.bucket,
    raw: driver.raw,
    canPresign: driver.presign !== undefined,

    upload: (key, body, options = {}) => driver.put(key, body, options),
    download: (key) => driver.read(key),
    delete: (key) => driver.remove(key),
    exists: (key) => driver.exists(key),
    stat: (key) => driver.stat(key),
    list: (options = {}) => driver.list(options),

    presignUpload: (key, options = {}) => requirePresign()(key, { ...options, method: 'PUT' }),

    directUpload: (key, options = {}) => {
      const expiresIn = options.expiresIn ?? 900
      const url = requirePresign()(key, { ...options, method: 'PUT', expiresIn })

      return {
        url,
        method: 'PUT',
        // The content type is part of what was signed, so the browser has to send the same one
        // back or S3 rejects the request with a signature mismatch that reads like nonsense.
        headers: options.type ? { 'content-type': options.type } : {},
        key,
        bucket: driver.bucket,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      }
    },
    presignDownload: (key, options = {}) => requirePresign()(key, { ...options, method: 'GET' }),

    bucket: (name) => {
      const existing = services.get(name)
      if (existing) return existing

      const other = buckets.get(name)
      if (!other) {
        throw new StorageError(
          `No bucket named "${name}" is configured. Configured: ${[...buckets.keys()].join(', ')}.`,
          { driver: driver.name },
        )
      }

      const built = createService(other, buckets, services)
      services.set(name, built)
      return built
    },
  }

  return service
}
