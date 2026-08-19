/**
 * The storage contract.
 *
 * Small on purpose, like the database contract: it covers what every application does with
 * objects — put, get, delete, exists, list, stat — and stops there. Anything a specific backend
 * offers beyond that is reached through `raw`.
 *
 * `presign` is a **declared capability**, not a required method. S3 can hand a browser a URL
 * that uploads straight to the bucket; a local directory cannot, and the difference is real
 * rather than something to paper over (D19).
 */

/** What can be uploaded. Everything here streams; nothing is buffered on the way through. */
export type Uploadable = Blob | File | ArrayBuffer | ArrayBufferView | ReadableStream | string

/** Metadata about a stored object. */
export interface StoredObject {
  /** The object key, as stored — never the local filename it arrived with. */
  key: string
  size: number
  /** Content type, as stored. */
  type: string
  lastModified?: Date | undefined
  /** The bucket it lives in, for apps with more than one. */
  bucket: string
}

/**
 * Every optional field here accepts `undefined` explicitly.
 *
 * The repo runs with `exactOptionalPropertyTypes`, under which `{ type?: string }` rejects
 * `{ type: undefined }` — and the natural call is `upload(key, file, { type: file.type })`,
 * where the value is `string | undefined`. Making the caller write a conditional spread to
 * satisfy the framework is the framework's problem, not theirs.
 */
export interface PutOptions {
  /** Content type. Taken from a `File`'s own type when not given. */
  type?: string | undefined
  /** `Cache-Control` to store alongside the object. */
  cacheControl?: string | undefined
  /** S3 ACL, e.g. `public-read`. Ignored by drivers that have no concept of one. */
  acl?: string | undefined
}

export interface ListOptions {
  prefix?: string | undefined
  /** Maximum keys to return. Drivers may return fewer. */
  limit?: number | undefined
  /** Continue a previous listing — pass the `next` from the page before. */
  after?: string | undefined
}

export interface ListResult {
  objects: StoredObject[]
  /** Pass back as `after` to continue. Absent when the listing is complete. */
  next?: string | undefined
}

export interface PresignOptions {
  /** Seconds the URL stays valid. Default 900 (15 minutes). */
  expiresIn?: number | undefined
  /** `GET` to download, `PUT` to upload. */
  method?: 'GET' | 'PUT' | undefined
  /** Content type the upload must declare. Worth setting: it is part of what gets signed. */
  type?: string | undefined
  /** `Content-Disposition` for a download, e.g. `attachment; filename="report.pdf"`. */
  disposition?: string | undefined
}

export interface DirectUploadOptions {
  /** Seconds the ticket stays valid. Default 900 (15 minutes). */
  expiresIn?: number | undefined
  /**
   * Content type the browser must send.
   *
   * Worth setting. It is part of what gets signed, so a client that sends something else is
   * rejected — which is the only content-type check a direct upload gets, since the bytes never
   * pass through your server.
   */
  type?: string | undefined
}

/**
 * A ticket a browser can upload with, meant to be returned from a route as JSON.
 *
 * Deliberately a plain object rather than a URL string: the `headers` are not optional — the
 * content type is part of the signature, and omitting it produces a signature mismatch whose
 * error message explains nothing.
 */
export interface DirectUpload {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  /** The key the object will have. Store this; the URL is temporary and the key is not. */
  key: string
  bucket: string
  /** ISO timestamp after which the URL stops working. */
  expiresAt: string
}

/**
 * What a storage backend must provide.
 *
 * `read` returns a **`Blob`** rather than bytes. Both `Bun.file()` and Bun's `S3File` are Blobs,
 * so a route can `return ctx.storage.read(key)` and core streams it to the client without the
 * body ever being held in memory. Returning an `ArrayBuffer` here would have made that
 * impossible for every caller, forever.
 */
export interface StorageDriver {
  /** Identifies the driver in errors and logs, e.g. `s3` or `disk`. */
  readonly name: string
  /** The bucket, or the directory, this driver writes to. */
  readonly bucket: string

  put(key: string, body: Uploadable, options: PutOptions): Promise<StoredObject>
  /** A lazy handle. Nothing is fetched until the Blob is read. */
  read(key: string): Blob
  remove(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  stat(key: string): Promise<StoredObject | null>
  list(options: ListOptions): Promise<ListResult>

  /**
   * Signs a URL. Absent when the backend has no such concept — checked at boot, not at use.
   *
   * Declared as an optional *property* rather than an optional method so a driver can decide at
   * construction: Bunny can sign only when a pull zone and token key are configured, and needs
   * to say so with `presign: undefined`.
   */
  presign?: ((key: string, options: PresignOptions) => string) | undefined

  /** The underlying client, for whatever the contract does not cover. */
  readonly raw: unknown
}

/** Raised when a storage operation fails. Names the driver and the key. */
export class StorageError extends Error {
  override name = 'StorageError'
  readonly driver: string | undefined
  readonly key: string | undefined

  constructor(message: string, options: { driver?: string; key?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.driver = options.driver
    this.key = options.key
  }
}

/**
 * Rejects keys that would escape the bucket or the directory they belong to.
 *
 * Uploads are usually named from something a user controls, so `../../etc/passwd` and
 * `/etc/passwd` both have to be refused *before* they reach a filesystem. S3 would treat them as
 * literal key names, which is harmless; the disk driver would not, which is not. One check in
 * one place rather than one per driver.
 */
export function assertSafeKey(key: string): void {
  if (key === '' || key === '.' || key === '..') {
    throw new StorageError(`"${key}" is not a usable object key.`, { key })
  }
  if (key.startsWith('/') || key.startsWith('\\')) {
    throw new StorageError(`Object keys must be relative; "${key}" starts at the root.`, { key })
  }
  if (key.includes('\0')) {
    throw new StorageError('Object keys cannot contain a null byte.', { key })
  }
  // Checked on both separators: a Windows-style key reaching a POSIX path join is still a key
  // someone chose, and the intent is identical.
  for (const segment of key.split(/[/\\]/)) {
    if (segment === '..') {
      throw new StorageError(`Object keys cannot traverse upwards; "${key}" contains "..".`, {
        key,
      })
    }
  }
}
